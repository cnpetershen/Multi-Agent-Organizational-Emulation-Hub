import { beforeEach, describe, expect, it } from 'vitest';
import { getLlmCalls, resetLlmCalls } from '@maoeh/observability';
import type { LlmErrorCode, LlmProvider } from '@maoeh/llm-gateway';
import { createCallBudget, createLlmGateway } from '@maoeh/llm-gateway';
import { testActorContext } from '../../helpers/cognition-fixtures';

/**
 * Retry semantics. The load-bearing property is that a retry is *visible*: it costs budget and it
 * leaves its own row in `llm_calls`, because ADR-008 makes that ledger the source of truth for
 * what a run actually spent.
 */

type Outcome = 'ok' | LlmErrorCode;

function scriptedProvider(pName: string, pOutcomes: readonly Outcome[]) {
  const state = { calls: 0 };
  const provider: LlmProvider = {
    name: pName,
    async generate() {
      const index = state.calls;
      state.calls += 1;
      const outcome = pOutcomes[index] ?? 'ok';
      if (outcome === 'ok') {
        return {
          ok: true,
          value: { text: '{"ok":true}', provider: pName, model: 'm-1', latencyMs: 0 },
        };
      }
      return {
        ok: false,
        error: { code: outcome, issues: [{ field: 'provider', reason: `seeded ${outcome}` }] },
      };
    },
  };
  return { provider, state };
}

const request = {
  requestId: 'req-1',
  system: 'You are Alice.',
  prompt: '{"interpretation":"x"}',
};

function gatewayWith(pOutcomes: readonly Outcome[], pMaxAttempts?: number) {
  const scripted = scriptedProvider('deepseek', pOutcomes);
  const gateway = createLlmGateway({
    providers: [scripted.provider],
    defaultProvider: 'deepseek',
    ...(pMaxAttempts === undefined ? {} : { maxAttempts: pMaxAttempts }),
  });
  return { gateway, scripted };
}

describe('llm-gateway 重试：默认行为与改动前完全一致', () => {
  beforeEach(() => {
    resetLlmCalls();
  });

  it('未设置 maxAttempts 时只尝试一次', async () => {
    const { gateway, scripted } = gatewayWith(['provider_error']);
    const budget = createCallBudget(5);

    const result = await gateway.generate({ actorContext: testActorContext(), request, budget });

    expect(result.ok).toBe(false);
    expect(scripted.state.calls).toBe(1);
    expect(budget.callCount).toBe(1);
    expect(getLlmCalls()).toHaveLength(1);
  });

  it('maxAttempts=1 显式设置时同样只尝试一次', async () => {
    const { gateway, scripted } = gatewayWith(['provider_error'], 1);

    await gateway.generate({
      actorContext: testActorContext(),
      request,
      budget: createCallBudget(5),
    });

    expect(scripted.state.calls).toBe(1);
  });
});

describe('llm-gateway 重试：暂时性失败值得再试', () => {
  beforeEach(() => {
    resetLlmCalls();
  });

  it('持续 provider_error → 尝试三次，预算与账本各记三次', async () => {
    const { gateway, scripted } = gatewayWith(
      ['provider_error', 'provider_error', 'provider_error'],
      3,
    );
    const budget = createCallBudget(10);

    const result = await gateway.generate({ actorContext: testActorContext(), request, budget });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('provider_error');
    expect(scripted.state.calls).toBe(3);
    expect(budget.callCount).toBe(3);

    const calls = getLlmCalls();
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.success)).toEqual([false, false, false]);
    expect(calls.map((call) => call.callCount)).toEqual([1, 2, 3]);
  });

  it('第二次成功 → 返回成功，账本留下一次失败与一次成功', async () => {
    const { gateway, scripted } = gatewayWith(['provider_error', 'ok'], 3);
    const budget = createCallBudget(10);

    const result = await gateway.generate({ actorContext: testActorContext(), request, budget });

    expect(result.ok).toBe(true);
    expect(scripted.state.calls).toBe(2);
    expect(budget.callCount).toBe(2);
    expect(getLlmCalls().map((call) => call.success)).toEqual([false, true]);
  });

  it('rate_limited 可重试——限流是暂时的', async () => {
    const { gateway, scripted } = gatewayWith(['rate_limited', 'rate_limited', 'ok'], 3);

    const result = await gateway.generate({
      actorContext: testActorContext(),
      request,
      budget: createCallBudget(10),
    });

    expect(result.ok).toBe(true);
    expect(scripted.state.calls).toBe(3);
  });

  it('timeout 可重试', async () => {
    const { gateway, scripted } = gatewayWith(['timeout', 'ok'], 3);

    const result = await gateway.generate({
      actorContext: testActorContext(),
      request,
      budget: createCallBudget(10),
    });

    expect(result.ok).toBe(true);
    expect(scripted.state.calls).toBe(2);
  });
});

describe('llm-gateway 重试：需要人来处理的失败不重试', () => {
  beforeEach(() => {
    resetLlmCalls();
  });

  const nonRetryable: readonly LlmErrorCode[] = [
    'auth_failed',
    'account_unfunded',
    'invalid_request',
    'provider_unavailable',
  ];

  for (const code of nonRetryable) {
    it(`${code} 即使 maxAttempts=5 也只尝试一次`, async () => {
      const { gateway, scripted } = gatewayWith([code], 5);
      const budget = createCallBudget(10);

      const result = await gateway.generate({ actorContext: testActorContext(), request, budget });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(code);
      expect(scripted.state.calls).toBe(1);
      expect(budget.callCount).toBe(1);
    });
  }
});

describe('llm-gateway 重试：预算依然有最终发言权', () => {
  beforeEach(() => {
    resetLlmCalls();
  });

  it('预算撑不起重试时停止，并报告真正的失败原因而不是 budget_exceeded', async () => {
    const { gateway, scripted } = gatewayWith(
      ['provider_error', 'provider_error', 'provider_error'],
      3,
    );
    const budget = createCallBudget(2);

    const result = await gateway.generate({ actorContext: testActorContext(), request, budget });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Pointing at the budget here would send the operator looking in the wrong place.
    expect(result.error.code).toBe('provider_error');
    expect(scripted.state.calls).toBe(2);
    expect(budget.callCount).toBe(2);
  });

  it('预算为 0 且一次都没尝试 → budget_exceeded，provider 不被调用', async () => {
    const { gateway, scripted } = gatewayWith(['ok'], 3);

    const result = await gateway.generate({
      actorContext: testActorContext(),
      request,
      budget: createCallBudget(0),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('budget_exceeded');
    expect(scripted.state.calls).toBe(0);
  });
});
