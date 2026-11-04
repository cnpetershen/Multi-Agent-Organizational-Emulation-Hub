import { describe, expect, it } from 'vitest';
import type { EmployeeId, OrgEvent } from '@maoeh/shared-types';
import { createInMemoryEventStore } from '@maoeh/event-store';
import { capabilityLabel } from '@maoeh/organization-model';
import { collectEvents, createControlHarness } from '../helpers/control-fixtures';

type ControlHarness = Awaited<ReturnType<typeof createControlHarness>>;

/**
 * Capability-based task assignment (M1.6): an operator can hand work to *whoever can do it*
 * instead of naming a seat, and the system records why that person was chosen.
 *
 * Pinned properties:
 *   1. `Organization.InjectTask` without a `positionId` delegates by capability and emits the
 *      `Control.DelegationDecided` fact — the decision is on the log, not in a prompt;
 *   2. `Task.AssignToAgent` re-delegates a task either to a named agent or by capability;
 *   3. every rejected assignment states which rule refused it (`INVALID_COMMAND`,
 *      `INVALID_TARGET`);
 *   4. the explanation (`assignmentReason` + `matchedCapabilities`) is log-derived state and
 *      survives a restart.
 */

function payloadOf(event: OrgEvent | undefined): Readonly<Record<string, unknown>> {
  const payload = event?.payload;
  return typeof payload === 'object' && payload !== null
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

async function injectByCapability(
  h: ControlHarness,
  requiredSkills: readonly string[],
  title: string,
  goal: string,
) {
  return h.plane.control.execute(
    h.command('Organization.InjectTask', {
      targetType: 'organization',
      targetId: 'future-ai-lab',
      extra: { title, goal, requiredSkills },
    } as never),
  );
}

async function injectBySeat(
  h: ControlHarness,
  positionId: string,
  title: string,
  goal: string,
  requiredSkills?: readonly string[],
) {
  return h.plane.control.execute(
    h.command('Organization.InjectTask', {
      targetType: 'organization',
      targetId: 'future-ai-lab',
      extra: {
        title,
        goal,
        positionId,
        ...(requiredSkills === undefined ? {} : { requiredSkills }),
      },
    } as never),
  );
}

describe('M1.6 Organization.InjectTask delegates by capability', () => {
  it('assigns to whoever covers the capability and records why, on the log', async () => {
    const h = await createControlHarness();
    const outcome = await injectByCapability(
      h,
      ['testing'],
      'Verify the release build',
      'Run the release verification suite',
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const task = h.plane.control.query.getTasks()[0];
    expect(task?.assigneeEmployeeId).toBe('qa-peter');
    expect(task?.positionId).toBe('qa');
    expect(task?.requiredSkills).toEqual(['testing']);
    expect(task?.assignmentReason).toContain('Requires');
    expect(task?.assignmentReason).toContain(capabilityLabel('testing'));
    expect(task?.assignmentReason).toContain('Peter');
    expect(task?.matchedCapabilities).toEqual(['testing']);

    // The decision is a first-class fact, in the order: created → assigned → injected → decided.
    const events = await collectEvents(h.simulation.eventStore);
    const types = events.map((event) => event.type);
    expect(types.indexOf('Task.Created')).toBeLessThan(types.indexOf('Task.Assigned'));
    expect(types.indexOf('Task.Assigned')).toBeLessThan(types.indexOf('Control.TaskInjected'));
    expect(types.indexOf('Control.TaskInjected')).toBeLessThan(
      types.indexOf('Control.DelegationDecided'),
    );

    const decided = events.find((event) => event.type === 'Control.DelegationDecided');
    expect(payloadOf(decided)).toMatchObject({
      taskId: task?.taskId,
      requiredCapabilities: ['testing'],
      assigneeEmployeeId: 'qa-peter',
      assigneePositionId: 'qa',
      rationale: task?.assignmentReason,
    });

    // And the scheduler really wakes the matched person.
    const results = await h.harness.run(1);
    expect(results[0]?.turns.map((turn) => turn.employeeId)).toEqual(['qa-peter']);
  });

  it('prefers the more specific seat when two holders tie', async () => {
    const h = await createControlHarness();
    const outcome = await injectByCapability(
      h,
      ['product_requirement'],
      'Draft the Q4 roadmap',
      'Write the Q4 product roadmap',
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    // PM seat (authority 4) beats the CEO seat (authority 5): closest qualified holder first.
    expect(h.plane.control.query.getTasks()[0]?.assigneeEmployeeId).toBe('pm-bona');
  });

  it('falls to the next candidate when the operator paused the natural one', async () => {
    const h = await createControlHarness();
    // The pause overlay is an operator decision, so it arrives as a command — the Control Plane
    // owns the overlay and mirrors it into the runtime.
    const paused = await h.plane.control.execute(
      h.command('Agent.Pause', { targetId: 'pm-bona', reason: 'seconded to the board review' }),
    );
    expect(paused.status, JSON.stringify(paused.failure)).toBe('accepted');
    expect(h.simulation.isAgentPaused('pm-bona' as EmployeeId)).toBe(true);

    const outcome = await injectByCapability(
      h,
      ['product_requirement'],
      'Draft the Q4 roadmap',
      'Write the Q4 product roadmap',
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const task = h.plane.control.query.getTasks()[0];
    expect(task?.assigneeEmployeeId).toBe('ceo-alex');
    expect(task?.assignmentReason).toContain('Alex');
    expect(task?.matchedCapabilities).toEqual(['product_requirement']);
  });

  it('refuses a capability nobody in the company covers', async () => {
    const h = await createControlHarness();
    const outcome = await injectByCapability(
      h,
      ['teleportation'],
      'Blink the build to staging',
      'Move the build without touching it',
    );
    expect(outcome.status).toBe('rejected');
    expect(outcome.failure?.code).toBe('INVALID_TARGET');
    expect(outcome.failure?.issues[0]?.field).toBe('requiredSkills');
    expect(h.plane.control.query.getTasks()).toEqual([]);
  });
});

describe('M1.6 Task.AssignToAgent re-delegates a task', () => {
  it('routes by the task capabilities when no agent is named', async () => {
    const h = await createControlHarness();
    // Routed to a seat first: the CTO seat cannot cover `testing`, so no delegation fact yet.
    const seated = await injectBySeat(h, 'cto', 'Sign off the release', 'Approve the release', [
      'testing',
    ]);
    expect(seated.status, JSON.stringify(seated.failure)).toBe('accepted');
    const seatedTask = h.plane.control.query.getTasks()[0];
    expect(seatedTask?.assigneeEmployeeId).toBe('cto-john');
    expect(seatedTask?.matchedCapabilities).toEqual([]);

    const taskId = seatedTask?.taskId ?? '';
    const outcome = await h.plane.control.execute(
      h.command('Task.AssignToAgent', { targetId: taskId }),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const task = h.plane.control.query.getTask(taskId);
    expect(task?.assigneeEmployeeId).toBe('qa-peter');
    expect(task?.positionId).toBe('qa');
    expect(task?.assignmentReason).toContain(capabilityLabel('testing'));
    expect(task?.matchedCapabilities).toEqual(['testing']);

    const events = await collectEvents(h.simulation.eventStore);
    const types = events.map((event) => event.type);
    expect(types.indexOf('Task.Assigned')).toBeLessThan(
      types.indexOf('Control.TaskAssigned'),
    );
    expect(types.indexOf('Control.TaskAssigned')).toBeLessThan(
      types.indexOf('Control.DelegationDecided'),
    );
    expect(
      types.lastIndexOf('Control.DelegationDecided'),
    ).toBeGreaterThan(types.lastIndexOf('Control.TaskAssigned'));
  });

  it('takes a named agent and explains the seat coverage behind the choice', async () => {
    const h = await createControlHarness();
    const seated = await injectBySeat(h, 'engineer', 'Fix the flaky suite', 'Stabilise the suite', [
      'testing',
    ]);
    expect(seated.status, JSON.stringify(seated.failure)).toBe('accepted');
    const taskId = h.plane.control.query.getTasks()[0]?.taskId ?? '';

    const outcome = await h.plane.control.execute(
      h.command('Task.AssignToAgent', {
        targetId: taskId,
        extra: { agentId: 'qa-peter' },
      } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const task = h.plane.control.query.getTask(taskId);
    expect(task?.assigneeEmployeeId).toBe('qa-peter');
    expect(task?.assignmentReason).toContain('operator chose Peter');
    expect(task?.matchedCapabilities).toEqual(['testing']);

    const decided = (await collectEvents(h.simulation.eventStore)).find(
      (event) => event.type === 'Control.DelegationDecided',
    );
    expect(payloadOf(decided)).toMatchObject({
      taskId,
      assigneeEmployeeId: 'qa-peter',
      rationale: task?.assignmentReason,
    });
  });

  it('states which rule refused an assignment that cannot be explained', async () => {
    const h = await createControlHarness();

    // 1. No capabilities to match on and no named agent: nothing to decide with.
    await injectBySeat(h, 'cto', 'Review the architecture', 'Review the architecture draft');
    const undecidable = h.plane.control.query.getTasks()[0]?.taskId ?? '';
    const noRule = await h.plane.control.execute(
      h.command('Task.AssignToAgent', { targetId: undecidable }),
    );
    expect(noRule.status).toBe('rejected');
    expect(noRule.failure?.code).toBe('INVALID_COMMAND');
    expect(noRule.failure?.issues[0]?.field).toBe('requiredSkills');

    // 2. A named agent that does not exist: never silently reassigned.
    const unknownAgent = await h.plane.control.execute(
      h.command('Task.AssignToAgent', {
        targetId: undecidable,
        extra: { agentId: 'nobody-at-all' },
      } as never),
    );
    expect(unknownAgent.status).toBe('rejected');
    expect(unknownAgent.failure?.code).toBe('INVALID_TARGET');
    expect(unknownAgent.failure?.issues[0]?.field).toBe('agentId');

    // 3. Capabilities no seat declares: matching must not invent a candidate.
    await injectBySeat(h, 'cto', 'Blink the build to staging', 'Move the build', [
      'teleportation',
    ]);
    const undeclarable = h.plane.control.query.getTasks().at(-1)?.taskId ?? '';
    expect(undeclarable).not.toBe(undecidable);
    const noCandidate = await h.plane.control.execute(
      h.command('Task.AssignToAgent', { targetId: undeclarable }),
    );
    expect(noCandidate.status).toBe('rejected');
    expect(noCandidate.failure?.code).toBe('INVALID_TARGET');
    expect(noCandidate.failure?.issues[0]?.field).toBe('requiredSkills');

    // Nothing was reassigned by any of the refusals.
    expect(h.plane.control.query.getTask(undecidable)?.assigneeEmployeeId).toBe('cto-john');
    expect(h.plane.control.query.getTask(undeclarable)?.assigneeEmployeeId).toBe('cto-john');
  });

  it('keeps the assignment explanation across a restart', async () => {
    const store = createInMemoryEventStore();
    const first = await createControlHarness({ eventStore: store });
    const outcome = await injectByCapability(
      first,
      ['testing'],
      'Verify the release build',
      'Run the release verification suite',
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    const taskId = first.plane.control.query.getTasks()[0]?.taskId ?? '';
    const before = first.plane.control.query.getTask(taskId);
    expect(before?.assignmentReason).not.toBeNull();

    // Restart over the same log: the console reads the same "why" back.
    const restarted = await createControlHarness({ eventStore: store });
    const after = restarted.plane.control.query.getTask(taskId);
    expect(after?.assigneeEmployeeId).toBe('qa-peter');
    expect(after?.assignmentReason).toBe(before?.assignmentReason);
    expect(after?.matchedCapabilities).toEqual(['testing']);

    // The raw task record carries the same explanation, folded from `Task.Assigned`.
    const folded = restarted.simulation.tasks.get(taskId);
    expect(folded?.assignmentReason).toBe(before?.assignmentReason);
    expect(folded?.matchedCapabilities).toEqual(['testing']);
    expect(folded?.assignment.assigneeEmployeeId).toBe('qa-peter');

    // And the decision event itself is still on the log after the replay.
    const types = (await collectEvents(store)).map((event) => event.type);
    expect(types).toContain('Control.DelegationDecided');
  });
});
