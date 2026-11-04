import type {
  Action,
  ActorContext,
  AuthorityLevel,
  DecisionDomain,
  EmployeeId,
  PositionId,
  Result,
} from '@maoeh/shared-types';
import type { AuthorityService } from '@maoeh/authority-engine';
import { levelForContext } from '@maoeh/authority-engine';
import type { Organization } from '@maoeh/organization-model';
import type { AuthzDecision, AuthzService, CommandActor, PermissionPolicy } from '@maoeh/permission-system';
import { employeeActor, resourceRef } from '@maoeh/permission-system';

import {
  CONTROL_ACTION_BY_COMMAND,
  CONTROL_DOMAIN_BY_COMMAND,
  controlResourceOf,
  type ControlCommand,
  type ControlFailure,
} from './types.js';

export interface ControlAuthorizer {
  authorize(context: ActorContext, command: ControlCommand): Result<CommandActor, ControlFailure>;
  authorityLevelFor(employeeId: EmployeeId, domain: DecisionDomain): AuthorityLevel;
  can(actor: ActorContext, action: Action, resource: string): AuthzDecision;
}

export interface ControlAuthorizerOptions {
  readonly organization: Organization;
  readonly companyId: string;
  readonly authz: AuthzService;
  readonly authority: AuthorityService;
}

/**
 * A control policy must be granted explicitly. There is no implicit "operator is admin"
 * branch anywhere in this package — authority is always delegated to `AuthzService.can`.
 */
export const EMPTY_CONTROL_POLICY: PermissionPolicy = Object.freeze({
  grants: Object.freeze([]),
  denies: Object.freeze([]),
});

/** Grants every control action to one position, with no authority threshold. */
export function controlPolicyForPosition(
  positionId: string,
  actions: readonly Action[] = [
    'ControlSimulation',
    'ControlAgent',
    'ControlWorkflow',
    'ControlTask',
    'InjectOrganizationInput',
  ],
): PermissionPolicy {
  return Object.freeze({
    grants: Object.freeze(
      actions.map((action) =>
        Object.freeze({
          subject: Object.freeze({
            kind: 'position' as const,
            positionId: positionId as PositionId,
          }),
          action,
          resource: '*',
        }),
      ),
    ),
    denies: Object.freeze([]),
  });
}

/** Default operator policy: all control actions for the `board-operator` position. */
export function defaultControlPolicy(): PermissionPolicy {
  return controlPolicyForPosition('board-operator');
}

export function createControlAuthorizer(options: ControlAuthorizerOptions): ControlAuthorizer {
  const { authz, authority, companyId } = options;

  const authorize = (
    context: ActorContext,
    command: ControlCommand,
  ): Result<CommandActor, ControlFailure> => {
    const action = CONTROL_ACTION_BY_COMMAND[command.commandType];
    if (action === undefined) {
      return {
        ok: false,
        error: {
          code: 'INVALID_COMMAND',
          issues: [
            {
              field: 'commandType',
              reason: `no control action is registered for "${command.commandType}"`,
            },
          ],
        },
      };
    }

    const domain = CONTROL_DOMAIN_BY_COMMAND[command.commandType];
    const resource = controlResourceOf(command, companyId);
    const decision = authz.can(context, action as Action, resourceRef(resource), { domain });

    if (decision.allow) {
      return {
        ok: true,
        value: employeeActor(context),
      };
    }

    return { ok: false, error: toFailure(decision, action, resource) };
  };

  return {
    authorize,
    authorityLevelFor: (employeeId, domain) => authority.levelFor(employeeId, domain),
    can: (actor, action, resource) => authz.can(actor, action, resourceRef(resource)),
  };
}

export function toFailure(
  decision: Extract<AuthzDecision, { readonly allow: false }>,
  action: string,
  resource: string,
): ControlFailure {
  // The existing AuthzService already distinguishes "you may not" from
  // "you may, but not at your level — ask this person". Preserve that distinction so the
  // Control Plane can expose an approval inbox instead of burying the escalation.
  const code: ControlFailure['code'] =
    decision.reason === 'NEEDS_APPROVAL'
      ? 'NEEDS_APPROVAL'
      : decision.reason === 'OUT_OF_SCOPE'
        ? 'OUT_OF_SCOPE'
        : 'UNAUTHORIZED';
  const parts = [`${action} on ${resource}: ${decision.reason}`];
  if (decision.requiredAuthority !== undefined) {
    parts.push(`requiredAuthority=${String(decision.requiredAuthority)}`);
  }
  if (decision.escalateTo !== undefined) {
    parts.push(`escalateTo=${String(decision.escalateTo)}`);
  }
  return {
    code,
    issues: [{ field: 'permission', reason: parts.join(' ') }],
    ...(decision.requiredAuthority === undefined
      ? {}
      : { requiredAuthority: decision.requiredAuthority }),
    ...(decision.escalateTo === undefined ? {} : { escalateTo: decision.escalateTo as EmployeeId }),
  };
}

/**
 * Optional authority gate. Returns `null` when satisfied; the requirement is derived from
 * the actor's own authority snapshot, so `authority-engine` stays the single source of truth.
 */
export function checkAuthority(
  context: ActorContext,
  domain: DecisionDomain,
  minimum: AuthorityLevel,
): ControlFailure | null {
  const level = levelForContext(context, domain);
  if (level >= minimum) return null;
  return {
    code: 'UNAUTHORIZED',
    issues: [
      {
        field: 'authority',
        reason: `authority ${String(level)} in domain "${domain}" is below the required ${String(minimum)}`,
      },
    ],
    requiredAuthority: minimum,
  };
}
