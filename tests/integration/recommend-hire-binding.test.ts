import { describe, expect, it } from 'vitest';
import type { CompanyId, CorrelationId, EmployeeId, SimTime, Step } from '@maoeh/shared-types';
import type { PlanExecutionContext } from '@maoeh/agent-runtime';
import type { PlanExecutor, Simulation } from '@maoeh/kernel';
import { createKernelPlanExecutor, DEFAULT_AGENT_POLICY } from '@maoeh/kernel';
import type { PermissionPolicy } from '@maoeh/permission-system';
import { DEFAULT_BUDGET, createBudgetTracker } from '@maoeh/runtime-scheduler';
import { createControlHarness, type ControlHarness } from '../helpers/control-fixtures';

/**
 * Route A, steps A1 + A2 (`docs/review/role-agents-cannot-complete-tasks.md` §9).
 *
 * `RecommendHire` used to be an empty cheque: it lives in the closed Action Space but was not
 * bound in `PLAN_ACTION_BINDINGS`, so an agent plan carrying it died with `unsupported_action`
 * — a manager who found an empty seat could do nothing about it. The binding now authorizes
 * through the kernel's own `AuthzService` (`ControlAgent` on `position:<id>`, granted at org
 * domain level ≥ 3) and materializes through the Runtime's `createAgent`, emitting the same
 * `Control.AgentCreated` fact the console's `Agent.Create` writes.
 *
 * The acceptance below pins both halves of the permission: an unqualified seat (an employee
 * below the threshold) is refused without touching the roster, and a qualified one produces
 * the event *and* the live employee — plus the subtree rule a policy pattern cannot express.
 */
function hireExecutor(h: ControlHarness): PlanExecutor {
  return createKernelPlanExecutor({
    tasks: h.simulation.tasks,
    workflow: h.simulation.workflow,
    communication: h.simulation.communication,
    collaboration: h.simulation.collaboration,
    budget: createBudgetTracker(DEFAULT_BUDGET),
    authz: h.simulation.authz,
    organization: h.simulation.organization,
    instances: h.simulation.instanceStore,
  });
}

function planContext(simulation: Simulation, employeeId: string): PlanExecutionContext {
  const correlationId = `corr-hire-${employeeId}`;
  let eventSeq = 0;
  return {
    companyId: String(simulation.organization.company.id) as CompanyId,
    actorContext: simulation.identity.actorContext(
      employeeId as EmployeeId,
      correlationId as CorrelationId,
    ),
    simTime: 0 as SimTime,
    registry: simulation.registry,
    correlationId,
    causationId: 'evt-hire-source',
    traceId: null,
    nextEventId: () => {
      eventSeq += 1;
      return `evt-hire-${String(eventSeq)}`;
    },
  };
}

function hireStep(args: Readonly<Record<string, unknown>>): Step {
  return { index: 0, action: 'RecommendHire', args, reasonRef: 0 };
}

const MANDATE = ['Ship the frontend backlog'];

/** The deferred proposal a `RecommendHire` now carries (A4): resumed once the root grants. */
const HIRE_PROPOSAL = {
  capabilities: ['frontend'],
  title: 'Ship the frontend backlog',
  goal: 'Ship the frontend backlog',
};

describe('route A A1/A4: RecommendHire opens the root approval gate', () => {
  it('parks the objectives and enters the approval chain instead of touching the roster', async () => {
    const h = await createControlHarness();
    const before = h.simulation.organization.employees.length;

    const outcome = await hireExecutor(h).execute(
      hireStep({
        positionId: 'frontend-engineer',
        employeeId: 'frontend-grace',
        name: 'Grace',
        responsibilities: MANDATE,
        traits: ['meticulous'],
        expertise: ['frontend'],
        reason: 'the frontend seat is empty',
        proposal: HIRE_PROPOSAL,
      }),
      planContext(h.simulation, 'ceo-alex'),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const types = outcome.value.map((event) => event.type);
    // The objectives are parked as one recoverable task …
    expect(types).toContain('Task.Created');
    expect(types).toContain('Task.Blocked');
    // … and the request waits in the root approval chain — no `Control.AgentCreated` (R2/R3).
    expect(types).toContain('Workflow.InstanceStarted');
    expect(types).toContain('Workflow.ApprovalRequested');
    expect(types).not.toContain('Control.AgentCreated');

    // Roster and schedulability untouched while the request is pending (R3).
    expect(h.simulation.organization.employees).toHaveLength(before);
    expect(h.simulation.agents.has('frontend-grace' as EmployeeId)).toBe(false);

    // R4: the original task never sits `assigned` with a null assignee — it is blocked, owned by
    // the requester, with a stable reason the resume/completion paths key on (R5/R8).
    const parked = h.simulation.taskStore
      .all()
      .find((task) => String(task.title) === 'Ship the frontend backlog');
    expect(parked?.status).toBe('blocked');
    expect(String(parked?.assignment.assigneeEmployeeId)).toBe('ceo-alex');
    expect(parked?.blockedReason ?? '').toMatch(/^waiting_for_approval/);

    // R1/R2: exactly one `hire-gate` instance, awaiting the root, carrying the seat and the
    // deferred proposal the kernel will resume on a grant.
    const gates = h.simulation.instanceStore
      .all()
      .filter((instance) => instance.workflowId === 'hire-gate');
    expect(gates).toHaveLength(1);
    const gate = gates[0];
    expect(gate?.status).toBe('blocked');
    expect(gate?.approval?.status).toBe('open');
    expect(String(gate?.context['originalTaskId'])).toBe(String(parked?.taskId));
    const hire = gate?.context['hire'] as Readonly<Record<string, unknown>>;
    expect(String(hire['positionId'])).toBe('frontend-engineer');
    expect(String(hire['employeeId'])).toBe('frontend-grace');
    expect(
      (gate?.context['proposal'] as Readonly<Record<string, unknown>>)['capabilities'],
    ).toEqual(['frontend']);
  });

  it('refuses a hire whose mandate is missing before the roster is touched', async () => {
    const h = await createControlHarness();
    const before = h.simulation.organization.employees.length;

    const outcome = await hireExecutor(h).execute(
      hireStep({
        positionId: 'frontend-engineer',
        employeeId: 'frontend-nobody',
        name: 'Nobody',
      }),
      planContext(h.simulation, 'ceo-alex'),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('invalid_args');
    expect(h.simulation.organization.employees).toHaveLength(before);
    expect(h.simulation.agents.has('frontend-nobody' as EmployeeId)).toBe(false);
  });
});

describe('route A A2: ControlAgent is scoped to org-domain authority and the hirer\'s subtree', () => {
  it('refuses an employee below the org threshold with NEEDS_APPROVAL, escalating to the manager', async () => {
    const h = await createControlHarness();
    const before = h.simulation.organization.employees.length;

    const outcome = await hireExecutor(h).execute(
      hireStep({
        positionId: 'frontend-engineer',
        employeeId: 'frontend-frank',
        name: 'Frank',
        responsibilities: MANDATE,
      }),
      planContext(h.simulation, 'engineer-mike'),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('NEEDS_APPROVAL');
    expect(outcome.error.issues[0]?.reason).toContain('escalateTo=cto-john');
    expect(h.simulation.organization.employees).toHaveLength(before);
    expect(h.simulation.agents.has('frontend-frank' as EmployeeId)).toBe(false);
  });

  it('still refuses a seat outside the hirer\'s reporting subtree when the grant has no threshold', async () => {
    // The threshold alone cannot express "your subtree": a permissive grant proves the walk
    // inside the binding is what stops a sideways/upward hire.
    const permissive: PermissionPolicy = {
      grants: [
        ...DEFAULT_AGENT_POLICY.grants,
        { subject: { kind: 'any' }, action: 'ControlAgent', resource: 'position:*' },
      ],
      denies: [],
    };
    const h = await createControlHarness({ agentPolicy: permissive });

    const sideways = await hireExecutor(h).execute(
      hireStep({
        positionId: 'frontend-engineer',
        employeeId: 'frontend-fay',
        name: 'Fay',
        responsibilities: MANDATE,
      }),
      planContext(h.simulation, 'engineer-mike'),
    );
    expect(sideways.ok).toBe(false);
    if (!sideways.ok) {
      expect(sideways.error.code).toBe('UNAUTHORIZED');
      expect(sideways.error.issues[0]?.field).toBe('args.positionId');
    }
    expect(
      h.simulation.organization.employees.some((entry) => String(entry.id) === 'frontend-fay'),
    ).toBe(false);

    // Downward — and into your own seat, exactly like `DispatchWork` — stays legal: the request
    // enters the approval chain rather than being refused at the subtree gate.
    const downward = await hireExecutor(h).execute(
      hireStep({
        positionId: 'engineer',
        employeeId: 'engineer-finn',
        name: 'Finn',
        responsibilities: ['Build features'],
        proposal: { capabilities: ['implementation'], title: 'Build', goal: 'Build features' },
      }),
      planContext(h.simulation, 'engineer-mike'),
    );
    expect(downward.ok).toBe(true);
    if (!downward.ok) return;
    const types = downward.value.map((event) => event.type);
    expect(types).toContain('Workflow.ApprovalRequested');
    expect(types).not.toContain('Control.AgentCreated');
    expect(
      h.simulation.organization.employees.some((entry) => String(entry.id) === 'engineer-finn'),
    ).toBe(false);
  });
});
