import type { DepartmentId, EmployeeId, PositionId, Result } from '@maoeh/shared-types';

export interface ResolvedIdentity {
  readonly employeeId: EmployeeId;
  readonly positionId: PositionId;
  readonly departmentId: DepartmentId | null;
}

export interface IdentityResolutionFailure {
  readonly code: 'unknown_employee';
  readonly employeeId: string;
}

export interface CommunicationIdentity {
  resolve(employeeId: EmployeeId): Result<ResolvedIdentity, IdentityResolutionFailure>;
}

export function createResolvedIdentity(input: {
  readonly employeeId: EmployeeId;
  readonly positionId: PositionId;
  readonly departmentId?: DepartmentId | null;
}): ResolvedIdentity {
  return Object.freeze({
    employeeId: input.employeeId,
    positionId: input.positionId,
    departmentId: input.departmentId ?? null,
  });
}
