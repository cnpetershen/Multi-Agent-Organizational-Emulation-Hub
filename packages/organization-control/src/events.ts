import { z } from 'zod';
import type { Result } from '@maoeh/shared-types';
import type { EventContractFailure, EventRegistry } from '@maoeh/event-system';

/**
 * Control events: `<Aggregate>.<PastTenseVerb>` (03-data-model §3.6.2).
 * A control *command* is `Simulation.Pause`; the corresponding *event* is
 * `Control.SimulationPaused` — never the command written as a fact.
 */
export const CONTROL_SIMULATION_STARTED = 'Control.SimulationStarted';
export const CONTROL_SIMULATION_PAUSED = 'Control.SimulationPaused';
export const CONTROL_SIMULATION_RESUMED = 'Control.SimulationResumed';
export const CONTROL_SIMULATION_STEPPED = 'Control.SimulationStepped';
export const CONTROL_SIMULATION_SOUGHT = 'Control.SimulationSought';
export const CONTROL_AGENT_CREATED = 'Control.AgentCreated';
export const CONTROL_AGENT_ARCHIVED = 'Control.AgentArchived';
export const CONTROL_AGENT_PAUSED = 'Control.AgentPaused';
export const CONTROL_AGENT_RESUMED = 'Control.AgentResumed';
export const CONTROL_AGENT_INSTRUCTED = 'Control.AgentInstructed';
export const CONTROL_AGENT_TASK_CANCELLED = 'Control.AgentTaskCancelled';
export const CONTROL_AGENT_REVIEW_REQUESTED = 'Control.AgentReviewRequested';
export const CONTROL_WORKFLOW_CANCELLED = 'Control.WorkflowCancelled';
export const CONTROL_WORKFLOW_APPROVAL_DECIDED = 'Control.WorkflowApprovalDecided';
/**
 * The operator removed a workflow instance (and, with it, the tasks it owned). `Control.*`
 * records the command's effect; `Workflow.InstanceDeleted` and the `Task.Deleted` facts beside
 * it record what actually left the organization.
 */
export const CONTROL_WORKFLOW_DELETED = 'Control.WorkflowDeleted';
/**
 * M1.8: the operator re-pointed not-yet-entered task steps of a single instance at named
 * employees (per-instance override). `Control.*` answers "who and why"; the beside
 * `Workflow.StepAssignmentOverridden` facts answer "what changed and is now the truth".
 */
export const CONTROL_WORKFLOW_INSTANCE_ASSIGNMENT_OVERRIDDEN =
  'Control.WorkflowInstanceAssignmentOverridden';
/** M1.9: the operator confirmed a draft instance on the canvas; the engine enters the entry stage. */
export const CONTROL_WORKFLOW_INSTANCE_CONFIRMED = 'Control.WorkflowInstanceConfirmed';
export const CONTROL_TASK_CANCELLED = 'Control.TaskCancelled';
export const CONTROL_TASK_REASSIGNED = 'Control.TaskReassigned';
export const CONTROL_TASK_DELETED = 'Control.TaskDeleted';
/**
 * M1.6: a task was handed to a named employee — by the operator (`agentId`) or by the
 * deterministic capability matcher. The event is what makes "who got the work, and which
 * capabilities they covered" replayable without re-running the matcher.
 */
export const CONTROL_TASK_ASSIGNED = 'Control.TaskAssigned';
export const CONTROL_TASK_REVIEW_REQUESTED = 'Control.TaskReviewRequested';
export const CONTROL_TASK_INJECTED = 'Control.TaskInjected';
/**
 * M1.6: the delegation decision behind an assignment — the requirement, the chosen holder
 * and the rationale, in one auditable fact. Emitted together with the assignment it explains,
 * so the console can answer "why this agent?" from the log alone.
 */
export const CONTROL_DELEGATION_DECIDED = 'Control.DelegationDecided';
/**
 * M1.4: the human submitted a work brief (任务书) — the one entry point for organizational
 * work (§5.7). The payload carries the brief verbatim, so the read model rebuilds
 * "brief → decomposition" from the log by grouping on `correlationId` (§5.4).
 */
export const CONTROL_WORK_BRIEFED = 'Control.WorkBriefed';
export const CONTROL_EVENT_INJECTED = 'Control.EventInjected';
export const CONTROL_COMMAND_REJECTED = 'Control.CommandRejected';

export const CONTROL_EVENT_TYPES = [
  CONTROL_SIMULATION_STARTED,
  CONTROL_SIMULATION_PAUSED,
  CONTROL_SIMULATION_RESUMED,
  CONTROL_SIMULATION_STEPPED,
  CONTROL_SIMULATION_SOUGHT,
  CONTROL_AGENT_CREATED,
  CONTROL_AGENT_ARCHIVED,
  CONTROL_AGENT_PAUSED,
  CONTROL_AGENT_RESUMED,
  CONTROL_AGENT_INSTRUCTED,
  CONTROL_AGENT_TASK_CANCELLED,
  CONTROL_AGENT_REVIEW_REQUESTED,
  CONTROL_WORKFLOW_CANCELLED,
  CONTROL_WORKFLOW_APPROVAL_DECIDED,
  CONTROL_WORKFLOW_DELETED,
  CONTROL_WORKFLOW_INSTANCE_ASSIGNMENT_OVERRIDDEN,
  CONTROL_WORKFLOW_INSTANCE_CONFIRMED,
  CONTROL_TASK_CANCELLED,
  CONTROL_TASK_REASSIGNED,
  CONTROL_TASK_DELETED,
  CONTROL_TASK_ASSIGNED,
  CONTROL_TASK_REVIEW_REQUESTED,
  CONTROL_TASK_INJECTED,
  CONTROL_DELEGATION_DECIDED,
  CONTROL_WORK_BRIEFED,
  CONTROL_EVENT_INJECTED,
  CONTROL_COMMAND_REJECTED,
] as const;

const idSchema = z.string().min(1).max(128);
const reasonSchema = z.string().min(1).max(2000);
const simSchema = z.number().int().min(0);
const nonNegInt = z.number().int().min(0);

/**
 * The rejection envelope must be formable from *any* refused command, including one whose own
 * payload was invalid — that is exactly when the refusal matters most. So the descriptive
 * fields degrade gracefully instead of failing the contract.
 */
const optionalId = z.string().max(128).optional();
const softReason = z.string().max(2000).optional();

const CONTROL_ERROR_CODES = [
  'UNAUTHENTICATED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'OUT_OF_SCOPE',
  'NEEDS_APPROVAL',
  'INVALID_COMMAND',
  'INVALID_TARGET',
  'STALE_VERSION',
  'ALREADY_PROCESSED',
  'INVALID_STATE',
  'NOT_FOUND',
  'CONFLICT',
  'BUDGET_EXCEEDED',
  'SIMULATION_PAUSED',
  'AGENT_PAUSED',
  'WORKFLOW_BLOCKED',
  'UNSUPPORTED',
] as const;

const softResultCode = z.enum(CONTROL_ERROR_CODES).optional();

/** Every control event carries the command that caused it (Command → Event link). */
const controlEnvelope = {
  commandId: idSchema,
  operatorId: idSchema,
  reason: reasonSchema,
};

export const controlSimulationStartedPayloadSchema = z.object({
  ...controlEnvelope,
  tickNumber: nonNegInt,
});

export const controlSimulationPausedPayloadSchema = z.object({
  ...controlEnvelope,
  tickNumber: nonNegInt,
});

export const controlSimulationResumedPayloadSchema = z.object({
  ...controlEnvelope,
  tickNumber: nonNegInt,
});

export const controlSimulationSteppedPayloadSchema = z.object({
  ...controlEnvelope,
  tickNumber: nonNegInt,
  tickStatus: z.string().min(1),
});

export const controlSimulationSoughtPayloadSchema = z.object({
  ...controlEnvelope,
  fromTick: nonNegInt,
  toTick: nonNegInt,
});

export const controlAgentPausedPayloadSchema = z.object({
  ...controlEnvelope,
  agentId: idSchema,
});

/**
 * `AGENT_CREATED` / `Control.AgentCreated`.
 *
 * The payload is deliberately complete: it carries everything the Runtime needs to materialize
 * the same agent again (`name`, `positionId`, `employeeNo`, mandate, traits, cognition profile
 * and the template the 8-layer structure came from), so a replay of the log can rebuild the
 * roster instead of merely remembering that something happened.
 */
export const controlAgentCreatedPayloadSchema = z.object({
  ...controlEnvelope,
  agentId: idSchema,
  name: z.string().min(1).max(200),
  positionId: idSchema,
  employeeNo: z.string().min(1).max(64).nullable(),
  responsibilities: z.array(z.string().min(1).max(200)).min(1),
  traits: z.array(z.string().min(1).max(200)),
  /**
   * Fine-grained specializations of the person (M1.6). Optional so logs written before this
   * field existed replay unchanged; when present, capability matching reads it back.
   */
  expertise: z.array(z.string().min(1).max(64)).optional(),
  cognitionProfileId: idSchema,
  templateEmployeeId: idSchema.nullable(),
  definitionSource: z.string().min(1).max(128),
  status: z.literal('active'),
  /**
   * Present only when this creation also added the seat to the chart. The seat is organization
   * state on the log (A3), so a replay can rebuild it before the employee lands in it.
   */
  position: z
    .object({
      departmentId: idSchema,
      title: z.string().min(1).max(120),
      capabilities: z.array(z.string().min(1).max(64)),
      reportsToPositionId: idSchema.nullable(),
    })
    .optional(),
});

/**
 * `AGENT_ARCHIVED` / `Control.AgentArchived`. Archive is a status change, never a deletion:
 * the event records the lifecycle status (`archived`) and the employment status it maps to
 * (`offboarded`) so the two vocabularies cannot drift.
 */
export const controlAgentArchivedPayloadSchema = z.object({
  ...controlEnvelope,
  agentId: idSchema,
  status: z.literal('archived'),
  employmentStatus: z.literal('offboarded'),
});

export const controlAgentResumedPayloadSchema = z.object({
  ...controlEnvelope,
  agentId: idSchema,
});

export const controlAgentInstructedPayloadSchema = z.object({
  ...controlEnvelope,
  agentId: idSchema,
  instructionId: idSchema,
  instruction: z.string().min(1).max(8000),
});

export const controlAgentTaskCancelledPayloadSchema = z.object({
  ...controlEnvelope,
  agentId: idSchema,
  taskId: idSchema,
});

export const controlAgentReviewRequestedPayloadSchema = z.object({
  ...controlEnvelope,
  agentId: idSchema,
  taskId: idSchema,
  reviewId: idSchema,
});

export const controlWorkflowCancelledPayloadSchema = z.object({
  ...controlEnvelope,
  instanceId: idSchema,
});

export const controlWorkflowApprovalDecidedPayloadSchema = z.object({
  ...controlEnvelope,
  instanceId: idSchema,
  stepId: idSchema,
  decision: z.enum(['granted', 'denied']),
});

export const controlWorkflowDeletedPayloadSchema = z.object({
  ...controlEnvelope,
  instanceId: idSchema,
});

export const controlWorkflowInstanceConfirmedPayloadSchema = z.object({
  ...controlEnvelope,
  instanceId: idSchema,
});

/**
 * M1.8: the audited summary of an assignment override command — only the entries that made
 * it in (the command is whole-batch, so "all or none" is the only shape this event can have).
 * `reason` is the per-override reason, falling back to the command-level reason upstream.
 */
export const controlWorkflowInstanceAssignmentOverriddenPayloadSchema = z.object({
  ...controlEnvelope,
  instanceId: idSchema,
  overrides: z
    .array(
      z.object({
        stepId: idSchema,
        employeeId: idSchema,
        reason: z.string().min(1).max(500).nullable(),
      }),
    )
    .min(1)
    .max(64),
});

export const controlTaskCancelledPayloadSchema = z.object({
  ...controlEnvelope,
  taskId: idSchema,
});

export const controlTaskDeletedPayloadSchema = z.object({
  ...controlEnvelope,
  taskId: idSchema,
});

export const controlTaskReassignedPayloadSchema = z.object({
  ...controlEnvelope,
  taskId: idSchema,
  positionId: idSchema,
});

export const controlTaskAssignedPayloadSchema = z.object({
  ...controlEnvelope,
  taskId: idSchema,
  agentId: idSchema,
  matchedCapabilities: z.array(z.string().min(1).max(64)),
});

/**
 * The delegation decision itself: what the work needed, who got it, and why. Everything the
 * console shows under "why assigned" comes from this payload — no re-derivation.
 */
export const controlDelegationDecidedPayloadSchema = z.object({
  ...controlEnvelope,
  taskId: idSchema,
  title: z.string().min(1).max(200),
  requiredCapabilities: z.array(z.string().min(1).max(64)),
  assigneeEmployeeId: idSchema,
  assigneePositionId: idSchema,
  rationale: z.string().min(1).max(2000),
});

export const controlTaskReviewRequestedPayloadSchema = z.object({
  ...controlEnvelope,
  taskId: idSchema,
  reviewId: idSchema,
});

export const controlTaskInjectedPayloadSchema = z.object({
  ...controlEnvelope,
  taskId: idSchema,
  title: z.string().min(1).max(200),
  goal: z.string().min(1),
  positionId: idSchema,
  createdAtSim: simSchema,
});

export const controlEventInjectedPayloadSchema = z.object({
  ...controlEnvelope,
  injectedEventType: z.string().min(1),
  injectedEventId: z.string().min(1),
});

/**
 * `Work.SubmitBrief` / `Control.WorkBriefed` (M1.4). The brief rides the event verbatim
 * (title / goal / context / verification / priority / deadline) so the read model can serve
 * the brief page from the log alone; `briefId` is the human-facing id of the submission.
 */
export const controlWorkBriefedPayloadSchema = z.object({
  ...controlEnvelope,
  agentId: idSchema,
  briefId: idSchema,
  title: z.string().min(1).max(200),
  goal: z.string().min(1).max(8000),
  context: z.string().max(8000).nullable(),
  verificationKeys: z.array(z.string().min(1).max(64)).min(1),
  priority: z.number().int().min(1).max(9).nullable(),
  dueAtSim: simSchema.nullable(),
});

/**
 * A refused command is itself a fact worth keeping on the event log: it is what makes
 * "who tried to do what, and what did the system say" replayable without a second store.
 */
export const controlCommandRejectedPayloadSchema = z.object({
  /** Every field degrades instead of failing: a refused command is still a fact worth keeping. */
  commandId: z.string().max(128).optional(),
  operatorId: z.string().max(128).optional(),
  reason: softReason,
  commandType: z.string().max(128).optional(),
  targetType: z.string().max(64).optional(),
  targetId: optionalId,
  resultCode: softResultCode,
  issues: z
    .array(z.object({ field: z.string(), reason: z.string() }))
    .optional(),
});

export type ControlSimulationPausedPayload = z.infer<typeof controlSimulationPausedPayloadSchema>;
export type ControlAgentInstructedPayload = z.infer<typeof controlAgentInstructedPayloadSchema>;
export type ControlAgentCreatedPayload = z.infer<typeof controlAgentCreatedPayloadSchema>;
export type ControlAgentArchivedPayload = z.infer<typeof controlAgentArchivedPayloadSchema>;
export type ControlTaskInjectedPayload = z.infer<typeof controlTaskInjectedPayloadSchema>;
export type ControlTaskAssignedPayload = z.infer<typeof controlTaskAssignedPayloadSchema>;
export type ControlDelegationDecidedPayload = z.infer<typeof controlDelegationDecidedPayloadSchema>;
export type ControlEventInjectedPayload = z.infer<typeof controlEventInjectedPayloadSchema>;
export type ControlWorkBriefedPayload = z.infer<typeof controlWorkBriefedPayloadSchema>;
export type ControlWorkflowInstanceAssignmentOverriddenPayload = z.infer<typeof controlWorkflowInstanceAssignmentOverriddenPayloadSchema>;
export type ControlWorkflowInstanceConfirmedPayload = z.infer<typeof controlWorkflowInstanceConfirmedPayloadSchema>;

/**
 * M1.3 requirement names for the two lifecycle facts. The event *type* keeps the repository-wide
 * `<Aggregate>.<PastTenseVerb>` contract (`Control.*` is the aggregate every control-plane fact
 * lives under, 03-data-model §3.6.2); these constants are the names the lifecycle feature speaks.
 */
export const AGENT_CREATED = CONTROL_AGENT_CREATED;
export const AGENT_ARCHIVED = CONTROL_AGENT_ARCHIVED;

function registerOnce(
  registry: EventRegistry,
  type: string,
  schema: z.ZodType<unknown>,
): Result<void, EventContractFailure> {
  if (registry.isRegistered(type)) return { ok: true, value: undefined };
  return registry.register(type, schema);
}

export function registerControlEvents(
  registry: EventRegistry,
): Result<void, EventContractFailure> {
  const registrations: readonly (readonly [string, z.ZodType<unknown>])[] = [
    [CONTROL_SIMULATION_STARTED, controlSimulationStartedPayloadSchema],
    [CONTROL_SIMULATION_PAUSED, controlSimulationPausedPayloadSchema],
    [CONTROL_SIMULATION_RESUMED, controlSimulationResumedPayloadSchema],
    [CONTROL_SIMULATION_STEPPED, controlSimulationSteppedPayloadSchema],
    [CONTROL_SIMULATION_SOUGHT, controlSimulationSoughtPayloadSchema],
    [CONTROL_AGENT_CREATED, controlAgentCreatedPayloadSchema],
    [CONTROL_AGENT_ARCHIVED, controlAgentArchivedPayloadSchema],
    [CONTROL_AGENT_PAUSED, controlAgentPausedPayloadSchema],
    [CONTROL_AGENT_RESUMED, controlAgentResumedPayloadSchema],
    [CONTROL_AGENT_INSTRUCTED, controlAgentInstructedPayloadSchema],
    [CONTROL_AGENT_TASK_CANCELLED, controlAgentTaskCancelledPayloadSchema],
    [CONTROL_AGENT_REVIEW_REQUESTED, controlAgentReviewRequestedPayloadSchema],
    [CONTROL_WORKFLOW_CANCELLED, controlWorkflowCancelledPayloadSchema],
    [CONTROL_WORKFLOW_APPROVAL_DECIDED, controlWorkflowApprovalDecidedPayloadSchema],
    [CONTROL_WORKFLOW_DELETED, controlWorkflowDeletedPayloadSchema],
    [CONTROL_WORKFLOW_INSTANCE_ASSIGNMENT_OVERRIDDEN, controlWorkflowInstanceAssignmentOverriddenPayloadSchema],
    [CONTROL_WORKFLOW_INSTANCE_CONFIRMED, controlWorkflowInstanceConfirmedPayloadSchema],
    [CONTROL_TASK_CANCELLED, controlTaskCancelledPayloadSchema],
    [CONTROL_TASK_DELETED, controlTaskDeletedPayloadSchema],
    [CONTROL_TASK_REASSIGNED, controlTaskReassignedPayloadSchema],
    [CONTROL_TASK_ASSIGNED, controlTaskAssignedPayloadSchema],
    [CONTROL_TASK_REVIEW_REQUESTED, controlTaskReviewRequestedPayloadSchema],
    [CONTROL_TASK_INJECTED, controlTaskInjectedPayloadSchema],
    [CONTROL_DELEGATION_DECIDED, controlDelegationDecidedPayloadSchema],
    [CONTROL_EVENT_INJECTED, controlEventInjectedPayloadSchema],
    [CONTROL_WORK_BRIEFED, controlWorkBriefedPayloadSchema],
    [CONTROL_COMMAND_REJECTED, controlCommandRejectedPayloadSchema],
  ];
  for (const [type, schema] of registrations) {
    const result = registerOnce(registry, type, schema);
    if (!result.ok) return result;
  }
  return { ok: true, value: undefined };
}

export function isControlEvent(type: string): boolean {
  return (CONTROL_EVENT_TYPES as readonly string[]).includes(type);
}
