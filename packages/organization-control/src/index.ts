export type {
  ControlAction,
  Action,
} from '@maoeh/shared-types';
export { CONTROL_ACTIONS } from '@maoeh/shared-types';

export {
  CONTROL_ACTION_BY_COMMAND,
  CONTROL_COMMAND_TYPES,
  CONTROL_DOMAIN_BY_COMMAND,
  CONTROL_TARGET_TYPES,
  controlResourceOf,
} from './types.js';
export type {
  AgentActivity,
  AgentActivityEntry,
  AgentArchiveCommand,
  AgentCreateCommand,
  AgentLifecycleFailureCode,
  AgentLifecycleResult,
  AgentMaterialization,
  AgentStateView,
  AgentSummary,
  ApprovalInbox,
  AuditPort,
  AuditPortRecord,
  AuditRecordLike,
  AuditTargetClaim,
  AuditTrailEntry,
  AuditView,
  ControlActor,
  ControlAuthorizationDecision,
  ControlAuthorizationRequest,
  ControlCommand,
  ControlCommandType,
  ControlErrorCode,
  ControlFailure,
  ControlIssue,
  ControlOutcome,
  ControlSimulationPort,
  ControlState,
  ControlTarget,
  ControlTargetType,
  CreateAgentRequest,
  DepartmentSummary,
  EmployeeSummary,
  EventStreamFilter,
  EventView,
  OrganizationSnapshot,
  PendingApprovalView,
  PositionSummary,
  SimulationSnapshot,
  SimulationStateView,
  TaskSummary,
  TaskView,
  WorkBriefItemView,
  WorkBriefSpec,
  WorkBriefView,
  WorkSubmitBriefCommand,
  WorkflowConfirmStartCommand,
  WorkflowInstanceAssignmentOverrideCommand,
  WorkflowCanvasStepView,
  WorkflowSummary,
  WorkflowView,
} from './types.js';

export {
  AGENT_LIFECYCLE_STATUSES,
  ARCHIVED_EMPLOYMENT_STATUS,
  agentLifecycleOf,
  isArchivedEmployment,
} from './agent-lifecycle.js';
export type { AgentLifecycleStatus } from './agent-lifecycle.js';

export {
  AGENT_ARCHIVED,
  AGENT_CREATED,
  CONTROL_AGENT_ARCHIVED,
  CONTROL_AGENT_CREATED,
  CONTROL_AGENT_INSTRUCTED,
  CONTROL_AGENT_PAUSED,
  CONTROL_AGENT_RESUMED,
  CONTROL_AGENT_REVIEW_REQUESTED,
  CONTROL_AGENT_TASK_CANCELLED,
  CONTROL_COMMAND_REJECTED,
  CONTROL_DELEGATION_DECIDED,
  CONTROL_EVENT_INJECTED,
  CONTROL_EVENT_TYPES,
  CONTROL_SIMULATION_PAUSED,
  CONTROL_SIMULATION_RESUMED,
  CONTROL_SIMULATION_SOUGHT,
  CONTROL_SIMULATION_STARTED,
  CONTROL_SIMULATION_STEPPED,
  CONTROL_TASK_ASSIGNED,
  CONTROL_TASK_CANCELLED,
  CONTROL_TASK_DELETED,
  CONTROL_TASK_INJECTED,
  CONTROL_TASK_REASSIGNED,
  CONTROL_TASK_REVIEW_REQUESTED,
  CONTROL_WORK_BRIEFED,
  CONTROL_WORKFLOW_APPROVAL_DECIDED,
  CONTROL_WORKFLOW_CANCELLED,
  CONTROL_WORKFLOW_DELETED,
  CONTROL_WORKFLOW_INSTANCE_ASSIGNMENT_OVERRIDDEN,
  CONTROL_WORKFLOW_INSTANCE_CONFIRMED,
  controlAgentArchivedPayloadSchema,
  controlAgentCreatedPayloadSchema,
  controlAgentInstructedPayloadSchema,
  controlAgentPausedPayloadSchema,
  controlAgentReviewRequestedPayloadSchema,
  controlAgentResumedPayloadSchema,
  controlAgentTaskCancelledPayloadSchema,
  controlCommandRejectedPayloadSchema,
  controlDelegationDecidedPayloadSchema,
  controlEventInjectedPayloadSchema,
  controlSimulationPausedPayloadSchema,
  controlSimulationResumedPayloadSchema,
  controlSimulationSoughtPayloadSchema,
  controlSimulationStartedPayloadSchema,
  controlSimulationSteppedPayloadSchema,
  controlTaskAssignedPayloadSchema,
  controlTaskCancelledPayloadSchema,
  controlTaskDeletedPayloadSchema,
  controlTaskInjectedPayloadSchema,
  controlTaskReassignedPayloadSchema,
  controlTaskReviewRequestedPayloadSchema,
  controlWorkBriefedPayloadSchema,
  controlWorkflowApprovalDecidedPayloadSchema,
  controlWorkflowCancelledPayloadSchema,
  controlWorkflowDeletedPayloadSchema,
  controlWorkflowInstanceAssignmentOverriddenPayloadSchema,
  controlWorkflowInstanceConfirmedPayloadSchema,
  isControlEvent,
  registerControlEvents,
} from './events.js';
export type {
  ControlAgentArchivedPayload,
  ControlAgentCreatedPayload,
  ControlAgentInstructedPayload,
  ControlDelegationDecidedPayload,
  ControlEventInjectedPayload,
  ControlSimulationPausedPayload,
  ControlTaskAssignedPayload,
  ControlTaskInjectedPayload,
  ControlWorkBriefedPayload,
  ControlWorkflowInstanceAssignmentOverriddenPayload,
  ControlWorkflowInstanceConfirmedPayload,
} from './events.js';

export {
  EMPTY_CONTROL_POLICY,
  checkAuthority,
  controlPolicyForPosition,
  createControlAuthorizer,
  defaultControlPolicy,
  toFailure,
} from './authorization.js';
export type {
  ControlAuthorizer,
  ControlAuthorizerOptions,
} from './authorization.js';

export {
  applyControlEvent,
  applyControlEvents,
  agentVersionOf,
  createInitialControlProjection,
  taskVersionOf,
  workflowVersionOf,
} from './state.js';
export type { ControlProjection } from './state.js';

export {
  controlFailure,
  controlIssue,
  fingerprintOf,
  resolveOperatorActor,
  validateCommand,
} from './validation.js';

export {
  fromTaskFailure,
  fromWorkflowFailure,
  createControlService,
} from './service.js';
export type { ControlPlane, ControlServiceOptions } from './service.js';

export {
  BACKGROUND_EVENT_TYPE_PREFIXES,
  createControlQuery,
  toAuditView,
  toEventView,
} from './query.js';
export type { AuditReader, ControlQuery, ControlQueryOptions } from './query.js';

/**
 * M3.1 · unified collaboration protocol + trace, and M3.0 legacy-work audit.
 * Pure projections over the existing event log — no new event system, no writes.
 */
export {
  COLLABORATION_EVENT_KINDS,
  COLLABORATION_EVENT_PROTOCOL,
  collaborationDescriptorOf,
  collaborationKindOf,
  isCollaborationEvent,
  protocolDescriptorOf,
} from './collaboration/protocol.js';
export type {
  CollaborationEventDescriptor,
  CollaborationEventDirection,
  CollaborationEventKind,
  CollaborationEventStatus,
  CollaborationTraceApplicability,
} from './collaboration/protocol.js';
export {
  buildCollaborationTrace,
  collaborationTraceOfSession,
  collaborationTraceOfTask,
} from './collaboration/trace.js';
export type {
  CollaborationTrace,
  CollaborationTraceDanglingLink,
  CollaborationTraceEntry,
  CollaborationTraceOptions,
  CollaborationTraceSession,
} from './collaboration/trace.js';
export { buildMessageLifecycles } from './collaboration/message-lifecycle.js';
export type {
  MessageDeliveryLike,
  MessageLifecycle,
  MessageRecipientLifecycle,
  MessageRecipientState,
} from './collaboration/message-lifecycle.js';

/**
 * M3.2 · collaboration theater: the seven business stages, the honest stage association and the
 * per-event projection the SSE tail and the replay endpoint share.
 */
export {
  THEATER_STAGES,
  TheaterStageTracker,
  buildTheaterEvents,
  stageOfCapability,
  stageOfEventType,
  theaterEventOf,
} from './collaboration/theater.js';
export type {
  TheaterEventView,
  TheaterHistory,
  TheaterHistoryInput,
  TheaterStageBasis,
  TheaterStageId,
  TheaterStageSeed,
  TheaterStageView,
} from './collaboration/theater.js';
export { auditLegacyWork, legacyRepairPlan } from './legacy-audit.js';
export type {
  LegacyAuditInput,
  LegacyAuditReport,
  LegacyFinding,
  LegacyFindingCode,
  LegacyFindingSeverity,
  LegacyRepairAction,
  LegacyRepairCommand,
} from './legacy-audit.js';
