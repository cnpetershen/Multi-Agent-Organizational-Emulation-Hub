import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import { collectEvents, createControlHarness } from '../helpers/control-fixtures';

function payloadOf(event: OrgEvent | undefined): Readonly<Record<string, unknown>> {
  const payload = event?.payload;
  return typeof payload === 'object' && payload !== null
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

/**
 * Regression for the M1.0 runtime defect found by dogfooding (report D2):
 *
 * `Organization.InjectTask` only called `TaskService.create()`. No `Task.Assigned` was emitted,
 * so the scheduler never woke the target position and the injected work was invisible to the
 * organization — contradicting M1.0 §9.4 ("写入正常任务流，由 Scheduler 唤醒").
 */
describe('M1.0 regression: Organization.InjectTask dispatches the task to its position', () => {
  it('assigns the task to the position holder and wakes them', async () => {
    const h = await createControlHarness();
    const outcome = await h.plane.control.execute(
      h.command('Organization.InjectTask', {
        targetType: 'organization',
        targetId: 'future-ai-lab',
        extra: {
          positionId: 'cto',
          title: 'Audit the deploy pipeline',
          goal: 'Find the slowest stage of the deploy pipeline',
        },
      } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const task = h.plane.control.query.getTasks()[0];
    expect(task?.positionId).toBe('cto');
    expect(task?.status).toBe('assigned');
    expect(task?.assigneeEmployeeId).toBe('cto-john');

    const types = (await collectEvents(h.simulation.eventStore)).map((event) => event.type);
    expect(types).toContain('Task.Created');
    expect(types).toContain('Task.Assigned');

    // The scheduler really picks the injected work up on the next tick.
    const results = await h.harness.run(1);
    expect(results[0]?.turns.map((turn) => turn.employeeId)).toEqual(['cto-john']);
    const assignedEvent = (await collectEvents(h.simulation.eventStore)).find(
      (event) => event.type === 'Task.Assigned',
    );
    expect(results[0]?.turns[0]?.sourceEventId).toBe(assignedEvent?.eventId);
  });

  /**
   * M1.0.1 K2 — the standalone lifecycle really ends.
   *
   * A task that belongs to no workflow used to rest at `submitted` forever: the executor may not
   * verify its own work and nothing else owned the completion. It is now settled by the kernel
   * reactor on the task's own verification rule, through `TaskService.complete()`.
   */
  it('settles the standalone task to completed once its result verifies', async () => {
    const h = await createControlHarness();
    await h.plane.control.execute(
      h.command('Organization.InjectTask', {
        targetType: 'organization',
        targetId: 'future-ai-lab',
        extra: {
          positionId: 'cto',
          title: 'Audit the deploy pipeline',
          goal: 'Find the slowest stage of the deploy pipeline',
        },
      } as never),
    );

    await h.harness.run(1);
    const taskId = h.plane.control.query.getTasks()[0]?.taskId ?? '';
    const observed = h.plane.control.query.getTask(taskId);
    expect(observed?.status).toBe('completed');
    expect(observed?.completedAtSim).not.toBeNull();
    const settled = h.simulation.tasks.get(taskId);
    expect(settled?.result).not.toBeNull();
    expect(settled?.result?.producedBy).toBe('cto-john');

    // The whole standalone lifecycle is on the record.
    const events = await collectEvents(h.simulation.eventStore);
    const lifecycle = events
      .filter(
        (event) =>
          event.type.startsWith('Task.') && payloadOf(event)['taskId'] === taskId,
      )
      .map((event) => event.type);
    expect(lifecycle).toEqual([
      'Task.Created',
      'Task.Assigned',
      'Task.Accepted',
      'Task.Started',
      'Task.ProgressReported',
      'Task.Completed',
    ]);

    // Completion went through the deterministic kernel actor, never through the executor itself
    // (which is what `TaskService.complete()` forbids).
    const completed = events.find((event) => event.type === 'Task.Completed');
    expect(completed?.actorKind).toBe('system');
    expect(completed?.actorId).toBe('kernel-reactor');

    // Nothing further happens: no follow-up work, no loop.
    const after = await h.harness.run(2);
    expect(after.flatMap((result) => result.turns)).toEqual([]);
    expect(after[1]?.status).toBe('idle');
  });

  it('leaves a standalone task submitted when its declared verification does not pass', async () => {
    const h = await createControlHarness();
    // A task that declares required output keys the executor does not produce.
    const created = h.simulation.tasks.create({
      actor: h.harness.actor('operator-dana'),
      simTime: h.simulation.scheduler.clock.simTime,
      title: 'Write the migration plan',
      goal: 'Produce a migration plan',
      assignment: { kind: 'position', positionId: 'cto' },
      verification: { kind: 'deterministic', requiredOutputKeys: ['migration_steps'] },
      maxAttempts: 1,
    });
    expect(created.ok, JSON.stringify(created.ok ? null : created.error)).toBe(true);
    if (!created.ok) return;
    const taskId = created.value.task.taskId;
    const assigned = h.simulation.tasks.assign({
      taskId,
      actor: h.harness.actor('operator-dana'),
      simTime: h.simulation.scheduler.clock.simTime,
    });
    expect(assigned.ok, JSON.stringify(assigned.ok ? null : assigned.error)).toBe(true);
    // The task service returns events; the caller (here: the test, like any kernel consumer)
    // appends them so the scheduler can see the assignment.
    await h.simulation.inject([...created.value.events, ...assigned.value.events]);

    await h.harness.run(1);
    const task = h.simulation.tasks.get(taskId);
    // The submitted result is missing `migration_steps`, so the rule does not pass: the task is
    // left exactly where the lifecycle put it instead of being force-completed.
    expect(task?.status).toBe('submitted');
    expect(task?.result).not.toBeNull();
    expect(
      (await collectEvents(h.simulation.eventStore)).filter(
        (event) => event.type === 'Task.Completed',
      ),
    ).toEqual([]);
  });

  it('leaves the assignee empty for an unstaffed position (documented §11.7 behaviour)', async () => {
    const h = await createControlHarness();
    const outcome = await h.plane.control.execute(
      h.command('Organization.InjectTask', {
        targetType: 'organization',
        targetId: 'future-ai-lab',
        extra: {
          positionId: 'backend-engineer',
          title: 'Draft the backend charter',
          goal: 'Describe the backend mandate',
        },
      } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const task = h.plane.control.query.getTasks()[0];
    expect(task?.positionId).toBe('backend-engineer');
    expect(task?.assigneeEmployeeId).toBeNull();

    // Nobody is woken, and the simulation stays healthy rather than looping.
    const results = await h.harness.run(2);
    expect(results.flatMap((result) => result.turns)).toEqual([]);
    expect(results[1]?.status).toBe('idle');
  });
});
