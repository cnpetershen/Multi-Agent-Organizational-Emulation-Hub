import type { OrgEvent } from '@maoeh/shared-types';
import type { CollaborationEventKind } from './protocol.js';
import { collaborationKindOf } from './protocol.js';

/**
 * M3.1 · Collaboration trace.
 *
 * Turns the raw event log into the one thing a human can actually follow: what each agent said
 * or handed over, to whom, why (causation), inside which session, and on which task/workflow.
 *
 * It is a **pure projection**: no new events, no writes, no LLM. Everything here is derived from
 * facts the domain already appended, which is what makes the trace trustworthy — if it is not in
 * the log, it is not in the timeline.
 */

export interface CollaborationTraceEntry {
  readonly eventId: string;
  readonly seq: number;
  readonly type: string;
  readonly kind: CollaborationEventKind;
  /**
   * The session/thread this fact belongs to. In MAOEH that is the `correlationId`: one work brief,
   * one sandbox session, one operator command. It is surfaced under the name the collaboration
   * model asks for rather than duplicated as a new event field.
   */
  readonly sessionId: string;
  readonly workflowInstanceId: string | null;
  readonly taskId: string | null;
  readonly handoffId: string | null;
  readonly messageId: string | null;
  readonly approvalKey: string | null;
  readonly senderAgentId: string | null;
  readonly receiverAgentIds: readonly string[];
  readonly causationId: string | null;
  readonly occurredAtSim: number;
  readonly occurredAtWall: string;
  /** `Task.ProgressReported` phase, when the event carries one. */
  readonly phase: string | null;
  /** Terminal/settlement outcome when the kind has one (handoff outcome, review verdict). */
  readonly outcome: string | null;
  /** A short, id-free sentence for a product surface. */
  readonly summary: string;
}

export interface CollaborationTraceSession {
  readonly sessionId: string;
  readonly entries: readonly CollaborationTraceEntry[];
  readonly taskIds: readonly string[];
  readonly workflowInstanceIds: readonly string[];
  readonly agentIds: readonly string[];
}

/** A causation pointer whose target is not in the projected window — a broken chain, not a fact. */
export interface CollaborationTraceDanglingLink {
  readonly eventId: string;
  readonly causationId: string;
  readonly type: string;
}

export interface CollaborationTrace {
  readonly entries: readonly CollaborationTraceEntry[];
  readonly sessions: readonly CollaborationTraceSession[];
  readonly danglingCausation: readonly CollaborationTraceDanglingLink[];
}

export interface CollaborationTraceOptions {
  /**
   * Treat a missing causation target as a broken link. Defaults to `true`; pass `false` when the
   * caller projected a deliberately narrow window (e.g. one task) whose causes predate it.
   */
  readonly requireCausationInWindow?: boolean;
}

function payloadOf(event: OrgEvent): Readonly<Record<string, unknown>> {
  return typeof event.payload === 'object' && event.payload !== null
    ? (event.payload as Readonly<Record<string, unknown>>)
    : {};
}

function readString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

function subRecord(
  record: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = record[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

interface Identities {
  readonly senderAgentId: string | null;
  readonly receiverAgentIds: readonly string[];
  readonly workflowInstanceId: string | null;
  readonly taskId: string | null;
  readonly handoffId: string | null;
  readonly messageId: string | null;
  readonly approvalKey: string | null;
  readonly phase: string | null;
  readonly outcome: string | null;
  readonly summary: string;
}

/**
 * Who sent what to whom, per event type. The payload shapes are the domain's own; nothing is
 * guessed — a field the event does not carry stays `null` instead of being back-filled.
 */
function identitiesOf(
  event: OrgEvent,
  kind: CollaborationEventKind,
  taskWorkflowInstances: ReadonlyMap<string, string>,
): Identities {
  const payload = payloadOf(event);
  const taskId = readString(payload, 'taskId');
  // Workflow events carry their instance directly; Task.* events do not. The task's instance is
  // its `Task.Created` fact, so a trace resolves it from the log instead of inventing it.
  const instanceId =
    readString(payload, 'instanceId') ??
    (taskId === null ? null : (taskWorkflowInstances.get(taskId) ?? null));
  const actor = event.actorId;
  const none = {
    workflowInstanceId: instanceId,
    taskId,
    handoffId: null,
    messageId: null,
    approvalKey: null,
    phase: null,
    outcome: null,
  } as const;

  if (kind === 'AgentMessage') {
    const sender = readString(payload, 'senderId') ?? actor;
    const recipients = readStringArray(payload, 'recipientIds');
    const subject = readString(payload, 'subject');
    return {
      ...none,
      messageId: readString(payload, 'messageId'),
      senderAgentId: sender,
      receiverAgentIds: recipients,
      summary:
        recipients.length === 0
          ? 'a message was sent'
          : `message sent to ${String(recipients.length)} recipient(s)${subject === null ? '' : `: ${subject}`}`,
    };
  }

  if (kind === 'TaskAssigned') {
    const assignment = subRecord(payload, 'assignment');
    const assignee = readString(assignment, 'assigneeEmployeeId');
    const title = readString(payload, 'title');
    return {
      ...none,
      senderAgentId: actor,
      receiverAgentIds: assignee === null ? [] : [assignee],
      summary: `task assigned${title === null ? '' : `: ${title}`}`,
    };
  }

  if (kind === 'TaskAccepted') {
    return {
      ...none,
      senderAgentId: readString(payload, 'employeeId') ?? actor,
      receiverAgentIds: [],
      summary: 'task accepted by its executor',
    };
  }

  if (kind === 'TaskHandoff') {
    const handoffId = readString(payload, 'handoffId');
    const from = readString(payload, 'fromEmployeeId') ?? actor;
    const to = readString(payload, 'toEmployeeId');
    const outcome = readString(payload, 'outcome');
    const map: Readonly<Record<string, string>> = {
      'Task.HandoffRequested': 'handoff requested',
      'Task.HandoffAccepted': 'handoff accepted — the task moved to the receiver',
      'Task.HandoffDeclined': 'handoff declined — the task stays with the sender',
      'Task.HandoffCompleted': `handoff settled: ${outcome ?? 'no outcome'}`,
    };
    return {
      ...none,
      handoffId,
      senderAgentId: from,
      receiverAgentIds: to === null ? [] : [to],
      outcome,
      summary: map[event.type] ?? 'handoff updated',
    };
  }

  if (kind === 'ProgressReported') {
    const result = subRecord(payload, 'result');
    const summary = readString(payload, 'summary');
    return {
      ...none,
      senderAgentId: readString(payload, 'employeeId') ?? actor,
      receiverAgentIds: [],
      phase: 'progress',
      summary: summary ?? readString(result, 'summary') ?? 'progress reported',
    };
  }

  if (kind === 'DeliverableSubmitted') {
    const result = subRecord(payload, 'result');
    const review = subRecord(payload, 'review');
    const verdict = readString(review, 'verdict');
    const phase = readString(payload, 'phase') ?? 'submitted';
    return {
      ...none,
      senderAgentId: readString(payload, 'employeeId') ?? actor,
      receiverAgentIds: [],
      phase,
      outcome: verdict,
      summary:
        phase === 'reviewed'
          ? `deliverable reviewed: ${verdict ?? 'verdict recorded'}`
          : (readString(result, 'summary') ?? 'deliverable submitted'),
    };
  }

  if (kind === 'ApprovalRequested') {
    return {
      ...none,
      approvalKey: readString(payload, 'approvalKey'),
      senderAgentId: readString(payload, 'requestedBy') ?? actor,
      receiverAgentIds: [],
      summary: 'approval requested — the workflow step is waiting on a decision',
    };
  }

  return {
    ...none,
    senderAgentId: actor,
    receiverAgentIds: [],
    summary: `${kind} recorded`,
  };
}

/** The task → workflow instance link, readable from `Task.Created` alone. */
function taskWorkflowInstancesOf(events: readonly OrgEvent[]): ReadonlyMap<string, string> {
  const instances = new Map<string, string>();
  for (const event of events) {
    if (event.type !== 'Task.Created') continue;
    const payload = payloadOf(event);
    const taskId = readString(payload, 'taskId');
    const instanceId = readString(payload, 'workflowInstanceId');
    if (taskId !== null && instanceId !== null) instances.set(taskId, instanceId);
  }
  return instances;
}

export function buildCollaborationTrace(
  events: readonly OrgEvent[],
  options: CollaborationTraceOptions = {},
): CollaborationTrace {
  const entries: CollaborationTraceEntry[] = [];
  const knownEventIds = new Set(events.map((event) => event.eventId));
  const taskWorkflowInstances = taskWorkflowInstancesOf(events);

  for (const event of events) {
    const kind = collaborationKindOf(event);
    if (kind === null) continue;
    const identities = identitiesOf(event, kind, taskWorkflowInstances);
    entries.push(
      Object.freeze({
        eventId: event.eventId,
        seq: event.seq,
        type: event.type,
        kind,
        sessionId: event.correlationId,
        workflowInstanceId: identities.workflowInstanceId,
        taskId: identities.taskId,
        handoffId: identities.handoffId,
        messageId: identities.messageId,
        approvalKey: identities.approvalKey,
        senderAgentId: identities.senderAgentId,
        receiverAgentIds: Object.freeze([...identities.receiverAgentIds]),
        causationId: event.causationId,
        occurredAtSim: Number(event.occurredAtSim),
        occurredAtWall: event.occurredAtWall,
        phase: identities.phase,
        outcome: identities.outcome,
        summary: identities.summary,
      }),
    );
  }

  const requireInWindow = options.requireCausationInWindow ?? true;
  const danglingCausation: CollaborationTraceDanglingLink[] = [];
  if (requireInWindow) {
    for (const entry of entries) {
      if (entry.causationId === null) continue;
      if (knownEventIds.has(entry.causationId)) continue;
      danglingCausation.push(
        Object.freeze({
          eventId: entry.eventId,
          causationId: entry.causationId,
          type: entry.type,
        }),
      );
    }
  }

  const sessionMap = new Map<string, CollaborationTraceEntry[]>();
  for (const entry of entries) {
    const list = sessionMap.get(entry.sessionId) ?? [];
    list.push(entry);
    sessionMap.set(entry.sessionId, list);
  }
  const sessions: CollaborationTraceSession[] = [...sessionMap.entries()].map(
    ([sessionId, sessionEntries]) =>
      Object.freeze({
        sessionId,
        entries: Object.freeze([...sessionEntries]),
        taskIds: Object.freeze([
          ...new Set(sessionEntries.flatMap((entry) => (entry.taskId === null ? [] : [entry.taskId]))),
        ]),
        workflowInstanceIds: Object.freeze([
          ...new Set(
            sessionEntries.flatMap((entry) =>
              entry.workflowInstanceId === null ? [] : [entry.workflowInstanceId],
            ),
          ),
        ]),
        agentIds: Object.freeze([
          ...new Set(
            sessionEntries.flatMap((entry) =>
              [entry.senderAgentId, ...entry.receiverAgentIds].filter(
                (id): id is string => id !== null,
              ),
            ),
          ),
        ]),
      }),
  );

  return Object.freeze({
    entries: Object.freeze(entries),
    sessions: Object.freeze(sessions),
    danglingCausation: Object.freeze(danglingCausation),
  });
}

/** The ordered entries that touch one task (its whole handoff/approval chain). */
export function collaborationTraceOfTask(
  trace: CollaborationTrace,
  taskId: string,
): readonly CollaborationTraceEntry[] {
  return Object.freeze(trace.entries.filter((entry) => entry.taskId === taskId));
}

/** The ordered entries of one session (one brief, one sandbox session, one operator command). */
export function collaborationTraceOfSession(
  trace: CollaborationTrace,
  sessionId: string,
): readonly CollaborationTraceEntry[] {
  return Object.freeze(trace.entries.filter((entry) => entry.sessionId === sessionId));
}
