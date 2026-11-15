import type { OrgEvent } from '@maoeh/shared-types';
import {
  TASK_ACCEPTED,
  TASK_ASSIGNED,
  TASK_HANDOFF_ACCEPTED,
  TASK_HANDOFF_COMPLETED,
  TASK_HANDOFF_DECLINED,
  TASK_HANDOFF_REQUESTED,
  TASK_PROGRESS_REPORTED,
} from '@maoeh/task-system';
import { WORKFLOW_APPROVAL_REQUESTED } from '@maoeh/workflow-engine';

/**
 * M3.1 · The unified Agent collaboration event protocol.
 *
 * ## What this file is (and is not)
 *
 * It is a **descriptor over the existing event system**, not a second event system. Every
 * collaboration fact is already (or will be) a domain event on the one append-only log; this
 * table answers the three questions a collaboration surface needs without inventing new facts:
 *
 *   1. which semantic collaboration kind an event carries,
 *   2. which of the mandated trace fields actually apply to it, and
 *   3. which package owns its contract, so a later module knows where to extend it.
 *
 * The rule followed here is "reuse semantics before defining new ones": six of the eleven
 * mandated kinds are already produced by the M0–M2 code (`Communication.MessageSent`,
 * `Task.Assigned`, `Task.Accepted`, `Task.ProgressReported`, `Task.Handoff*`,
 * `Workflow.ApprovalRequested`). Nothing was re-declared under a new name.
 *
 * Per the mandate ("按现有架构决定哪些字段适用"), trace fields are deliberately **not**
 * force-filled. A `Task.Accepted` fact has no receiver — it is the executor's own act — and the
 * protocol says so instead of writing a duplicate `receiverAgentId` that means nothing. The
 * `trace` flags below are the contract a projection may rely on.
 *
 * ## Reserved kinds
 *
 * `DecisionProposed` / `DecisionAccepted` / `ConflictDetected` / `ConflictResolved` are part of
 * the collaboration model but are **not implemented yet**: their owning engines (`decision-engine`,
 * `escalation-engine`) are still scaffolds, and emitting a schema-less event just to fill the list
 * would be exactly the fake collaboration this milestone forbids. They are declared `reserved`
 * with the type names and aggregates they will own; the registry check in
 * `tests/architecture/collaboration-protocol.test.ts` pins that a reserved kind has no registered
 * event and an implemented kind does.
 */

export const COLLABORATION_EVENT_KINDS = [
  'AgentMessage',
  'TaskAssigned',
  'TaskAccepted',
  'TaskHandoff',
  'ProgressReported',
  'DecisionProposed',
  'DecisionAccepted',
  'ConflictDetected',
  'ConflictResolved',
  'DeliverableSubmitted',
  'ApprovalRequested',
] as const;

export type CollaborationEventKind = (typeof COLLABORATION_EVENT_KINDS)[number];

/** `implemented` = a registered event exists; `reserved` = contract space, no emitter yet. */
export type CollaborationEventStatus = 'implemented' | 'reserved';

/** Who speaks the event: a request, its answer, or a one-sided fact. */
export type CollaborationEventDirection = 'request' | 'response' | 'fact';

/**
 * Which of the mandated trace fields the event can actually carry.
 *
 * `sessionId` is not a field on `OrgEvent`: in MAOEH the business session/thread is the
 * `correlationId` (one brief, one sandbox session, one operator command), so it is projected from
 * there. `workflowInstanceId` / `taskId` come from the payload and are only claimed when the
 * domain writes them.
 */
export interface CollaborationTraceApplicability {
  /** The event belongs to a session/thread — always true: every event carries `correlationId`. */
  readonly sessionId: boolean;
  readonly workflowInstanceId: boolean;
  readonly taskId: boolean;
  /** The event names who asked/sent. */
  readonly senderAgentId: boolean;
  /** The event names who is asked to act. False when the act is not addressed to anybody. */
  readonly receiverAgentId: boolean;
  /** The event records its direct cause; false only for domain roots (e.g. a task creation). */
  readonly causationId: boolean;
  /** Extra payload identities worth tracing for this kind (handoffId, messageId, approvalKey …). */
  readonly correlationKeys: readonly string[];
}

export interface CollaborationEventDescriptor {
  readonly kind: CollaborationEventKind;
  /** Concrete event types already on (or planned for) the log. Empty only for reserved kinds. */
  readonly eventTypes: readonly string[];
  readonly status: CollaborationEventStatus;
  readonly aggregate: string;
  readonly direction: CollaborationEventDirection;
  /** The package that owns the event contract — where a future refinement belongs. */
  readonly owner: string;
  readonly trace: CollaborationTraceApplicability;
  /** One sentence a product surface can show; never a technical id. */
  readonly label: string;
}

const SESSION = { sessionId: true } as const;

const TASK_TRACE: CollaborationTraceApplicability = Object.freeze({
  ...SESSION,
  workflowInstanceId: true,
  taskId: true,
  senderAgentId: true,
  receiverAgentId: true,
  causationId: true,
  correlationKeys: Object.freeze(['handoffId', 'messageId']),
});

export const COLLABORATION_EVENT_PROTOCOL: readonly CollaborationEventDescriptor[] = Object.freeze([
  {
    kind: 'AgentMessage',
    eventTypes: Object.freeze(['Communication.MessageSent']),
    status: 'implemented',
    aggregate: 'Communication',
    direction: 'request',
    owner: 'agent-communication',
    trace: Object.freeze({
      ...SESSION,
      workflowInstanceId: false,
      taskId: false,
      senderAgentId: true,
      receiverAgentId: true,
      causationId: true,
      correlationKeys: Object.freeze(['messageId', 'channelId']),
    }),
    label: 'An agent sent a message to one or more colleagues.',
  },
  {
    kind: 'TaskAssigned',
    eventTypes: Object.freeze([TASK_ASSIGNED]),
    status: 'implemented',
    aggregate: 'Task',
    direction: 'request',
    owner: 'task-system',
    trace: Object.freeze({
      ...SESSION,
      workflowInstanceId: true,
      taskId: true,
      senderAgentId: true,
      receiverAgentId: true,
      causationId: true,
      // The assignment itself names no handoff or message: it is the briefing, and its own keys
      // (attempt, assignment) are what a trace can honestly claim.
      correlationKeys: Object.freeze(['taskId', 'attempt', 'assignment']),
    }),
    label: 'A task was assigned to an executor; the assignment is the briefing.',
  },
  {
    kind: 'TaskAccepted',
    eventTypes: Object.freeze([TASK_ACCEPTED]),
    status: 'implemented',
    aggregate: 'Task',
    direction: 'response',
    owner: 'task-system',
    trace: Object.freeze({
      ...SESSION,
      workflowInstanceId: true,
      taskId: true,
      senderAgentId: true,
      receiverAgentId: false,
      causationId: true,
      correlationKeys: Object.freeze(['taskId']),
    }),
    label: 'The executor accepted the task they were given.',
  },
  {
    kind: 'TaskHandoff',
    eventTypes: Object.freeze([
      TASK_HANDOFF_REQUESTED,
      TASK_HANDOFF_ACCEPTED,
      TASK_HANDOFF_DECLINED,
      TASK_HANDOFF_COMPLETED,
    ]),
    status: 'implemented',
    aggregate: 'Task',
    direction: 'request',
    owner: 'task-system',
    trace: TASK_TRACE,
    label: 'One agent asked another to take over a task; the chain ends with the result.',
  },
  {
    kind: 'ProgressReported',
    eventTypes: Object.freeze([TASK_PROGRESS_REPORTED]),
    status: 'implemented',
    aggregate: 'Task',
    direction: 'fact',
    owner: 'task-system',
    trace: Object.freeze({
      ...SESSION,
      workflowInstanceId: true,
      taskId: true,
      senderAgentId: true,
      receiverAgentId: false,
      causationId: true,
      correlationKeys: Object.freeze(['taskId']),
    }),
    label: 'The executor reported progress (phase `progress`).',
  },
  {
    kind: 'DeliverableSubmitted',
    eventTypes: Object.freeze([TASK_PROGRESS_REPORTED]),
    status: 'implemented',
    aggregate: 'Task',
    direction: 'response',
    owner: 'task-system',
    trace: Object.freeze({
      ...SESSION,
      workflowInstanceId: true,
      taskId: true,
      senderAgentId: true,
      receiverAgentId: false,
      causationId: true,
      correlationKeys: Object.freeze(['taskId']),
    }),
    label: 'The executor submitted a deliverable (phase `submitted`; `reviewed` carries a verdict).',
  },
  {
    kind: 'ApprovalRequested',
    eventTypes: Object.freeze([WORKFLOW_APPROVAL_REQUESTED]),
    status: 'implemented',
    aggregate: 'Workflow',
    direction: 'request',
    owner: 'workflow-engine',
    trace: Object.freeze({
      ...SESSION,
      workflowInstanceId: true,
      taskId: false,
      senderAgentId: true,
      receiverAgentId: false,
      causationId: true,
      correlationKeys: Object.freeze(['instanceId', 'stepId', 'approvalKey']),
    }),
    label: 'A workflow step opened a gate for a human or an authorized role to decide.',
  },
  {
    kind: 'DecisionProposed',
    eventTypes: Object.freeze(['Decision.Proposed']),
    status: 'reserved',
    aggregate: 'Decision',
    direction: 'request',
    owner: 'decision-engine',
    trace: TASK_TRACE,
    label: 'A proposal was put to the organization for a decision (not emitted yet).',
  },
  {
    kind: 'DecisionAccepted',
    eventTypes: Object.freeze(['Decision.Accepted']),
    status: 'reserved',
    aggregate: 'Decision',
    direction: 'response',
    owner: 'decision-engine',
    trace: TASK_TRACE,
    label: 'The organization accepted a proposal (not emitted yet).',
  },
  {
    kind: 'ConflictDetected',
    eventTypes: Object.freeze(['Conflict.Detected']),
    status: 'reserved',
    aggregate: 'Conflict',
    direction: 'fact',
    owner: 'escalation-engine',
    trace: TASK_TRACE,
    label: 'A conflict between agents or work was detected (not emitted yet).',
  },
  {
    kind: 'ConflictResolved',
    eventTypes: Object.freeze(['Conflict.Resolved']),
    status: 'reserved',
    aggregate: 'Conflict',
    direction: 'response',
    owner: 'escalation-engine',
    trace: TASK_TRACE,
    label: 'A detected conflict was resolved, with its resolution recorded (not emitted yet).',
  },
]);

/** Event type → descriptor. A type belongs to exactly one kind. */
const BY_EVENT_TYPE: ReadonlyMap<string, CollaborationEventDescriptor> = new Map(
  COLLABORATION_EVENT_PROTOCOL.flatMap((descriptor) =>
    descriptor.eventTypes.map((eventType) => [eventType, descriptor] as const),
  ),
);

export function collaborationDescriptorOf(
  eventType: string,
): CollaborationEventDescriptor | null {
  return BY_EVENT_TYPE.get(eventType) ?? null;
}

export function protocolDescriptorOf(
  kind: CollaborationEventKind,
): CollaborationEventDescriptor | null {
  return COLLABORATION_EVENT_PROTOCOL.find((descriptor) => descriptor.kind === kind) ?? null;
}

function payloadOf(event: OrgEvent): Readonly<Record<string, unknown>> {
  return typeof event.payload === 'object' && event.payload !== null
    ? (event.payload as Readonly<Record<string, unknown>>)
    : {};
}

/**
 * The semantic kind of one event, refined by payload when one type carries two kinds:
 * `Task.ProgressReported` is a progress report in phase `progress` and a deliverable
 * submission in phases `submitted`/`reviewed`.
 */
export function collaborationKindOf(event: OrgEvent): CollaborationEventKind | null {
  if (event.type === TASK_PROGRESS_REPORTED) {
    const phase = payloadOf(event)['phase'];
    return phase === 'progress' ? 'ProgressReported' : 'DeliverableSubmitted';
  }
  return collaborationDescriptorOf(event.type)?.kind ?? null;
}

/** `true` when the wire type is covered by the collaboration protocol at all. */
export function isCollaborationEvent(event: OrgEvent): boolean {
  return collaborationKindOf(event) !== null;
}
