import { describe, expect, it } from 'vitest';
import { createInMemoryEventStore } from '@maoeh/event-store';
import { createControlHarness } from '../helpers/control-fixtures';

/**
 * Deletion is asynchronous with respect to the scheduler and to the restart.
 *
 * `Task.Assigned` is written first and only wakes its assignee on the *next* tick, so an
 * operator can remove the task in between. Nothing un-writes the assignment — nor should it,
 * the fact stays on the log — but running a turn against it would report progress on work that
 * is already gone. The wakeup is settled instead of attempted.
 */
describe('M1.0 runtime: a wakeup whose work was deleted is settled, not run', () => {
  it('does not run a turn against a task deleted before the tick', async () => {
    const h = await createControlHarness();
    const injected = await h.plane.control.execute(
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
    expect(injected.status, JSON.stringify(injected.failure)).toBe('accepted');
    const taskId = h.plane.control.query.getTasks()[0]?.taskId ?? '';
    expect(taskId).not.toBe('');
    expect(h.plane.control.query.getTask(taskId)?.assigneeEmployeeId).toBe('cto-john');

    const removed = await h.plane.control.execute(
      h.command('Task.Delete', { targetId: taskId }),
    );
    expect(removed.status, JSON.stringify(removed.failure)).toBe('accepted');

    const results = await h.harness.run(1);
    const turns = results[0]?.turns ?? [];
    expect(turns).toHaveLength(1);
    expect(turns[0]?.employeeId).toBe('cto-john');
    expect(turns[0]?.status).toBe('ignored');
    expect(turns[0]?.failureCode).toBe('work_deleted');
    expect(turns[0]?.emittedEventCount).toBe(0);
    expect(turns[0]?.llmCalls).toBe(0);

    // The skipped wakeup is not a failed turn: the tick stays healthy and produces nothing.
    expect(results[0]?.status).toBe('ok');
    expect(h.plane.control.query.getTask(taskId)).toBeNull();

    // And the scheduler does not keep re-offering work that no longer exists.
    const after = await h.harness.run(2);
    expect(after.flatMap((result) => result.turns)).toEqual([]);
  });
});

/**
 * The deletion survives the restart even though every event that described the work is still
 * on the log: the fold turns `Workflow.InstanceDeleted` back into "no instance", and a recovery
 * stores only what a fold produced.
 */
describe('M1.0 deletion: recovery rebuilds nothing that was deleted', () => {
  it('keeps an instance and its tasks gone across a restart', async () => {
    const store = createInMemoryEventStore();
    const before = await createControlHarness({ eventStore: store });
    const instanceId = await before.harness.startProductAnalysis();
    const taskId =
      before.plane.control.query
        .getTasks()
        .find((task) => task.workflowInstanceId === instanceId)?.taskId ?? '';
    expect(taskId).not.toBe('');
    await before.harness.run(1);

    const removed = await before.plane.control.execute(
      before.command('Workflow.Delete', { targetId: instanceId }),
    );
    expect(removed.status, JSON.stringify(removed.failure)).toBe('accepted');

    const after = await createControlHarness({ eventStore: store });
    expect(after.simulation.recovery.workflowInstanceCount).toBe(0);
    expect(after.simulation.recovery.taskCount).toBe(0);
    expect(after.simulation.instanceStore.get(instanceId)).toBeNull();
    expect(after.simulation.taskStore.get(taskId)).toBeNull();
    expect(after.plane.control.query.getWorkflow(instanceId)).toBeNull();
    expect(after.plane.control.query.getTask(taskId)).toBeNull();
  });
});
