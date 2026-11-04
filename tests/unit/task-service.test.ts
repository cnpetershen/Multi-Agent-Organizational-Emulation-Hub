import { describe, expect, it } from 'vitest';
import type { EmployeeId, PositionId } from '@maoeh/shared-types';
import type { CommandActor, PermissionPolicy } from '@maoeh/permission-system';
import { systemActor } from '@maoeh/permission-system';
import type { TaskAssignmentInput, TaskVerification } from '@maoeh/task-system';
import type { WorkflowFixture } from '../helpers/workflow-fixtures';
import { createWorkflowFixture, must, sim, workflowTestPolicy } from '../helpers/workflow-fixtures';
import { loadMemoryOrganization } from '../helpers/communication-fixtures';

const pid = (value: string): PositionId => value as PositionId;
const eid = (value: string): EmployeeId => value as EmployeeId;

interface CreateOptions {
  readonly creator?: CommandActor;
  readonly assignment?: TaskAssignmentInput;
  readonly maxAttempts?: number;
  readonly verification?: TaskVerification;
  readonly title?: string;
  readonly goal?: string;
}

function createTask(fx: WorkflowFixture, options: CreateOptions = {}): string {
  const creator = options.creator ?? fx.ceoActor;
  const created = must(
    fx.tasks.create({
      actor: creator,
      simTime: sim(0),
      title: options.title ?? 'Draft the brief',
      goal: options.goal ?? 'Write the brief for the analysis',
      assignment: options.assignment ?? { kind: 'position', positionId: pid('ceo') },
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.verification === undefined ? {} : { verification: options.verification }),
    }),
    'tasks.create',
  );
  const assigned = must(
    fx.tasks.assign({ taskId: created.task.taskId, actor: creator, simTime: sim(1) }),
    'tasks.assign',
  );
  return assigned.task.taskId;
}

function driveToStarted(fx: WorkflowFixture, taskId: string, actor: CommandActor): void {
  must(fx.tasks.accept({ taskId, actor, simTime: sim(2) }), 'tasks.accept');
  must(fx.tasks.start({ taskId, actor, simTime: sim(3) }), 'tasks.start');
}

describe('M0.8 任务生命周期（task-system）', () => {
  it('create+assign：状态 assigned、执行人解析、事件为 Created→Assigned', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const created = must(
      fx.tasks.create({
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Draft brief',
        goal: 'Write it',
        assignment: { kind: 'position', positionId: pid('ceo') },
      }),
      'create',
    );
    expect(created.task.status).toBe('created');
    expect(created.task.createdById).toBe(eid('ceo-alex'));

    const assigned = must(
      fx.tasks.assign({ taskId: created.task.taskId, actor: fx.ceoActor, simTime: sim(1) }),
      'assign',
    );
    expect(assigned.task.status).toBe('assigned');
    expect(assigned.task.assignment.assigneeEmployeeId).toBe(eid('ceo-alex'));
    expect(assigned.task.assignment.positionId).toBe(pid('ceo'));
    expect(assigned.events.map((event) => event.type)).toEqual(['Task.Assigned']);
    expect(created.events.map((event) => event.type)).toEqual(['Task.Created']);
  });

  it('Task.Assigned 携带执行人的作业简报（title/goal/requiredOutputKeys）', () => {
    // `Task.Assigned` is what wakes the executor, and the cognition prompt carries the event plus
    // the org slice and nothing else. Without the brief on the event the assignee learns a taskId
    // and nothing more, so every step of every workflow answered with the same placeholder.
    const fx = createWorkflowFixture({ definitions: [] });
    const created = must(
      fx.tasks.create({
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Frontend',
        goal: 'Complete step "Frontend" of workflow "贪吃蛇": 做一个 Web 端的贪吃蛇小游戏',
        assignment: { kind: 'position', positionId: pid('ceo') },
        verification: { kind: 'deterministic', requiredOutputKeys: ['entrypoint', 'stack'] },
      }),
      'create',
    );
    const assigned = must(
      fx.tasks.assign({ taskId: created.task.taskId, actor: fx.ceoActor, simTime: sim(1) }),
      'assign',
    );
    const payload = assigned.events[0]?.payload as Record<string, unknown>;
    expect(payload['title']).toBe('Frontend');
    expect(String(payload['goal'])).toContain('贪吃蛇');
    expect(payload['requiredOutputKeys']).toEqual(['entrypoint', 'stack']);
  });

  it('Task.Assigned 在步骤没有输出契约时不带 requiredOutputKeys', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const created = must(
      fx.tasks.create({
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Ad hoc',
        goal: 'Look into the outage',
        assignment: { kind: 'position', positionId: pid('ceo') },
      }),
      'create',
    );
    const assigned = must(
      fx.tasks.assign({ taskId: created.task.taskId, actor: fx.ceoActor, simTime: sim(1) }),
      'assign',
    );
    const payload = assigned.events[0]?.payload as Record<string, unknown>;
    // Omitted rather than sent empty: a step that declares no contract must not look like one
    // that declares an empty one, and older logs without the field keep replaying unchanged.
    expect('requiredOutputKeys' in payload).toBe(false);
    expect(payload['goal']).toBe('Look into the outage');
  });

  it('完整生命周期 assigned→accepted→started→submitted→completed（验证人非执行人）', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createTask(fx, {
      assignment: { kind: 'employee', employeeId: eid('cto-john') },
    });
    must(fx.tasks.accept({ taskId, actor: fx.ctoActor, simTime: sim(2) }), 'accept');
    must(fx.tasks.start({ taskId, actor: fx.ctoActor, simTime: sim(3) }), 'start');
    const submitted = must(
      fx.tasks.submit({
        taskId,
        actor: fx.ctoActor,
        simTime: sim(4),
        submission: { summary: 'Done', data: { architecture: 'layers' } },
      }),
      'submit',
    );
    expect(submitted.task.status).toBe('submitted');
    expect(submitted.task.result?.data).toEqual({ architecture: 'layers' });

    const completed = must(
      fx.tasks.complete({ taskId, actor: fx.ceoActor, simTime: sim(5) }),
      'complete',
    );
    expect(completed.task.status).toBe('completed');
    expect(completed.task.completedAtSim).toBe(sim(5));
    expect(completed.events[0]?.type).toBe('Task.Completed');
  });

  it('执行人不能验收自己的任务 → self_verification_forbidden', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createTask(fx, {
      assignment: { kind: 'employee', employeeId: eid('cto-john') },
    });
    driveToStarted(fx, taskId, fx.ctoActor);
    must(
      fx.tasks.submit({
        taskId,
        actor: fx.ctoActor,
        simTime: sim(4),
        submission: { summary: 'Done', data: { plan: 'p' } },
      }),
      'submit',
    );
    const failure = fx.tasks.complete({ taskId, actor: fx.ctoActor, simTime: sim(5) });
    expect(failure.ok).toBe(false);
    if (failure.ok) return;
    expect(failure.error.code).toBe('self_verification_forbidden');
  });

  it('非执行人不能接受任务 → not_assignee；非法状态命令 → invalid_transition', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createTask(fx, {
      assignment: { kind: 'employee', employeeId: eid('cto-john') },
    });
    const wrongActor = fx.tasks.accept({ taskId, actor: fx.ceoActor, simTime: sim(2) });
    expect(wrongActor.ok).toBe(false);
    if (!wrongActor.ok) expect(wrongActor.error.code).toBe('not_assignee');

    const createdOnly = must(
      fx.tasks.create({
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Unassigned',
        goal: 'Wait',
        assignment: { kind: 'position', positionId: pid('ceo') },
      }),
      'create',
    );
    const earlyAccept = fx.tasks.accept({
      taskId: createdOnly.task.taskId,
      actor: fx.ceoActor,
      simTime: sim(1),
    });
    expect(earlyAccept.ok).toBe(false);
    if (!earlyAccept.ok) expect(earlyAccept.error.code).toBe('invalid_transition');
  });

  it('非所有者不能改派任务 → not_task_owner', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createTask(fx, {
      creator: fx.ctoActor,
      assignment: { kind: 'employee', employeeId: eid('cto-john') },
    });
    const reassign = fx.tasks.assign({ taskId, actor: fx.ceoActor, simTime: sim(5) });
    expect(reassign.ok).toBe(false);
    if (!reassign.ok) expect(reassign.error.code).toBe('not_task_owner');
  });

  it('权限缺失 → permission_denied（带 denial 原因）', () => {
    const policy: PermissionPolicy = {
      grants: workflowTestPolicy.grants.filter((rule) => rule.action !== 'RejectTask'),
      denies: [],
    };
    const fx = createWorkflowFixture({ definitions: [], policy });
    const taskId = createTask(fx);
    const cancelled = fx.tasks.cancel({ taskId, actor: fx.ceoActor, simTime: sim(6), reason: 'no' });
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) return;
    expect(cancelled.error.code).toBe('permission_denied');
    expect(cancelled.error.denial?.reason).toBe('NO_PERMISSION');
  });

  it('block/unblock：started⇄blocked，unblock 复用 Task.Started', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createTask(fx);

    const earlyBlock = fx.tasks.block({
      taskId,
      actor: fx.ceoActor,
      simTime: sim(4),
      reason: 'too early',
    });
    expect(earlyBlock.ok).toBe(false);
    if (!earlyBlock.ok) expect(earlyBlock.error.code).toBe('invalid_transition');

    driveToStarted(fx, taskId, fx.ceoActor);

    const blocked = must(
      fx.tasks.block({ taskId, actor: fx.ceoActor, simTime: sim(4), reason: 'waiting for info' }),
      'block',
    );
    expect(blocked.task.status).toBe('blocked');
    expect(blocked.task.blockedReason).toBe('waiting for info');
    expect(blocked.task.blockedFrom).toBe('started');

    const unblocked = must(
      fx.tasks.unblock({ taskId, actor: fx.ceoActor, simTime: sim(5) }),
      'unblock',
    );
    expect(unblocked.task.status).toBe('started');
    expect(unblocked.events[0]?.type).toBe('Task.Started');
    expect(unblocked.task.blockedReason).toBeNull();
  });

  it('reject 后 attempt+1，重派推进重试，超出 maxAttempts → retries_exhausted', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createTask(fx, { maxAttempts: 2 });

    const rejected = must(
      fx.tasks.reject({ taskId, actor: fx.ceoActor, simTime: sim(4), reason: 'not good' }),
      'reject',
    );
    expect(rejected.task.status).toBe('rejected');
    expect(rejected.task.attempt).toBe(2);
    expect(rejected.events[0]?.payload).toMatchObject({ attempt: 2, from: 'assigned' });

    must(fx.tasks.assign({ taskId, actor: fx.ceoActor, simTime: sim(5), reason: 'retry' }), 'reassign');
    expect(fx.tasks.get(taskId)?.status).toBe('assigned');

    const rejectedAgain = must(
      fx.tasks.reject({ taskId, actor: fx.ceoActor, simTime: sim(6), reason: 'still bad' }),
      'reject2',
    );
    expect(rejectedAgain.task.attempt).toBe(3);

    const exhausted = fx.tasks.assign({ taskId, actor: fx.ceoActor, simTime: sim(7) });
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.error.code).toBe('retries_exhausted');
  });

  it('fail 从 started 进入 rejected 并累计 attempt', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createTask(fx);
    driveToStarted(fx, taskId, fx.ceoActor);
    const failed = must(
      fx.tasks.fail({ taskId, actor: fx.ceoActor, simTime: sim(5), reason: 'boom' }),
      'fail',
    );
    expect(failed.task.status).toBe('rejected');
    expect(failed.task.attempt).toBe(2);
    expect(failed.events[0]?.type).toBe('Task.Failed');
  });

  it('cancel 进入终态且 Task.Cancelled payload 仅含 taskId/reason/from', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createTask(fx);
    driveToStarted(fx, taskId, fx.ceoActor);
    const cancelled = must(
      fx.tasks.cancel({ taskId, actor: fx.ceoActor, simTime: sim(6), reason: 'superseded' }),
      'cancel',
    );
    expect(cancelled.task.status).toBe('cancelled');
    const payload = cancelled.events[0]?.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['from', 'reason', 'taskId']);
    expect(payload.from).toBe('started');
    expect(payload.reason).toBe('superseded');

    const afterTerminal = fx.tasks.start({ taskId, actor: fx.ceoActor, simTime: sim(7) });
    expect(afterTerminal.ok).toBe(false);
    if (!afterTerminal.ok) expect(afterTerminal.error.code).toBe('invalid_transition');
  });

  it('delete：写 Task.Deleted 后记录从库里消失，payload 为 taskId/reason/from', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createTask(fx);
    driveToStarted(fx, taskId, fx.ceoActor);

    const deleted = must(
      fx.tasks.delete({ taskId, actor: fx.ceoActor, simTime: sim(8), reason: 'superseded' }),
      'delete',
    );
    expect(deleted.taskId).toBe(taskId);
    expect(deleted.events.map((event) => event.type)).toEqual(['Task.Deleted']);
    const payload = deleted.events[0]?.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['from', 'reason', 'taskId']);
    expect(payload.from).toBe('started');
    expect(payload.reason).toBe('superseded');
    // The record is gone from both views: the service's own lookup and the store it folds into.
    expect(fx.tasks.get(taskId)).toBeNull();
    expect(fx.taskStore.get(taskId)).toBeNull();

    const again = fx.tasks.delete({
      taskId,
      actor: fx.ceoActor,
      simTime: sim(9),
      reason: 'again',
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('unknown_task');
  });

  it('delete：空 reason 拒绝，缺少 RejectTask 权限拒绝且记录原样保留', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createTask(fx);

    const noReason = fx.tasks.delete({
      taskId,
      actor: fx.ceoActor,
      simTime: sim(2),
      reason: '   ',
    });
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error.code).toBe('invalid_reason');
    expect(fx.tasks.get(taskId)).not.toBeNull();

    // Removing work is refusing work: it rides the same `RejectTask` gate `reject` uses.
    const policy: PermissionPolicy = {
      grants: workflowTestPolicy.grants.filter((rule) => rule.action !== 'RejectTask'),
      denies: [],
    };
    const restricted = createWorkflowFixture({ definitions: [], policy });
    const otherId = createTask(restricted);
    const denied = restricted.tasks.delete({
      taskId: otherId,
      actor: restricted.ceoActor,
      simTime: sim(3),
      reason: 'not allowed',
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('permission_denied');
    expect(restricted.tasks.get(otherId)).not.toBeNull();
    expect(restricted.taskStore.get(otherId)).not.toBeNull();
  });

  it('review 验证：submitted 后可评审，执行人不可自评，系统裁决被拒', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createTask(fx, {
      assignment: { kind: 'employee', employeeId: eid('cto-john') },
      verification: { kind: 'review', requiredOutputKeys: ['plan'] },
    });

    const earlyReview = fx.tasks.review({
      taskId,
      actor: fx.ceoActor,
      simTime: sim(4),
      review: { verdict: 'approved' },
    });
    expect(earlyReview.ok).toBe(false);
    if (!earlyReview.ok) expect(earlyReview.error.code).toBe('invalid_transition');

    driveToStarted(fx, taskId, fx.ctoActor);
    must(
      fx.tasks.submit({
        taskId,
        actor: fx.ctoActor,
        simTime: sim(5),
        submission: { summary: 'Plan ready', data: { plan: 'phased' } },
      }),
      'submit',
    );

    const selfReview = fx.tasks.review({
      taskId,
      actor: fx.ctoActor,
      simTime: sim(6),
      review: { verdict: 'approved' },
    });
    expect(selfReview.ok).toBe(false);
    if (!selfReview.ok) expect(selfReview.error.code).toBe('self_verification_forbidden');

    const systemReview = fx.tasks.review({
      taskId,
      actor: systemActor('review-bot', 'corr-review'),
      simTime: sim(6),
      review: { verdict: 'approved' },
    });
    expect(systemReview.ok).toBe(false);
    if (!systemReview.ok) expect(systemReview.error.code).toBe('invalid_actor');

    const approved = must(
      fx.tasks.review({
        taskId,
        actor: fx.ceoActor,
        simTime: sim(7),
        review: { verdict: 'approved', reason: 'solid' },
      }),
      'review',
    );
    expect(approved.task.status).toBe('submitted');
    expect(approved.task.reviews).toHaveLength(1);
    expect(approved.task.reviews[0]?.verdict).toBe('approved');
    expect(approved.events[0]?.payload).toMatchObject({ phase: 'reviewed' });
  });

  it('deterministic 任务不允许 review → verification_not_applicable', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createTask(fx, {
      assignment: { kind: 'employee', employeeId: eid('cto-john') },
      verification: { kind: 'deterministic', requiredOutputKeys: ['plan'] },
    });
    driveToStarted(fx, taskId, fx.ctoActor);
    must(
      fx.tasks.submit({
        taskId,
        actor: fx.ctoActor,
        simTime: sim(5),
        submission: { summary: 'ok', data: { plan: 'p' } },
      }),
      'submit',
    );
    const review = fx.tasks.review({
      taskId,
      actor: fx.ceoActor,
      simTime: sim(6),
      review: { verdict: 'approved' },
    });
    expect(review.ok).toBe(false);
    if (!review.ok) expect(review.error.code).toBe('verification_not_applicable');
  });

  it('提交内容不合法 → invalid_result', () => {
    const fx = createWorkflowFixture({ definitions: [] });
    const taskId = createTask(fx);
    driveToStarted(fx, taskId, fx.ceoActor);
    const bad = fx.tasks.submit({
      taskId,
      actor: fx.ceoActor,
      simTime: sim(5),
      submission: { summary: '', data: {} },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('invalid_result');
  });

  it('assignment 目标校验：未知岗位与不可执行员工', () => {
    const orgFiles: Record<string, string> = {
      'company.yaml': 'id: acme\nname: Acme\n',
      'departments/engineering.yaml': 'id: engineering\nname: Engineering\n',
      'positions/ceo.yaml': 'id: ceo\ntitle: CEO\n',
      'positions/cto.yaml': 'id: cto\ntitle: CTO\ndepartment: engineering\nreports_to: ceo\n',
      'positions/engineer.yaml':
        'id: engineer\ntitle: Engineer\ndepartment: engineering\nreports_to: cto\n',
      'positions/analyst.yaml':
        'id: analyst\ntitle: Analyst\ndepartment: engineering\nreports_to: cto\n',
      'employees/ceo-alex.yaml': 'id: ceo-alex\nname: Alex\nposition: ceo\n',
      'employees/cto-john.yaml': 'id: cto-john\nname: John\nposition: cto\n',
      'employees/engineer-mike.yaml': 'id: engineer-mike\nname: Mike\nposition: engineer\n',
      'employees/eve.yaml': 'id: eve\nname: Eve\nposition: analyst\nstatus: suspended\n',
    };
    const fx = createWorkflowFixture({
      organization: loadMemoryOrganization(orgFiles),
      definitions: [],
    });
    const operator = systemActor('task-admin', 'corr-admin');

    const unknownPosition = fx.tasks.create({
      actor: operator,
      simTime: sim(0),
      title: 'Ghost role',
      goal: 'Assign nowhere',
      assignment: { kind: 'position', positionId: pid('ghost') },
    });
    expect(unknownPosition.ok).toBe(false);
    if (!unknownPosition.ok) expect(unknownPosition.error.code).toBe('unknown_position');

    const created = must(
      fx.tasks.create({
        actor: operator,
        simTime: sim(0),
        title: 'For Eve',
        goal: 'Assign to suspended employee',
        assignment: { kind: 'employee', employeeId: eid('eve') },
      }),
      'create',
    );
    const assigned = fx.tasks.assign({
      taskId: created.task.taskId,
      actor: operator,
      simTime: sim(1),
    });
    expect(assigned.ok).toBe(false);
    if (!assigned.ok) expect(assigned.error.code).toBe('employee_not_executable');
  });
});
