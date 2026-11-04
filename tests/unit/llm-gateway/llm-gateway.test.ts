import { beforeEach, describe, expect, it } from 'vitest';
import type { Result } from '@maoeh/shared-types';
import { getLlmCalls, resetLlmCalls } from '@maoeh/observability';
import type { LlmError, LlmProvider } from '@maoeh/llm-gateway';
import { createCallBudget, createLlmGateway, createMockLlmProvider } from '@maoeh/llm-gateway';
import { testActorContext, validOutput } from '../../helpers/cognition-fixtures';

const baseRequest = {
  requestId: 'req-1',
  system: 'You are Alice.',
  prompt: '{"interpretation":"x"}',
};

function failingProvider(name: string, code: 'provider_unavailable' | 'provider_error' | 'timeout' | 'budget_exceeded'): LlmProvider {
  return {
    name,
    async generate(): Promise<Result<never, LlmError>> {
      return { ok: false, error: { code, issues: [{ field: 'provider', reason: 'seeded' }] } };
    },
  };
}

describe('llm-gateway: ActorContext / request / provider / budget guard (A4, ADR-008)', () => {
  beforeEach(() => {
    resetLlmCalls();
  });

  it('缺少 ActorContext → missing_actor_context，且 provider 不被调用', async () => {
    const provider = createMockLlmProvider({ text: validOutput() });
    const gateway = createLlmGateway({ providers: [provider], defaultProvider: 'mock' });
    const budget = createCallBudget(3);

    const result = await gateway.generate({
      actorContext: undefined,
      request: baseRequest,
      budget,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_actor_context');
    expect(provider.callCount).toBe(0);
    expect(budget.callCount).toBe(0);
    expect(getLlmCalls()).toHaveLength(0);
  });

  it('ActorContext.employeeId 为空 → missing_actor_context', async () => {
    const provider = createMockLlmProvider({ text: validOutput() });
    const gateway = createLlmGateway({ providers: [provider], defaultProvider: 'mock' });

    const result = await gateway.generate({
      actorContext: { ...testActorContext(), employeeId: '' as never },
      request: baseRequest,
      budget: createCallBudget(3),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_actor_context');
    expect(provider.callCount).toBe(0);
  });

  it('requestId / prompt 为空 → invalid_request', async () => {
    const provider = createMockLlmProvider({ text: validOutput() });
    const gateway = createLlmGateway({ providers: [provider], defaultProvider: 'mock' });
    const actorContext = testActorContext();

    const emptyId = await gateway.generate({
      actorContext,
      request: { ...baseRequest, requestId: '' },
      budget: createCallBudget(3),
    });
    expect(emptyId.ok).toBe(false);
    if (!emptyId.ok) expect(emptyId.error.code).toBe('invalid_request');

    const emptyPrompt = await gateway.generate({
      actorContext,
      request: { ...baseRequest, prompt: '   ' },
      budget: createCallBudget(3),
    });
    expect(emptyPrompt.ok).toBe(false);
    if (!emptyPrompt.ok) expect(emptyPrompt.error.code).toBe('invalid_request');

    expect(provider.callCount).toBe(0);
  });

  it('未注册的 provider → provider_unavailable，且不消耗预算', async () => {
    const provider = createMockLlmProvider({ text: validOutput() });
    const gateway = createLlmGateway({ providers: [provider], defaultProvider: 'mock' });
    const budget = createCallBudget(3);

    const result = await gateway.generate({
      actorContext: testActorContext(),
      request: { ...baseRequest, provider: 'missing' },
      budget,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('provider_unavailable');
    expect(budget.callCount).toBe(0);
  });

  it('预算耗尽 → budget_exceeded，provider 不被调用', async () => {
    const provider = createMockLlmProvider({ text: validOutput() });
    const gateway = createLlmGateway({ providers: [provider], defaultProvider: 'mock' });
    const budget = createCallBudget(1);

    const first = await gateway.generate({
      actorContext: testActorContext(),
      request: baseRequest,
      budget,
    });
    expect(first.ok).toBe(true);

    const second = await gateway.generate({
      actorContext: testActorContext(),
      request: { ...baseRequest, requestId: 'req-2' },
      budget,
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('budget_exceeded');
    expect(provider.callCount).toBe(1);
    expect(budget.callCount).toBe(1);
  });

  it('成功调用：写入 observability 记录并返回结构化响应', async () => {
    const provider = createMockLlmProvider({
      text: validOutput(),
      inputTokens: 120,
      outputTokens: 64,
      latencyMs: 9,
    });
    let clock = 1000;
    const gateway = createLlmGateway({
      providers: [provider],
      defaultProvider: 'mock',
      now: () => {
        clock += 5;
        return clock;
      },
    });
    const budget = createCallBudget(2);

    const result = await gateway.generate({
      actorContext: testActorContext(),
      request: { ...baseRequest, traceId: 'trace-1' },
      budget,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.provider).toBe('mock');
    expect(result.value.model).toBe('mock-model-1');
    expect(result.value.latencyMs).toBe(5);
    expect(result.value.inputTokens).toBe(120);
    expect(result.value.outputTokens).toBe(64);
    expect(budget.callCount).toBe(1);

    const calls = getLlmCalls();
    expect(calls).toHaveLength(1);
    const record = calls[0];
    if (record === undefined) throw new Error('expected one llm call record');
    expect(record.requestId).toBe('req-1');
    expect(record.agentId).toBe('alice');
    expect(record.provider).toBe('mock');
    expect(record.success).toBe(true);
    expect(record.callCount).toBe(1);
    expect(record.inputTokens).toBe(120);
  });

  it('provider 抛出异常 → provider_error，并记录失败调用', async () => {
    const throwing: LlmProvider = {
      name: 'boom',
      async generate() {
        throw new Error('kaboom');
      },
    };
    const gateway = createLlmGateway({ providers: [throwing], defaultProvider: 'boom' });

    const result = await gateway.generate({
      actorContext: testActorContext(),
      request: baseRequest,
      budget: createCallBudget(3),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('provider_error');
    expect(result.error.issues[0]?.reason).toContain('kaboom');

    const record = getLlmCalls()[0];
    if (record === undefined) throw new Error('expected a failed llm call record');
    expect(record.success).toBe(false);
    expect(record.provider).toBe('boom');
  });

  it('provider 返回结构化失败 → 原样传播错误码', async () => {
    const gateway = createLlmGateway({
      providers: [failingProvider('seeded', 'provider_unavailable')],
      defaultProvider: 'seeded',
    });

    const result = await gateway.generate({
      actorContext: testActorContext(),
      request: baseRequest,
      budget: createCallBudget(3),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('provider_unavailable');
  });

  it('provider 超时 → timeout', async () => {
    const hangProvider = createMockLlmProvider({ text: validOutput(), hang: true });
    const gateway = createLlmGateway({
      providers: [hangProvider],
      defaultProvider: 'mock',
      timeoutMs: 5,
    });

    const result = await gateway.generate({
      actorContext: testActorContext(),
      request: baseRequest,
      budget: createCallBudget(3),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('timeout');
    expect(hangProvider.callCount).toBe(1);

    const record = getLlmCalls()[0];
    if (record === undefined) throw new Error('expected a timed out llm call record');
    expect(record.success).toBe(false);
  });

  it('request.provider 显式覆盖 defaultProvider', async () => {
    const primary = createMockLlmProvider({ name: 'primary', text: validOutput() });
    const secondary = createMockLlmProvider({ name: 'secondary', text: validOutput() });
    const gateway = createLlmGateway({
      providers: [primary, secondary],
      defaultProvider: 'primary',
    });

    const result = await gateway.generate({
      actorContext: testActorContext(),
      request: { ...baseRequest, provider: 'secondary' },
      budget: createCallBudget(3),
    });

    expect(result.ok).toBe(true);
    expect(primary.callCount).toBe(0);
    expect(secondary.callCount).toBe(1);
  });
});
