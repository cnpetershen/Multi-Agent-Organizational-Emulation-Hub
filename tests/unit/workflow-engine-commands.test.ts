import { describe, expect, it } from 'vitest';
import type { Action } from '@maoeh/shared-types';
import type { PermissionPolicy } from '@maoeh/permission-system';
import type { WorkflowDefinition } from '@maoeh/workflow-engine';
import { replayWorkflowInstance } from '@maoeh/workflow-engine';
import type { WorkflowFixture } from '../helpers/workflow-fixtures';
import { createWorkflowFixture, must, sim, workflowTestPolicy } from '../helpers/workflow-fixtures';

function startProductAnalysis(fx: WorkflowFixture): string {
  const started = must(
    fx.engine.start({
      workflowId: 'product-analysis',
      actor: fx.ceoActor,
      simTime: sim(0),
      title: 'Analyze the market',
      goal: 'Explain the competitive landscape',
    }),
    'engine.start',
  );
  return started.instance.instanceId;
}

function approvalEntryDefinition(workflowId: string): WorkflowDefinition {
  return {
    workflowId,
    version: 1,
    name: 'Approval Entry',
    description: null,
    cyclePolicy: 'forbid',
    entryStageId: 'gate-stage',
    terminalStageIds: ['gate-stage'],
    stages: [
      {
        stageId: 'gate-stage',
        name: 'Gate',
        steps: [
          {
            stepId: 'gate',
            name: 'Approval gate',
            kind: 'approval',
            description: null,
            assignment: null,
            verification: null,
            maxAttempts: 1,
            requiredAuthority: null,
            requiredRoles: ['ceo'],
            approvalPolicy: 'single',
            requiredCount: 1,
          },
        ],
        transitions: [
          {
            transitionId: 'gate__granted',
            fromStepId: 'gate',
            when: { kind: 'approval_decision', decision: 'granted' },
            to: { kind: 'complete' },
          },
          {
            transitionId: 'gate__denied',
            fromStepId: 'gate',
            when: { kind: 'approval_decision', decision: 'denied' },
            to: { kind: 'fail', reason: 'gate_denied' },
          },
        ],
      },
    ],
  };
}

describe('M0.8 实例命令与门禁（workflow-engine wait/resume/commands/gate）', () => {
  it('wait 暂停为 manual 阻塞；resume 恢复运行', () => {
    const fx = createWorkflowFixture();
    const instanceId = startProductAnalysis(fx);

    const paused = must(
      fx.engine.wait({ instanceId, actor: fx.ceoActor, simTime: sim(1) }),
      'engine.wait',
    );
    expect(paused.outcome).toBe('paused');
    expect(paused.events.map((event) => event.type)).toEqual(['Workflow.InstanceBlocked']);
    expect(paused.instance.status).toBe('blocked');
    expect(paused.instance.blockedReason).toEqual({
      kind: 'manual',
      detail: 'paused by operator',
      stepId: 'intake-brief',
    });

    const blockedAgain = fx.engine.wait({ instanceId, actor: fx.ceoActor, simTime: sim(2) });
    expect(blockedAgain.ok).toBe(false);
    if (!blockedAgain.ok) expect(blockedAgain.error.code).toBe('instance_blocked');

    const resumed = must(
      fx.engine.resume({ instanceId, actor: fx.ceoActor, simTime: sim(3) }),
      'engine.resume',
    );
    expect(resumed.outcome).toBe('resumed');
    expect(resumed.events.map((event) => event.type)).toEqual(['Workflow.InstanceResumed']);
    expect(resumed.instance.status).toBe('running');
    expect(resumed.instance.blockedReason).toBeNull();

    const resumeWhileRunning = fx.engine.resume({
      instanceId,
      actor: fx.ceoActor,
      simTime: sim(4),
    });
    expect(resumeWhileRunning.ok).toBe(false);
    if (!resumeWhileRunning.ok) {
      expect(resumeWhileRunning.error.code).toBe('instance_not_running');
    }
  });

  it('审批阻塞的实例不能用 resume 解除 → approval_not_open', () => {
    const fx = createWorkflowFixture({
      definitions: [approvalEntryDefinition('wf-gate-entry')],
    });
    const started = must(
      fx.engine.start({
        workflowId: 'wf-gate-entry',
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Blocked run',
        goal: 'Blocked on approval',
      }),
      'engine.start',
    );
    expect(started.instance.status).toBe('blocked');
    expect(started.instance.blockedReason?.kind).toBe('approval');

    const resumed = fx.engine.resume({
      instanceId: started.instance.instanceId,
      actor: fx.ceoActor,
      simTime: sim(1),
    });
    expect(resumed.ok).toBe(false);
    if (!resumed.ok) expect(resumed.error.code).toBe('approval_not_open');
  });

  it('缺少 RequestDeviation 权限时 wait 被拒', () => {
    const policy: PermissionPolicy = {
      grants: workflowTestPolicy.grants.filter((rule) => rule.action !== 'RequestDeviation'),
      denies: [],
    };
    const fx = createWorkflowFixture({ policy });
    const instanceId = startProductAnalysis(fx);
    const paused = fx.engine.wait({ instanceId, actor: fx.ceoActor, simTime: sim(1) });
    expect(paused.ok).toBe(false);
    if (!paused.ok) expect(paused.error.code).toBe('permission_denied');
    expect(fx.instance(instanceId)?.status).toBe('running');
  });

  it('手动 complete：取消活动任务、步置 done、实例完成', () => {
    const fx = createWorkflowFixture();
    const instanceId = startProductAnalysis(fx);
    const taskId = fx.instance(instanceId)?.stepStates['intake-brief']?.taskId ?? '';

    const completed = must(
      fx.engine.complete({ instanceId, actor: fx.ceoActor, simTime: sim(2) }),
      'engine.complete',
    );
    expect(completed.outcome).toBe('completed');
    expect(completed.events.map((event) => event.type)).toEqual([
      'Task.Cancelled',
      'Workflow.StepCompleted',
      'Workflow.InstanceCompleted',
    ]);
    expect(completed.events[0]?.payload).toMatchObject({
      taskId,
      reason: 'workflow_complete',
      from: 'assigned',
    });
    expect(completed.instance.status).toBe('completed');
    expect(completed.instance.activeStepIds).toEqual([]);
    expect(completed.instance.stepStates['intake-brief']?.status).toBe('done');
    expect(completed.instance.stepStates['intake-brief']?.outcome).toBe('manual');
    expect(fx.tasks.get(taskId)?.status).toBe('cancelled');

    const afterTerminal = fx.engine.fail({ instanceId, actor: fx.ceoActor, simTime: sim(3) });
    expect(afterTerminal.ok).toBe(false);
    if (!afterTerminal.ok) expect(afterTerminal.error.code).toBe('instance_terminal');
  });

  it('手动 fail：步 rejected、实例 aborted（reason=failed）', () => {
    const fx = createWorkflowFixture();
    const instanceId = startProductAnalysis(fx);
    const taskId = fx.instance(instanceId)?.stepStates['intake-brief']?.taskId ?? '';

    const failed = must(
      fx.engine.fail({ instanceId, actor: fx.ceoActor, simTime: sim(2) }),
      'engine.fail',
    );
    expect(failed.outcome).toBe('aborted');
    expect(failed.events.map((event) => event.type)).toEqual([
      'Task.Cancelled',
      'Workflow.StepRejected',
      'Workflow.InstanceAborted',
    ]);
    expect(failed.events[0]?.payload).toMatchObject({ taskId, reason: 'workflow_fail' });
    expect(failed.instance.status).toBe('aborted');
    expect(failed.instance.stepStates['intake-brief']?.status).toBe('rejected');
    expect(failed.instance.stepStates['intake-brief']?.outcome).toBe('manual fail');
    expect(failed.events[2]?.payload).toMatchObject({ reason: 'failed', detail: 'manual fail' });
    expect(fx.tasks.get(taskId)?.status).toBe('cancelled');
  });

  it('手动 cancel：携带 reason，实例 aborted（reason=cancelled）', () => {
    const fx = createWorkflowFixture();
    const instanceId = startProductAnalysis(fx);

    const cancelled = must(
      fx.engine.cancel({
        instanceId,
        actor: fx.ceoActor,
        simTime: sim(2),
        reason: 'operator cancelled',
      }),
      'engine.cancel',
    );
    expect(cancelled.outcome).toBe('aborted');
    expect(cancelled.events.map((event) => event.type)).toEqual([
      'Task.Cancelled',
      'Workflow.StepRejected',
      'Workflow.InstanceAborted',
    ]);
    expect(cancelled.events[0]?.payload).toMatchObject({
      reason: 'workflow_cancel',
      from: 'assigned',
    });
    expect(cancelled.events[2]?.payload).toMatchObject({
      reason: 'cancelled',
      detail: 'operator cancelled',
    });
    expect(cancelled.instance.status).toBe('aborted');
  });

  it('gate 裁决：执行人 allowed、非执行人 assignment 失败、未知步报错', () => {
    const fx = createWorkflowFixture();
    const instanceId = startProductAnalysis(fx);
    // The gate is about the seat that actually holds the step; routing decides who that is.
    const taskId = fx.instance(instanceId)?.stepStates['intake-brief']?.taskId ?? '';
    const assigneeId = String(fx.tasks.get(taskId)?.assignment.assigneeEmployeeId ?? '');

    const allowed = must(
      fx.engine.gate({
        instanceId,
        stepId: 'intake-brief',
        actor: fx.executorActor(taskId),
        action: 'ApproveStep' as Action,
      }),
      'gate executor',
    );
    expect(allowed.allowed).toBe(true);
    expect(allowed.kind).toBe('task');
    expect(allowed.status).toBe('active');
    expect(allowed.assigneeEmployeeId).toBe(assigneeId);
    expect(allowed.checks.every((check) => check.passed)).toBe(true);

    const mismatch = must(
      fx.engine.gate({
        instanceId,
        stepId: 'intake-brief',
        actor: fx.engineerActor,
        action: 'ApproveStep' as Action,
      }),
      'gate engineer',
    );
    expect(mismatch.allowed).toBe(false);
    const assignmentCheck = mismatch.checks.find((check) => check.check === 'assignment');
    expect(assignmentCheck?.passed).toBe(false);
    expect(assignmentCheck?.reason).toContain(assigneeId);

    const unknownStep = fx.engine.gate({
      instanceId,
      stepId: 'ghost-step',
      actor: fx.ceoActor,
      action: 'ApproveStep' as Action,
    });
    expect(unknownStep.ok).toBe(false);
    if (!unknownStep.ok) expect(unknownStep.error.code).toBe('invalid_definition');

    const unknownInstance = fx.engine.gate({
      instanceId: 'ghost-instance',
      stepId: 'intake-brief',
      actor: fx.ceoActor,
      action: 'ApproveStep' as Action,
    });
    expect(unknownInstance.ok).toBe(false);
    if (!unknownInstance.ok) expect(unknownInstance.error.code).toBe('unknown_instance');
  });

  it('delete：实例与它拥有的任务一起离开，整条流折回 null', () => {
    const fx = createWorkflowFixture();
    const started = must(
      fx.engine.start({
        workflowId: 'product-analysis',
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Analyze the market',
        goal: 'Explain the competitive landscape',
      }),
      'engine.start',
    );
    const instanceId = started.instance.instanceId;
    const taskId = started.instance.stepStates['intake-brief']?.taskId ?? '';

    const deleted = must(
      fx.engine.delete({ instanceId, actor: fx.ceoActor, simTime: sim(2), reason: 'superseded' }),
      'engine.delete',
    );
    expect(deleted.outcome).toBe('deleted');
    expect(deleted.events.map((event) => event.type)).toEqual([
      'Task.Deleted',
      'Workflow.InstanceDeleted',
    ]);
    expect(deleted.events[0]?.payload).toMatchObject({
      taskId,
      reason: 'superseded',
      from: 'assigned',
    });
    expect(deleted.events[1]?.payload).toMatchObject({
      instanceId,
      reason: 'superseded',
      taskIds: [taskId],
    });

    // Both records are gone: the instance out of its store, the task out of the task service.
    expect(fx.instance(instanceId)).toBeNull();
    expect(fx.tasks.get(taskId)).toBeNull();

    // …while the log still carries every fact that led there, and replaying all of it empties
    // the instance again — which is what a restart reads instead of the record it dropped.
    expect(replayWorkflowInstance([...started.events, ...deleted.events])).toBeNull();

    const again = fx.engine.delete({
      instanceId,
      actor: fx.ceoActor,
      simTime: sim(3),
      reason: 'again',
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('unknown_instance');
  });

  it('delete：缺少 RejectStep 权限时实例原样保留', () => {
    const policy: PermissionPolicy = {
      grants: workflowTestPolicy.grants.filter((rule) => rule.action !== 'RejectStep'),
      denies: [],
    };
    const fx = createWorkflowFixture({ policy });
    const instanceId = startProductAnalysis(fx);
    const taskId = fx.instance(instanceId)?.stepStates['intake-brief']?.taskId ?? '';

    const denied = fx.engine.delete({
      instanceId,
      actor: fx.ceoActor,
      simTime: sim(2),
      reason: 'not allowed',
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('permission_denied');
    expect(fx.instance(instanceId)).not.toBeNull();
    expect(fx.tasks.get(taskId)).not.toBeNull();
  });

  it('delete：级联中途无权拒绝任务时整次删除退回，不留半截状态', () => {
    // `RejectStep` answers for `workflow:<id>`; the cascade checks `RejectTask` per task id, so a
    // policy may refuse the second task while allowing the instance and the first one.
    const policy: PermissionPolicy = {
      grants: workflowTestPolicy.grants,
      denies: [{ subject: { kind: 'any' }, action: 'RejectTask', resource: 'task:task-2' }],
    };
    const fx = createWorkflowFixture({ policy });
    const instanceId = startProductAnalysis(fx);
    const firstTaskId = fx.instance(instanceId)?.stepStates['intake-brief']?.taskId ?? '';

    // Drive the intake step to completion so the design step activates and mints a second task.
    const firstActor = fx.executorActor(firstTaskId);
    must(fx.tasks.accept({ taskId: firstTaskId, actor: firstActor, simTime: sim(1) }), 'accept');
    must(fx.tasks.start({ taskId: firstTaskId, actor: firstActor, simTime: sim(2) }), 'start');
    const submitted = must(
      fx.tasks.submit({
        taskId: firstTaskId,
        actor: firstActor,
        simTime: sim(3),
        submission: {
          summary: 'done',
          data: {
            problem: 'churn is rising',
            success_criteria: 'root causes identified',
          },
        },
      }),
      'submit',
    );
    must(
      fx.engine.advance({
        instanceId,
        actor: firstActor,
        event: submitted.events[0] as NonNullable<typeof submitted.events[0]>,
        simTime: sim(4),
      }),
      'advance',
    );
    const secondTaskId = fx.instance(instanceId)?.stepStates['design-approach']?.taskId ?? '';
    expect(secondTaskId).toBe('task-2');

    const denied = fx.engine.delete({
      instanceId,
      actor: fx.ceoActor,
      simTime: sim(5),
      reason: 'not allowed on one task',
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('permission_denied');

    // Nothing moved: a denial discovered halfway through must not leave the log and the stores
    // disagreeing about which tasks exist.
    expect(fx.instance(instanceId)).not.toBeNull();
    expect(fx.tasks.get(firstTaskId)).not.toBeNull();
    expect(fx.tasks.get(secondTaskId)).not.toBeNull();
  });
});
