import { describe, expect, it } from 'vitest';
import type { CognitionExecutor, CognitionRequest } from '@maoeh/agent-cognition';
import { createCognitionExecutor } from '@maoeh/agent-cognition';
import type { LlmGateway, LlmProvider } from '@maoeh/llm-gateway';
import { createLlmGateway, createMockLlmProvider } from '@maoeh/llm-gateway';
import {
  TEST_PROFILE,
  sim,
  testActorContext,
  testContext,
  validOutput,
} from '../../helpers/cognition-fixtures';

function gatewayFrom(provider: LlmProvider, timeoutMs?: number): LlmGateway {
  return createLlmGateway({
    providers: [provider],
    defaultProvider: provider.name,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    now: () => 1000,
  });
}

function executorFor(text: string | ((request: { readonly prompt: string }) => string), timeoutMs?: number): {
  readonly executor: CognitionExecutor;
  readonly provider: ReturnType<typeof createMockLlmProvider>;
} {
  const provider = createMockLlmProvider({ text, inputTokens: 11, outputTokens: 22 });
  return { executor: createCognitionExecutor({ gateway: gatewayFrom(provider, timeoutMs) }), provider };
}

function buildRequest(overrides: Partial<CognitionRequest> = {}): CognitionRequest {
  return {
    requestId: 'req-1',
    actorContext: testActorContext(),
    cognitionContext: testContext(),
    profile: TEST_PROFILE,
    maxLlmCalls: 2,
    simTime: sim(60),
    ...overrides,
  };
}

describe('agent-cognition: 执行管线（Context → Gateway → Schema → Reasoning → Plan）', () => {
  it('合法输出 → 结构化认知结果，幂等键由 requestId 派生', async () => {
    const { executor, provider } = executorFor(validOutput());

    const result = await executor.execute(buildRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cognition = result.value;
    expect(cognition.requestId).toBe('req-1');
    expect(cognition.interpretation).toBe('The task is assigned to me and unstarted.');
    expect(cognition.confidence).toBeCloseTo(0.86);
    expect(cognition.reasoning.considerations).toHaveLength(2);
    expect(cognition.plan.goal).toBe('task-1 is started');
    expect(cognition.plan.steps.map((step) => step.action)).toEqual(['AcceptTask', 'StartTask']);
    expect(cognition.plan.steps.map((step) => step.idempotencyKey)).toEqual([
      'req-1:0',
      'req-1:1',
    ]);
    expect(cognition.plan.steps[0]?.reasonRef).toBe(0);
    expect(cognition.llmMetadata.provider).toBe('mock');
    expect(cognition.llmMetadata.callCount).toBe(1);
    expect(cognition.llmMetadata.inputTokens).toBe(11);
    expect(cognition.llmMetadata.outputTokens).toBe(22);
    expect(provider.callCount).toBe(1);
  });

  it('provider 请求携带画像 system prompt 与事件/动作空间 prompt', async () => {
    const { executor, provider } = executorFor(validOutput());

    await executor.execute(buildRequest());

    const sent = provider.requests[0];
    if (sent === undefined) throw new Error('provider received no request');
    expect(sent.requestId).toBe('req-1');
    expect(sent.system).toContain('You are Alice');
    expect(sent.system).toContain('Reasoning style: step by step, evidence first');
    expect(sent.system).toContain('single JSON object');
    expect(sent.prompt).toContain('Task.Assigned');
    expect(sent.prompt).toContain('Acme Corp');
    expect(sent.prompt).toContain('AcceptTask');
    expect(sent.prompt).toContain('"confidence"');
  });

  it('markdown 围栏包裹的 JSON 也能解析', async () => {
    const { executor } = executorFor(`\`\`\`json\n${validOutput()}\n\`\`\``);
    const result = await executor.execute(buildRequest());
    expect(result.ok).toBe(true);
  });

  it('非 JSON / 非对象 → malformed_output', async () => {
    const notJson = executorFor('definitely not json');
    const badJson = await notJson.executor.execute(buildRequest());
    expect(badJson.ok).toBe(false);
    if (!badJson.ok) expect(badJson.error.code).toBe('malformed_output');

    const array = executorFor('[]');
    const badArray = await array.executor.execute(buildRequest());
    expect(badArray.ok).toBe(false);
    if (!badArray.ok) expect(badArray.error.code).toBe('malformed_output');

    const empty = executorFor('   ');
    const blank = await empty.executor.execute(buildRequest());
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error.code).toBe('malformed_output');
  });

  it('schema 违例 → schema_violation，并给出字段路径', async () => {
    const outOfRange = executorFor(validOutput({ confidence: 4 }));
    const confidenceFailure = await outOfRange.executor.execute(buildRequest());
    expect(confidenceFailure.ok).toBe(false);
    if (confidenceFailure.ok) return;
    expect(confidenceFailure.error.code).toBe('schema_violation');
    expect(confidenceFailure.error.issues.map((issue) => issue.field)).toContain('confidence');

    const missing = executorFor(
      JSON.stringify({ considerations: ['a'], conclusion: 'c', confidence: 0.5, plan: { goal: 'g', doneWhen: 'd', steps: [{ action: 'Speak', args: {}, reasonRef: 0 }] } }),
    );
    const missingFailure = await missing.executor.execute(buildRequest());
    expect(missingFailure.ok).toBe(false);
    if (missingFailure.ok) return;
    expect(missingFailure.error.code).toBe('schema_violation');
    expect(missingFailure.error.issues.map((issue) => issue.field)).toContain('interpretation');
  });

  it('动作不在闭合 Action Space → invalid_plan', async () => {
    const { executor } = executorFor(
      validOutput({ steps: [{ action: 'Teleport', args: {}, reasonRef: 0 }] }),
    );
    const result = await executor.execute(buildRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_plan');
    expect(result.error.issues[0]?.field).toBe('plan.steps[0].action');
    expect(result.error.issues[0]?.reason).toContain('Action Space');
  });

  it('reasonRef 越界 → invalid_plan', async () => {
    const { executor } = executorFor(
      validOutput({ steps: [{ action: 'Speak', args: {}, reasonRef: 9 }] }),
    );
    const result = await executor.execute(buildRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_plan');
    expect(result.error.issues[0]?.field).toBe('plan.steps[0].reasonRef');
  });

  it('空白 consideration → invalid_reasoning', async () => {
    const { executor } = executorFor(validOutput({ considerations: ['   '] }));
    const result = await executor.execute(buildRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_reasoning');
    expect(result.error.issues[0]?.field).toBe('considerations[0]');
  });

  it('缺少 ActorContext / 画像错配 / 预算非法 → 请求期失败且不调用 provider', async () => {
    const { executor, provider } = executorFor(validOutput());

    const noActor = await executor.execute(buildRequest({ actorContext: undefined }));
    expect(noActor.ok).toBe(false);
    if (!noActor.ok) expect(noActor.error.code).toBe('missing_actor_context');

    const wrongProfile = await executor.execute(
      buildRequest({ profile: { ...TEST_PROFILE, id: 'other-profile' } }),
    );
    expect(wrongProfile.ok).toBe(false);
    if (!wrongProfile.ok) expect(wrongProfile.error.code).toBe('invalid_profile');

    const badBudget = await executor.execute(buildRequest({ maxLlmCalls: -1 }));
    expect(badBudget.ok).toBe(false);
    if (!badBudget.ok) expect(badBudget.error.code).toBe('invalid_request');

    const emptyRequest = await executor.execute(buildRequest({ requestId: '  ' }));
    expect(emptyRequest.ok).toBe(false);
    if (!emptyRequest.ok) expect(emptyRequest.error.code).toBe('invalid_request');

    expect(provider.callCount).toBe(0);
  });

  it('maxLlmCalls 为 0 → budget_exceeded', async () => {
    const { executor, provider } = executorFor(validOutput());
    const result = await executor.execute(buildRequest({ maxLlmCalls: 0 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('budget_exceeded');
    expect(provider.callCount).toBe(0);
  });

  it('网关超时 → llm_timeout；provider 缺失 → llm_gateway_unavailable', async () => {
    const hanging = createMockLlmProvider({ text: validOutput(), hang: true });
    const hangExecutor = createCognitionExecutor({
      gateway: createLlmGateway({
        providers: [hanging],
        defaultProvider: 'mock',
        timeoutMs: 5,
        now: () => 1000,
      }),
    });
    const timeoutResult = await hangExecutor.execute(buildRequest());
    expect(timeoutResult.ok).toBe(false);
    if (!timeoutResult.ok) expect(timeoutResult.error.code).toBe('llm_timeout');
    expect(hanging.callCount).toBe(1);

    const gateway = createLlmGateway({ providers: [], defaultProvider: 'absent' });
    const executor = createCognitionExecutor({ gateway });
    const missing = await executor.execute(buildRequest());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('llm_gateway_unavailable');
  });

  it('相同输入 + 确定性 provider → 认知结果完全确定', async () => {
    const first = executorFor(validOutput());
    const second = executorFor(validOutput());

    const a = await first.executor.execute(buildRequest());
    const b = await second.executor.execute(buildRequest());

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.llmMetadata.latencyMs).toBe(b.value.llmMetadata.latencyMs);
    expect(a.value).toEqual(b.value);
  });

  it('结果不可变：plan 与 reasoning 被冻结', async () => {
    const { executor } = executorFor(validOutput());
    const result = await executor.execute(buildRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value.plan)).toBe(true);
    expect(Object.isFrozen(result.value.plan.steps)).toBe(true);
    expect(Object.isFrozen(result.value.reasoning.considerations)).toBe(true);
  });
});
