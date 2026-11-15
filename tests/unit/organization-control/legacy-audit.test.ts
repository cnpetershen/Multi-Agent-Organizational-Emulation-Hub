import { describe, expect, it } from 'vitest';
import type { EmployeeId, OrgEvent, PositionId, SimTime } from '@maoeh/shared-types';
import type { Task, TaskOperation } from '@maoeh/task-system';
import { auditLegacyWork, legacyRepairPlan } from '@maoeh/organization-control';
import type { WorkflowFixture } from '../../helpers/workflow-fixtures';
import { createWorkflowFixture, must, sim } from '../../helpers/workflow-fixtures';

/**
 * M3.0 · legacy-work audit (pure domain rules).
 *
 * The auditor must say the *true* thing even when the truth is uncomfortable:
 *
 *   - a completed task with no deliverable is reported, not re-labelled (no un-complete exists);
 *   - a terminal event stamped before creation is a broken timeline, not a business outcome;
 *   - open work that cannot move is repairable only where a legal transition exists;
 *   - a workflow step is NOT auto-cancelled, because cancellation aborts the instance.
 *
 * Every fixture drives the real `TaskService`; the audit only reads what it produced.
 */

const eid = (value: string): EmployeeId => value as EmployeeId;
const pid = (value: string): PositionId => value as PositionId;

function issued(operation: TaskOperation): readonly OrgEvent[] {
  return operation.events;
}

function createTask(
  fx: WorkflowFixture,
  options: {
    readonly title?: string;
    readonly workflowInstanceId?: string | null;
    readonly verification?: { kind: 'deterministic'; requiredOutputKeys: readonly string[] } | null;
  } = {},
): { taskId: string; events: readonly OrgEvent[] } {
  const created = must(
    fx.tasks.create({
      actor: fx.ceoActor,
      simTime: sim(0),
      title: options.title ?? 'Legacy item',
      goal: 'Deliver something verifiable',
      assignment: { kind: 'position', positionId: pid('engineer') },
      ...(options.verification === undefined ? {} : { verification: options.verification }),
      ...(options.workflowInstanceId === undefined
        ? {}
        : { workflowInstanceId: options.workflowInstanceId }),
    }),
    'create',
  );
  const assigned = must(
    fx.tasks.assign({ taskId: created.task.taskId, actor: fx.ceoActor, simTime: sim(1) }),
    'assign',
  );
  return { taskId: created.task.taskId, events: [...issued(created), ...issued(assigned)] };
}

function driveToSubmitted(
  fx: WorkflowFixture,
  taskId: string,
  data: Readonly<Record<string, unknown>>,
): readonly OrgEvent[] {
  const engineer = fx.actor(eid('engineer-mike'));
  const accepted = must(fx.tasks.accept({ taskId, actor: engineer, simTime: sim(2) }), 'accept');
  const started = must(fx.tasks.start({ taskId, actor: engineer, simTime: sim(3) }), 'start');
  const submitted = must(
    fx.tasks.submit({
      taskId,
      actor: engineer,
      simTime: sim(4),
      submission: { summary: 'delivery', data },
    }),
    'submit',
  );
  return [...issued(accepted), ...issued(started), ...issued(submitted)];
}

function audit(
  fx: WorkflowFixture,
  tasks: readonly Task[],
  events: readonly OrgEvent[],
  simTime?: number,
) {
  return auditLegacyWork({
    tasks,
    events,
    organization: fx.organization,
    ...(simTime === undefined ? {} : { simTime: simTime as SimTime }),
  });
}

describe('M3.0 legacy audit · fake and unverifiable deliveries', () => {
  it('flags a completed task whose result carries no content, and does not offer a rewrite', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const { taskId, events } = createTask(fx);
    const delivery = driveToSubmitted(fx, taskId, {});
    const completed = must(
      fx.tasks.complete({ taskId, actor: fx.actor(eid('cto-john')), simTime: sim(5) }),
      'complete',
    );

    const report = audit(fx, fx.tasks.all(), [...events, ...delivery, ...issued(completed)]);
    const finding = report.findings.find((item) => item.code === 'empty_delivery');
    expect(finding).toMatchObject({
      taskId,
      severity: 'critical',
      repair: 'none',
    });
    expect(finding?.detail).toContain('completion without a deliverable');
    const plan = legacyRepairPlan(report);
    expect(plan.map((command) => command.taskId)).not.toContain(taskId);
  });

  it('flags a completed task that does not carry its declared verification keys', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const { taskId, events } = createTask(fx, {
      verification: { kind: 'deterministic', requiredOutputKeys: ['checklist'] },
    });
    const delivery = driveToSubmitted(fx, taskId, { summary_of_work: 'looks done' });
    const completed = must(
      fx.tasks.complete({ taskId, actor: fx.actor(eid('cto-john')), simTime: sim(5) }),
      'complete',
    );
    const report = audit(fx, fx.tasks.all(), [...events, ...delivery, ...issued(completed)]);
    const finding = report.findings.find((item) => item.code === 'unverified_delivery');
    expect(finding?.detail).toContain('checklist');
    expect(finding?.repair).toBe('none');
  });

  it('does not flag a completed task that really delivered its keys', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const { taskId, events } = createTask(fx, {
      verification: { kind: 'deterministic', requiredOutputKeys: ['checklist'] },
    });
    const delivery = driveToSubmitted(fx, taskId, { checklist: '1. build 2. smoke' });
    const completed = must(
      fx.tasks.complete({ taskId, actor: fx.actor(eid('cto-john')), simTime: sim(5) }),
      'complete',
    );
    const report = audit(fx, fx.tasks.all(), [...events, ...delivery, ...issued(completed)]);
    expect(report.findings).toEqual([]);
  });
});

describe('M3.0 legacy audit · broken chronology', () => {
  it('reports a terminal fact stamped before the task existed, and refuses to rewrite it', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const { taskId, events } = createTask(fx);
    const cancelled = must(
      fx.tasks.cancel({
        taskId,
        actor: fx.actor(eid('engineer-mike')),
        simTime: sim(2),
        reason: 'superseded',
      }),
      'cancel',
    );
    const [created, , terminal] = [...events, ...issued(cancelled)];
    // The production defect: the console stamped a command with its stale clock, so the
    // cancellation landed at sim 0 while the task had been created at sim 0 too... but a task
    // created later in the same log is what makes it visible. Rewrite the created stamp to a
    // later sim to model a terminal fact that precedes creation.
    const brokenCreated: OrgEvent = { ...(created as OrgEvent), occurredAtSim: 63048 as SimTime };
    const brokenTerminal: OrgEvent = { ...(terminal as OrgEvent), occurredAtSim: 0 as SimTime };

    const report = audit(fx, fx.tasks.all(), [brokenCreated, ...events.slice(1), brokenTerminal]);
    const finding = report.findings.find((item) => item.code === 'chronology_violation');
    expect(finding).toMatchObject({
      taskId,
      severity: 'critical',
      repair: 'none',
    });
    expect(finding?.detail).toContain('before the task was created');
    expect(finding?.evidenceEventIds).toHaveLength(2);
  });
});

describe('M3.0 legacy audit · open work that cannot move', () => {
  it('offers a legal cancellation for a stalled standalone task', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const { taskId, events } = createTask(fx);
    const report = audit(fx, fx.tasks.all(), events, 5000);
    const finding = report.findings.find((item) => item.code === 'stalled_open_task');
    expect(finding).toMatchObject({ taskId, repair: 'cancel' });
    const plan = legacyRepairPlan(report);
    expect(plan).toEqual([
      expect.objectContaining({
        taskId,
        action: 'cancel',
        codes: ['stalled_open_task'],
      }),
    ]);
    expect(plan[0]?.reason).toContain('legacy audit at sim 5000');
  });

  it('applies a planned repair as a real, legal transition that keeps the history', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const { taskId, events } = createTask(fx);
    const report = audit(fx, fx.tasks.all(), events, 5000);
    const [command] = legacyRepairPlan(report);
    if (command === undefined) throw new Error('expected a repair command');

    // The plan is executed through the real state machine, by an actor the transition permits.
    const cancelled = must(
      fx.tasks.cancel({
        taskId,
        actor: fx.actor(eid('engineer-mike')),
        simTime: sim(5001),
        reason: command.reason,
      }),
      'cancel',
    );
    expect(cancelled.events.map((event) => event.type)).toEqual(['Task.Cancelled']);
    expect(cancelled.events[0]?.payload).toMatchObject({
      taskId,
      reason: expect.stringContaining('legacy audit at sim 5000'),
      from: 'assigned',
    });

    // Nothing was deleted or rewritten: the creation and assignment facts are still the log,
    // and the re-audit sees a terminal task instead of a stalled one.
    const after = audit(fx, fx.tasks.all(), [...events, ...cancelled.events], 5001);
    expect(after.findings).toEqual([]);
    expect(fx.tasks.get(taskId)?.status).toBe('cancelled');
  });

  it('will not auto-cancel a stalled workflow step (that would abort the instance)', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const { events } = createTask(fx, { workflowInstanceId: 'instance-99' });
    const report = audit(fx, fx.tasks.all(), events, 5000);
    const finding = report.findings.find((item) => item.code === 'stalled_open_task');
    expect(finding).toMatchObject({ severity: 'warning', repair: 'none' });
    expect(finding?.repairReason).toContain('aborts the instance');
    expect(legacyRepairPlan(report)).toEqual([]);
  });

  it('flags a stale submission nobody can settle, but not a review that is waiting for a human', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const deterministic = createTask(fx);
    const orphanEvents = driveToSubmitted(fx, deterministic.taskId, { checklist: 'x' });

    const reviewable = createTask(fx, {
      verification: { kind: 'deterministic', requiredOutputKeys: ['checklist'] },
    });
    const reviewEvents = driveToSubmitted(fx, reviewable.taskId, { checklist: 'x' });

    const tasks = fx.tasks.all();
    // Mark the second one as a review-verified task to model "waiting for a human".
    const reviewTask: Task = {
      ...(tasks.find((task) => task.taskId === reviewable.taskId) as Task),
      verification: { kind: 'review', requiredOutputKeys: ['checklist'] },
    };
    const report = audit(
      fx,
      [tasks.find((task) => task.taskId === deterministic.taskId) as Task, reviewTask],
      [...deterministic.events, ...orphanEvents, ...reviewable.events, ...reviewEvents],
      5000,
    );
    const orphan = report.findings.filter((item) => item.code === 'orphaned_submission');
    expect(orphan.map((item) => item.taskId)).toEqual([deterministic.taskId]);
    expect(orphan[0]?.repair).toBe('cancel');
  });

  it('flags a handoff waiting on a colleague who can no longer take work', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const { taskId, events } = createTask(fx);
    const request = must(
      fx.tasks.requestHandoff({
        taskId,
        actor: fx.actor(eid('engineer-mike')),
        simTime: sim(2),
        toEmployeeId: eid('qa-peter'),
        reason: 'QA owns verification',
      }),
      'handoff',
    );
    const qa = fx.organization.employees.find((employee) => String(employee.id) === 'qa-peter');
    if (qa === undefined) throw new Error('seed has no qa-peter');
    qa.status = 'offboarded';

    const report = audit(fx, fx.tasks.all(), [...events, ...issued(request)], 4);
    const finding = report.findings.find((item) => item.code === 'dangling_handoff');
    expect(finding).toMatchObject({ taskId, repair: 'cancel' });
    expect(finding?.detail).toContain('can no longer take work');
  });
});

describe('M3.0 legacy audit · records the fold no longer shows', () => {
  it('keeps auditing a fake completion after its record was deleted', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const { taskId, events } = createTask(fx);
    const delivery = driveToSubmitted(fx, taskId, {});
    const completed = must(
      fx.tasks.complete({ taskId, actor: fx.actor(eid('cto-john')), simTime: sim(5) }),
      'complete',
    );
    const deleted = must(
      fx.tasks.delete({
        taskId,
        actor: fx.ceoActor,
        simTime: sim(6),
        reason: 'placeholder superseded by the real runtime',
      }),
      'delete',
    );
    // The live board no longer knows the task — that is exactly the situation the audit must see
    // through: the log still carries the completion and the deletion.
    expect(fx.tasks.get(taskId)).toBeNull();

    const report = audit(
      fx,
      fx.tasks.all(),
      [...events, ...delivery, ...issued(completed), ...issued(deleted)],
      10,
    );
    expect(report.taskCount).toBe(0);
    expect(report.archivedTaskCount).toBe(1);
    const finding = report.findings.find((item) => item.code === 'empty_delivery');
    expect(finding).toMatchObject({
      taskId,
      record: 'deleted',
      severity: 'warning',
      repair: 'none',
    });
    expect(finding?.detail).toContain('deleted from the active board');
    expect(legacyRepairPlan(report)).toEqual([]);
  });

  it('does not propose repairs for a deleted record that was still open', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const { taskId, events } = createTask(fx);
    const deleted = must(
      fx.tasks.delete({
        taskId,
        actor: fx.ceoActor,
        simTime: sim(2),
        reason: 'demo task removed',
      }),
      'delete',
    );
    const report = audit(fx, [], [...events, ...issued(deleted)], 10_000);
    expect(report.archivedTaskCount).toBe(1);
    // Old live-work rules no longer apply to a record that left the board.
    expect(report.findings.filter((item) => item.record === 'deleted')).toEqual([]);
    expect(legacyRepairPlan(report)).toEqual([]);
  });
});

describe('M3.0 legacy audit · report shape', () => {
  it('is deterministic, counted and empty for a clean board', () => {    const fx = createWorkflowFixture({ definitions: [] });
    const report = audit(fx, [], []);
    expect(report).toMatchObject({
      taskCount: 0,
      archivedTaskCount: 0,
      evaluatedAtSim: 0,
      findings: [],
      summary: {
        total: 0,
        repairable: 0,
        byCode: {
          empty_delivery: 0,
          unverified_delivery: 0,
          chronology_violation: 0,
          orphaned_submission: 0,
          stalled_open_task: 0,
          dangling_handoff: 0,
        },
      },
    });
    expect(legacyRepairPlan(report)).toEqual([]);
  });
});
