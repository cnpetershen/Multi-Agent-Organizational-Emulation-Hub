import { describe, expect, it } from 'vitest';
import type { CorrelationId, EmployeeId, PositionId } from '@maoeh/shared-types';
import type { Employee, Organization } from '@maoeh/organization-model';
import type { PermissionPolicy } from '@maoeh/permission-system';
import { createAuthzService, denyRule, positionGrant } from '@maoeh/permission-system';
import { createAuthorityService } from '@maoeh/authority-engine';
import { createIdentity } from '@maoeh/identity-system';
import type { ControlCommand, ControlCommandType } from '@maoeh/organization-control';
import {
  CONTROL_COMMAND_TYPES,
  EMPTY_CONTROL_POLICY,
  checkAuthority,
  controlPolicyForPosition,
  createControlAuthorizer,
} from '@maoeh/organization-control';
import {
  NO_CONTROL_POLICY,
  OPERATOR_EMPLOYEE_ID,
  OPERATOR_POSITION_ID,
  OTHER_OPERATOR_EMPLOYEE_ID,
  createControlHarness,
  loadSeedOrganizationWithOperators,
  observerControlPolicy,
  operatorControlPolicy,
} from '../../helpers/control-fixtures';
import type { ControlHarness } from '../../helpers/control-fixtures';

/** Structurally valid payloads so each command under test fails on authorization, not shape. */
const VALID_PAYLOAD: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  'Simulation.Seek': Object.freeze({ tickNumber: 1 }),
  // M1.3: creating an agent needs identity, placement and a mandate before authorization runs.
  'Agent.Create': Object.freeze({
    employeeId: 'qa-priya',
    name: 'Priya',
    positionId: 'qa',
    responsibilities: Object.freeze(['test_strategy']),
  }),
  'Agent.Instruct': Object.freeze({ instruction: 'review the brief' }),
  'Agent.CancelTask': Object.freeze({ taskId: 'task-unknown' }),
  'Agent.RequestReview': Object.freeze({ taskId: 'task-unknown' }),
  'Task.Reassign': Object.freeze({ positionId: 'engineer' }),
  'Organization.InjectTask': Object.freeze({
    title: 'injected title',
    goal: 'injected goal',
    positionId: 'ceo',
  }),
  // M1.8: whole-batch per-instance override — structurally valid means a non-empty override list.
  'Workflow.InstanceAssignmentOverride': Object.freeze({
    overrides: Object.freeze([
      Object.freeze({ stepId: 'requirements', employeeId: 'cpo-maria' }),
    ]),
  }),
  'Organization.InjectEvent': Object.freeze({
    eventType: 'Operation.Note',
    subjectId: 'future-ai-lab',
    payload: Object.freeze({}),
  }),
  // M1.4: the work brief's verification is mandatory (Q3), so a valid payload carries it.
  'Work.SubmitBrief': Object.freeze({
    workBrief: Object.freeze({
      title: 'Ship the login feature',
      goal: 'Deliver a minimal login endpoint',
      context: 'operator-supplied context',
      verificationKeys: Object.freeze(['endpoint']),
      priority: 3,
      dueAtSim: null,
    }),
  }),
});

function commandFor(
  h: ControlHarness,
  commandType: ControlCommandType,
  payload: Readonly<Record<string, unknown>> = {},
): ControlCommand {
  return h.command(commandType, {
    extra: { ...(VALID_PAYLOAD[commandType] ?? {}), ...payload },
  } as never);
}

const danaActor = Object.freeze({
  operatorId: OPERATOR_EMPLOYEE_ID as EmployeeId,
  displayName: 'Dana',
  positionId: OPERATOR_POSITION_ID,
  kind: 'human' as const,
});

describe('M1.0 control plane: authorization', () => {
  it('fails closed for every command type when the operator holds no grant', async () => {
    const denied = await createControlHarness({ policy: NO_CONTROL_POLICY });
    // 20 M1.0/M1.2 commands + `Agent.Create` / `Agent.Archive` (M1.3 lifecycle) +
    // `Task.AssignToAgent` (M1.6 capability delegation) +
    // `Workflow.Delete` / `Task.Delete` (removal) + `Work.SubmitBrief` (M1.4 briefs) +
    // `Workflow.InstanceAssignmentOverride` (M1.8 per-instance override) + `Workflow.ConfirmStart`
    // (M1.9 draft confirmation): the surface grows, the fail-closed rule does not.
    expect(CONTROL_COMMAND_TYPES).toHaveLength(28);

    for (const commandType of CONTROL_COMMAND_TYPES) {
      const outcome = await denied.plane.control.execute(commandFor(denied, commandType));
      expect(outcome.status, `${commandType}: ${JSON.stringify(outcome.failure)}`).toBe('rejected');
      expect(outcome.failure?.code, commandType).toBe('UNAUTHORIZED');
      expect(outcome.failure?.issues[0]?.field, commandType).toBe('permission');
    }

    expect(denied.simulation.scheduler.paused).toBe(false);
    expect(denied.simulation.scheduler.clock.currentTick).toBe(0);
  });

  it('rejects an unknown operator id as UNAUTHENTICATED', async () => {
    const h = await createControlHarness();
    const outcome = await h.plane.control.execute(
      h.command('Simulation.Pause', {
        actor: {
          operatorId: 'ghost-operator' as EmployeeId,
          displayName: 'Ghost',
          positionId: OPERATOR_POSITION_ID,
          kind: 'human',
        },
      } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('rejected');
    expect(outcome.failure?.code).toBe('UNAUTHENTICATED');
    expect(outcome.failure?.issues[0]?.field).toBe('actor.operatorId');
  });

  it('rejects an operator who claims a position they do not occupy as OUT_OF_SCOPE', async () => {
    const h = await createControlHarness();
    const outcome = await h.plane.control.execute(
      h.command('Simulation.Pause', {
        actor: { ...danaActor, positionId: 'ceo' },
      } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('rejected');
    expect(outcome.failure?.code).toBe('OUT_OF_SCOPE');
    expect(outcome.failure?.issues[0]?.field).toBe('actor.positionId');
    expect(h.simulation.scheduler.paused).toBe(false);
  });

  it('scopes grants to the position, not to the operator in general', async () => {
    const h = await createControlHarness({ policy: observerControlPolicy() });

    const byOperator = await h.plane.control.execute(h.command('Simulation.Pause'));
    expect(byOperator.status, JSON.stringify(byOperator.failure)).toBe('rejected');
    expect(byOperator.failure?.code).toBe('UNAUTHORIZED');

    const byObserver = await h.plane.control.execute(
      h.command('Simulation.Pause', { actor: h.observer() }),
    );
    expect(byObserver.status, JSON.stringify(byObserver.failure)).toBe('accepted');
    expect(h.simulation.scheduler.paused).toBe(true);
  });

  it('applies deny-overrides: an explicit deny beats a matching grant', async () => {
    const policy: PermissionPolicy = {
      grants: [positionGrant(OPERATOR_POSITION_ID as PositionId, 'ControlSimulation', '*')],
      denies: [
        denyRule({ kind: 'position', positionId: OPERATOR_POSITION_ID as PositionId }, 'ControlSimulation', '*'),
      ],
    };
    const h = await createControlHarness({ policy });
    const outcome = await h.plane.control.execute(h.command('Simulation.Pause'));
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('rejected');
    expect(outcome.failure?.code).toBe('UNAUTHORIZED');
    expect(h.simulation.scheduler.paused).toBe(false);
  });

  it('honours a minAuthority threshold: L5 passes, L1 is refused with requiredAuthority', async () => {
    const policy: PermissionPolicy = {
      grants: [
        {
          subject: { kind: 'any' },
          action: 'ControlSimulation',
          resource: '*',
          minAuthority: { domain: 'org', level: 5 },
        },
      ],
      denies: [],
    };
    // board-operator holds org:5, board-observer holds org:1 — same command, different authority.
    const l5 = await createControlHarness({ policy });
    const accepted = await l5.plane.control.execute(l5.command('Simulation.Pause'));
    expect(accepted.status, JSON.stringify(accepted.failure)).toBe('accepted');
    expect(l5.simulation.scheduler.paused).toBe(true);

    const l1 = await createControlHarness({ policy });
    const refused = await l1.plane.control.execute(
      l1.command('Simulation.Pause', { actor: l1.observer() }),
    );
    expect(refused.status, JSON.stringify(refused.failure)).toBe('rejected');
    // The existing AuthzService answered NEEDS_APPROVAL (allowed in principle, but below the
    // required level); the control plane keeps that distinction instead of flattening it to
    // UNAUTHORIZED, and carries the missing level so the caller can escalate.
    expect(refused.failure?.code).toBe('NEEDS_APPROVAL');
    expect(refused.failure?.requiredAuthority).toBe(5);
    expect(l1.simulation.scheduler.paused).toBe(false);
  });

  it('refuses a suspended operator before any permission is consulted', async () => {
    const base = loadSeedOrganizationWithOperators();
    const employees: Employee[] = base.employees.map((employee): Employee =>
      employee.id === OPERATOR_EMPLOYEE_ID ? { ...employee, status: 'suspended' } : employee,
    );
    const suspendedOrganization: Organization = { ...base, employees };
    const h = await createControlHarness({ org: suspendedOrganization });

    const outcome = await h.plane.control.execute(h.command('Simulation.Pause'));
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('rejected');
    // Observed: UNAUTHENTICATED, not UNAUTHORIZED. The identity/legitimacy pre-flight
    // (validateActorLegitimacy) refuses non-executable employment before AuthzService.can()
    // is consulted, so a suspended operator is fail-closed one step earlier than the grant
    // check. Reported to the lead as a spec/implementation mismatch.
    expect(outcome.failure?.code).toBe('UNAUTHENTICATED');
    expect(outcome.failure?.issues[0]?.field).toBe('actor.employeeId');
    expect(outcome.failure?.issues[0]?.reason).toContain('suspended');
  });

  it('exposes createControlAuthorizer and checkAuthority as the single authority path', async () => {
    const h = await createControlHarness();
    const identity = createIdentity(h.organization);
    const authorizer = createControlAuthorizer({
      organization: h.organization,
      companyId: 'future-ai-lab',
      authz: createAuthzService({ organization: h.organization, policy: operatorControlPolicy() }),
      authority: createAuthorityService(h.organization),
    });
    const context = identity.actorContext(
      OPERATOR_EMPLOYEE_ID as EmployeeId,
      'corr-direct' as CorrelationId,
    );

    expect(checkAuthority(context, 'org', 5)).toBeNull();
    expect(authorizer.authorityLevelFor(OPERATOR_EMPLOYEE_ID as EmployeeId, 'org')).toBe(5);
    expect(authorizer.can(context, 'ControlSimulation', 'simulation:future-ai-lab').allow).toBe(true);

    const granted = authorizer.authorize(context, commandFor(h, 'Simulation.Pause'));
    expect(granted.ok, JSON.stringify(granted)).toBe(true);
    if (granted.ok) {
      expect(granted.value.kind).toBe('employee');
      expect(granted.value.context.employeeId).toBe(OPERATOR_EMPLOYEE_ID);
    }

    const observerContext = identity.actorContext(
      OTHER_OPERATOR_EMPLOYEE_ID as EmployeeId,
      'corr-direct' as CorrelationId,
    );
    const belowThreshold = checkAuthority(observerContext, 'org', 5);
    expect(belowThreshold?.code).toBe('UNAUTHORIZED');
    expect(belowThreshold?.requiredAuthority).toBe(5);
    expect(belowThreshold?.issues[0]?.field).toBe('authority');

    const starved = createControlAuthorizer({
      organization: h.organization,
      companyId: 'future-ai-lab',
      authz: createAuthzService({ organization: h.organization, policy: EMPTY_CONTROL_POLICY }),
      authority: createAuthorityService(h.organization),
    });
    const refused = starved.authorize(context, commandFor(h, 'Simulation.Pause'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('UNAUTHORIZED');
  });

  it('accepts a genuine human Employee occupying a real Position', async () => {
    const h = await createControlHarness();
    const dana = h.organization.employees.find((employee) => employee.id === OPERATOR_EMPLOYEE_ID);
    expect(dana?.kind).toBe('human');
    expect(dana?.status).toBe('active');
    expect(dana?.positionId).toBe(OPERATOR_POSITION_ID);
    expect(h.organization.positions.map((position) => position.id)).toContain(OPERATOR_POSITION_ID);
    // The AI employees are a different kind of member: humans are not a synthetic bypass.
    expect(
      h.organization.employees
        .filter((employee) => employee.kind === 'human')
        .map((employee) => employee.id),
    ).toContain(OPERATOR_EMPLOYEE_ID);
    expect(h.organization.employees.find((employee) => employee.id === 'ceo-alex')?.kind).not.toBe(
      'human',
    );

    expect(h.operator().operatorId).toBe(dana?.id);
    expect(h.operator().positionId).toBe(dana?.positionId);
    expect(h.operator().kind).toBe('human');

    const outcome = await h.plane.control.execute(h.command('Simulation.Start'));
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    expect(h.simulation.scheduler.clock.currentTick).toBe(1);
  });

  it('has no bypass: an empty policy blocks Start and InjectEvent too', async () => {
    const denied = await createControlHarness({ policy: NO_CONTROL_POLICY });

    const start = await denied.plane.control.execute(denied.command('Simulation.Start'));
    expect(start.status, JSON.stringify(start.failure)).toBe('rejected');
    expect(start.failure?.code).toBe('UNAUTHORIZED');
    expect(denied.simulation.scheduler.clock.currentTick).toBe(0);

    const inject = await denied.plane.control.execute(commandFor(denied, 'Organization.InjectEvent'));
    expect(inject.status, JSON.stringify(inject.failure)).toBe('rejected');
    expect(inject.failure?.code).toBe('UNAUTHORIZED');
    expect(denied.plane.control.query.getTasks()).toHaveLength(0);
  });

  it('keeps a per-position policy composable with a second granted position', async () => {
    const policy: PermissionPolicy = {
      grants: [
        ...controlPolicyForPosition(OPERATOR_POSITION_ID).grants,
        ...controlPolicyForPosition('ceo').grants,
      ],
      denies: [],
    };
    const h = await createControlHarness({ policy });

    const byCeo = await h.plane.control.execute(
      h.command('Agent.Pause', {
        targetId: 'ceo-alex',
        actor: {
          operatorId: 'ceo-alex' as EmployeeId,
          displayName: 'Alex',
          positionId: 'ceo',
          kind: 'employee',
        },
      } as never),
    );
    expect(byCeo.status, JSON.stringify(byCeo.failure)).toBe('accepted');
    expect(h.plane.control.query.getAgentRuntimeState('ceo-alex' as EmployeeId)?.paused).toBe(true);
  });
});
