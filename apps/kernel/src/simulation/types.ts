import type { CompanyId, EmployeeId, OrgEvent, SimTime } from '@maoeh/shared-types';
import type { AgentCycleStatus } from '@maoeh/agent-runtime';
import type {
  BudgetReason,
  BudgetUsage,
  ScheduleDefinition,
  SimulationBudget,
} from '@maoeh/runtime-scheduler';

export const SIMULATION_TICK_STATUSES = [
  'ok',
  'idle',
  'partial_failure',
  'budget_exceeded',
  'paused',
] as const;

export type SimulationTickStatus = (typeof SIMULATION_TICK_STATUSES)[number];

export const DEFAULT_SIMULATION_BUDGET: SimulationBudget = Object.freeze({
  maxAgentTurns: 32,
  maxEvents: 256,
  maxTasks: 64,
  maxWorkflowTransitions: 64,
  maxLlmCalls: 32,
});

export interface SimulationConfig {
  readonly companyId: CompanyId;
  readonly tickDuration: number;
  readonly startTick: number;
  readonly maxRetries: number;
  readonly consumerGroup: string;
  readonly budget: SimulationBudget;
  readonly schedules: readonly ScheduleDefinition[];
}

export interface SimulationConfigOptions {
  readonly companyId?: CompanyId;
  readonly tickDuration?: number;
  readonly startTick?: number;
  readonly maxRetries?: number;
  readonly consumerGroup?: string;
  readonly budget?: Partial<SimulationBudget>;
  readonly schedules?: readonly ScheduleDefinition[];
}

export function resolveSimulationConfig(
  options: SimulationConfigOptions,
): SimulationConfig {
  if (options.companyId === undefined) {
    throw new Error('companyId is required to resolve a simulation config');
  }
  const companyId = options.companyId;
  const tickDuration = options.tickDuration ?? 1;
  if (!Number.isInteger(tickDuration) || tickDuration <= 0) {
    throw new Error('tickDuration must be a positive integer');
  }
  const startTick = options.startTick ?? 0;
  if (!Number.isInteger(startTick) || startTick < 0) {
    throw new Error('startTick must be a non-negative integer');
  }
  const maxRetries = options.maxRetries ?? 3;
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new Error('maxRetries must be an integer >= 1');
  }
  const budget: SimulationBudget = Object.freeze({
    ...DEFAULT_SIMULATION_BUDGET,
    ...options.budget,
  });
  return Object.freeze({
    companyId,
    tickDuration,
    startTick,
    maxRetries,
    consumerGroup: options.consumerGroup ?? 'agent-turn',
    budget,
    schedules: Object.freeze([...(options.schedules ?? [])]),
  });
}

export interface AgentTurnRecord {
  readonly wakeupId: string;
  readonly cycleId: string;
  readonly employeeId: EmployeeId;
  readonly sourceEventId: string | null;
  readonly reason: string;
  readonly status: AgentCycleStatus;
  readonly retryable: boolean;
  readonly llmCalls: number;
  readonly emittedEventCount: number;
  readonly failureCode: string | null;
}

export interface SimulationBudgetSnapshot extends BudgetUsage {
  readonly exceeded: readonly BudgetReason[];
  readonly limits: SimulationBudget;
}

export interface SimulationTickResult {
  readonly tickNumber: number;
  readonly simTime: SimTime;
  readonly windowStartSim: SimTime;
  readonly deltaSim: number;
  readonly status: SimulationTickStatus;
  readonly cursorBefore: number;
  readonly cursor: number;
  readonly inputEventCount: number;
  readonly scheduledWakeupCount: number;
  readonly wakeupCount: number;
  readonly dispatchLimit: number;
  readonly turns: readonly AgentTurnRecord[];
  readonly reactorEventCount: number;
  readonly emittedEvents: readonly OrgEvent[];
  readonly budget: SimulationBudgetSnapshot;
}

export interface RecoveryReport {
  readonly cursor: number;
  readonly tickNumber: number;
  readonly taskCount: number;
  readonly workflowInstanceCount: number;
  readonly agentStateCount: number;
  readonly eventCount: number;
}
