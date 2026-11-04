export const BUDGET_REASONS = [
  'max_agent_turns',
  'max_events',
  'max_tasks',
  'max_workflow_transitions',
  'max_llm_calls',
] as const;

export type BudgetReason = (typeof BUDGET_REASONS)[number];

export interface SimulationBudget {
  readonly maxAgentTurns: number;
  readonly maxEvents: number;
  readonly maxTasks: number;
  readonly maxWorkflowTransitions: number;
  readonly maxLlmCalls: number;
}

export interface BudgetUsage {
  readonly agentTurns: number;
  readonly events: number;
  readonly tasks: number;
  readonly workflowTransitions: number;
  readonly llmCalls: number;
}

export interface BudgetTracker {
  readonly limits: SimulationBudget;
  readonly usage: BudgetUsage;
  readonly exceeded: readonly BudgetReason[];
  readonly remainingLlmCalls: number;
  tryAgentTurn(): boolean;
  tryEvents(count: number): boolean;
  tryTask(): boolean;
  tryWorkflowTransition(): boolean;
  tryLlmCalls(count: number): boolean;
  markExceeded(reason: BudgetReason): void;
}

function assertLimit(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer, received ${String(value)}`);
  }
  return value;
}

export const DEFAULT_BUDGET: SimulationBudget = Object.freeze({
  maxAgentTurns: 64,
  maxEvents: 512,
  maxTasks: 64,
  maxWorkflowTransitions: 128,
  maxLlmCalls: 64,
});

export function createBudgetTracker(limits: SimulationBudget): BudgetTracker {
  const frozen: SimulationBudget = Object.freeze({
    maxAgentTurns: assertLimit(limits.maxAgentTurns, 'maxAgentTurns'),
    maxEvents: assertLimit(limits.maxEvents, 'maxEvents'),
    maxTasks: assertLimit(limits.maxTasks, 'maxTasks'),
    maxWorkflowTransitions: assertLimit(
      limits.maxWorkflowTransitions,
      'maxWorkflowTransitions',
    ),
    maxLlmCalls: assertLimit(limits.maxLlmCalls, 'maxLlmCalls'),
  });

  const usage = {
    agentTurns: 0,
    events: 0,
    tasks: 0,
    workflowTransitions: 0,
    llmCalls: 0,
  };
  const exceeded = new Set<BudgetReason>();

  const canFit = (used: number, limit: number, count: number): boolean =>
    used + count <= limit;

  return {
    limits: frozen,
    get usage() {
      return { ...usage };
    },
    get exceeded() {
      return Object.freeze([...exceeded]);
    },
    get remainingLlmCalls() {
      return Math.max(0, frozen.maxLlmCalls - usage.llmCalls);
    },
    tryAgentTurn() {
      if (!canFit(usage.agentTurns, frozen.maxAgentTurns, 1)) {
        exceeded.add('max_agent_turns');
        return false;
      }
      usage.agentTurns += 1;
      return true;
    },
    tryEvents(count) {
      if (count < 0 || !Number.isInteger(count)) return false;
      if (!canFit(usage.events, frozen.maxEvents, count)) {
        exceeded.add('max_events');
        return false;
      }
      usage.events += count;
      return true;
    },
    tryTask() {
      if (!canFit(usage.tasks, frozen.maxTasks, 1)) {
        exceeded.add('max_tasks');
        return false;
      }
      usage.tasks += 1;
      return true;
    },
    tryWorkflowTransition() {
      if (!canFit(usage.workflowTransitions, frozen.maxWorkflowTransitions, 1)) {
        exceeded.add('max_workflow_transitions');
        return false;
      }
      usage.workflowTransitions += 1;
      return true;
    },
    tryLlmCalls(count) {
      if (count < 0 || !Number.isInteger(count)) return false;
      if (!canFit(usage.llmCalls, frozen.maxLlmCalls, count)) {
        exceeded.add('max_llm_calls');
        return false;
      }
      usage.llmCalls += count;
      return true;
    },
    markExceeded(reason) {
      exceeded.add(reason);
    },
  };
}
