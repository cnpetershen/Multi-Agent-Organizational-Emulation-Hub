import type {
  Action,
  ActorContext,
  DecisionDomain,
  EmployeeId,
  PositionId,
} from '@maoeh/shared-types';
import type { Organization } from '@maoeh/organization-model';
import { createOrgGraph } from '@maoeh/organization-model';
import type { AuthzDecision } from './authz-decision.js';
import { ALLOW, deny, needsApproval } from './authz-decision.js';
import type {
  PermissionAuthorityThreshold,
  PermissionPolicy,
  PermissionRule,
} from './permission-policy.js';
import { EMPTY_POLICY, matchesResource } from './permission-policy.js';
import type { ResourceRef } from './resource-ref.js';

export interface AuthzContext {
  readonly domain?: DecisionDomain;
  readonly requiredRoles?: readonly string[];
  readonly amount?: number;
}

export interface PermissionEntry {
  readonly action: Action;
  readonly resource: string;
}

export interface PermissionSet {
  readonly employeeId: EmployeeId;
  readonly granted: readonly PermissionEntry[];
  readonly denied: readonly PermissionEntry[];
}

export interface AuthzService {
  can(
    actor: ActorContext,
    action: Action,
    resource: ResourceRef,
    ctx?: AuthzContext,
  ): AuthzDecision;
  effective(employeeId: EmployeeId): PermissionSet;
}

export interface AuthzServiceOptions {
  readonly organization: Organization;
  readonly policy?: PermissionPolicy;
}

const INACTIVE_EMPLOYMENT: ReadonlySet<string> = new Set([
  'suspended',
  'transferred',
  'offboarded',
]);

function subjectMatches(
  rule: PermissionRule,
  employeeId: EmployeeId,
  positionId: PositionId,
): boolean {
  if (rule.subject.kind === 'any') return true;
  if (rule.subject.kind === 'employee') return rule.subject.employeeId === employeeId;
  return rule.subject.positionId === positionId;
}

function ruleMatches(
  rule: PermissionRule,
  employeeId: EmployeeId,
  positionId: PositionId,
  action: Action,
  resource: string,
): boolean {
  return (
    rule.action === action &&
    matchesResource(rule.resource, resource) &&
    subjectMatches(rule, employeeId, positionId)
  );
}

function ruleKey(rule: PermissionRule): string {
  return `${rule.action} ${rule.resource}`;
}

export function createAuthzService(options: AuthzServiceOptions): AuthzService {
  const policy = options.policy ?? EMPTY_POLICY;
  const graph = createOrgGraph(options.organization);

  const can = (
    actor: ActorContext,
    action: Action,
    resource: ResourceRef,
    ctx?: AuthzContext,
  ): AuthzDecision => {
    if (actor.employeeId === '' || actor.positionId === '') {
      return deny('OUT_OF_SCOPE');
    }
    // The employee is resolved through the graph, which reads the live organization: an agent
    // placed at runtime (M1.3 `Agent.Create`) holds the permissions of its position immediately,
    // exactly like a seeded one. A boot-time snapshot here would silently deny every new agent.
    const employee = graph.getEmployee(actor.employeeId);
    if (employee === null) return deny('OUT_OF_SCOPE');
    if (employee.positionId !== actor.positionId) return deny('OUT_OF_SCOPE');
    if (INACTIVE_EMPLOYMENT.has(employee.status)) return deny('NO_PERMISSION');

    if (ctx?.requiredRoles !== undefined) {
      const position = graph.getPosition(employee.positionId);
      const roles = [position?.id, position?.key, position?.roleCode].filter(
        (value): value is string => typeof value === 'string' && value !== '',
      );
      const satisfied = ctx.requiredRoles.some((role) => roles.includes(role));
      if (!satisfied) return deny('OUT_OF_SCOPE');
    }

    for (const rule of policy.denies) {
      if (ruleMatches(rule, employee.id, employee.positionId, action, resource)) {
        return deny('NO_PERMISSION');
      }
    }

    let unmetThreshold: PermissionAuthorityThreshold | null = null;
    for (const rule of policy.grants) {
      if (!ruleMatches(rule, employee.id, employee.positionId, action, resource)) continue;
      const threshold = rule.minAuthority;
      if (threshold === undefined) return ALLOW;
      const level = actor.authorityByDomain[threshold.domain];
      if (level >= threshold.level) return ALLOW;
      if (unmetThreshold === null || threshold.level > unmetThreshold.level) {
        unmetThreshold = threshold;
      }
    }

    if (unmetThreshold !== null) {
      const manager = graph.getManagerOf(employee.id);
      if (manager === null) return needsApproval(unmetThreshold.level);
      return needsApproval(unmetThreshold.level, manager.id);
    }

    return deny('NO_PERMISSION');
  };

  const effective = (employeeId: EmployeeId): PermissionSet => {
    const employee = graph.getEmployee(employeeId) ?? undefined;
    const granted: PermissionEntry[] = [];
    const denied: PermissionEntry[] = [];
    const seenGranted = new Set<string>();
    const seenDenied = new Set<string>();

    if (employee !== undefined) {
      for (const rule of policy.grants) {
        if (!subjectMatches(rule, employee.id, employee.positionId)) continue;
        const key = ruleKey(rule);
        if (seenGranted.has(key)) continue;
        seenGranted.add(key);
        granted.push(Object.freeze({ action: rule.action, resource: rule.resource }));
      }
      for (const rule of policy.denies) {
        if (!subjectMatches(rule, employee.id, employee.positionId)) continue;
        const key = ruleKey(rule);
        if (seenDenied.has(key)) continue;
        seenDenied.add(key);
        denied.push(Object.freeze({ action: rule.action, resource: rule.resource }));
      }
    }

    const inactive = employee !== undefined && INACTIVE_EMPLOYMENT.has(employee.status);
    return Object.freeze({
      employeeId,
      granted: Object.freeze(inactive ? [] : granted),
      denied: Object.freeze(denied),
    });
  };

  return { can, effective };
}
