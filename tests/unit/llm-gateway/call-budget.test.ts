import { describe, expect, it } from 'vitest';
import { createCallBudget } from '@maoeh/llm-gateway';

describe('llm-gateway: CallBudget（ADR-008 / 05-runtime §5.2 预算护栏）', () => {
  it('consume() 按额度递增 callCount 并暴露 remaining', () => {
    const budget = createCallBudget(3);
    expect(budget.maxLlmCalls).toBe(3);
    expect(budget.callCount).toBe(0);
    expect(budget.remaining).toBe(3);

    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(true);
    expect(budget.callCount).toBe(2);
    expect(budget.remaining).toBe(1);

    expect(budget.consume()).toBe(true);
    expect(budget.consume()).toBe(false);
    expect(budget.callCount).toBe(3);
    expect(budget.remaining).toBe(0);
  });

  it('maxLlmCalls 为 0 → 永远无法 consume', () => {
    const budget = createCallBudget(0);
    expect(budget.consume()).toBe(false);
    expect(budget.callCount).toBe(0);
  });

  it('非有限值按 0 处理，负数按 0 处理', () => {
    expect(createCallBudget(Number.NaN).maxLlmCalls).toBe(0);
    expect(createCallBudget(Number.POSITIVE_INFINITY).maxLlmCalls).toBe(0);
    expect(createCallBudget(-4).maxLlmCalls).toBe(0);
    expect(createCallBudget(2.7).maxLlmCalls).toBe(2);
  });

  it('每个预算实例相互独立', () => {
    const a = createCallBudget(1);
    const b = createCallBudget(1);
    expect(a.consume()).toBe(true);
    expect(b.consume()).toBe(true);
    expect(a.consume()).toBe(false);
    expect(b.consume()).toBe(false);
  });
});
