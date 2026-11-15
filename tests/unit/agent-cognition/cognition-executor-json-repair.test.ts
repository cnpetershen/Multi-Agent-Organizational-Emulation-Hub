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
} from '../../helpers/cognition-fixtures';

function gatewayFrom(provider: LlmProvider): LlmGateway {
  return createLlmGateway({ providers: [provider], defaultProvider: provider.name, now: () => 1000 });
}

function executorFor(text: string | ((request: { readonly prompt: string }) => string)): {
  readonly executor: CognitionExecutor;
} {
  const provider = createMockLlmProvider({ text, inputTokens: 11, outputTokens: 22 });
  return { executor: createCognitionExecutor({ gateway: gatewayFrom(provider) }) };
}

function buildRequest(): CognitionRequest {
  return {
    requestId: 'req-repair',
    actorContext: testActorContext(),
    cognitionContext: testContext(),
    profile: TEST_PROFILE,
    maxLlmCalls: 2,
    simTime: sim(60),
  };
}

/**
 * The live model (deepseek-flash) embeds real newline bytes inside string values of the JSON it
 * emits. Strict JSON.parse refuses those, so the whole plan fails with `malformed_output`.
 * The repair pass must accept the value — not the model's discipline.
 */
function rawOutputWithEmbeddedNewlines(): string {
  const lines = [
    '{',
    '  "interpretation": "I will produce the deliverable",',
    '  "considerations": ["a", "b"],',
    '  "conclusion": "c",',
    '  "confidence": 0.9,',
    '  "plan": {',
    '    "goal": "g",',
    '    "doneWhen": "d",',
    '    "steps": [',
    '      {',
    '        "action": "ProduceArtifact",',
    '        "args": {',
    '          "taskId": "task-1",',
    '          "name": "requirements.md",',
    '          "content": "# Requirements',
    '',
    '## Scope',
    '- 1–2 partner universities',
    '- no community"',
    '        },',
    '        "reasonRef": 0',
    '      }',
    '    ]',
    '  }',
    '}',
  ];
  return lines.join('\n');
}

describe('cognition executor: JSON repair for live provider output', () => {
  it('accepts raw newlines embedded in a string value', async () => {
    const raw = rawOutputWithEmbeddedNewlines();
    expect(() => JSON.parse(raw)).toThrow();

    const { executor } = executorFor(raw);
    const result = await executor.execute(buildRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plan.steps[0]?.action).toBe('ProduceArtifact');
    expect(String(result.value.plan.steps[0]?.args?.content)).toContain('Scope');
  });

  it('leaves valid JSON alone (control-char repair is not applied to healthy output)', async () => {
    const raw =
      '{"interpretation":"i","considerations":["a"],"conclusion":"c","confidence":0.5,"plan":{"goal":"g","doneWhen":"d","steps":[{"action":"AcceptTask","args":{"taskId":"task-1"},"reasonRef":0}]}}';
    const { executor } = executorFor(raw);
    const result = await executor.execute(buildRequest());
    expect(result.ok).toBe(true);
  });

  it('preserves legal escapes and the exact string contents', async () => {
    const content = 'quote=" and path=C:\\work\\file and tab=\\t and newline=\\n';
    const raw = JSON.stringify({
      interpretation: 'i',
      considerations: ['a'],
      conclusion: 'c',
      confidence: 0.5,
      plan: {
        goal: 'g',
        doneWhen: 'd',
        steps: [
          {
            action: 'ProduceArtifact',
            args: { taskId: 'task-1', name: 'x.md', content },
            reasonRef: 0,
          },
        ],
      },
    });
    expect(() => JSON.parse(raw)).not.toThrow();
    const { executor } = executorFor(raw);
    const result = await executor.execute(buildRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plan.steps[0]?.args?.content).toBe(content);
  });

  it('repairs raw tab, carriage-return and NUL only inside strings', async () => {
    const content = `line1\nline2\t${String.fromCharCode(13)}${String.fromCharCode(0)}end`;
    const raw = `{"interpretation":"i","considerations":["a"],"conclusion":"c","confidence":0.5,"plan":{"goal":"g","doneWhen":"d","steps":[{"action":"ProduceArtifact","args":{"taskId":"task-1","name":"x.md","content":"${content}"},"reasonRef":0}]}}`;
    expect(() => JSON.parse(raw)).toThrow();
    const { executor } = executorFor(raw);
    const result = await executor.execute(buildRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plan.steps[0]?.args?.content).toBe(content);
  });

  it('does not silently repair a structural error', async () => {
    const raw =
      '{"interpretation":"i","considerations":["a"],"conclusion":"c","confidence":0.5,"plan":{"goal":"g","doneWhen":"d","steps":[]},}';
    const { executor } = executorFor(raw);
    const result = await executor.execute(buildRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('malformed_output');
  });

  it('does not silently repair an invalid escape', async () => {
    const raw =
      '{"interpretation":"i","considerations":["a"],"conclusion":"c","confidence":0.5,"plan":{"goal":"g","doneWhen":"d","steps":[{"action":"ProduceArtifact","args":{"taskId":"task-1","name":"x.md","content":"\\x41"},"reasonRef":0}]}}';
    const { executor } = executorFor(raw);
    const result = await executor.execute(buildRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('malformed_output');
  });

  it('drops harmless extra keys and defaults only the non-semantic reasonRef', async () => {
    const raw =
      '{"interpretation":"i","considerations":["a"],"conclusion":"c","confidence":0.5,"steps_notes":null,"plan":{"goal":"g","doneWhen":"d","notes":"extra","steps":[{"action":"AcceptTask","args":{"taskId":"task-1"},"notes":"extra"}]}}';
    const { executor } = executorFor(raw);
    const result = await executor.execute(buildRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plan.steps[0]?.action).toBe('AcceptTask');
  });

  it('still rejects a missing semantic field after normalisation', async () => {
    const raw =
      '{"interpretation":"i","considerations":["a"],"conclusion":"c","confidence":0.5,"plan":{"goal":"g","doneWhen":"d","steps":[{"action":"AcceptTask","args":{"taskId":"task-1"},"reasonRef":0}]}}';
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    delete (parsed['plan'] as Record<string, unknown>)['goal'];
    const { executor } = executorFor(JSON.stringify(parsed));
    const result = await executor.execute(buildRequest());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('schema_violation');
  });
});
