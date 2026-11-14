import { z } from 'zod';
import type { Result } from '@maoeh/shared-types';
import type { EventContractFailure, EventRegistry } from '@maoeh/event-system';
import {
  APPROVAL_POLICIES,
  STEP_KINDS,
} from './workflow-types.js';

export const WORKFLOW_INSTANCE_STARTED = 'Workflow.InstanceStarted';
export const WORKFLOW_STEP_ENTERED = 'Workflow.StepEntered';
export const WORKFLOW_STEP_COMPLETED = 'Workflow.StepCompleted';
export const WORKFLOW_STEP_REJECTED = 'Workflow.StepRejected';
export const WORKFLOW_APPROVAL_REQUESTED = 'Workflow.ApprovalRequested';
export const WORKFLOW_APPROVAL_GRANTED = 'Workflow.ApprovalGranted';
export const WORKFLOW_APPROVAL_DENIED = 'Workflow.ApprovalDenied';
export const WORKFLOW_INSTANCE_COMPLETED = 'Workflow.InstanceCompleted';
export const WORKFLOW_INSTANCE_ABORTED = 'Workflow.InstanceAborted';
export const WORKFLOW_INSTANCE_BLOCKED = 'Workflow.InstanceBlocked';
export const WORKFLOW_INSTANCE_RESUMED = 'Workflow.InstanceResumed';
/**
 * M1.8: a human overrode the not-yet-entered task step's executor for this instance only.
 * The fold merges `{ [stepId]: employeeId }` into `context.assignmentOverrides`; the
 * definition and every other instance are untouched by construction.
 */
/**
 * M1.8/M1.9: a human confirmed a draft instance on the canvas; the engine enters the entry
 * stage and the workflow runs. The fold drops the `draft` marker from `context`.
 */
export const WORKFLOW_DRAFT_CONFIRMED = 'Workflow.DraftConfirmed';
export const DRAFT_CONTEXT_KEY = 'draft';

export const WORKFLOW_STEP_ASSIGNMENT_OVERRIDDEN = 'Workflow.StepAssignmentOverridden';
/** `context` key carrying the per-instance `{ [stepId]: employeeId }` executor overrides. */
export const ASSIGNMENT_OVERRIDES_CONTEXT_KEY = 'assignmentOverrides';

/**
 * The instance leaves the organization together with every task it owns. The fold turns the
 * stream back into `null`, so a recovery rebuilds neither the instance nor its steps.
 */
export const WORKFLOW_INSTANCE_DELETED = 'Workflow.InstanceDeleted';

export const WORKFLOW_EVENT_TYPES = [
  WORKFLOW_INSTANCE_STARTED,
  WORKFLOW_STEP_ENTERED,
  WORKFLOW_STEP_COMPLETED,
  WORKFLOW_STEP_REJECTED,
  WORKFLOW_APPROVAL_REQUESTED,
  WORKFLOW_APPROVAL_GRANTED,
  WORKFLOW_APPROVAL_DENIED,
  WORKFLOW_INSTANCE_COMPLETED,
  WORKFLOW_INSTANCE_ABORTED,
  WORKFLOW_INSTANCE_BLOCKED,
  WORKFLOW_INSTANCE_RESUMED,
  WORKFLOW_INSTANCE_DELETED,
  WORKFLOW_DRAFT_CONFIRMED,
  WORKFLOW_STEP_ASSIGNMENT_OVERRIDDEN,
] as const;

const idSchema = z.string().min(1).max(64);
const simSchema = z.number().int().min(0);

export const instanceStartedPayloadSchema = z.object({
  instanceId: idSchema,
  workflowId: idSchema,
  version: z.number().int().min(1),
  title: z.string().min(1).max(200),
  goal: z.string().min(1),
  context: z.record(z.string(), z.unknown()),
  initiatedBy: idSchema,
  entryStageId: idSchema,
});

export const stepEnteredPayloadSchema = z.object({
  instanceId: idSchema,
  stageId: idSchema,
  stepId: idSchema,
  kind: z.enum(STEP_KINDS),
  taskId: idSchema.nullable(),
  assigneePositionId: idSchema.nullable(),
  assigneeEmployeeId: idSchema.nullable(),
});

export const stepCompletedPayloadSchema = z.object({
  instanceId: idSchema,
  stageId: idSchema,
  stepId: idSchema,
  outcome: z.string().min(1),
  taskId: idSchema.nullable(),
  outputs: z.unknown().nullable(),
});

export const stepRejectedPayloadSchema = z.object({
  instanceId: idSchema,
  stageId: idSchema,
  stepId: idSchema,
  reason: z.string().min(1),
  taskId: idSchema.nullable(),
});

export const approvalRequestedPayloadSchema = z.object({
  instanceId: idSchema,
  stepId: idSchema,
  approvalKey: idSchema,
  policy: z.enum(APPROVAL_POLICIES),
  requiredCount: z.number().int().min(1),
  requiredLevel: z.number().int().min(0).max(5),
  requiredRoles: z.array(z.string().min(1)),
  requestedBy: idSchema,
  requestedAtSim: simSchema,
});

export const approvalGrantedPayloadSchema = z.object({
  instanceId: idSchema,
  stepId: idSchema,
  approvalKey: idSchema,
  decidedBy: idSchema,
  grantedCount: z.number().int().min(1),
  reason: z.string().nullable(),
});

export const approvalDeniedPayloadSchema = z.object({
  instanceId: idSchema,
  stepId: idSchema,
  approvalKey: idSchema,
  decidedBy: idSchema,
  reason: z.string().nullable(),
});

export const instanceCompletedPayloadSchema = z.object({
  instanceId: idSchema,
  reason: z.string().nullable(),
});

export const instanceAbortedPayloadSchema = z.object({
  instanceId: idSchema,
  reason: z.string().min(1),
  detail: z.string().nullable(),
});

export const instanceBlockedPayloadSchema = z.object({
  instanceId: idSchema,
  kind: z.enum(['approval', 'manual', 'task']),
  detail: z.string().min(1),
  stepId: idSchema.nullable(),
});

export const instanceResumedPayloadSchema = z.object({
  instanceId: idSchema,
  resumedBy: idSchema,
});

export const stepAssignmentOverriddenPayloadSchema = z.object({
  instanceId: idSchema,
  stepId: idSchema,
  employeeId: idSchema,
  actorId: idSchema,
  /** The previous *override* for this step, or null when this is the first override. */
  previousEmployeeId: idSchema.nullable(),
  reason: z.string().min(1).max(500).nullable(),
});

/** Who confirmed the draft, on the record; `reason` is optional. */
export const draftConfirmedPayloadSchema = z.object({
  instanceId: idSchema,
  confirmedBy: idSchema,
  reason: z.string().min(1).max(500).nullable(),
});

/**
 * Which tasks went with the instance, recorded on the deletion itself: without them "what did
 * this removal take out of the organization" would only be answerable by re-reading every
 * `Task.Deleted` in the log.
 */
export const instanceDeletedPayloadSchema = z.object({
  instanceId: idSchema,
  reason: z.string().min(1),
  taskIds: z.array(idSchema),
});

export type InstanceStartedPayload = z.infer<typeof instanceStartedPayloadSchema>;
export type StepEnteredPayload = z.infer<typeof stepEnteredPayloadSchema>;
export type StepCompletedPayload = z.infer<typeof stepCompletedPayloadSchema>;
export type StepRejectedPayload = z.infer<typeof stepRejectedPayloadSchema>;
export type ApprovalRequestedPayload = z.infer<typeof approvalRequestedPayloadSchema>;
export type ApprovalGrantedPayload = z.infer<typeof approvalGrantedPayloadSchema>;
export type ApprovalDeniedPayload = z.infer<typeof approvalDeniedPayloadSchema>;
export type InstanceCompletedPayload = z.infer<typeof instanceCompletedPayloadSchema>;
export type InstanceAbortedPayload = z.infer<typeof instanceAbortedPayloadSchema>;
export type InstanceBlockedPayload = z.infer<typeof instanceBlockedPayloadSchema>;
export type InstanceResumedPayload = z.infer<typeof instanceResumedPayloadSchema>;
export type InstanceDeletedPayload = z.infer<typeof instanceDeletedPayloadSchema>;
export type StepAssignmentOverriddenPayload = z.infer<typeof stepAssignmentOverriddenPayloadSchema>;
export type DraftConfirmedPayload = z.infer<typeof draftConfirmedPayloadSchema>;

function registerOnce(
  registry: EventRegistry,
  type: string,
  schema: z.ZodType<unknown>,
): Result<void, EventContractFailure> {
  if (registry.isRegistered(type)) return { ok: true, value: undefined };
  return registry.register(type, schema);
}

export function registerWorkflowEvents(
  registry: EventRegistry,
): Result<void, EventContractFailure> {
  const registrations: readonly (readonly [string, z.ZodType<unknown>])[] = [
    [WORKFLOW_INSTANCE_STARTED, instanceStartedPayloadSchema],
    [WORKFLOW_STEP_ENTERED, stepEnteredPayloadSchema],
    [WORKFLOW_STEP_COMPLETED, stepCompletedPayloadSchema],
    [WORKFLOW_STEP_REJECTED, stepRejectedPayloadSchema],
    [WORKFLOW_APPROVAL_REQUESTED, approvalRequestedPayloadSchema],
    [WORKFLOW_APPROVAL_GRANTED, approvalGrantedPayloadSchema],
    [WORKFLOW_APPROVAL_DENIED, approvalDeniedPayloadSchema],
    [WORKFLOW_INSTANCE_COMPLETED, instanceCompletedPayloadSchema],
    [WORKFLOW_INSTANCE_ABORTED, instanceAbortedPayloadSchema],
    [WORKFLOW_INSTANCE_BLOCKED, instanceBlockedPayloadSchema],
    [WORKFLOW_INSTANCE_RESUMED, instanceResumedPayloadSchema],
    [WORKFLOW_INSTANCE_DELETED, instanceDeletedPayloadSchema],
    [WORKFLOW_STEP_ASSIGNMENT_OVERRIDDEN, stepAssignmentOverriddenPayloadSchema],
    [WORKFLOW_DRAFT_CONFIRMED, draftConfirmedPayloadSchema],
  ];
  for (const [type, schema] of registrations) {
    const result = registerOnce(registry, type, schema);
    if (!result.ok) return result;
  }
  return { ok: true, value: undefined };
}

export function isWorkflowEvent(type: string): boolean {
  return (WORKFLOW_EVENT_TYPES as readonly string[]).includes(type);
}
