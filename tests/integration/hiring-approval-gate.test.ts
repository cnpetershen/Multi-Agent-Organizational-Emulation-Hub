import { describe, expect, it } from 'vitest';
import type { Organization } from '@maoeh/organization-model';
import type { Row } from '../../apps/web/src/api';
import { hiringRequests } from '../../apps/web/src/hiring';
import { deterministicCognitionText } from '../../apps/api/src/deterministic-cognition';
import {
  collectEvents,
  createControlHarness,
  loadSeedOrganizationWithOperators,
} from '../helpers/control-fixtures';

/**
 * A4 (`docs/review/role-agents-cannot-complete-tasks.md` §9): a `RecommendHire` is a *request*.
 * The binding never fills the seat — it parks the original objectives in a blocked task and opens
 * the root approval gate (`hire-gate`); the kernel's deterministic pass applies the decision.
 *
 * This file pins the decision outcomes the road-map calls out:
 *
 * 1. **Pending** — no roster change, no null assignee, the objectives stay recoverable.
 * 2. **Granted** — the employee materializes once, the original task resumes, and the deferred
 *    proposal is routed so its work lands on the new employee (assignment follows the router).
 * 3. **Rejected** — no agent is created and the original task is reopened with a
 *    `needs_human_decision` reason, so the board sees why the work stopped.
 * 4. **Duplicate** — a repeated request, a second decision or a replay never produces a second
 *    employee, gate or roster event.
 */
function toStarterOrganization(organization: Organization): Organization {
  const rootPositions = new Set(
    organization.positions
      .filter((position) => position.reportsToPositionId === null)
      .map((position) => String(position.id)),
  );
  organization.employees = organization.employees.filter((employee) =>
    rootPositions.has(String(employee.positionId)),
  );
  return organization;
}

async function runToIdle(
  harness: Awaited<ReturnType<typeof createControlHarness>>,
  maxTicks = 30,
): Promise<void> {
  for (let index = 0; index < maxTicks; index += 1) {
    const result = await harness.simulation.tick();
    if (result.status === 'idle') return;
  }
}

/** The starter company: only the CEO is staffed, so a delivery brief must recommend a hire. */
async function pendingHarness() {
  const organization = toStarterOrganization(loadSeedOrganizationWithOperators());
  const harness = await createControlHarness({
    organization,
    definitionsForRosterOnly: true,
    llmText: deterministicCognitionText,
  });
  const started = await harness.plane.control.execute(harness.command('Simulation.Start'));
  expect(started.status, JSON.stringify(started.failure)).toBe('accepted');
  const submitted = await harness.plane.control.execute(
    harness.command('Work.SubmitBrief', {
      targetId: 'ceo-alex',
      reason: 'board wants tetris and needs somebody to build it',
      workBrief: {
        title: '开发一个俄罗斯方块程序',
        goal: '前端Web SPA 后端用python，后端用来记录每次排名和得分',
        verificationKeys: ['多用户在线运行'],
      },
    } as never),
  );
  expect(submitted.status, JSON.stringify(submitted.failure)).toBe('accepted');
  await runToIdle(harness);
  return { harness, organization };
}

function hiringGate(simulation: Awaited<ReturnType<typeof createControlHarness>>['simulation']) {
  return simulation.instanceStore
    .all()
    .find((instance) => instance.workflowId === 'hire-gate');
}

describe('A4 hiring approval gate', () => {
  it('pending: the roster stands still and the objectives wait in a recoverable blocked task', async () => {
    const { harness, organization } = await pendingHarness();
    const events = await collectEvents(harness.simulation.eventStore);
    const types = events.map((event) => event.type);

    expect(types).toContain('Workflow.ApprovalRequested');
    expect(types).not.toContain('Control.AgentCreated');
    expect(organization.employees.map((employee) => String(employee.id))).not.toContain(
      'engineer-hire',
    );

    const gate = hiringGate(harness.simulation);
    expect(gate?.status).toBe('blocked');
    expect(gate?.approval?.status).toBe('open');

    const parked = harness.simulation.taskStore
      .all()
      .find((task) => (task.blockedReason ?? '').startsWith('waiting_for_approval'));
    expect(parked?.status).toBe('blocked');
    expect(String(parked?.assignment.assigneeEmployeeId)).toBe('ceo-alex');
    // R4: never `assigned` with a null assignee — the precondition of the original defect.
    for (const task of harness.simulation.taskStore.all()) {
      if (task.status === 'assigned') {
        expect(task.assignment.assigneeEmployeeId).not.toBeNull();
      }
    }
  });

  it('granted: the employee materializes once, the objectives resume and the router assigns the work', async () => {
    const { harness, organization } = await pendingHarness();
    const gate = hiringGate(harness.simulation);

    const approved = await harness.plane.control.execute(
      harness.command('Workflow.Approve', {
        targetType: 'workflow',
        targetId: String(gate?.instanceId),
        reason: 'board approves the hire',
      }),
    );
    expect(approved.status, JSON.stringify(approved.failure)).toBe('accepted');
    await runToIdle(harness, 40);

    const events = await collectEvents(harness.simulation.eventStore);
    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === 'Control.AgentCreated')).toHaveLength(1);
    expect(organization.employees.map((employee) => String(employee.id))).toContain(
      'engineer-hire',
    );

    const resumed = harness.simulation.instanceStore
      .all()
      .find(
        (instance) =>
          instance.workflowId !== 'hire-gate' &&
          instance.context['resumedFor'] === String(gate?.instanceId),
      );
    expect(resumed, 'the deferred proposal runs as a workflow instance').toBeDefined();
    const routed = harness.simulation.taskStore
      .all()
      .filter((task) => task.workflowInstanceId === String(resumed?.instanceId));
    expect(routed.length).toBeGreaterThan(0);
    for (const task of routed) {
      expect(task.assignment.assigneeEmployeeId).toBe('engineer-hire');
    }

    // The held placeholder is retired once the resume owns the objectives: it shares the brief's
    // `correlationId`, so leaving it open — even unblocked, as it used to be — would pin the
    // brief's progress below 100% forever (the reported "still stuck" symptom).
    expect(
      harness.simulation.taskStore
        .all()
        .some((task) => (task.blockedReason ?? '').startsWith('waiting_for_approval')),
    ).toBe(false);

    // R9: a repeated recommendation (the brief re-submitted) and a repeated decision change
    // nothing — the live gate already records the seat, and the employee already exists.
    const resubmitted = await harness.plane.control.execute(
      harness.command('Work.SubmitBrief', {
        targetId: 'ceo-alex',
        reason: 'board repeats the tetris brief',
        workBrief: {
          title: '开发一个俄罗斯方块程序',
          goal: '前端Web SPA 后端用python，后端用来记录每次排名和得分',
          verificationKeys: ['多用户在线运行'],
        },
      } as never),
    );
    expect(resubmitted.status, JSON.stringify(resubmitted.failure)).toBe('accepted');
    await runToIdle(harness, 40);

    const secondDecision = await harness.plane.control.execute(
      harness.command('Workflow.Approve', {
        targetType: 'workflow',
        targetId: String(gate?.instanceId),
        reason: 'board approves again',
      }),
    );
    expect(['accepted', 'rejected']).toContain(secondDecision.status);

    const after = await collectEvents(harness.simulation.eventStore);
    expect(
      after.filter((event) => event.type === 'Control.AgentCreated'),
      'a duplicate request or decision never hires twice',
    ).toHaveLength(1);
    expect(
      after.filter(
        (event) =>
          event.type === 'Workflow.InstanceStarted' &&
          String(event.payload['workflowId']) === 'hire-gate',
      ),
    ).toHaveLength(1);
  });

  it('rejected: no agent is created and the objectives reopen for a human decision', async () => {
    const { harness, organization } = await pendingHarness();
    const before = organization.employees.length;
    const gate = hiringGate(harness.simulation);

    const rejected = await harness.plane.control.execute(
      harness.command('Workflow.Reject', {
        targetType: 'workflow',
        targetId: String(gate?.instanceId),
        reason: 'board declines the request',
      }),
    );
    expect(rejected.status, JSON.stringify(rejected.failure)).toBe('accepted');
    await runToIdle(harness, 40);

    const events = await collectEvents(harness.simulation.eventStore);
    const types = events.map((event) => event.type);
    expect(types).toContain('Workflow.ApprovalDenied');
    expect(types, 'a rejected hire creates no agent (R7)').not.toContain('Control.AgentCreated');
    expect(organization.employees).toHaveLength(before);
    expect(organization.employees.map((employee) => String(employee.id))).not.toContain(
      'engineer-hire',
    );

    // R8: the original task is not left silently blocked-as-pending — it reopens with the
    // rejection reason so the board knows a human has to decide.
    const parked = harness.simulation.taskStore
      .all()
      .find((task) => (task.blockedReason ?? '').startsWith('needs_human_decision'));
    expect(parked?.status).toBe('blocked');
    expect(parked?.blockedReason ?? '').toContain('rejected');
    expect(
      harness.simulation.taskStore
        .all()
        .some((task) => (task.blockedReason ?? '').startsWith('waiting_for_approval')),
    ).toBe(false);
  });

  it('replay: recovering the log rebuilds the gate and the roster without duplicating anything', async () => {
    const { harness, organization } = await pendingHarness();
    const gate = hiringGate(harness.simulation);

    const approved = await harness.plane.control.execute(
      harness.command('Workflow.Approve', {
        targetType: 'workflow',
        targetId: String(gate?.instanceId),
        reason: 'board approves the hire',
      }),
    );
    expect(approved.status, JSON.stringify(approved.failure)).toBe('accepted');
    await runToIdle(harness, 40);

    const hired = organization.employees.filter(
      (employee) => String(employee.id) === 'engineer-hire',
    );
    expect(hired).toHaveLength(1);

    // R10: the log is the source of truth — replaying it rebuilds the same single hire, the gate
    // and the resumed instance, and never appends a second `Control.AgentCreated`.
    const report = await harness.simulation.recover();
    expect(report).toBeDefined();

    const after = await collectEvents(harness.simulation.eventStore);
    expect(after.filter((event) => event.type === 'Control.AgentCreated')).toHaveLength(1);
    expect(
      organization.employees.filter((employee) => String(employee.id) === 'engineer-hire'),
      'recovery never duplicates a roster entry',
    ).toHaveLength(1);
    expect(
      harness.simulation.instanceStore
        .all()
        .filter((instance) => instance.workflowId === 'hire-gate'),
    ).toHaveLength(1);
    expect(
      harness.simulation.instanceStore
        .all()
        .some((instance) => instance.context['resumedFor'] === String(gate?.instanceId)),
    ).toBe(true);
  });
});

/**
 * A5: the console derives hiring purely from the read models it already polls. These two checks
 * feed the *real* control-plane projections (`/api/workflows` full views + `/api/work-briefs`)
 * through the web derivation, proving the pages see Pending → Approved on a grant and Rejected
 * on a denial — without a second hiring state machine, and without ever reading the event log.
 */
function workflowViews(harness: Awaited<ReturnType<typeof createControlHarness>>): readonly Row[] {
  const query = harness.plane.control.query;
  return query
    .getWorkflows()
    .map((summary) => query.getWorkflow(summary.instanceId) ?? summary) as unknown as readonly Row[];
}

async function briefRows(
  harness: Awaited<ReturnType<typeof createControlHarness>>,
): Promise<readonly Row[]> {
  return (await harness.plane.control.query.listWorkBriefs()) as unknown as readonly Row[];
}

describe('A5 hiring read model feeds the console', () => {
  it('shows Pending while the gate is open, then Approved once the root grants', async () => {
    const { harness } = await pendingHarness();
    let requests = hiringRequests(workflowViews(harness), await briefRows(harness));

    expect(requests).toHaveLength(1);
    const pending = requests[0];
    expect(pending?.status).toBe('pending');
    expect(pending?.seatId).toBe('engineer');
    expect(pending?.seatTitle).toBe('Software Engineer');
    expect(pending?.rationale).toContain('engineer');
    expect(pending?.requesterId).toContain('ceo');
    expect(pending?.relatedTasks.length).toBeGreaterThan(0);

    const gate = hiringGate(harness.simulation);
    const approved = await harness.plane.control.execute(
      harness.command('Workflow.Approve', {
        targetType: 'workflow',
        targetId: String(gate?.instanceId),
        reason: 'board approves the hire',
      }),
    );
    expect(approved.status, JSON.stringify(approved.failure)).toBe('accepted');
    await runToIdle(harness, 40);

    requests = hiringRequests(workflowViews(harness), await briefRows(harness));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.status).toBe('approved');
    // The person who joined is on the roster the console reads — the Agents page needs nothing new.
    expect(
      harness.simulation.organization.employees.some(
        (employee) => String(employee.id) === 'engineer-hire',
      ),
    ).toBe(true);
  });

  it('shows Rejected, with no agent on the roster, when the root declines', async () => {
    const { harness } = await pendingHarness();
    const gate = hiringGate(harness.simulation);
    const rejected = await harness.plane.control.execute(
      harness.command('Workflow.Reject', {
        targetType: 'workflow',
        targetId: String(gate?.instanceId),
        reason: 'board declines the request',
      }),
    );
    expect(rejected.status, JSON.stringify(rejected.failure)).toBe('accepted');
    await runToIdle(harness, 40);

    const requests = hiringRequests(workflowViews(harness), await briefRows(harness));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.status).toBe('rejected');
    expect(
      harness.simulation.organization.employees.some(
        (employee) => String(employee.id) === 'engineer-hire',
      ),
    ).toBe(false);
  });
});
