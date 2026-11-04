import { describe, expect, it } from 'vitest';
import type { Seq } from '@maoeh/event-store';
import type { OrgEvent } from '@maoeh/shared-types';
import {
  CONTROL_TASK_DELETED,
  CONTROL_WORKFLOW_DELETED,
} from '@maoeh/organization-control';
import { createControlHarness } from '../../helpers/control-fixtures';
import type { ControlHarness } from '../../helpers/control-fixtures';

/**
 * `Task.Delete` and `Workflow.Delete` are the only commands that remove state instead of
 * changing it, so they earn their own file: what they take with them, what they leave behind,
 * and the fact they still write to the log afterwards.
 */

function payloadOf(event: OrgEvent | undefined): Readonly<Record<string, unknown>> {
  const payload = event?.payload;
  return typeof payload === 'object' && payload !== null
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

async function storedEvents(h: ControlHarness): Promise<readonly OrgEvent[]> {
  const collected: OrgEvent[] = [];
  for await (const event of h.simulation.eventStore.replay(1 as Seq)) collected.push(event);
  return collected;
}

/** Inject a standalone task (no workflow) through the documented control command. */
async function injectStandaloneTask(h: ControlHarness, title: string): Promise<string> {
  const outcome = await h.plane.control.execute(
    h.command('Organization.InjectTask', {
      extra: { title, goal: `goal for ${title}`, positionId: 'ceo' },
    } as never),
  );
  expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
  const task = h.plane.control.query.getTasks().find((summary) => summary.title === title);
  if (task === undefined) throw new Error(`injected task "${title}" is not visible`);
  return task.taskId;
}

describe('M1.0 control plane: deletion', () => {
  it('Workflow.Delete takes the instance and every task it owns, and says so on the log', async () => {
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();
    const survivorTaskId = await injectStandaloneTask(h, 'survivor');
    const ownedTaskIds = h.plane.control.query
      .getTasks()
      .filter((task) => task.workflowInstanceId === instanceId)
      .map((task) => task.taskId);
    expect(ownedTaskIds.length).toBeGreaterThan(0);

    const outcome = await h.plane.control.execute(
      h.command('Workflow.Delete', { targetId: instanceId }),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    expect(h.plane.control.query.getWorkflow(instanceId)).toBeNull();
    for (const taskId of ownedTaskIds) {
      expect(h.plane.control.query.getTask(taskId), taskId).toBeNull();
    }
    // The cascade is bounded: it removes the instance's work, not the company's.
    expect(h.plane.control.query.getTask(survivorTaskId)).not.toBeNull();

    const events = await storedEvents(h);
    const types = events.map((event) => event.type);
    expect(types).toContain('Task.Deleted');
    expect(types).toContain('Workflow.InstanceDeleted');
    expect(types).toContain(CONTROL_WORKFLOW_DELETED);
    const control = events.find((event) => event.type === CONTROL_WORKFLOW_DELETED);
    expect(payloadOf(control)).toMatchObject({ commandId: outcome.commandId, instanceId });
    const instanceDeleted = events.find((event) => event.type === 'Workflow.InstanceDeleted');
    expect(payloadOf(instanceDeleted)).toMatchObject({ instanceId, taskIds: ownedTaskIds });

    const record = h.audit.find(outcome.commandId);
    expect(record?.verdict).toBe('accepted');
    expect(record?.eventIds).toEqual(outcome.events);
  });

  it('Task.Delete on workflow work removes the whole instance with it', async () => {
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();
    const taskId = h.plane.control.query
      .getTasks()
      .find((task) => task.workflowInstanceId === instanceId)?.taskId;
    if (taskId === undefined) throw new Error('the workflow has no task to delete');

    const outcome = await h.plane.control.execute(h.command('Task.Delete', { targetId: taskId }));
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    // One deliverable and the stream that produced it are a single unit of cleanup.
    expect(h.plane.control.query.getTask(taskId)).toBeNull();
    expect(h.plane.control.query.getWorkflow(instanceId)).toBeNull();

    const events = await storedEvents(h);
    expect(events.map((event) => event.type)).toContain(CONTROL_TASK_DELETED);
    expect(events.map((event) => event.type)).toContain('Workflow.InstanceDeleted');
    const control = events.find((event) => event.type === CONTROL_TASK_DELETED);
    expect(payloadOf(control)).toMatchObject({ commandId: outcome.commandId, taskId });
  });

  it('Task.Delete on standalone work leaves the rest of the organization alone', async () => {
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();
    const doomed = await injectStandaloneTask(h, 'doomed');
    const kept = await injectStandaloneTask(h, 'kept');

    const outcome = await h.plane.control.execute(h.command('Task.Delete', { targetId: doomed }));
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    expect(h.plane.control.query.getTask(doomed)).toBeNull();
    expect(h.plane.control.query.getTask(kept)).not.toBeNull();
    expect(h.plane.control.query.getWorkflow(instanceId)).not.toBeNull();

    const events = await storedEvents(h);
    // Nothing cascaded, so no workflow fact was invented to explain a removal that did not happen.
    expect(events.map((event) => event.type)).not.toContain('Workflow.InstanceDeleted');
    expect(events.map((event) => event.type)).toContain(CONTROL_TASK_DELETED);
  });

  it('rejects a deletion that names work the organization does not have as NOT_FOUND', async () => {
    const h = await createControlHarness();

    const workflow = await h.plane.control.execute(
      h.command('Workflow.Delete', { targetId: 'instance-ghost' }),
    );
    expect(workflow.status, JSON.stringify(workflow.failure)).toBe('rejected');
    expect(workflow.failure?.code).toBe('NOT_FOUND');

    const task = await h.plane.control.execute(
      h.command('Task.Delete', { targetId: 'task-ghost' }),
    );
    expect(task.status, JSON.stringify(task.failure)).toBe('rejected');
    expect(task.failure?.code).toBe('NOT_FOUND');

    // A refusal must not remove anything: both records are still fictional.
    const types = (await storedEvents(h)).map((event) => event.type);
    expect(types).not.toContain('Task.Deleted');
    expect(types).not.toContain('Workflow.InstanceDeleted');
  });
});
