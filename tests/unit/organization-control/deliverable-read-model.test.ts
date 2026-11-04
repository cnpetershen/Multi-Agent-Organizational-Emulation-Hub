import { describe, expect, it } from 'vitest';
import type { ControlCommand } from '@maoeh/organization-control';

import { createControlHarness, type ControlHarness } from '../../helpers/control-fixtures';
import { sim } from '../../helpers/workflow-fixtures';

/**
 * M1.4 Deliverables: the read model behind the CEO workspace.
 *
 * The workspace lists tasks from the snapshot summary, and the *result* view reads one task
 * through `ControlQuery.getTask()` (served as `GET /api/tasks/:id`). Two properties matter and
 * are pinned here:
 *
 * 1. `TaskView.result` carries what the executor actually submitted — the summary, the
 *    structured deliverable data and the artifact references the task's `outputs` are folded
 *    from — so the console renders a delivery instead of inventing one.
 * 2. The list projection (`TaskSummary`) stays lean: a task with no submission reads
 *    `result: null` rather than a fabricated empty delivery.
 */

function injectTask(h: ControlHarness): ControlCommand {
  return h.command('Organization.InjectTask', {
    targetType: 'organization',
    targetId: 'future-ai-lab',
    extra: {
      positionId: 'ceo',
      title: 'Quantify Q3 churn',
      goal: 'Publish the churn driver table with sources',
    },
  });
}

/** Drive the injected task to a submitted result the way its executor would. */
async function submitResult(h: ControlHarness, taskId: string, artifacts: readonly string[]): Promise<void> {
  const actor = h.harness.actor('ceo-alex');
  const accepted = h.simulation.tasks.accept({ taskId, actor, simTime: sim(1) });
  expect(accepted.ok, JSON.stringify(accepted.ok ? null : accepted.error)).toBe(true);
  const started = h.simulation.tasks.start({ taskId, actor, simTime: sim(2) });
  expect(started.ok, JSON.stringify(started.ok ? null : started.error)).toBe(true);
  const submitted = h.simulation.tasks.submit({
    taskId,
    actor,
    simTime: sim(3),
    submission: {
      summary: 'The churn driver table is published with per-source citations.',
      data: {
        problem: 'churn is rising among the first cohort',
        findings: ['onboarding friction', 'pricing change'],
        recommendation: 'ship the retention pilot',
      },
      ...(artifacts.length === 0 ? {} : { artifacts }),
    },
  });
  expect(submitted.ok, JSON.stringify(submitted.ok ? null : submitted.error)).toBe(true);
}

describe('M1.4 deliverable read model', () => {
  it('reports no result for a task nobody has delivered into yet', async () => {
    const h = await createControlHarness();
    const outcome = await h.plane.control.execute(injectTask(h));
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const taskId = h.plane.control.query.getTasks()[0]?.taskId ?? '';
    const task = h.plane.control.query.getTask(taskId);
    expect(task).not.toBeNull();
    expect(task?.result).toBeNull();
    expect(task?.outputs).toEqual([]);
  });

  it('exposes the submitted delivery on the task record and folds its artifacts into outputs', async () => {
    const h = await createControlHarness();
    const outcome = await h.plane.control.execute(injectTask(h));
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const taskId = h.plane.control.query.getTasks()[0]?.taskId ?? '';
    await submitResult(h, taskId, ['artifact-churn-table', 'artifact-citations']);

    const task = h.plane.control.query.getTask(taskId);
    expect(task).not.toBeNull();
    expect(task?.status).toBe('submitted');
    expect(task?.goal).toBe('Publish the churn driver table with sources');
    expect(task?.result?.summary).toBe('The churn driver table is published with per-source citations.');
    expect(task?.result?.producedBy).toBe('ceo-alex');
    expect(task?.result?.data['problem']).toBe('churn is rising among the first cohort');
    expect(task?.result?.data['findings']).toEqual(['onboarding friction', 'pricing change']);
    expect(task?.result?.artifacts).toEqual(['artifact-churn-table', 'artifact-citations']);
    // `Task.Created`'s `outputs` is the fold of the submitted artifacts — the same two documents.
    expect(task?.outputs).toEqual(['artifact-churn-table', 'artifact-citations']);
  });

  it('keeps the list projection lean: the snapshot summary carries no result content', async () => {
    const h = await createControlHarness();
    const outcome = await h.plane.control.execute(injectTask(h));
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const taskId = h.plane.control.query.getTasks()[0]?.taskId ?? '';
    await submitResult(h, taskId, []);

    const snapshot = await h.plane.control.query.getOrganizationSnapshot();
    const listed = snapshot.tasks.find((task) => task.taskId === taskId);
    expect(listed, 'the submitted task must stay in the workspace list').toBeDefined();
    expect(listed?.status).toBe('submitted');
    // The page reads the list for the workspace and the record for the delivery: the split is
    // what keeps a poll from carrying every task's full deliverable payload.
    expect(listed).not.toHaveProperty('result');
    expect(listed).not.toHaveProperty('goal');
  });

  it('reads the result back through the control query for an unknown task as null', async () => {
    const h = await createControlHarness();
    expect(h.plane.control.query.getTask('task-unknown')).toBeNull();
  });
});
