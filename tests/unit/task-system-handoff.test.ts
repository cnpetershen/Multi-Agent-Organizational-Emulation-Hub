import { describe, expect, it } from 'vitest';
import type { EmployeeId, PositionId } from '@maoeh/shared-types';
import { applyTaskEvent } from '@maoeh/task-system';
import type { TaskOperation } from '@maoeh/task-system';
import type { WorkflowFixture } from '../helpers/workflow-fixtures';
import { createWorkflowFixture, must, sim } from '../helpers/workflow-fixtures';

/**
 * M3.1 · Task handoff (task-system domain).
 *
 * A handoff is not a comment and not a plain reassignment: it is a two-sided domain act.
 *
 *   sender: `Task.HandoffRequested`      (the task does not move)
 *   receiver: `Task.HandoffAccepted`     → then `Task.Assigned` (the task moves to them)
 *              or `Task.HandoffDeclined` (the task stays with the sender, with a reason)
 *   either way: `Task.HandoffCompleted`  when the accepted handoff settles (result included)
 *
 * These tests pin the sides: only the executor/creator may ask, only the named receiver may
 * answer, a repeated ask is idempotent, an acceptance moves the executor and preserves the
 * attempt, and the settlement is caused by the terminal task event it summarises.
 */

const eid = (value: string): EmployeeId => value as EmployeeId;
const pid = (value: string): PositionId => value as PositionId;

function createEngineerTask(fx: WorkflowFixture): string {
  const created = must(
    fx.tasks.create({
      actor: fx.ceoActor,
      simTime: sim(0),
      title: 'Ship the release checklist',
      goal: 'Write the release checklist with every verification step',
      assignment: { kind: 'position', positionId: pid('engineer') },
      requiredSkills: ['implementation'],
      verification: { kind: 'deterministic', requiredOutputKeys: ['checklist'] },
    }),
    'create',
  );
  const assigned = must(
    fx.tasks.assign({
      taskId: created.task.taskId,
      actor: fx.ceoActor,
      simTime: sim(1),
      reason: 'dispatched to the engineer seat',
    }),
    'assign',
  );
  return assigned.task.taskId;
}

function mustOp(result: { ok: true; value: TaskOperation } | { ok: false; error: unknown }, label: string): TaskOperation {
  return must(result, label);
}

function typesOf(operation: TaskOperation): readonly string[] {
  return operation.events.map((event) => event.type);
}

describe('M3.1 task handoff · request', () => {
  it('records the request, restates the work and leaves the task where it is', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createEngineerTask(fx);
    const before = fx.tasks.get(taskId);
    expect(before?.assignment.assigneeEmployeeId).toBe(eid('engineer-mike'));

    const request = mustOp(
      fx.tasks.requestHandoff({
        taskId,
        actor: fx.actor(eid('engineer-mike')),
        simTime: sim(2),
        toEmployeeId: eid('qa-peter'),
        reason: 'QA owns the verification checklist; I cannot verify my own work',
        note: 'the five acceptance checks are in the brief',
      }),
      'requestHandoff',
    );

    expect(typesOf(request)).toEqual(['Task.HandoffRequested']);
    const event = request.events[0];
    expect(event?.actorId).toBe('engineer-mike');
    expect(event?.subjectType).toBe('task');
    expect(event?.subjectId).toBe(taskId);
    expect(event?.payload).toMatchObject({
      handoffId: 'handoff-1',
      taskId,
      fromEmployeeId: 'engineer-mike',
      toEmployeeId: 'qa-peter',
      fromStatus: 'assigned',
      reason: 'QA owns the verification checklist; I cannot verify my own work',
      title: 'Ship the release checklist',
      requiredOutputKeys: ['checklist'],
    });

    const after = fx.tasks.get(taskId);
    // The task has not moved: intent is not a transfer.
    expect(after?.status).toBe('assigned');
    expect(after?.assignment.assigneeEmployeeId).toBe(eid('engineer-mike'));
    expect(after?.handoff).toMatchObject({
      handoffId: 'handoff-1',
      fromEmployeeId: 'engineer-mike',
      toEmployeeId: 'qa-peter',
      status: 'requested',
    });
  });

  it('is idempotent for the same target and refuses to silently re-point a pending ask', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createEngineerTask(fx);
    const actor = fx.actor(eid('engineer-mike'));

    mustOp(
      fx.tasks.requestHandoff({
        taskId,
        actor,
        simTime: sim(2),
        toEmployeeId: eid('qa-peter'),
        reason: 'please take the checklist',
      }),
      'first request',
    );
    const repeated = mustOp(
      fx.tasks.requestHandoff({
        taskId,
        actor,
        simTime: sim(3),
        toEmployeeId: eid('qa-peter'),
        reason: 'please take the checklist',
      }),
      'repeated request',
    );
    expect(repeated.events).toEqual([]);
    expect(fx.tasks.get(taskId)?.handoff?.handoffId).toBe('handoff-1');

    const other = fx.tasks.requestHandoff({
      taskId,
      actor,
      simTime: sim(4),
      toEmployeeId: eid('pm-bona'),
      reason: 'also ask the PM',
    });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.code).toBe('handoff_pending');
  });

  it('refuses self-handoff, strangers, non-owners and non-executable receivers', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createEngineerTask(fx);
    const engineer = fx.actor(eid('engineer-mike'));

    const self = fx.tasks.requestHandoff({
      taskId,
      actor: engineer,
      simTime: sim(2),
      toEmployeeId: eid('engineer-mike'),
      reason: 'to myself',
    });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.code).toBe('invalid_input');

    const stranger = fx.tasks.requestHandoff({
      taskId,
      actor: engineer,
      simTime: sim(2),
      toEmployeeId: eid('nobody'),
      reason: 'to a stranger',
    });
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.error.code).toBe('unknown_employee');

    // The marketing seat neither created the task nor executes it.
    const outsider = fx.tasks.requestHandoff({
      taskId,
      actor: fx.actor(eid('marketing-jack')),
      simTime: sim(2),
      toEmployeeId: eid('qa-peter'),
      reason: 'someone else should take it',
    });
    expect(outsider.ok).toBe(false);
    if (!outsider.ok) expect(outsider.error.code).toBe('not_task_owner');

    // A submitted task cannot be handed over: `handoff` is not a legal command once the work is
    // waiting for settlement (moving it would move work nobody can verify any more).
    const engineer2 = fx.actor(eid('engineer-mike'));
    mustOp(fx.tasks.accept({ taskId, actor: engineer2, simTime: sim(3) }), 'accept');
    mustOp(fx.tasks.start({ taskId, actor: engineer2, simTime: sim(4) }), 'start');
    const submitted = mustOp(
      fx.tasks.submit({
        taskId,
        actor: engineer2,
        simTime: sim(5),
        submission: { summary: 'checklist', data: { checklist: 'a real checklist' } },
      }),
      'submit',
    );
    expect(submitted.task.status).toBe('submitted');
    const late = fx.tasks.requestHandoff({
      taskId,
      actor: fx.actor(eid('engineer-mike')),
      simTime: sim(6),
      toEmployeeId: eid('qa-peter'),
      reason: 'too late',
    });
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe('invalid_transition');
  });
});

describe('M3.1 task handoff · acceptance moves the work', () => {
  it('accepts from the named receiver, reassigns the task and chains causation', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createEngineerTask(fx);
    mustOp(
      fx.tasks.requestHandoff({
        taskId,
        actor: fx.actor(eid('engineer-mike')),
        simTime: sim(2),
        toEmployeeId: eid('qa-peter'),
        reason: 'QA should own the checklist',
      }),
      'request',
    );

    // Only the named receiver may answer.
    const impostor = fx.tasks.acceptHandoff({
      taskId,
      actor: fx.actor(eid('pm-bona')),
      simTime: sim(3),
    });
    expect(impostor.ok).toBe(false);
    if (!impostor.ok) expect(impostor.error.code).toBe('handoff_not_recipient');

    const accepted = mustOp(
      fx.tasks.acceptHandoff({
        taskId,
        actor: fx.actor(eid('qa-peter')),
        simTime: sim(3),
        handoffId: 'handoff-1',
      }),
      'acceptHandoff',
    );
    expect(typesOf(accepted)).toEqual(['Task.HandoffAccepted', 'Task.Assigned']);
    const [acceptedEvent, assignedEvent] = accepted.events;
    expect(acceptedEvent?.payload).toMatchObject({
      handoffId: 'handoff-1',
      fromEmployeeId: 'engineer-mike',
      toEmployeeId: 'qa-peter',
      previousStatus: 'assigned',
    });
    // The transfer is caused by the acceptance — the handoff chain is walkable from the log.
    expect(assignedEvent?.causationId).toBe(acceptedEvent?.eventId);
    expect(assignedEvent?.payload).toMatchObject({
      assignment: {
        kind: 'employee',
        positionId: 'qa',
        assigneeEmployeeId: 'qa-peter',
      },
      attempt: 1,
      title: 'Ship the release checklist',
      requiredOutputKeys: ['checklist'],
    });

    const moved = fx.tasks.get(taskId);
    expect(moved?.status).toBe('assigned');
    expect(moved?.assignment.assigneeEmployeeId).toBe(eid('qa-peter'));
    expect(moved?.attempt).toBe(1);
    expect(moved?.handoff?.status).toBe('accepted');

    // A repeat acceptance is the same fact, not a second transfer.
    const again = mustOp(
      fx.tasks.acceptHandoff({ taskId, actor: fx.actor(eid('qa-peter')), simTime: sim(4) }),
      'repeat accept',
    );
    expect(again.events).toEqual([]);
  });

  it('declining records the reason and leaves the sender holding the task', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createEngineerTask(fx);
    mustOp(
      fx.tasks.requestHandoff({
        taskId,
        actor: fx.actor(eid('engineer-mike')),
        simTime: sim(2),
        toEmployeeId: eid('qa-peter'),
        reason: 'QA should own the checklist',
      }),
      'request',
    );

    const noReason = fx.tasks.declineHandoff({
      taskId,
      actor: fx.actor(eid('qa-peter')),
      simTime: sim(3),
    });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error.code).toBe('invalid_reason');

    const declined = mustOp(
      fx.tasks.declineHandoff({
        taskId,
        actor: fx.actor(eid('qa-peter')),
        simTime: sim(3),
        reason: 'the engineer holds the environment access this checklist needs',
      }),
      'declineHandoff',
    );
    expect(typesOf(declined)).toEqual(['Task.HandoffDeclined']);
    const task = fx.tasks.get(taskId);
    expect(task?.status).toBe('assigned');
    expect(task?.assignment.assigneeEmployeeId).toBe(eid('engineer-mike'));
    expect(task?.handoff).toMatchObject({
      status: 'declined',
      settlement: 'the engineer holds the environment access this checklist needs',
    });
    // A retried decline is the same fact, not a second refusal.
    const repeated = fx.tasks.declineHandoff({
      taskId,
      actor: fx.actor(eid('qa-peter')),
      simTime: sim(4),
      reason: 'duplicate refusal',
    });
    expect(repeated.ok).toBe(true);
    if (repeated.ok) expect(repeated.value.events).toEqual([]);
    // A declined handoff can be asked again — to somebody else.
    const retry = mustOp(
      fx.tasks.requestHandoff({
        taskId,
        actor: fx.actor(eid('engineer-mike')),
        simTime: sim(4),
        toEmployeeId: eid('pm-bona'),
        reason: 'second attempt',
      }),
      'retry request',
    );
    expect(retry.events.map((event) => event.type)).toEqual(['Task.HandoffRequested']);
    expect(fx.tasks.get(taskId)?.handoff?.handoffId).toBe('handoff-2');
  });
});

describe('M3.1 task handoff · the receiver delivers a result', () => {
  it('settles the handoff with the delivered result when the task completes', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createEngineerTask(fx);
    mustOp(
      fx.tasks.requestHandoff({
        taskId,
        actor: fx.actor(eid('engineer-mike')),
        simTime: sim(2),
        toEmployeeId: eid('qa-peter'),
        reason: 'QA should own the checklist',
      }),
      'request',
    );
    mustOp(
      fx.tasks.acceptHandoff({ taskId, actor: fx.actor(eid('qa-peter')), simTime: sim(3) }),
      'accept',
    );

    const qa = fx.actor(eid('qa-peter'));
    mustOp(fx.tasks.accept({ taskId, actor: qa, simTime: sim(4) }), 'task accept');
    mustOp(fx.tasks.start({ taskId, actor: qa, simTime: sim(5) }), 'task start');
    const submitted = mustOp(
      fx.tasks.submit({
        taskId,
        actor: qa,
        simTime: sim(6),
        submission: {
          summary: 'release checklist covering the five acceptance checks',
          data: { checklist: '1. build 2. smoke 3. approval' },
        },
      }),
      'submit',
    );
    expect(submitted.task.status).toBe('submitted');

    const completed = mustOp(
      fx.tasks.complete({
        taskId,
        actor: fx.actor(eid('cto-john')),
        simTime: sim(7),
        causationId: submitted.events[0]?.eventId ?? null,
      }),
      'complete',
    );
    expect(typesOf(completed)).toEqual(['Task.Completed', 'Task.HandoffCompleted']);
    const [completedEvent, settlement] = completed.events;
    expect(settlement?.causationId).toBe(completedEvent?.eventId);
    expect(settlement?.payload).toMatchObject({
      handoffId: 'handoff-1',
      taskId,
      fromEmployeeId: 'engineer-mike',
      toEmployeeId: 'qa-peter',
      outcome: 'completed',
      resultSummary: 'release checklist covering the five acceptance checks',
      artifactCount: 0,
    });

    const done = fx.tasks.get(taskId);
    expect(done?.status).toBe('completed');
    expect(done?.result?.producedBy).toBe(eid('qa-peter'));
    expect(done?.handoff).toMatchObject({ status: 'completed', outcome: 'completed' });
  });

  it('settles as failed when the receiver fails the task, and as cancelled on cancel', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createEngineerTask(fx);
    mustOp(
      fx.tasks.requestHandoff({
        taskId,
        actor: fx.actor(eid('engineer-mike')),
        simTime: sim(2),
        toEmployeeId: eid('qa-peter'),
        reason: 'QA should own the checklist',
      }),
      'request',
    );
    mustOp(
      fx.tasks.acceptHandoff({ taskId, actor: fx.actor(eid('qa-peter')), simTime: sim(3) }),
      'accept',
    );
    const qa = fx.actor(eid('qa-peter'));
    mustOp(fx.tasks.accept({ taskId, actor: qa, simTime: sim(4) }), 'task accept');
    mustOp(fx.tasks.start({ taskId, actor: qa, simTime: sim(5) }), 'task start');
    const failed = mustOp(
      fx.tasks.fail({ taskId, actor: qa, simTime: sim(6), reason: 'the release build is missing' }),
      'fail',
    );
    expect(typesOf(failed)).toEqual(['Task.Failed', 'Task.HandoffCompleted']);
    expect(failed.events[1]?.payload).toMatchObject({ outcome: 'failed' });

    const second = createEngineerTask(fx);
    mustOp(
      fx.tasks.requestHandoff({
        taskId: second,
        actor: fx.actor(eid('engineer-mike')),
        simTime: sim(7),
        toEmployeeId: eid('qa-peter'),
        reason: 'take it',
      }),
      'request 2',
    );
    mustOp(
      fx.tasks.acceptHandoff({ taskId: second, actor: fx.actor(eid('qa-peter')), simTime: sim(8) }),
      'accept 2',
    );
    const cancelled = mustOp(
      fx.tasks.cancel({
        taskId: second,
        actor: fx.actor(eid('qa-peter')),
        simTime: sim(9),
        reason: 'the release was dropped',
      }),
      'cancel',
    );
    expect(typesOf(cancelled)).toEqual(['Task.Cancelled', 'Task.HandoffCompleted']);
    expect(cancelled.events[1]?.payload).toMatchObject({ outcome: 'cancelled' });
  });

  it('folds the handoff chain back from the log after a replay', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const created = mustOp(
      fx.tasks.create({
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Ship the release checklist',
        goal: 'Write the release checklist with every verification step',
        assignment: { kind: 'position', positionId: pid('engineer') },
        verification: { kind: 'deterministic', requiredOutputKeys: ['checklist'] },
      }),
      'create',
    );
    const taskId = created.task.taskId;
    const assigned = mustOp(
      fx.tasks.assign({ taskId, actor: fx.ceoActor, simTime: sim(1) }),
      'assign',
    );
    const requested = mustOp(
      fx.tasks.requestHandoff({
        taskId,
        actor: fx.actor(eid('engineer-mike')),
        simTime: sim(2),
        toEmployeeId: eid('qa-peter'),
        reason: 'QA should own the checklist',
      }),
      'request',
    );
    const accepted = mustOp(
      fx.tasks.acceptHandoff({ taskId, actor: fx.actor(eid('qa-peter')), simTime: sim(3) }),
      'accept',
    );

    // A restart rebuilds the record from the events alone, in order.
    let replayed = null;
    for (const event of [
      ...created.events,
      ...assigned.events,
      ...requested.events,
      ...accepted.events,
    ]) {
      replayed = applyTaskEvent(replayed, event);
    }
    expect(replayed?.assignment.assigneeEmployeeId).toBe(eid('qa-peter'));
    expect(replayed?.handoff).toMatchObject({
      handoffId: 'handoff-1',
      status: 'accepted',
      fromEmployeeId: 'engineer-mike',
      toEmployeeId: 'qa-peter',
      sourceEventId: requested.events[0]?.eventId,
    });
  });
});
