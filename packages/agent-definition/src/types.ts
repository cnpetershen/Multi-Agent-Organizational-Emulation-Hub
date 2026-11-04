import type { DepartmentId, EmployeeId, PositionId } from '@maoeh/shared-types';

export interface AgentIdentity {
  readonly name: string;
  readonly description?: string;
  readonly traits: readonly string[];
}

export type AgentCapabilities = Readonly<Record<string, readonly string[]>>;

export interface MemoryPolicy {
  readonly retain: readonly string[];
}

export interface ToolPolicy {
  readonly allowed: readonly string[];
}

export interface AgentDefinition {
  readonly id: string;
  readonly employeeId: EmployeeId;
  readonly positionId: PositionId;
  readonly departmentId?: DepartmentId;
  readonly identity: AgentIdentity;
  readonly responsibilities: readonly string[];
  readonly capabilities: AgentCapabilities;
  readonly cognitionProfileId: string;
  readonly memoryPolicy: MemoryPolicy;
  readonly toolPolicy: ToolPolicy;
}
