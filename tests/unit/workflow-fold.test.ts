import { describe, expect, it } from 'vitest';
import type { CompanyId, OrgEvent, SimTime } from '@maoeh/shared-types';
import type { EventRegistry } from '@maoeh/event-system';
import { createEventRegistry, createOrgEvent } from '@maoeh/event-system';
import {
  applyWorkflowEvent,
  applyWorkflowEvents,
  registerWorkflowEvents,
  replayWorkflowInstance,
} from '@maoeh/workflow-engine';

const registry: EventRegistry = createEventRegistry();
const registration = registerWorkflowEvents(registry);
if (!registration.ok) throw new Error('workflow event registration failed');

const companyId = 'fal' as CompanyId;

function wfEvent(
  eventId: string,
  type: string,
  payload: unknown,
  occurredAtSim = 10,
): OrgEvent {
  const created = createOrgEvent(
    registry,
    {
      companyId,
      type,
      occurredAtSim: occurredAtSim as SimTime,
      actorKind: 'system',
      actorId: 'fold-test',
      subjectType: 'workflow',
      subjectId: 'wf-1',
      correlationId: 'corr-fold',
      payload,
    },
    { eventIdGenerator: () => eventId },
  );
  if (!created.ok) {
    throw new Error(
      created.error.issues.map((issue) => `${issue.field}: ${issue.reason}`).join(', '),
    );
  }
  return created.value;
}

const started = (eventId = 'e-start'): OrgEvent =>
  wfEvent(eventId, 'Workflow.InstanceStarted', {
    instanceId: 'wf-1',
    workflowId: 'wf-demo',
    version: 1,
    title: 'Demo',
    goal: 'Show the fold',
    context: { source: 'test' },
    initiatedBy: 'ceo-alex',
    entryStageId: 'stage-a',
  });

const entered = (eventId: string, stepId: string, taskId: string | null): OrgEvent =>
  wfEvent(eventId, 'Workflow.StepEntered', {
    instanceId: 'wf-1',
    stageId: 'stage-a',
    stepId,
    kind: 'task',
    taskId,
    assigneePositionId: 'ceo',
    assigneeEmployeeId: taskId === null ? null : 'ceo-alex',
  });

const completed = (eventId: string, stepId: string, outputs: unknown): OrgEvent =>
  wfEvent(eventId, 'Workflow.StepCompleted', {
    instanceId: 'wf-1',
    stageId: 'stage-a',
    stepId,
    outcome: 'verified',
    taskId: `${stepId}-task`,
    outputs,
  });

describe('M0.8 折叠（workflow-fold）', () => {
  it('InstanceStarted 建立初始实例', () => {
    const instance = applyWorkflowEvent(null, started());
    expect(instance).not.toBeNull();
    expect(instance?.instanceId).toBe('wf-1');
    expect(instance?.status).toBe('running');
    expect(instance?.currentStageId).toBe('stage-a');
    expect(instance?.sourceEventId).toBe('e-start');
    expect(instance?.initiatedBy).toBe('ceo-alex');
    expect(instance?.context).toEqual({ source: 'test' });
    expect(instance?.processedEventIds).toEqual([]);
  });

  it('StepEntered 激活步；StepCompleted 置 done 并合并 outputs', () => {
    let instance = applyWorkflowEvent(null, started());
    instance = applyWorkflowEvent(instance, entered('e-enter', 'step-1', 'task-1'));
    expect(instance?.activeStepIds).toEqual(['step-1']);
    expect(instance?.stepStates['step-1']?.status).toBe('active');
    expect(instance?.stepStates['step-1']?.taskId).toBe('task-1');

    instance = applyWorkflowEvent(instance, completed('e-done', 'step-1', { answer: 42 }));
    expect(instance?.stepStates['step-1']?.status).toBe('done');
    expect(instance?.stepStates['step-1']?.outcome).toBe('verified');
    expect(instance?.activeStepIds).toEqual([]);
    expect(instance?.outputs).toEqual({ 'step-1': { answer: 42 } });
  });

  it('StepRejected 置 rejected 并以 reason 记录 outcome', () => {
    let instance = applyWorkflowEvent(null, started());
    instance = applyWorkflowEvent(instance, entered('e-enter', 'step-1', 'task-1'));
    instance = applyWorkflowEvent(
      instance,
      wfEvent('e-reject', 'Workflow.StepRejected', {
        instanceId: 'wf-1',
        stageId: 'stage-a',
        stepId: 'step-1',
        reason: 'missing output keys: answer',
        taskId: 'task-1',
      }),
    );
    expect(instance?.stepStates['step-1']?.status).toBe('rejected');
    expect(instance?.stepStates['step-1']?.outcome).toBe('missing output keys: answer');
    expect(instance?.activeStepIds).toEqual([]);
  });

  it('ApprovalRequested 阻塞实例；ApprovalGranted 达标后恢复 running', () => {
    let instance = applyWorkflowEvent(null, started());
    instance = applyWorkflowEvent(
      instance,
      wfEvent('e-req', 'Workflow.ApprovalRequested', {
        instanceId: 'wf-1',
        stepId: 'gate',
        approvalKey: 'wf-1:gate',
        policy: 'quorum',
        requiredCount: 2,
        requiredLevel: 1,
        requiredRoles: ['ceo', 'cto'],
        requestedBy: 'workflow-engine',
        requestedAtSim: 10,
      }),
    );
    expect(instance?.status).toBe('blocked');
    expect(instance?.blockedReason?.kind).toBe('approval');
    expect(instance?.approval?.status).toBe('open');
    expect(instance?.approval?.grantedBy).toEqual([]);

    instance = applyWorkflowEvent(
      instance,
      wfEvent('e-g1', 'Workflow.ApprovalGranted', {
        instanceId: 'wf-1',
        stepId: 'gate',
        approvalKey: 'wf-1:gate',
        decidedBy: 'ceo-alex',
        grantedCount: 1,
        reason: null,
      }),
    );
    expect(instance?.status).toBe('blocked');
    expect(instance?.approval?.status).toBe('open');
    expect(instance?.approval?.grantedBy).toEqual(['ceo-alex']);

    instance = applyWorkflowEvent(
      instance,
      wfEvent('e-g2', 'Workflow.ApprovalGranted', {
        instanceId: 'wf-1',
        stepId: 'gate',
        approvalKey: 'wf-1:gate',
        decidedBy: 'cto-john',
        grantedCount: 2,
        reason: null,
      }),
    );
    expect(instance?.status).toBe('running');
    expect(instance?.blockedReason).toBeNull();
    expect(instance?.approval?.status).toBe('granted');
  });

  it('ApprovalDenied 记录决策人与原因', () => {
    let instance = applyWorkflowEvent(null, started());
    instance = applyWorkflowEvent(
      instance,
      wfEvent('e-req', 'Workflow.ApprovalRequested', {
        instanceId: 'wf-1',
        stepId: 'gate',
        approvalKey: 'wf-1:gate',
        policy: 'single',
        requiredCount: 1,
        requiredLevel: 0,
        requiredRoles: ['ceo'],
        requestedBy: 'workflow-engine',
        requestedAtSim: 10,
      }),
    );
    instance = applyWorkflowEvent(
      instance,
      wfEvent('e-denied', 'Workflow.ApprovalDenied', {
        instanceId: 'wf-1',
        stepId: 'gate',
        approvalKey: 'wf-1:gate',
        decidedBy: 'ceo-alex',
        reason: 'not enough evidence',
      }),
    );
    expect(instance?.approval?.status).toBe('denied');
    expect(instance?.approval?.decidedBy).toBe('ceo-alex');
    expect(instance?.approval?.reason).toBe('not enough evidence');
  });

  it('InstanceBlocked/InstanceResumed 切换人工暂停', () => {
    let instance = applyWorkflowEvent(null, started());
    instance = applyWorkflowEvent(
      instance,
      wfEvent('e-block', 'Workflow.InstanceBlocked', {
        instanceId: 'wf-1',
        kind: 'manual',
        detail: 'paused by operator',
        stepId: 'step-1',
      }),
    );
    expect(instance?.status).toBe('blocked');
    expect(instance?.blockedReason).toEqual({
      kind: 'manual',
      detail: 'paused by operator',
      stepId: 'step-1',
    });

    instance = applyWorkflowEvent(
      instance,
      wfEvent('e-resume', 'Workflow.InstanceResumed', {
        instanceId: 'wf-1',
        resumedBy: 'ceo-alex',
      }),
    );
    expect(instance?.status).toBe('running');
    expect(instance?.blockedReason).toBeNull();
  });

  it('InstanceCompleted/InstanceAborted 进入终态并清空活动步', () => {
    let completedInstance = applyWorkflowEvent(null, started());
    completedInstance = applyWorkflowEvent(completedInstance, entered('e-enter', 'step-1', 't'));
    completedInstance = applyWorkflowEvent(
      completedInstance,
      wfEvent('e-done', 'Workflow.InstanceCompleted', {
        instanceId: 'wf-1',
        reason: 'workflow_complete',
      }),
    );
    expect(completedInstance?.status).toBe('completed');
    expect(completedInstance?.activeStepIds).toEqual([]);
    expect(completedInstance?.blockedReason).toBeNull();

    let abortedInstance = applyWorkflowEvent(null, started());
    abortedInstance = applyWorkflowEvent(
      abortedInstance,
      wfEvent('e-abort', 'Workflow.InstanceAborted', {
        instanceId: 'wf-1',
        reason: 'task_failed',
        detail: 'missing output keys: answer',
      }),
    );
    expect(abortedInstance?.status).toBe('aborted');
    expect(abortedInstance?.activeStepIds).toEqual([]);
  });

  it('非工作流事件原样返回；非 InstanceStarted 开头返回 null', () => {
    const instance = applyWorkflowEvent(null, started());
    const foreign: OrgEvent = {
      ...started('e-foreign'),
      type: 'Runtime.PresenceChanged' as OrgEvent['type'],
    };
    expect(applyWorkflowEvent(instance, foreign)).toBe(instance);
    expect(applyWorkflowEvent(null, entered('e-enter', 'step-1', 'task-1'))).toBeNull();
  });

  it('replayWorkflowInstance 与逐事件折叠等价（不含 bookkeeping 差异）', () => {
    const stream: OrgEvent[] = [
      started(),
      entered('e-enter', 'step-1', 'task-1'),
      completed('e-done', 'step-1', { answer: 1 }),
      entered('e-enter-2', 'step-2', 'task-2'),
      wfEvent('e-abort', 'Workflow.InstanceAborted', {
        instanceId: 'wf-1',
        reason: 'task_failed',
        detail: 'boom',
      }),
    ];
    const replayed = replayWorkflowInstance(stream);
    const folded = applyWorkflowEvents(stream);
    expect(replayed).not.toBeNull();
    expect(replayed).toEqual(folded);
    expect(replayed?.status).toBe('aborted');
  });
});
