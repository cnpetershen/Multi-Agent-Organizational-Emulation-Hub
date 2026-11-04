import { describe, expect, it } from 'vitest';
import type { EmployeeId, OrgEvent } from '@maoeh/shared-types';

import { collectEvents, createControlHarness, type ControlHarness } from '../../helpers/control-fixtures';

/**
 * Deletion is a read-side mask, not a hole in the log (the same contract
 * `BACKGROUND_EVENT_TYPE_PREFIXES` already holds for the clock markers): the activity panels
 * must stop naming work that is gone — tombstones included — while `getEventStream`, the
 * audit trail and the event store keep every event, so recovery and the operator's paper
 * trail are untouched.
 */

async function storedEvents(h: ControlHarness): Promise<readonly OrgEvent[]> {
  return collectEvents(h.simulation.eventStore);
}

/** Inject a standalone task through the documented control command. */
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

/** The instance plus every task it owned, captured before the removal. */
async function seedWorkflowAndSurvivor(h: ControlHarness): Promise<{
  readonly instanceId: string;
  readonly ownedTaskIds: readonly string[];
  readonly survivorId: string;
}> {
  const instanceId = await h.harness.startProductAnalysis();
  const survivorId = await injectStandaloneTask(h, 'survivor');
  const ownedTaskIds = h.plane.control.query
    .getTasks()
    .filter((task) => task.workflowInstanceId === instanceId)
    .map((task) => task.taskId);
  expect(ownedTaskIds.length).toBeGreaterThan(0);
  const outcome = await h.plane.control.execute(
    h.command('Workflow.Delete', { targetId: instanceId }),
  );
  expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
  return { instanceId, ownedTaskIds, survivorId };
}

function aboutRemoval(
  events: readonly { readonly subjectId: string | null }[],
  removed: ReadonlySet<string>,
): readonly { readonly subjectId: string | null }[] {
  return events.filter((event) => event.subjectId !== null && removed.has(event.subjectId));
}

function payloadOf(payload: unknown): Readonly<Record<string, unknown>> {
  return typeof payload === 'object' && payload !== null
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

describe('M1.0 activity view: removed work leaves the feed, not the log', () => {
  it('never names the deleted instance or its tasks in getRecentEvents', async () => {
    const h = await createControlHarness();
    const { instanceId, ownedTaskIds, survivorId } = await seedWorkflowAndSurvivor(h);
    const removed = new Set([instanceId, ...ownedTaskIds]);

    const recent = await h.plane.control.query.getRecentEvents({ limit: 1000 });

    expect(aboutRemoval(recent, removed)).toEqual([]);
    const types = recent.map((event) => event.type);
    expect(types).not.toContain('Workflow.InstanceStarted');
    expect(types).not.toContain('Workflow.InstanceDeleted');
    expect(types).not.toContain('Control.WorkflowDeleted');
    expect(types).not.toContain('Control.TaskDeleted');
    // The mask is bounded: work that still exists keeps its history.
    expect(recent.some((event) => event.subjectId === survivorId)).toBe(true);
    expect(types).toContain('Control.TaskInjected');
    expect(types).toContain('Task.Created');
  });

  it('leaves the raw log, the snapshot and the audit trail complete', async () => {
    const h = await createControlHarness();
    const { instanceId, ownedTaskIds } = await seedWorkflowAndSurvivor(h);
    const removed = new Set([instanceId, ...ownedTaskIds]);
    const before = await storedEvents(h);

    // Raw by default: audits, pagination and recovery-style inspection still see everything.
    const raw = await h.plane.control.query.getEventStream({ limit: 1000 });
    expect(raw.map((event) => event.type)).toContain('Workflow.InstanceDeleted');
    expect(aboutRemoval(raw, removed).length).toBeGreaterThan(0);
    expect(raw).toHaveLength(before.length);

    const snapshot = await h.plane.control.query.getOrganizationSnapshot();
    expect(aboutRemoval(snapshot.recentEvents, removed)).toEqual([]);

    const audits = h.plane.control.query.getRecentAudits(50);
    expect(
      audits.some((entry) => entry.actionType === 'Workflow.Delete' && entry.verdict === 'accepted'),
    ).toBe(true);

    // Reading the view never mutates the log.
    expect(await storedEvents(h)).toHaveLength(before.length);
  });

  it('brings the history back for a caller who asks with includeDeleted', async () => {
    const h = await createControlHarness();
    const { instanceId, ownedTaskIds } = await seedWorkflowAndSurvivor(h);
    const removed = new Set([instanceId, ...ownedTaskIds]);

    const withDeleted = await h.plane.control.query.getRecentEvents({
      limit: 1000,
      includeDeleted: true,
    });
    expect(aboutRemoval(withDeleted, removed).length).toBeGreaterThan(0);
    expect(withDeleted.map((event) => event.type)).toContain('Workflow.InstanceDeleted');
    expect(withDeleted.some((event) => event.subjectId === instanceId)).toBe(true);

    // The raw stream is equally willing to mask, but only when told to.
    const masked = await h.plane.control.query.getEventStream({ limit: 1000, includeDeleted: false });
    expect(aboutRemoval(masked, removed)).toEqual([]);
    expect(masked.length).toBeLessThan(withDeleted.length);
  });

  it('keeps an agent activity feed from naming work that is gone', async () => {
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();
    const task = h.plane.control.query
      .getTasks()
      .find((summary) => summary.workflowInstanceId === instanceId);
    if (task === undefined) throw new Error('the workflow has no task to brief a review on');
    const agentId = 'engineer-mike';

    // A review request is filed against the agent, so it sits in that agent's feed while
    // naming the task it is about — the one shape where an agent's own history outlives the
    // work it describes.
    const review = await h.plane.control.execute(
      h.command('Agent.RequestReview', { targetId: agentId, extra: { taskId: task.taskId } } as never),
    );
    expect(review.status, JSON.stringify(review.failure)).toBe('accepted');
    const before = await h.plane.control.query.getAgentActivity(agentId as EmployeeId);
    expect(before.entries.some((entry) => payloadOf(entry.event.payload)['taskId'] === task.taskId)).toBe(true);

    const removal = await h.plane.control.execute(
      h.command('Workflow.Delete', { targetId: instanceId }),
    );
    expect(removal.status, JSON.stringify(removal.failure)).toBe('accepted');

    const removed = new Set([instanceId, task.taskId]);
    const after = await h.plane.control.query.getAgentActivity(agentId as EmployeeId);
    expect(
      after.entries.some((entry) => payloadOf(entry.event.payload)['taskId'] === task.taskId),
      'the agent feed still names a task that no longer exists',
    ).toBe(false);
    for (const entry of after.entries) {
      expect(removed.has(entry.event.subjectId ?? ''), entry.event.type).toBe(false);
    }
    expect(after.entries.length).toBeLessThan(before.entries.length);
  });
});
