import type { EmployeeId, OrgEvent, PositionId, SimTime } from '@maoeh/shared-types';
import type {
  Task,
  TaskAssignment,
  TaskHandoff,
  TaskResult,
  TaskReview,
  TaskVerification,
} from './task-types.js';
import { isTaskEvent } from './task-events.js';
import type {
  TaskAssignedPayload,
  TaskBlockedPayload,
  TaskCompletedPayload,
  TaskCreatedPayload,
  TaskFailedPayload,
  TaskHandoffAcceptedPayload,
  TaskHandoffCompletedPayload,
  TaskHandoffDeclinedPayload,
  TaskHandoffRequestedPayload,
  TaskProgressReportedPayload,
  TaskRejectedPayload,
} from './task-events.js';
import {
  TASK_ACCEPTED,
  TASK_ASSIGNED,
  TASK_BLOCKED,
  TASK_CANCELLED,
  TASK_COMPLETED,
  TASK_CREATED,
  TASK_DELETED,
  TASK_FAILED,
  TASK_HANDOFF_ACCEPTED,
  TASK_HANDOFF_COMPLETED,
  TASK_HANDOFF_DECLINED,
  TASK_HANDOFF_REQUESTED,
  TASK_PROGRESS_REPORTED,
  TASK_REJECTED,
  TASK_STARTED,
} from './task-events.js';

function employeeOrNull(value: string | null): EmployeeId | null {
  return value === null ? null : (value as EmployeeId);
}

function positionOrNull(value: string | null): PositionId | null {
  return value === null ? null : (value as PositionId);
}

function toAssignment(
  raw: {
    readonly kind: string;
    readonly positionId: string | null;
    readonly targetEmployeeId: string | null;
    readonly assigneeEmployeeId: string | null;
    readonly actingEmployeeId: string | null;
  },
): TaskAssignment {
  return Object.freeze({
    kind: raw.kind as TaskAssignment['kind'],
    positionId: positionOrNull(raw.positionId),
    targetEmployeeId: employeeOrNull(raw.targetEmployeeId),
    assigneeEmployeeId: employeeOrNull(raw.assigneeEmployeeId),
    actingEmployeeId: employeeOrNull(raw.actingEmployeeId),
  });
}

function toVerification(
  raw: { readonly kind: string; readonly requiredOutputKeys: readonly string[] } | null,
): TaskVerification | null {
  if (raw === null) return null;
  return Object.freeze({
    kind: raw.kind as TaskVerification['kind'],
    requiredOutputKeys: Object.freeze([...raw.requiredOutputKeys]),
  });
}

function toResult(
  raw: {
    readonly taskId: string;
    readonly producedBy: string;
    readonly summary: string;
    readonly data: Readonly<Record<string, unknown>>;
    readonly artifacts: readonly string[];
  } | null,
): TaskResult | null {
  if (raw === null) return null;
  return Object.freeze({
    taskId: raw.taskId,
    producedBy: raw.producedBy as EmployeeId,
    summary: raw.summary,
    data: raw.data,
    artifacts: Object.freeze([...raw.artifacts]),
  });
}

function freezeTask(task: Task): Task {
  Object.freeze(task.assignment);
  Object.freeze(task.reviews);
  if (task.handoff !== null) Object.freeze(task.handoff);
  if (task.result !== null) {
    Object.freeze(task.result.artifacts);
    Object.freeze(task.result);
  }
  Object.freeze(task.requiredSkills);
  Object.freeze(task.matchedCapabilities);
  Object.freeze(task.outputs);
  if (task.verification !== null) Object.freeze(task.verification);
  return Object.freeze(task);
}

function buildInitial(payload: TaskCreatedPayload, event: OrgEvent): Task {
  return {
    taskId: payload.taskId,
    companyId: event.companyId,
    title: payload.title,
    goal: payload.goal,
    detail: payload.detail,
    workflowInstanceId: payload.workflowInstanceId,
    workflowStepId: payload.workflowStepId,
    assignment: toAssignment(payload.assignment),
    createdByKind: payload.createdByKind,
    createdById: employeeOrNull(payload.createdById),
    status: 'created',
    priority: payload.priority,
    attempt: payload.attempt,
    maxAttempts: payload.maxAttempts,
    rejectReason: null,
    failureReason: null,
    blockedReason: null,
    blockedFrom: null,
    requiredSkills: payload.requiredSkills,
    capability: payload.capability ?? null,
    assignmentReason: null,
    matchedCapabilities: Object.freeze([]),
    verification: toVerification(payload.verification),
    outputs: payload.outputs,
    result: null,
    review: null,
    reviews: [],
    handoff: null,
    correlationId: event.correlationId,
    createdAtSim: event.occurredAtSim,
    dueAtSim: payload.dueAtSim as SimTime | null,
    startedAtSim: null,
    submittedAtSim: null,
    completedAtSim: null,
    sourceEventId: event.eventId,
  };
}

function payloadTaskId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const taskId = (payload as { readonly taskId?: unknown }).taskId;
  return typeof taskId === 'string' ? taskId : null;
}

export function applyTaskEvent(current: Task | null, event: OrgEvent): Task | null {
  if (!isTaskEvent(event.type)) return current;

  if (event.type === TASK_CREATED) {
    return freezeTask(buildInitial(event.payload as TaskCreatedPayload, event));
  }
  if (current === null) return current;
  if (payloadTaskId(event.payload) !== current.taskId) return current;

  switch (event.type) {
    case TASK_ASSIGNED: {
      const payload = event.payload as TaskAssignedPayload;
      return freezeTask({
        ...current,
        assignment: toAssignment(payload.assignment),
        attempt: payload.attempt,
        status: 'assigned',
        assignmentReason: payload.reason ?? null,
        matchedCapabilities: Object.freeze([...(payload.matchedCapabilities ?? [])]),
        failureReason: null,
        // The kind of work travels with the assignment (it is what wakes the executor), but an
        // assignment that names none must not erase what the step declared at creation.
        ...(payload.capability === undefined ? {} : { capability: payload.capability }),
        blockedReason: null,
        blockedFrom: null,
      });
    }
    case TASK_ACCEPTED: {
      return freezeTask({ ...current, status: 'accepted' });
    }
    case TASK_STARTED: {
      return freezeTask({
        ...current,
        status: 'started',
        startedAtSim: current.startedAtSim ?? event.occurredAtSim,
        blockedReason: null,
        blockedFrom: null,
      });
    }
    case TASK_BLOCKED: {
      const payload = event.payload as TaskBlockedPayload;
      return freezeTask({
        ...current,
        status: 'blocked',
        blockedReason: payload.reason,
        blockedFrom: payload.from,
      });
    }
    case TASK_PROGRESS_REPORTED: {
      const payload = event.payload as TaskProgressReportedPayload;
      if (payload.phase === 'submitted') {
        const result = toResult(payload.result) ?? current.result;
        return freezeTask({
          ...current,
          status: 'submitted',
          submittedAtSim: event.occurredAtSim,
          result,
          outputs: result === null ? current.outputs : [...result.artifacts],
        });
      }
      if (payload.phase === 'reviewed' && payload.review !== null) {
        const review: TaskReview = Object.freeze({
          reviewerId: payload.review.reviewerId as EmployeeId,
          verdict: payload.review.verdict,
          reason: payload.review.reason,
          reviewedAtSim: payload.review.reviewedAtSim as TaskReview['reviewedAtSim'],
        });
        return freezeTask({ ...current, reviews: [...current.reviews, review] });
      }
      return current;
    }
    case TASK_COMPLETED: {
      const payload = event.payload as TaskCompletedPayload;
      const result = toResult(payload.result) ?? current.result;
      return freezeTask({
        ...current,
        status: 'completed',
        completedAtSim: event.occurredAtSim,
        result,
        outputs: result === null ? current.outputs : [...result.artifacts],
        failureReason: null,
        blockedReason: null,
        blockedFrom: null,
      });
    }
    case TASK_REJECTED: {
      const payload = event.payload as TaskRejectedPayload;
      return freezeTask({
        ...current,
        status: 'rejected',
        rejectReason: payload.reason,
        attempt: payload.attempt,
        failureReason: null,
        blockedReason: null,
        blockedFrom: null,
      });
    }
    case TASK_FAILED: {
      const payload = event.payload as TaskFailedPayload;
      return freezeTask({
        ...current,
        status: 'rejected',
        rejectReason: payload.reason,
        attempt: payload.attempt,
        failureReason: payload.reason,
        blockedReason: null,
        blockedFrom: null,
      });
    }
    case TASK_CANCELLED: {
      return freezeTask({
        ...current,
        status: 'cancelled',
        failureReason: null,
        blockedReason: null,
        blockedFrom: null,
      });
    }
    /**
     * M3.1 handoff. The request is a fact about intent, not a status change: the task stays where
     * it is until the receiver accepts (the followed `Task.Assigned` is what moves the executor).
     */
    case TASK_HANDOFF_REQUESTED: {
      const payload = event.payload as TaskHandoffRequestedPayload;
      return freezeTask({
        ...current,
        handoff: Object.freeze({
          handoffId: payload.handoffId,
          fromEmployeeId: payload.fromEmployeeId as EmployeeId,
          toEmployeeId: payload.toEmployeeId as EmployeeId,
          status: 'requested' as const,
          reason: payload.reason,
          fromStatus: payload.fromStatus,
          requestedAtSim: event.occurredAtSim,
          sourceEventId: event.eventId,
          respondedAtSim: null,
          settledAtSim: null,
          outcome: null,
          settlement: null,
        } satisfies TaskHandoff),
      });
    }
    case TASK_HANDOFF_ACCEPTED: {
      // The request must be the one being answered: an acceptance that names no open handoff is
      // not a fact about this task and must not fabricate one.
      const payload = event.payload as TaskHandoffAcceptedPayload;
      if (current.handoff === null || current.handoff.handoffId !== payload.handoffId) {
        return current;
      }
      return freezeTask({
        ...current,
        handoff: Object.freeze({
          ...current.handoff,
          status: 'accepted' as const,
          respondedAtSim: event.occurredAtSim,
        }),
      });
    }
    case TASK_HANDOFF_DECLINED: {
      const payload = event.payload as TaskHandoffDeclinedPayload;
      if (current.handoff === null || current.handoff.handoffId !== payload.handoffId) {
        return current;
      }
      return freezeTask({
        ...current,
        handoff: Object.freeze({
          ...current.handoff,
          status: 'declined' as const,
          respondedAtSim: event.occurredAtSim,
          outcome: null,
          settlement: payload.reason,
        }),
      });
    }
    case TASK_HANDOFF_COMPLETED: {
      const payload = event.payload as TaskHandoffCompletedPayload;
      if (current.handoff === null || current.handoff.handoffId !== payload.handoffId) {
        return current;
      }
      return freezeTask({
        ...current,
        handoff: Object.freeze({
          ...current.handoff,
          status: 'completed' as const,
          settledAtSim: event.occurredAtSim,
          outcome: payload.outcome,
          settlement: payload.summary,
        }),
      });
    }
    /**
     * The record is gone. `null` is what makes a restart rebuild nothing: `recover()` skips a
     * group whose fold produces no instance, so the deletion survives as a fact on the log
     * while the record itself does not come back.
     */
    case TASK_DELETED:
      return null;
    default:
      return current;
  }
}

export function applyTaskEvents(
  events: Iterable<OrgEvent>,
  initial: Task | null = null,
): Task | null {
  let task = initial;
  for (const event of events) {
    task = applyTaskEvent(task, event);
  }
  return task;
}
