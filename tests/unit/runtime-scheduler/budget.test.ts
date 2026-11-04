import { describe, expect, it } from 'vitest';
import type { SimulationBudget } from '@maoeh/runtime-scheduler';
import { createBudgetTracker } from '@maoeh/runtime-scheduler';

function limits(overrides: Partial<SimulationBudget> = {}): SimulationBudget {
  return {
    maxAgentTurns: 2,
    maxEvents: 5,
    maxTasks: 2,
    maxWorkflowTransitions: 2,
    maxLlmCalls: 3,
    ...overrides,
  };
}

describe('runtime-scheduler / BudgetTracker', () => {
  it('counts agent turns and stops at the limit', () => {
    const budget = createBudgetTracker(limits({ maxAgentTurns: 2 }));
    expect(budget.tryAgentTurn()).toBe(true);
    expect(budget.tryAgentTurn()).toBe(true);
    expect(budget.tryAgentTurn()).toBe(false);
    expect(budget.usage.agentTurns).toBe(2);
    expect(budget.exceeded).toContain('max_agent_turns');
  });

  it('counts events and rejects invalid counts', () => {
    const budget = createBudgetTracker(limits({ maxEvents: 3 }));
    expect(budget.tryEvents(2)).toBe(true);
    expect(budget.tryEvents(2)).toBe(false);
    expect(budget.tryEvents(-1)).toBe(false);
    expect(budget.usage.events).toBe(2);
    expect(budget.exceeded).toContain('max_events');
  });

  it('counts tasks and workflow transitions independently', () => {
    const budget = createBudgetTracker(limits({ maxTasks: 1, maxWorkflowTransitions: 1 }));
    expect(budget.tryTask()).toBe(true);
    expect(budget.tryTask()).toBe(false);
    expect(budget.tryWorkflowTransition()).toBe(true);
    expect(budget.tryWorkflowTransition()).toBe(false);
    expect(budget.exceeded).toEqual(
      expect.arrayContaining(['max_tasks', 'max_workflow_transitions']),
    );
  });

  it('tracks llm calls and exposes remaining budget', () => {
    const budget = createBudgetTracker(limits({ maxLlmCalls: 3 }));
    expect(budget.remainingLlmCalls).toBe(3);
    expect(budget.tryLlmCalls(2)).toBe(true);
    expect(budget.remainingLlmCalls).toBe(1);
    expect(budget.tryLlmCalls(2)).toBe(false);
    expect(budget.remainingLlmCalls).toBe(1);
    expect(budget.exceeded).toContain('max_llm_calls');
  });

  it('records explicit exceed reasons', () => {
    const budget = createBudgetTracker(limits());
    budget.markExceeded('max_events');
    expect(budget.exceeded).toEqual(['max_events']);
  });

  it('rejects negative or non-integer limits at construction', () => {
    expect(() => createBudgetTracker(limits({ maxEvents: -1 }))).toThrow(/non-negative/);
    expect(() => createBudgetTracker(limits({ maxTasks: 1.5 }))).toThrow(/non-negative/);
  });
});
