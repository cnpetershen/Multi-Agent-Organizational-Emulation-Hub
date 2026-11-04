import type {
  ActorContext,
  CorrelationId,
  DepartmentId,
  EmployeeId,
  PositionId,
} from '@maoeh/shared-types';
import { createOrgGraph } from '@maoeh/organization-model';
import type {
  Employee,
  EmployeeKind,
  EmployeeStatus,
  Organization,
} from '@maoeh/organization-model';

export interface EmployeeIdentity {
  employeeId: EmployeeId;
  employeeNo: string | null;
  name: string;
  kind: EmployeeKind | null;
  status: EmployeeStatus;
  positionId: PositionId;
  departmentId: DepartmentId | null;
}

export interface Identity {
  register(employee: Employee): EmployeeIdentity;
  resolve(employeeId: EmployeeId): EmployeeIdentity;
  resolveByEmployeeNo(employeeNo: string): EmployeeIdentity;
  actorContext(
    employeeId: EmployeeId,
    correlationId: CorrelationId,
  ): ActorContext;
}

export type IdentityErrorCode =
  | 'duplicate_employee'
  | 'unknown_employee'
  | 'unknown_employee_no'
  | 'unknown_position';

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly subject: string;

  constructor(code: IdentityErrorCode, subject: string) {
    super(`${code}: ${subject}`);
    this.name = 'IdentityError';
    this.code = code;
    this.subject = subject;
  }
}

export function createIdentity(organization: Organization): Identity {
  const graph = createOrgGraph(organization);
  const byId = new Map<EmployeeId, EmployeeIdentity>();
  const byEmployeeNo = new Map<string, EmployeeId>();

  const register = (employee: Employee): EmployeeIdentity => {
    const position = graph.getPosition(employee.positionId);
    if (position === null) {
      throw new IdentityError('unknown_position', employee.positionId);
    }
    const identity: EmployeeIdentity = {
      employeeId: employee.id,
      employeeNo: employee.employeeNo ?? null,
      name: employee.name,
      kind: employee.kind ?? null,
      status: employee.status,
      positionId: position.id,
      departmentId: position.departmentId,
    };
    if (byId.has(identity.employeeId)) {
      throw new IdentityError('duplicate_employee', identity.employeeId);
    }
    if (identity.employeeNo !== null && byEmployeeNo.has(identity.employeeNo)) {
      throw new IdentityError('duplicate_employee', identity.employeeNo);
    }
    byId.set(identity.employeeId, identity);
    if (identity.employeeNo !== null) {
      byEmployeeNo.set(identity.employeeNo, identity.employeeId);
    }
    return identity;
  };

  const resolve = (employeeId: EmployeeId): EmployeeIdentity => {
    const identity = byId.get(employeeId);
    if (identity === undefined) {
      throw new IdentityError('unknown_employee', employeeId);
    }
    return identity;
  };

  const resolveByEmployeeNo = (employeeNo: string): EmployeeIdentity => {
    const employeeId = byEmployeeNo.get(employeeNo);
    if (employeeId === undefined) {
      throw new IdentityError('unknown_employee_no', employeeNo);
    }
    return resolve(employeeId);
  };

  const actorContext = (
    employeeId: EmployeeId,
    correlationId: CorrelationId,
  ): ActorContext => {
    const identity = resolve(employeeId);
    const position = graph.getPosition(identity.positionId);
    if (position === null) {
      throw new IdentityError('unknown_position', identity.positionId);
    }
    const domains = position.decisionDomains ?? {};
    return {
      employeeId: identity.employeeId,
      positionId: position.id,
      departmentId: position.departmentId,
      authorityByDomain: {
        engineering: domains.engineering ?? 0,
        product: domains.product ?? 0,
        ops: domains.ops ?? 0,
        marketing: domains.marketing ?? 0,
        finance: domains.finance ?? 0,
        org: domains.org ?? 0,
      },
      correlationId,
    };
  };

  for (const employee of organization.employees) {
    register(employee);
  }

  return { register, resolve, resolveByEmployeeNo, actorContext };
}
