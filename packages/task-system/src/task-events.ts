import { z } from 'zod';
import type { Result } from '@maoeh/shared-types';
import type { EventContractFailure, EventRegistry } from '@maoeh/event-system';
import { TASK_HANDOFF_OUTCOMES, TASK_STATUSES, TASK_VERIFICATION_KINDS } from './task-types.js';

export const TASK_CREATED = 'Task.Created';
export const TASK_ASSIGNED = 'Task.Assigned';
export const TASK_ACCEPTED = 'Task.Accepted';
export const TASK_STARTED = 'Task.Started';
export const TASK_BLOCKED = 'Task.Blocked';
export const TASK_PROGRESS_REPORTED = 'Task.ProgressReported';
export const TASK_COMPLETED = 'Task.Completed';
export const TASK_REJECTED = 'Task.Rejected';
export const TASK_FAILED = 'Task.Failed';
export const TASK_CANCELLED = 'Task.Cancelled';
/**
 * M3.1 collaboration handoff (see `TaskHandoff` in task-types):
 * requested → accepted|declined → completed. The accepted hop is followed by a `Task.Assigned`
 * caused by it, which is what actually moves the executor; the handoff events carry the chain's
 * identity so "who asked whom, who took it, and how did it end" is readable from the log alone.
 */
export const TASK_HANDOFF_REQUESTED = 'Task.HandoffRequested';
export const TASK_HANDOFF_ACCEPTED = 'Task.HandoffAccepted';
export const TASK_HANDOFF_DECLINED = 'Task.HandoffDeclined';
export const TASK_HANDOFF_COMPLETED = 'Task.HandoffCompleted';
/**
 * The record leaves the organization, not just the run: the fold turns the stream back into
 * `null`, so a replay rebuilds nothing and the console's counts fall by one. Cancellation is
 * kept (`Task.Cancelled`) because it is a status a delivery can still be read at.
 */
export const TASK_DELETED = 'Task.Deleted';

export const TASK_EVENT_TYPES = [
  TASK_CREATED,
  TASK_ASSIGNED,
  TASK_ACCEPTED,
  TASK_STARTED,
  TASK_BLOCKED,
  TASK_PROGRESS_REPORTED,
  TASK_COMPLETED,
  TASK_REJECTED,
  TASK_FAILED,
  TASK_CANCELLED,
  TASK_HANDOFF_REQUESTED,
  TASK_HANDOFF_ACCEPTED,
  TASK_HANDOFF_DECLINED,
  TASK_HANDOFF_COMPLETED,
  TASK_DELETED,
] as const;

const idSchema = z.string().min(1).max(64);

const assignmentSchema = z.object({
  kind: z.enum(['employee', 'position', 'unassigned']),
  positionId: idSchema.nullable(),
  targetEmployeeId: idSchema.nullable(),
  assigneeEmployeeId: idSchema.nullable(),
  actingEmployeeId: idSchema.nullable(),
});

const verificationSchema = z.object({
  kind: z.enum(TASK_VERIFICATION_KINDS),
  requiredOutputKeys: z.array(z.string().min(1)),
});

const resultSchema = z.object({
  taskId: idSchema,
  producedBy: idSchema,
  summary: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  artifacts: z.array(idSchema),
});

const reviewSchema = z.object({
  reviewerId: idSchema,
  verdict: z.enum(['approved', 'rejected']),
  reason: z.string().nullable(),
  reviewedAtSim: z.number().int().min(0),
});

const attemptSchema = z.number().int().min(1);
const simSchema = z.number().int().min(0);

export const taskCreatedPayloadSchema = z.object({
  taskId: idSchema,
  title: z.string().min(1).max(200),
  goal: z.string().min(1),
  detail: z.string().nullable(),
  workflowInstanceId: idSchema.nullable(),
  workflowStepId: idSchema.nullable(),
  assignment: assignmentSchema,
  createdByKind: z.enum(['employee', 'human', 'system']),
  createdById: idSchema.nullable(),
  priority: z.number().int().min(1).max(9),
  attempt: attemptSchema,
  maxAttempts: z.number().int().min(1),
  requiredSkills: z.array(z.string().min(1)),
  verification: verificationSchema.nullable(),
  outputs: z.array(idSchema),
  dueAtSim: simSchema.nullable(),
  /**
   * The kind of work this task is, when its step declared one. Optional so every task written
   * before the field existed replays unchanged (and so an unlabelled task stays unlabelled
   * instead of inheriting a capability from its seat).
   */
  capability: z.string().min(1).max(64).nullable().optional(),
});

export const taskAssignedPayloadSchema = z.object({
  taskId: idSchema,
  assignment: assignmentSchema,
  attempt: attemptSchema,
  reason: z.string().nullable(),
  /**
   * Present when the assignee was chosen by capability matching: the required capabilities
   * this assignee covers. Optional so logs written before M1.6 replay unchanged.
   */
  matchedCapabilities: z.array(z.string().min(1)).optional(),
  /**
   * What the assignee was asked to do, restated on the wake-up event.
   *
   * `Task.Assigned` is what wakes the executor, and the cognition prompt only carries the input
   * event plus the org slice — so without these the assignee learns a `taskId` and nothing else,
   * and can only answer with a constant. `requiredOutputKeys` is the task's verification rule
   * (empty when the step declares none), which is what lets the executor produce output that
   * actually passes verification. Optional so older logs replay unchanged.
   */
  title: z.string().min(1).max(200).optional(),
  goal: z.string().min(1).max(2000).optional(),
  requiredOutputKeys: z.array(z.string().min(1)).optional(),
  /**
   * The step's declared capability, restated on the wake-up event for the same reason `goal`
   * is: the cognition prompt carries the input event and the org slice and nothing else, so a
   * delivery that must differ per kind of work (a backend service is not a frontend page) can
   * only be shaped from what this event says. Optional so older logs replay unchanged.
   */
  capability: z.string().min(1).max(64).optional(),
});

export const taskAcceptedPayloadSchema = z.object({
  taskId: idSchema,
  employeeId: idSchema.nullable(),
  attempt: attemptSchema,
});

export const taskStartedPayloadSchema = z.object({
  taskId: idSchema,
  employeeId: idSchema.nullable(),
  attempt: attemptSchema,
  reason: z.string().nullable(),
});

export const taskBlockedPayloadSchema = z.object({
  taskId: idSchema,
  employeeId: idSchema.nullable(),
  reason: z.string().min(1),
  from: z.enum(TASK_STATUSES),
});

export const taskProgressReportedPayloadSchema = z.object({
  taskId: idSchema,
  employeeId: idSchema.nullable(),
  phase: z.enum(['progress', 'submitted', 'reviewed']),
  summary: z.string().nullable(),
  result: resultSchema.nullable(),
  review: reviewSchema.nullable(),
});

export const taskCompletedPayloadSchema = z.object({
  taskId: idSchema,
  employeeId: idSchema.nullable(),
  verification: verificationSchema.nullable(),
  result: resultSchema.nullable(),
});

export const taskRejectedPayloadSchema = z.object({
  taskId: idSchema,
  reason: z.string().min(1),
  attempt: attemptSchema,
  from: z.enum(TASK_STATUSES),
  employeeId: idSchema.nullable(),
});

export const taskFailedPayloadSchema = z.object({
  taskId: idSchema,
  reason: z.string().min(1),
  attempt: attemptSchema,
  from: z.enum(TASK_STATUSES),
  employeeId: idSchema.nullable(),
});

export const taskCancelledPayloadSchema = z.object({
  taskId: idSchema,
  reason: z.string().min(1),
  from: z.enum(TASK_STATUSES),
});

const handoffIdSchema = z.string().min(1).max(64);
const handoffReasonSchema = z.string().min(1).max(500);

/**
 * The request restates the work on the event that wakes the receiver, for the same reason
 * `Task.Assigned` does: the cognition prompt carries the input event and the org slice, so
 * without the title / goal / output keys the receiver could not shape the delivery it is asked
 * to take over.
 */
export const taskHandoffRequestedPayloadSchema = z.object({
  handoffId: handoffIdSchema,
  taskId: idSchema,
  fromEmployeeId: idSchema,
  toEmployeeId: idSchema,
  fromStatus: z.enum(TASK_STATUSES),
  reason: handoffReasonSchema,
  note: z.string().max(2000).nullable(),
  title: z.string().min(1).max(200).optional(),
  goal: z.string().min(1).max(2000).optional(),
  requiredOutputKeys: z.array(z.string().min(1)).optional(),
  capability: z.string().min(1).max(64).optional(),
});

export const taskHandoffAcceptedPayloadSchema = z.object({
  handoffId: handoffIdSchema,
  taskId: idSchema,
  fromEmployeeId: idSchema,
  toEmployeeId: idSchema,
  previousStatus: z.enum(TASK_STATUSES),
});

export const taskHandoffDeclinedPayloadSchema = z.object({
  handoffId: handoffIdSchema,
  taskId: idSchema,
  fromEmployeeId: idSchema,
  toEmployeeId: idSchema,
  reason: handoffReasonSchema,
});

/**
 * The handoff's result. `resultSummary` is the delivered work's own summary when the task was
 * completed; `summary` explains the settlement itself (who did what, or why the chain closed
 * without a delivery). Both are optional content, never ids — the ids are the payload fields.
 */
export const taskHandoffCompletedPayloadSchema = z.object({
  handoffId: handoffIdSchema,
  taskId: idSchema,
  fromEmployeeId: idSchema,
  toEmployeeId: idSchema,
  outcome: z.enum(TASK_HANDOFF_OUTCOMES),
  summary: z.string().min(1).max(2000).nullable(),
  resultSummary: z.string().min(1).max(2000).nullable(),
  artifactCount: z.number().int().min(0),
});

/**
 * Deliberately carries no `employeeId`: a deletion must not wake the assignee, it only has to
 * explain to the log why the record is gone.
 */
export const taskDeletedPayloadSchema = z.object({
  taskId: idSchema,
  reason: z.string().min(1),
  from: z.enum(TASK_STATUSES),
});

export type TaskCreatedPayload = z.infer<typeof taskCreatedPayloadSchema>;
export type TaskAssignedPayload = z.infer<typeof taskAssignedPayloadSchema>;
export type TaskAcceptedPayload = z.infer<typeof taskAcceptedPayloadSchema>;
export type TaskStartedPayload = z.infer<typeof taskStartedPayloadSchema>;
export type TaskBlockedPayload = z.infer<typeof taskBlockedPayloadSchema>;
export type TaskProgressReportedPayload = z.infer<typeof taskProgressReportedPayloadSchema>;
export type TaskCompletedPayload = z.infer<typeof taskCompletedPayloadSchema>;
export type TaskRejectedPayload = z.infer<typeof taskRejectedPayloadSchema>;
export type TaskFailedPayload = z.infer<typeof taskFailedPayloadSchema>;
export type TaskCancelledPayload = z.infer<typeof taskCancelledPayloadSchema>;
export type TaskHandoffRequestedPayload = z.infer<typeof taskHandoffRequestedPayloadSchema>;
export type TaskHandoffAcceptedPayload = z.infer<typeof taskHandoffAcceptedPayloadSchema>;
export type TaskHandoffDeclinedPayload = z.infer<typeof taskHandoffDeclinedPayloadSchema>;
export type TaskHandoffCompletedPayload = z.infer<typeof taskHandoffCompletedPayloadSchema>;
export type TaskDeletedPayload = z.infer<typeof taskDeletedPayloadSchema>;

function registerOnce(
  registry: EventRegistry,
  type: string,
  schema: z.ZodType<unknown>,
): Result<void, EventContractFailure> {
  if (registry.isRegistered(type)) return { ok: true, value: undefined };
  return registry.register(type, schema);
}

export function registerTaskEvents(
  registry: EventRegistry,
): Result<void, EventContractFailure> {
  const registrations: readonly (readonly [string, z.ZodType<unknown>])[] = [
    [TASK_CREATED, taskCreatedPayloadSchema],
    [TASK_ASSIGNED, taskAssignedPayloadSchema],
    [TASK_ACCEPTED, taskAcceptedPayloadSchema],
    [TASK_STARTED, taskStartedPayloadSchema],
    [TASK_BLOCKED, taskBlockedPayloadSchema],
    [TASK_PROGRESS_REPORTED, taskProgressReportedPayloadSchema],
    [TASK_COMPLETED, taskCompletedPayloadSchema],
    [TASK_REJECTED, taskRejectedPayloadSchema],
    [TASK_FAILED, taskFailedPayloadSchema],
    [TASK_CANCELLED, taskCancelledPayloadSchema],
    [TASK_HANDOFF_REQUESTED, taskHandoffRequestedPayloadSchema],
    [TASK_HANDOFF_ACCEPTED, taskHandoffAcceptedPayloadSchema],
    [TASK_HANDOFF_DECLINED, taskHandoffDeclinedPayloadSchema],
    [TASK_HANDOFF_COMPLETED, taskHandoffCompletedPayloadSchema],
    [TASK_DELETED, taskDeletedPayloadSchema],
  ];
  for (const [type, schema] of registrations) {
    const result = registerOnce(registry, type, schema);
    if (!result.ok) return result;
  }
  return { ok: true, value: undefined };
}

export function isTaskEvent(type: string): boolean {
  return (TASK_EVENT_TYPES as readonly string[]).includes(type);
}
