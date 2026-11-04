import { describe, expect, it } from 'vitest';
import type { Organization } from '@maoeh/organization-model';
import { deterministicCognitionText } from '../../apps/api/src/deterministic-cognition';
import {
  collectEvents,
  createControlHarness,
  loadSeedOrganizationWithOperators,
} from '../helpers/control-fixtures';

/**
 * A work brief in the company shape the console actually creates: `seed: starter` — the full
 * org chart with only the CEO on the roster (`toStarterOrganization`, `apps/api/src/composition.ts`).
 *
 * This is the company the reported symptom came from, and the shape every existing acceptance
 * test misses: `tests/acceptance/game-mandate-deliverable.test.ts` runs the *lab* seed, where an
 * `engineer` is on the roster, so the brief could never expose the defect below.
 *
 * The defect: `Control.WorkBriefed` used to pick its own seats — the two least-loaded ones off
 * the whole chart, which in a company that has not hired yet are empty seats. `TaskService`
 * assigned the work with `assigneeEmployeeId: null`, `eligibleAgentsFor` refuses to wake anybody
 * for an assignment with no assignee (`apps/kernel/src/simulation/eligibility.ts`), and the task
 * sat `assigned` forever. The board saw "work dispatched"; nothing was ever produced.
 *
 * The contract this pins: **a dispatched work item always has an owner who can execute it.**
 * A seat with nobody in it must never be handed work — the planner does not name seats at all,
 * and the capability router only resolves to staffed seats (with vacant-seat escalation).
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
}async function runToIdle(
  harness: Awaited<ReturnType<typeof createControlHarness>>,
  maxTicks = 12,
): Promise<void> {
  for (let index = 0; index < maxTicks; index += 1) {
    const result = await harness.simulation.tick();
    if (result.status === 'idle') return;
  }
}

describe('starter company · a work brief never creates work nobody can execute', () => {
  it('creates no stranded task when every capability seat is vacant', async () => {
    const organization = toStarterOrganization(loadSeedOrganizationWithOperators());
    // The premise of the scenario: on the AI side of the chart, only the CEO is on the roster.
    // (`operator-dana` / `operator-erin` are the human board positions the control-plane fixtures
    // add; they provide no delivery capability and never appear in a capability plan.)
    const aiRoster = organization.employees
      .filter((employee) => !String(employee.id).startsWith('operator-'))
      .map((employee) => String(employee.id));
    expect(aiRoster).toEqual(['ceo-alex']);
    for (const capability of ['implementation', 'frontend', 'backend', 'testing']) {
      const seats = organization.positions.filter((position) =>
        (position.capabilities ?? []).includes(capability),
      );
      for (const seat of seats) {
        expect(
          organization.employees.some(
            (employee) => String(employee.positionId) === String(seat.id),
          ),
          `the premise is that ${capability} seats are empty, but ${String(seat.id)} is staffed`,
        ).toBe(false);
      }
    }

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
        reason: 'board wants tetris',
        workBrief: {
          title: '开发一个俄罗斯方块程序',
          goal: '前端Web SPA 后端用python，后端用来记录每次排名和得分',
          verificationKeys: ['多用户在线运行'],
        },
      } as never),
    );
    expect(submitted.status, JSON.stringify(submitted.failure)).toBe('accepted');

    await runToIdle(harness);

    const tasks = harness.simulation.taskStore.all();
    const unowned = tasks.filter((task) => task.assignment.assigneeEmployeeId === null);
    expect(
      unowned.map((task) => `${task.taskId}@${task.assignment.positionId}`),
      'a dispatched item with no assignee is work that will never be done',
    ).toEqual([]);

    // The regression in full: no item may sit on a seat nobody holds, and no item may sit
    // `assigned` with no executor while the run has gone idle.
    const staffedSeats = new Set(organization.employees.map((employee) => String(employee.positionId)));
    for (const task of tasks) {
      expect(staffedSeats.has(String(task.assignment.positionId))).toBe(true);
      if (task.status === 'assigned') {
        expect(task.assignment.assigneeEmployeeId).not.toBeNull();
      }
    }

    // And the specific seats the defect picked must never appear: they are empty in this company.
    const positions = tasks.map((task) => String(task.assignment.positionId));
    expect(positions).not.toContain('agent-engineer');
    expect(positions).not.toContain('ai-engineer');

    // The brief itself is still a durable fact on the log, whatever the routing outcome.
    const events = await collectEvents(harness.simulation.eventStore);
    expect(events.map((event) => event.type)).toContain('Control.WorkBriefed');
  });

  it('carries the brief verification keys into a task only when a seat can actually answer them', async () => {
    // Counter-case on the lab seed: a staffed `engineer` seat exists, so the brief is real work.
    // Free-text acceptance keys are not field names, so the generated workflow must not turn
    // them into `requiredOutputKeys` — doing that made the deliverable structurally impossible
    // (it would answer `{"多用户在线运行": "..."}` with no artifact at all).
    const harness = await createControlHarness({
      organization: loadSeedOrganizationWithOperators(),
      llmText: deterministicCognitionText,
    });
    const started = await harness.plane.control.execute(harness.command('Simulation.Start'));
    expect(started.status, JSON.stringify(started.failure)).toBe('accepted');

    const submitted = await harness.plane.control.execute(
      harness.command('Work.SubmitBrief', {
        targetId: 'ceo-alex',
        reason: 'board wants the tetris game',
        workBrief: {
          title: '开发一个俄罗斯方块程序',
          goal: '前端Web SPA 后端用python，后端用来记录每次排名和得分',
          verificationKeys: ['多用户在线运行'],
        },
      } as never),
    );
    expect(submitted.status, JSON.stringify(submitted.failure)).toBe('accepted');

    await runToIdle(harness, 20);

    const tasks = harness.simulation.taskStore.all();
    expect(tasks.length).toBeGreaterThan(0);

    // Every created item has an executor, and the brief is not answered by naming the sentence.
    for (const task of tasks) {
      expect(task.assignment.assigneeEmployeeId).not.toBeNull();
      const keys = task.verification?.requiredOutputKeys ?? [];
      expect(keys).not.toContain('多用户在线运行');
    }
  });

  it('holds the hire behind the root gate, then staffs the seat and lands the work on it (A3/A4)', async () => {
    // A3/A4 (`role-agents-cannot-complete-tasks.md` §9): in this company the brief's capabilities
    // — implementation / frontend / backend — sit only on vacant seats, and the one staffed
    // seat (the CEO's own) is the dispatcher the router excludes. The proposal alone therefore
    // has nobody to assign its work to, so the cognition turn recommends a hire — and A4 makes
    // that recommendation a *request*: the objectives are parked, the root decides, and only a
    // grant fills the seat and re-runs the deferred proposal against the new roster.
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

    await runToIdle(harness, 20);

    // Pending: the request is on the root chain, the roster stands still and the objectives wait
    // in one blocked task — nothing is staffed, nothing is lost (R2/R3/R4/R5).
    let events = await collectEvents(harness.simulation.eventStore);
    let types = events.map((event) => event.type);
    expect(types).toContain('Control.WorkBriefed');
    expect(types).toContain('Workflow.ApprovalRequested');
    expect(types, 'no hire before the root grants').not.toContain('Control.AgentCreated');
    expect(organization.employees.map((employee) => String(employee.id))).not.toContain(
      'engineer-hire',
    );

    const gates = harness.simulation.instanceStore
      .all()
      .filter((instance) => instance.workflowId === 'hire-gate');
    expect(gates, 'exactly one hiring gate').toHaveLength(1);
    const gate = gates[0];
    expect(gate?.approval?.status).toBe('open');

    const parked = harness.simulation.taskStore
      .all()
      .find((task) => (task.blockedReason ?? '').startsWith('waiting_for_approval'));
    expect(parked?.status).toBe('blocked');
    expect(String(parked?.assignment.assigneeEmployeeId)).toBe('ceo-alex');

    // The root grants the hire; the kernel applies the decision deterministically.
    const approved = await harness.plane.control.execute(
      harness.command('Workflow.Approve', {
        targetType: 'workflow',
        targetId: String(gate?.instanceId),
        reason: 'board approves the hire',
      }),
    );
    expect(approved.status, JSON.stringify(approved.failure)).toBe('accepted');

    await runToIdle(harness, 40);

    events = await collectEvents(harness.simulation.eventStore);
    types = events.map((event) => event.type);
    const hire = events.find((event) => event.type === 'Control.AgentCreated');
    expect(hire, 'the granted hire materializes the employee').toBeDefined();
    // The hire names the seat that covers the whole brief (implementation + frontend + backend),
    // never the seats the old defect picked — and it happens exactly once (R9).
    expect(String(hire?.payload['positionId'])).toBe('engineer');
    expect(String(hire?.payload['agentId'])).toBe('engineer-hire');
    expect(
      types.filter((type) => type === 'Control.AgentCreated'),
      'one seat covers every needed capability, so exactly one hire',
    ).toHaveLength(1);

    // The roster actually changed: the new employee exists and can carry the work.
    expect(organization.employees.map((employee) => String(employee.id))).toContain(
      'engineer-hire',
    );

    // The original objectives resumed as the deferred proposal, routed against the staffed seat:
    // every task the resumed workflow created sits on `engineer` with the new owner.
    const resumed = harness.simulation.instanceStore
      .all()
      .find(
        (instance) =>
          instance.workflowId !== 'hire-gate' &&
          instance.context['resumedFor'] === String(gate?.instanceId),
      );
    expect(resumed, 'the deferred proposal runs as a workflow instance').toBeDefined();
    const routedTasks = harness.simulation.taskStore
      .all()
      .filter((task) => task.workflowInstanceId === String(resumed?.instanceId));
    expect(routedTasks.length).toBeGreaterThan(0);
    for (const task of routedTasks) {
      expect(String(task.assignment.positionId)).toBe('engineer');
      expect(task.assignment.assigneeEmployeeId).toBe('engineer-hire');
    }

    // And the original placeholder is retired, not left open: its objectives moved into the
    // routed work, and a task lingering under the brief's `correlationId` would pin the brief's
    // progress below 100% forever — the reported "still stuck" symptom.
    expect(
      harness.simulation.taskStore.get(String(parked?.taskId)),
      'the held placeholder is retired once the resume owns the objectives',
    ).toBeNull();

    // The resumed proposal runs to completion, and the newly hired employee delivers the *game*:
    // the company that started with only a CEO ends this brief with a playable Tetris page.
    await runToIdle(harness, 80);
    const finished = harness.simulation.instanceStore.get(String(resumed?.instanceId));
    expect(finished?.status).toBe('completed');
    const delivered = harness.simulation.taskStore
      .all()
      .filter((task) => task.workflowInstanceId === String(resumed?.instanceId));
    expect(delivered.length).toBeGreaterThan(0);
    for (const task of delivered) {
      expect(task.status, `${String(task.taskId)} did not complete`).toBe('completed');
    }
    const playable = delivered.some((task) => {
      const data = task.result?.data as Readonly<Record<string, unknown>> | undefined;
      return (
        typeof data?.['content'] === 'string' &&
        String(data['content']).includes('<canvas id="board"')
      );
    });
    expect(playable, 'the delivered artifact is the playable game, not a placeholder').toBe(true);

    // The user-visible contract: the brief reaches 完成. Every task under its `correlationId`
    // completed — including no lingering held placeholder pinning it below 100%.
    const brief = (await harness.plane.control.query.listWorkBriefs()).find(
      (row) => row.title === '开发一个俄罗斯方块程序',
    );
    expect(brief, 'the brief is on the log').toBeDefined();
    expect(brief?.counts.total).toBeGreaterThan(0);
    expect(
      brief?.counts.completed,
      'the brief cannot be stuck at "in progress" once its work is done',
    ).toBe(brief?.counts.total);
  });
});
