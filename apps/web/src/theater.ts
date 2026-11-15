import { readNumber, readString, type Row } from './api';

/**
 * M3.2 · the collaboration theater's read model.
 *
 * Pure functions over the events the API already streamed. Nothing here invents a fact, a
 * message, an employee or a stage: every card is a projection of one or more real `OrgEvent`s,
 * and the page only turns ids into names and tokens into copy.
 *
 * The two merges that matter:
 *   - a message is one card whose state is updated by `Communication.MessageProcessed`;
 *   - a handoff is one card whose status is updated by `Accepted` / `Declined` / `Completed`,
 *     so the floor shows the chain, not four unrelated rows.
 */

export const THEATER_STAGES = [
  'sandbox',
  'orchestration',
  'canvas',
  'implementation',
  'approval',
  'promotion',
  'release',
] as const;

export type TheaterStage = (typeof THEATER_STAGES)[number];

/** The stage filter: all, one of the seven, or the honest "no proven stage" bucket. */
export type TheaterStageFilter = 'all' | TheaterStage | 'unclassified';

export interface TheaterEvent {
  readonly seq: number;
  readonly eventId: string;
  readonly type: string;
  readonly occurredAtSim: number;
  readonly actorId: string | null;
  readonly subjectId: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload: Row;
  readonly stage: TheaterStage | null;
  readonly stageBasis: string | null;
}

export interface TheaterHistory {
  readonly companyId: string;
  readonly latestSeq: number;
  readonly events: readonly TheaterEvent[];
}

function isStage(value: unknown): value is TheaterStage {
  return typeof value === 'string' && (THEATER_STAGES as readonly string[]).includes(value);
}

function payloadOf(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Parse one SSE frame / history event; a malformed event is dropped, never guessed at. */
export function parseTheaterEvent(value: unknown): TheaterEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Row;
  const seq = readNumber(row['seq'], 0);
  const eventId = readString(row['eventId'], '');
  const type = readString(row['type'], '');
  if (seq <= 0 || eventId === '' || type === '') return null;
  return {
    seq,
    eventId,
    type,
    occurredAtSim: readNumber(row['occurredAtSim'], 0),
    actorId: optionalString(row['actorId']),
    subjectId: optionalString(row['subjectId']),
    correlationId: readString(row['correlationId'], ''),
    causationId: optionalString(row['causationId']),
    payload: payloadOf(row['payload']),
    stage: isStage(row['stage']) ? row['stage'] : null,
    stageBasis: optionalString(row['stageBasis']),
  };
}

/** Parse `GET /api/theater/history`; an unreadable envelope is an error, not an empty feed. */
export function parseTheaterHistory(value: unknown): TheaterHistory {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('theater history is not an object');
  }
  const row = value as Row;
  const events = Array.isArray(row['events'])
    ? (row['events'] as readonly unknown[])
        .map(parseTheaterEvent)
        .filter((event): event is TheaterEvent => event !== null)
    : [];
  return {
    companyId: readString(row['companyId'], ''),
    latestSeq: readNumber(row['latestSeq'], 0),
    events,
  };
}

/**
 * Merge a live batch into the feed: ordered by seq, deduplicated by seq, capped.
 *
 * Deduplication is by `seq` because the server's cursor is a seq and a reconnect may legitimately
 * re-deliver the boundary event; dropping it keeps the floor from showing one handoff twice.
 */
export function mergeTheaterEvents(
  current: readonly TheaterEvent[],
  incoming: readonly TheaterEvent[],
  limit = 400,
): readonly TheaterEvent[] {
  if (incoming.length === 0) return current;
  const bySeq = new Map<number, TheaterEvent>();
  for (const event of current) bySeq.set(event.seq, event);
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()]
    .sort((left, right) => left.seq - right.seq)
    .slice(-limit);
}

export function stageFilterOf(event: TheaterEvent): TheaterStageFilter {
  return event.stage ?? 'unclassified';
}

export function countByStage(
  events: readonly TheaterEvent[],
): Readonly<Record<TheaterStageFilter, number>> {
  const counts: Record<TheaterStageFilter, number> = {
    all: events.length,
    sandbox: 0,
    orchestration: 0,
    canvas: 0,
    implementation: 0,
    approval: 0,
    promotion: 0,
    release: 0,
    unclassified: 0,
  };
  for (const event of events) counts[stageFilterOf(event)] += 1;
  return counts;
}

export function filterByStage(
  events: readonly TheaterEvent[],
  stage: TheaterStageFilter,
): readonly TheaterEvent[] {
  return stage === 'all' ? events : events.filter((event) => stageFilterOf(event) === stage);
}

/** The agent ids that acted in the recent window — used to make the stage feel alive. */
export function recentActors(events: readonly TheaterEvent[], window = 30): ReadonlySet<string> {
  const actors = new Set<string>();
  for (const event of events.slice(-window)) {
    if (event.actorId !== null) actors.add(event.actorId);
  }
  return actors;
}

// -------------------------------------------------------------------------------------------------
// Cards
// -------------------------------------------------------------------------------------------------

export type MessageState = 'sent' | 'processed' | 'failed';

export interface MessageCard {
  readonly kind: 'message';
  readonly key: string;
  readonly seq: number;
  readonly sim: number;
  readonly fromId: string | null;
  readonly toIds: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly messageType: string;
  readonly state: MessageState;
  readonly handled: number;
  readonly failed: number;
}

export type HandoffStatus = 'requested' | 'accepted' | 'declined' | 'completed';

export interface HandoffCard {
  readonly kind: 'handoff';
  readonly key: string;
  readonly seq: number;
  readonly sim: number;
  readonly handoffId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly fromId: string | null;
  readonly toId: string | null;
  readonly status: HandoffStatus;
  readonly reason: string;
  readonly outcome: string | null;
  readonly resultSummary: string | null;
}

export interface TaskCard {
  readonly kind: 'task';
  readonly key: string;
  readonly seq: number;
  readonly sim: number;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly type: string;
  readonly phase: string | null;
  readonly actorId: string | null;
  readonly assigneeId: string | null;
  readonly status: string;
}

export interface ApprovalCard {
  readonly kind: 'approval';
  readonly key: string;
  readonly seq: number;
  readonly sim: number;
  readonly instanceId: string | null;
  readonly instanceTitle: string;
  readonly status: string;
  readonly actorId: string | null;
}

export interface WorkflowCard {
  readonly kind: 'workflow';
  readonly key: string;
  readonly seq: number;
  readonly sim: number;
  readonly instanceId: string | null;
  readonly instanceTitle: string;
  readonly status: string;
  readonly actorId: string | null;
}

export interface BriefCard {
  readonly kind: 'brief';
  readonly key: string;
  readonly seq: number;
  readonly sim: number;
  readonly actorId: string | null;
  readonly type: string;
  readonly title: string;
  /** Who the instruction/work addressed, when the payload names an employee (never a task id). */
  readonly targetId: string | null;
}

export interface PublicationCard {
  readonly kind: 'publication';
  readonly key: string;
  readonly seq: number;
  readonly sim: number;
  readonly publicationId: string;
  readonly version: number;
  readonly status: string;
  readonly publicPath: string | null;
  readonly actorId: string | null;
}

export interface RequirementCard {
  readonly kind: 'requirement';
  readonly key: string;
  readonly seq: number;
  readonly sim: number;
  readonly title: string;
  readonly version: number;
  readonly status: 'analyzed' | 'confirmed';
  readonly actorId: string | null;
}

export interface PromotionCard {
  readonly kind: 'promotion';
  readonly key: string;
  readonly seq: number;
  readonly sim: number;
  readonly title: string;
  readonly version: number;
  readonly status: 'generated' | 'confirmed';
  readonly actorId: string | null;
}

export type FeedItem =
  | MessageCard
  | HandoffCard
  | TaskCard
  | ApprovalCard
  | WorkflowCard
  | BriefCard
  | PublicationCard
  | RequirementCard
  | PromotionCard;

export interface FeedContext {
  /** Task titles from the snapshot, for events whose payload restates only the id. */
  readonly taskTitles?: ReadonlyMap<string, string>;
  /** Workflow titles from the snapshot, keyed by instance id. */
  readonly workflowTitles?: ReadonlyMap<string, string>;
}

const TASK_TYPES = new Set([
  'Task.Assigned',
  'Task.Started',
  'Task.ProgressReported',
  'Task.Completed',
  'Task.Blocked',
  'Task.Failed',
  'Task.Cancelled',
  'Task.Deleted',
]);

const APPROVAL_TYPES: Readonly<Record<string, string>> = {
  'Workflow.ApprovalRequested': 'requested',
  'Workflow.ApprovalGranted': 'granted',
  'Workflow.ApprovalDenied': 'denied',
};

const PUBLICATION_TYPES: Readonly<Record<string, string>> = {
  'Document.PublicationDrafted': 'drafted',
  'Document.PublicationConfirmed': 'confirmed',
  'Document.PublicationPublished': 'published',
  'Document.PublicationPartiallyPublished': 'partial',
  'Document.PublicationFailed': 'failed',
};

const REQUIREMENT_TYPES: Readonly<Record<string, 'analyzed' | 'confirmed'>> = {
  'Document.RequirementAnalyzed': 'analyzed',
  'Document.RequirementConfirmed': 'confirmed',
};

const PROMOTION_TYPES: Readonly<Record<string, 'generated' | 'confirmed'>> = {
  'Document.PromotionGenerated': 'generated',
  'Document.PromotionConfirmed': 'confirmed',
};

const WORKFLOW_TYPES: Readonly<Record<string, string>> = {
  'Workflow.InstanceStarted': 'started',
  'Workflow.InstanceCompleted': 'completed',
  'Workflow.InstanceAborted': 'aborted',
  'Workflow.StepCompleted': 'step-completed',
  'Workflow.StepRejected': 'step-rejected',
  'Workflow.DraftConfirmed': 'draft-confirmed',
  'Workflow.StepAssignmentOverridden': 'overridden',
};

const BRIEF_TYPES = new Set([
  'Control.WorkBriefed',
  'Control.AgentInstructed',
  'Control.TaskInjected',
  'Control.DelegationDecided',
  'Control.TaskReassigned',
  'Control.AgentCreated',
  'Control.TaskReviewRequested',
  'Control.SimulationPaused',
  'Control.SimulationResumed',
]);

/**
 * The event types the theater actually renders.
 *
 * The API's history/stream carry the company's collaboration facts; this predicate is the
 * product's own curation: task creation/acceptance are mechanics, command rejections and
 * channel bookkeeping are not on the stage, and telemetry never reaches the client. Stage
 * counters use the same predicate, so "N events" always means "N things you can see".
 */
export function theaterEventVisible(event: TheaterEvent): boolean {
  const type = event.type;
  if (
    type === 'Communication.MessageSent' ||
    type === 'Communication.MessageProcessed'
  ) {
    return true;
  }
  if (type.startsWith('Task.Handoff')) return true;
  if (TASK_TYPES.has(type)) return type !== 'Task.Created' && type !== 'Task.Accepted';
  if (APPROVAL_TYPES[type] !== undefined) return true;
  if (PUBLICATION_TYPES[type] !== undefined) return true;
  if (REQUIREMENT_TYPES[type] !== undefined) return true;
  if (PROMOTION_TYPES[type] !== undefined) return true;
  if (WORKFLOW_TYPES[type] !== undefined) return true;
  return BRIEF_TYPES.has(type);
}

const TASK_STATUS: Readonly<Record<string, string>> = {
  'Task.Assigned': 'assigned',
  'Task.Started': 'started',
  'Task.Completed': 'completed',
  'Task.Blocked': 'blocked',
  'Task.Failed': 'failed',
  'Task.Cancelled': 'cancelled',
  'Task.Deleted': 'removed',
};

function taskTitleOf(event: TheaterEvent, context: FeedContext): string {
  const fromPayload = readString(event.payload['title'], '');
  if (fromPayload !== '') return fromPayload;
  const taskId = readString(event.payload['taskId'], '');
  return context.taskTitles?.get(taskId) ?? '';
}

/**
 * Build the collaboration floor from raw events.
 *
 * Message and handoff cards are merged; task/approval/workflow/brief cards are one per real
 * event (that is what makes a process legible). Technical aggregates (`Runtime.*`, `System.*`)
 * never become cards.
 */
export function buildFeed(
  events: readonly TheaterEvent[],
  context: FeedContext = {},
): readonly FeedItem[] {
  const items = new Map<string, FeedItem>();
  const messages = new Map<string, MessageCard>();
  const handoffs = new Map<string, HandoffCard>();

  for (const event of events) {
    const payload = event.payload;
    const type = event.type;

    if (type === 'Communication.MessageSent') {
      const messageId = readString(payload['messageId'], '');
      if (messageId === '') continue;
      const card: MessageCard = {
        kind: 'message',
        key: `message:${messageId}`,
        seq: event.seq,
        sim: event.occurredAtSim,
        fromId: optionalString(payload['senderId']) ?? event.actorId,
        toIds: Array.isArray(payload['recipientIds'])
          ? (payload['recipientIds'] as readonly unknown[])
              .map((id) => readString(id, ''))
              .filter((id) => id !== '')
          : [],
        subject: readString(payload['subject'], ''),
        body: readString(payload['body'], ''),
        messageType: readString(payload['messageType'], 'request'),
        state: 'sent',
        handled: 0,
        failed: 0,
      };
      messages.set(messageId, card);
      items.set(card.key, card);
      continue;
    }

    if (type === 'Communication.MessageProcessed') {
      const messageId = readString(payload['messageId'], '');
      const current = messages.get(messageId);
      if (current === undefined) continue;
      const handled = current.handled + (readString(payload['outcome'], '') === 'handled' ? 1 : 0);
      const failed = current.failed + (readString(payload['outcome'], '') === 'failed' ? 1 : 0);
      const next: MessageCard = {
        ...current,
        handled,
        failed,
        state: handled > 0 ? 'processed' : failed > 0 ? 'failed' : current.state,
      };
      messages.set(messageId, next);
      items.set(next.key, next);
      continue;
    }

    if (type === 'Task.HandoffRequested') {
      const handoffId = readString(payload['handoffId'], '');
      const taskId = readString(payload['taskId'], '');
      const card: HandoffCard = {
        kind: 'handoff',
        key: `handoff:${handoffId}`,
        seq: event.seq,
        sim: event.occurredAtSim,
        handoffId,
        taskId,
        taskTitle: taskTitleOf(event, context),
        fromId: optionalString(payload['fromEmployeeId']) ?? event.actorId,
        toId: optionalString(payload['toEmployeeId']),
        status: 'requested',
        reason: readString(payload['reason'], ''),
        outcome: null,
        resultSummary: null,
      };
      handoffs.set(handoffId, card);
      items.set(card.key, card);
      continue;
    }

    if (
      type === 'Task.HandoffAccepted' ||
      type === 'Task.HandoffDeclined' ||
      type === 'Task.HandoffCompleted'
    ) {
      const handoffId = readString(payload['handoffId'], '');
      const current = handoffs.get(handoffId);
      // A decision/settlement can fall inside the window while its request fell before it
      // (the history is capped). The chain is still real; show the half that the log gives us.
      const base: HandoffCard =
        current ??
        {
          kind: 'handoff',
          key: `handoff:${handoffId}`,
          seq: event.seq,
          sim: event.occurredAtSim,
          handoffId,
          taskId: readString(payload['taskId'], ''),
          taskTitle: taskTitleOf(event, context),
          fromId: optionalString(payload['fromEmployeeId']),
          toId: optionalString(payload['toEmployeeId']),
          status: 'requested',
          reason: '',
          outcome: null,
          resultSummary: null,
        };
      const next: HandoffCard = {
        ...base,
        sim: event.occurredAtSim,
        fromId: optionalString(payload['fromEmployeeId']) ?? base.fromId,
        toId: optionalString(payload['toEmployeeId']) ?? base.toId,
        status:
          type === 'Task.HandoffAccepted'
            ? 'accepted'
            : type === 'Task.HandoffDeclined'
              ? 'declined'
              : 'completed',
        reason:
          type === 'Task.HandoffDeclined'
            ? readString(payload['reason'], base.reason)
            : base.reason,
        outcome: optionalString(payload['outcome']) ?? base.outcome,
        resultSummary: optionalString(payload['resultSummary']) ?? base.resultSummary,
      };
      handoffs.set(handoffId, next);
      items.set(next.key, next);
      continue;
    }

    if (TASK_TYPES.has(type)) {
      if (type === 'Task.Created' || type === 'Task.Accepted') continue;
      const taskId = readString(payload['taskId'], '');
      if (taskId === '') continue;
      const phase = optionalString(payload['phase']);
      const status =
        type === 'Task.ProgressReported'
          ? phase === 'submitted'
            ? 'submitted'
            : phase === 'reviewed'
              ? 'reviewed'
              : 'progress'
          : (TASK_STATUS[type] ?? 'updated');
      const assignment = payload['assignment'];
      const assigneeId =
        typeof assignment === 'object' && assignment !== null && !Array.isArray(assignment)
          ? optionalString((assignment as Row)['assigneeEmployeeId'])
          : optionalString(payload['employeeId']);
      items.set(`task:${taskId}:${String(event.seq)}`, {
        kind: 'task',
        key: `task:${taskId}:${String(event.seq)}`,
        seq: event.seq,
        sim: event.occurredAtSim,
        taskId,
        taskTitle: taskTitleOf(event, context),
        type,
        phase,
        actorId: event.actorId,
        assigneeId,
        status,
      });
      continue;
    }

    if (REQUIREMENT_TYPES[type] !== undefined) {
      items.set(`requirement:${String(event.seq)}`, {
        kind: 'requirement',
        key: `requirement:${String(event.seq)}`,
        seq: event.seq,
        sim: event.occurredAtSim,
        title: readString(payload['title'], ''),
        version: readNumber(payload['version'], 1),
        status: REQUIREMENT_TYPES[type] as 'analyzed' | 'confirmed',
        actorId: event.actorId,
      });
      continue;
    }

    if (PROMOTION_TYPES[type] !== undefined) {
      items.set(`promotion:${String(event.seq)}`, {
        kind: 'promotion',
        key: `promotion:${String(event.seq)}`,
        seq: event.seq,
        sim: event.occurredAtSim,
        title: readString(payload['title'], ''),
        version: readNumber(payload['version'], 1),
        status: PROMOTION_TYPES[type] as 'generated' | 'confirmed',
        actorId: event.actorId,
      });
      continue;
    }

    if (PUBLICATION_TYPES[type] !== undefined) {
      const publicationId = readString(payload['publicationId'], '');
      if (publicationId === '') continue;
      items.set(`publication:${String(event.seq)}`, {
        kind: 'publication',
        key: `publication:${String(event.seq)}`,
        seq: event.seq,
        sim: event.occurredAtSim,
        publicationId,
        version: readNumber(payload['version'], 1),
        status: PUBLICATION_TYPES[type] as string,
        publicPath:
          typeof payload['publicPath'] === 'string' ? payload['publicPath'] : null,
        actorId: event.actorId,
      });
      continue;
    }

    if (APPROVAL_TYPES[type] !== undefined) {
      const instanceId = optionalString(payload['instanceId']);
      items.set(`approval:${String(event.seq)}`, {
        kind: 'approval',
        key: `approval:${String(event.seq)}`,
        seq: event.seq,
        sim: event.occurredAtSim,
        instanceId,
        instanceTitle:
          instanceId === null ? '' : (context.workflowTitles?.get(instanceId) ?? ''),
        status: APPROVAL_TYPES[type] as string,
        actorId: event.actorId,
      });
      continue;
    }

    if (WORKFLOW_TYPES[type] !== undefined) {
      const instanceId = optionalString(payload['instanceId']);
      const eventContext =
        typeof payload['context'] === 'object' && payload['context'] !== null && !Array.isArray(payload['context'])
          ? (payload['context'] as Row)
          : {};
      const isDraft = type === 'Workflow.InstanceStarted' && eventContext['draft'] === true;
      items.set(`workflow:${String(event.seq)}`, {
        kind: 'workflow',
        key: `workflow:${String(event.seq)}`,
        seq: event.seq,
        sim: event.occurredAtSim,
        instanceId,
        instanceTitle:
          readString(payload['title'], '') ||
          (instanceId === null ? '' : (context.workflowTitles?.get(instanceId) ?? '')),
        status: isDraft ? 'draft-created' : (WORKFLOW_TYPES[type] as string),
        actorId: event.actorId,
      });
      continue;
    }

    if (BRIEF_TYPES.has(type)) {
      items.set(`brief:${String(event.seq)}`, {
        kind: 'brief',
        key: `brief:${String(event.seq)}`,
        seq: event.seq,
        sim: event.occurredAtSim,
        actorId: event.actorId,
        type,
        // An instruction is the operator's wording; it may quote internal ids. The card shows
        // who it was given to, not the raw prompt — a theater is a product, not a debugger.
        title: type === 'Control.AgentInstructed' ? '' : readString(payload['title'], '') || readString(payload['goal'], ''),
        targetId:
          type === 'Control.AgentInstructed' || type === 'Control.AgentCreated'
            ? optionalString(payload['agentId'])
            : null,
      });
      continue;
    }
  }

  return [...items.values()].sort((left, right) => left.seq - right.seq);
}

// -------------------------------------------------------------------------------------------------
// Sessions (replay)
// -------------------------------------------------------------------------------------------------

export interface TheaterSession {
  readonly correlationId: string;
  readonly firstSeq: number;
  readonly lastSeq: number;
  readonly count: number;
  readonly fromSim: number;
  readonly toSim: number;
  /** A real title from the session's own events; empty when none of them name the work. */
  readonly title: string;
}

/**
 * Group the visible events into the work sessions the log already carries.
 *
 * A session is a `correlationId` — one brief, one workflow, one operator instruction. The label is
 * taken from the session's own first title-bearing event, never from the id.
 */
export function groupSessions(events: readonly TheaterEvent[]): readonly TheaterSession[] {
  const bySession = new Map<string, TheaterEvent[]>();
  for (const event of events) {
    if (event.correlationId === '') continue;
    const list = bySession.get(event.correlationId) ?? [];
    list.push(event);
    bySession.set(event.correlationId, list);
  }
  const sessions: TheaterSession[] = [];
  for (const [correlationId, list] of bySession) {
    if (list.length === 0) continue;
    const first = list[0] as TheaterEvent;
    const last = list[list.length - 1] as TheaterEvent;
    const titleEvent =
      list.find((event) => readString(event.payload['title'], '') !== '') ??
      list.find((event) =>
        ['Control.WorkBriefed', 'Workflow.InstanceStarted', 'Task.Assigned', 'Task.Created'].includes(
          event.type,
        ),
      );
    sessions.push({
      correlationId,
      firstSeq: first.seq,
      lastSeq: last.seq,
      count: list.length,
      fromSim: first.occurredAtSim,
      toSim: last.occurredAtSim,
      title: titleEvent === undefined ? '' : taskTitleOf(titleEvent, {}),
    });
  }
  return sessions.sort((left, right) => right.lastSeq - left.lastSeq);
}

/** The title a task-level event names, for the session label fallback. */
export function sessionTitleOf(session: TheaterSession, events: readonly TheaterEvent[]): string {
  if (session.title !== '') return session.title;
  const first = events.find((event) => event.correlationId === session.correlationId);
  if (first === undefined) return '';
  return readString(first.payload['title'], '');
}
