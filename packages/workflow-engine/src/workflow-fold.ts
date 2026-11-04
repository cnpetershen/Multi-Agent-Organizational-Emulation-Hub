import type { AuthorityLevel, OrgEvent, SimTime } from '@maoeh/shared-types';
import { isWorkflowEvent } from './workflow-events.js';
import type {
  ApprovalDeniedPayload,
  ApprovalGrantedPayload,
  ApprovalRequestedPayload,
  InstanceAbortedPayload,
  InstanceBlockedPayload,
  InstanceCompletedPayload,
  InstanceResumedPayload,
  InstanceStartedPayload,
  StepCompletedPayload,
  StepEnteredPayload,
  StepRejectedPayload,
} from './workflow-events.js';
import {
  WORKFLOW_APPROVAL_DENIED,
  WORKFLOW_APPROVAL_GRANTED,
  WORKFLOW_APPROVAL_REQUESTED,
  WORKFLOW_INSTANCE_ABORTED,
  WORKFLOW_INSTANCE_BLOCKED,
  WORKFLOW_INSTANCE_COMPLETED,
  WORKFLOW_INSTANCE_DELETED,
  WORKFLOW_INSTANCE_RESUMED,
  WORKFLOW_INSTANCE_STARTED,
  WORKFLOW_STEP_COMPLETED,
  WORKFLOW_STEP_ENTERED,
  WORKFLOW_STEP_REJECTED,
} from './workflow-events.js';
import type {
  StepState,
  WorkflowApproval,
  WorkflowBlockedReason,
  WorkflowInstance,
} from './workflow-types.js';

function payloadInstanceId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const instanceId = (payload as { readonly instanceId?: unknown }).instanceId;
  return typeof instanceId === 'string' ? instanceId : null;
}

function freezeStepState(state: StepState): StepState {
  return Object.freeze({ ...state });
}

function freezeApproval(approval: WorkflowApproval): WorkflowApproval {
  return Object.freeze({
    ...approval,
    requiredRoles: Object.freeze([...approval.requiredRoles]),
    grantedBy: Object.freeze([...approval.grantedBy]),
  });
}

function freezeInstance(instance: WorkflowInstance): WorkflowInstance {
  Object.freeze(instance.activeStepIds);
  for (const state of Object.values(instance.stepStates)) freezeStepState(state);
  Object.freeze(instance.stepStates);
  Object.freeze(instance.context);
  Object.freeze(instance.outputs);
  if (instance.blockedReason !== null) Object.freeze(instance.blockedReason);
  if (instance.approval !== null) freezeApproval(instance.approval);
  Object.freeze(instance.processedEventIds);
  return Object.freeze(instance);
}

function buildInitial(payload: InstanceStartedPayload, event: OrgEvent): WorkflowInstance {
  return {
    instanceId: payload.instanceId,
    companyId: event.companyId,
    workflowId: payload.workflowId,
    version: payload.version,
    title: payload.title,
    goal: payload.goal,
    status: 'running',
    currentStageId: payload.entryStageId,
    activeStepIds: Object.freeze([]),
    stepStates: Object.freeze({}),
    context: Object.freeze({ ...payload.context }),
    outputs: Object.freeze({}),
    initiatedBy: payload.initiatedBy,
    correlationId: event.correlationId,
    startedAtSim: event.occurredAtSim,
    completedAtSim: null,
    abortedAtSim: null,
    blockedReason: null,
    approval: null,
    sourceEventId: event.eventId,
    processedEventIds: Object.freeze([]),
  };
}

function clearApprovalBlock(instance: WorkflowInstance): Pick<
  WorkflowInstance,
  'status' | 'blockedReason'
> {
  if (instance.status === 'blocked' && instance.blockedReason !== null) {
    if (instance.blockedReason.kind === 'manual') {
      return { status: instance.status, blockedReason: instance.blockedReason };
    }
    return { status: 'running', blockedReason: null };
  }
  return { status: instance.status, blockedReason: instance.blockedReason };
}

function applyStepEntered(current: WorkflowInstance, event: OrgEvent): WorkflowInstance {
  const payload = event.payload as StepEnteredPayload;
  const state: StepState = {
    stepId: payload.stepId,
    status: 'active',
    enteredAtSim: event.occurredAtSim,
    completedAtSim: null,
    outcome: null,
    taskId: payload.taskId,
  };
  const block = clearApprovalBlock(current);
  return freezeInstance({
    ...current,
    ...block,
    currentStageId: payload.stageId,
    activeStepIds: Object.freeze([
      ...current.activeStepIds.filter((stepId) => stepId !== payload.stepId),
      payload.stepId,
    ]),
    stepStates: Object.freeze({
      ...current.stepStates,
      [payload.stepId]: state,
    }),
  });
}

function settleStep(
  current: WorkflowInstance,
  event: OrgEvent,
  status: 'done' | 'rejected',
): WorkflowInstance {
  if (status === 'done') {
    const payload = event.payload as StepCompletedPayload;
    const existing = current.stepStates[payload.stepId];
    if (existing === undefined) return current;
    const state: StepState = {
      ...existing,
      status,
      completedAtSim: event.occurredAtSim,
      outcome: payload.outcome,
    };
    return freezeInstance({
      ...current,
      outputs: mergeOutputs(current, payload),
      activeStepIds: Object.freeze(
        current.activeStepIds.filter((stepId) => stepId !== payload.stepId),
      ),
      stepStates: Object.freeze({
        ...current.stepStates,
        [payload.stepId]: state,
      }),
    });
  }
  const payload = event.payload as StepRejectedPayload;
  const existing = current.stepStates[payload.stepId];
  if (existing === undefined) return current;
  const state: StepState = {
    ...existing,
    status,
    completedAtSim: event.occurredAtSim,
    outcome: payload.reason,
  };
  return freezeInstance({
    ...current,
    activeStepIds: Object.freeze(
      current.activeStepIds.filter((stepId) => stepId !== payload.stepId),
    ),
    stepStates: Object.freeze({
      ...current.stepStates,
      [payload.stepId]: state,
    }),
  });
}

function mergeOutputs(
  current: WorkflowInstance,
  payload: StepCompletedPayload,
): Readonly<Record<string, unknown>> {
  if (payload.outputs === null || payload.outputs === undefined) return current.outputs;
  const previous = current.outputs as Record<string, unknown>;
  return Object.freeze({ ...previous, [payload.stepId]: payload.outputs });
}

function applyApprovalRequested(
  current: WorkflowInstance,
  event: OrgEvent,
): WorkflowInstance {
  const payload = event.payload as ApprovalRequestedPayload;
  const approval: WorkflowApproval = {
    approvalKey: payload.approvalKey,
    stepId: payload.stepId,
    status: 'open',
    policy: payload.policy,
    requiredCount: payload.requiredCount,
    requiredLevel: payload.requiredLevel as AuthorityLevel,
    requiredRoles: Object.freeze([...payload.requiredRoles]),
    requestedBy: payload.requestedBy,
    requestedAtSim: payload.requestedAtSim as SimTime,
    grantedBy: Object.freeze([]),
    decidedBy: null,
    decidedAtSim: null,
    reason: null,
  };
  const blocked: WorkflowBlockedReason = {
    kind: 'approval',
    detail: `awaiting approval on ${payload.stepId}`,
    stepId: payload.stepId,
  };
  return freezeInstance({
    ...current,
    status: 'blocked',
    blockedReason: blocked,
    approval,
  });
}

function applyApprovalGranted(
  current: WorkflowInstance,
  event: OrgEvent,
): WorkflowInstance {
  const payload = event.payload as ApprovalGrantedPayload;
  const approval = current.approval;
  if (approval === null || approval.approvalKey !== payload.approvalKey) return current;
  const grantedBy = approval.grantedBy.includes(payload.decidedBy)
    ? approval.grantedBy
    : Object.freeze([...approval.grantedBy, payload.decidedBy]);
  const settled = payload.grantedCount >= approval.requiredCount;
  const nextApproval: WorkflowApproval = {
    ...approval,
    status: settled ? 'granted' : 'open',
    grantedBy,
    decidedBy: payload.decidedBy,
    decidedAtSim: event.occurredAtSim,
    reason: payload.reason,
  };
  return freezeInstance({
    ...current,
    status: settled ? 'running' : current.status,
    blockedReason: settled ? null : current.blockedReason,
    approval: nextApproval,
  });
}

function applyApprovalDenied(current: WorkflowInstance, event: OrgEvent): WorkflowInstance {
  const payload = event.payload as ApprovalDeniedPayload;
  const approval = current.approval;
  if (approval === null || approval.approvalKey !== payload.approvalKey) return current;
  return freezeInstance({
    ...current,
    approval: {
      ...approval,
      status: 'denied',
      decidedBy: payload.decidedBy,
      decidedAtSim: event.occurredAtSim,
      reason: payload.reason,
    },
  });
}

export function applyWorkflowEvent(
  current: WorkflowInstance | null,
  event: OrgEvent,
): WorkflowInstance | null {
  if (!isWorkflowEvent(event.type)) return current;

  if (event.type === WORKFLOW_INSTANCE_STARTED) {
    return freezeInstance(buildInitial(event.payload as InstanceStartedPayload, event));
  }
  if (current === null) return current;
  if (payloadInstanceId(event.payload) !== current.instanceId) return current;

  switch (event.type) {
    case WORKFLOW_STEP_ENTERED:
      return applyStepEntered(current, event);
    case WORKFLOW_STEP_COMPLETED:
      return settleStep(current, event, 'done');
    case WORKFLOW_STEP_REJECTED:
      return settleStep(current, event, 'rejected');
    case WORKFLOW_APPROVAL_REQUESTED:
      return applyApprovalRequested(current, event);
    case WORKFLOW_APPROVAL_GRANTED:
      return applyApprovalGranted(current, event);
    case WORKFLOW_APPROVAL_DENIED:
      return applyApprovalDenied(current, event);
    case WORKFLOW_INSTANCE_COMPLETED: {
      const payload = event.payload as InstanceCompletedPayload;
      void payload;
      return freezeInstance({
        ...current,
        status: 'completed',
        completedAtSim: event.occurredAtSim,
        activeStepIds: Object.freeze([]),
        blockedReason: null,
      });
    }
    case WORKFLOW_INSTANCE_ABORTED: {
      const payload = event.payload as InstanceAbortedPayload;
      void payload;
      return freezeInstance({
        ...current,
        status: 'aborted',
        abortedAtSim: event.occurredAtSim,
        activeStepIds: Object.freeze([]),
        blockedReason: null,
      });
    }
    case WORKFLOW_INSTANCE_BLOCKED: {
      const payload = event.payload as InstanceBlockedPayload;
      return freezeInstance({
        ...current,
        status: 'blocked',
        blockedReason: {
          kind: payload.kind,
          detail: payload.detail,
          stepId: payload.stepId,
        },
      });
    }
    case WORKFLOW_INSTANCE_RESUMED: {
      const payload = event.payload as InstanceResumedPayload;
      void payload;
      return freezeInstance({
        ...current,
        status: 'running',
        blockedReason: null,
      });
    }
    /**
     * The instance is gone. `null` is what makes a restart rebuild nothing — the group of
     * events still exists on the log, but it no longer describes anything to store.
     */
    case WORKFLOW_INSTANCE_DELETED:
      return null;
    default:
      return current;
  }
}

export function applyWorkflowEvents(
  events: readonly OrgEvent[],
): WorkflowInstance | null {
  let instance: WorkflowInstance | null = null;
  for (const event of events) {
    instance = applyWorkflowEvent(instance, event);
  }
  return instance;
}

export function replayWorkflowInstance(
  events: readonly OrgEvent[],
): WorkflowInstance | null {
  return applyWorkflowEvents(events);
}
