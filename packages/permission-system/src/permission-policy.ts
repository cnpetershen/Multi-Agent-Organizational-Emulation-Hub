import type {
  Action,
  AuthorityLevel,
  DecisionDomain,
  EmployeeId,
  PositionId,
} from '@maoeh/shared-types';

export type PermissionSubject =
  | { readonly kind: 'employee'; readonly employeeId: EmployeeId }
  | { readonly kind: 'position'; readonly positionId: PositionId }
  | { readonly kind: 'any' };

export interface PermissionAuthorityThreshold {
  readonly domain: DecisionDomain;
  readonly level: AuthorityLevel;
}

export interface PermissionRule {
  readonly subject: PermissionSubject;
  readonly action: Action;
  readonly resource: string;
  readonly minAuthority?: PermissionAuthorityThreshold;
}

export interface PermissionPolicy {
  readonly grants: readonly PermissionRule[];
  readonly denies: readonly PermissionRule[];
}

export const EMPTY_POLICY: PermissionPolicy = { grants: [], denies: [] };

export function matchesResource(pattern: string, resource: string): boolean {
  if (pattern === '*' || pattern === resource) return true;
  if (pattern.endsWith('*')) return resource.startsWith(pattern.slice(0, -1));
  return false;
}

export function employeeGrant(
  employeeId: EmployeeId,
  action: Action,
  resource: string,
): PermissionRule {
  return { subject: { kind: 'employee', employeeId }, action, resource };
}

export function positionGrant(
  positionId: PositionId,
  action: Action,
  resource: string,
): PermissionRule {
  return { subject: { kind: 'position', positionId }, action, resource };
}

export function denyRule(
  subject: PermissionSubject,
  action: Action,
  resource: string,
): PermissionRule {
  return { subject, action, resource };
}
