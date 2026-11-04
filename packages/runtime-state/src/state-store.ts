import type { EmployeeId, Plan, Result } from '@maoeh/shared-types';
import type { AgentState } from './agent-state.js';
import { createInitialAgentState } from './agent-state.js';

export interface CycleCheckpoint {
  readonly cycleId: string;
  readonly stepIndex: number;
  readonly employeeId: EmployeeId;
  readonly plan: Plan;
  readonly authorizedPlan: Plan;
  readonly stepResults: readonly unknown[];
  readonly idempotencyKeys: readonly string[];
}

export type CheckpointInput = Omit<CycleCheckpoint, 'cycleId'>;

export interface StateVersionConflict {
  readonly code: 'VERSION_CONFLICT';
  readonly actualVersion: number;
}

export interface StateStore {
  load(employeeId: EmployeeId): AgentState;
  commit(state: AgentState, expectedVersion: number): Result<void, StateVersionConflict>;
  checkpoint(cycleId: string, step: CheckpointInput): void;
  loadLatestCheckpoint(cycleId: string): CycleCheckpoint | null;
}

export function createInMemoryStateStore(): StateStore {
  const states = new Map<EmployeeId, AgentState>();
  const checkpoints = new Map<string, Map<number, CycleCheckpoint>>();

  return {
    load(employeeId) {
      return states.get(employeeId) ?? createInitialAgentState(employeeId);
    },
    commit(state, expectedVersion) {
      const stored = states.get(state.employeeId) ?? createInitialAgentState(state.employeeId);
      if (stored.version !== expectedVersion) {
        return { ok: false, error: { code: 'VERSION_CONFLICT', actualVersion: stored.version } };
      }
      states.set(state.employeeId, state);
      return { ok: true, value: undefined };
    },
    checkpoint(cycleId, step) {
      let cycle = checkpoints.get(cycleId);
      if (cycle === undefined) {
        cycle = new Map<number, CycleCheckpoint>();
        checkpoints.set(cycleId, cycle);
      }
      cycle.set(step.stepIndex, { ...step, cycleId });
    },
    loadLatestCheckpoint(cycleId) {
      const cycle = checkpoints.get(cycleId);
      if (cycle === undefined) return null;
      let latest: CycleCheckpoint | null = null;
      for (const checkpoint of cycle.values()) {
        if (latest === null || checkpoint.stepIndex > latest.stepIndex) latest = checkpoint;
      }
      return latest;
    },
  };
}
