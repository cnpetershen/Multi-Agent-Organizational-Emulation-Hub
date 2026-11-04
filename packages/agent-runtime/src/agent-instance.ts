import type { EmployeeId, SimTime } from '@maoeh/shared-types';
import type { AgentState } from '@maoeh/runtime-state';

export interface AgentInstance {
  readonly id: string;
  readonly definitionId: string;
  readonly employeeId: EmployeeId;
  readonly state: AgentState;
  readonly createdAtSim: SimTime;
}

export interface AgentInstantiateIssue {
  readonly field: string;
  readonly reason: string;
}

export interface AgentInstantiateFailure {
  readonly issues: readonly AgentInstantiateIssue[];
}
