import type { EventView } from '../types.js';

/**
 * M3.2 · the collaboration theater's stage model.
 *
 * ## What a "stage" is, and what it is not
 *
 * MAOEH's business mainline is: 需求沙盘 → 智能体编排 → 调整画布 → 任务实施 → 审批 → 推广 → 发布.
 * The event log does **not** carry a stage field, and this module refuses to invent one: an event
 * is associated with a stage only when the event itself proves it (its type, or an explicit
 * capability the work declared). Everything else — a message between colleagues, an operator
 * pausing the runtime, a handoff between two seats — is a real collaboration fact with **no**
 * business stage, and is reported as `stage: null` instead of being forced into a phase that has
 * not happened for it.
 *
 * This is what makes the model future-proof: the seven stages are already the vocabulary the
 * later modules (需求沙盘 / 智能体编排 / 调整画布 / 审批 / 推广 / 发布) will emit into, and when a
 * step declares a capability such as `marketing`, every later event of that task inherits the
 * promotion stage through `TheaterStageTracker` — without a new event field and without guessing
 * from titles.
 *
 * ## Priority (the part that keeps it honest)
 *
 *   1. an event type that *is* a stage boundary (an approval gate, a confirmed draft, a submitted
 *      brief) wins;
 *   2. otherwise the capability carried by this very event wins;
 *   3. otherwise the task's own stage (learned from the capability on `Task.Assigned` /
 *      `Task.HandoffRequested`, or seeded from the folded tasks) wins, so a marketing task's
 *      started/submitted/completed events all stay in 推广;
 *   4. otherwise the type's default stage (execution facts default to 任务实施);
 *   5. otherwise `null` (unclassified).
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

export type TheaterStageId = (typeof THEATER_STAGES)[number];

/** Why the stage was chosen — a product surface may explain it, an operator may audit it. */
export type TheaterStageBasis = 'event-type' | 'capability' | 'task';

export interface TheaterStageView {
  readonly stage: TheaterStageId | null;
  readonly basis: TheaterStageBasis | null;
}

/** One real event, plus the honest stage association (if any). */
export interface TheaterEventView extends EventView {
  readonly stage: TheaterStageId | null;
  readonly stageBasis: TheaterStageBasis | null;
}

export interface TheaterHistory {
  readonly companyId: string;
  readonly latestSeq: number;
  readonly events: readonly TheaterEventView[];
}

export interface TheaterHistoryInput {
  /** One work session (`OrgEvent.correlationId`). Absent = the most recent activity. */
  readonly correlationId?: string;
  readonly limit?: number;
}

/** A task's declared capability, the one fact the tracker needs to remember. */
export interface TheaterStageSeed {
  readonly taskId: string;
  readonly capability: string | null;
}

/**
 * Event types that *are* a stage boundary. Deliberately explicit: a type that is not listed
 * either falls to the execution default (`Task.*`, workflow steps) or stays unclassified.
 */
const STAGE_BY_EVENT_TYPE: Readonly<Record<string, TheaterStageId>> = Object.freeze({
  // 需求沙盘 — the brief is the discovery/sandbox output that starts the company's work.
  'Control.WorkBriefed': 'sandbox',
  'Work.SubmitBrief': 'sandbox',

  // 智能体编排 — who does what, and the roster decisions that make the plan possible.
  'Control.DelegationDecided': 'orchestration',
  'Control.AgentCreated': 'orchestration',
  'Agent.Created': 'orchestration',

  // 调整画布 — the plan draft, its confirmation, and assignment overrides.
  'Workflow.DraftConfirmed': 'canvas',
  'Workflow.StepAssignmentOverridden': 'canvas',
  'Control.WorkflowInstanceConfirmed': 'canvas',
  'Control.TaskReassigned': 'canvas',

  // 审批 — every gate that waits on a human/role decision.
  'Workflow.ApprovalRequested': 'approval',
  'Workflow.ApprovalGranted': 'approval',
  'Workflow.ApprovalDenied': 'approval',
  'Control.WorkflowApprovalDecided': 'approval',
  'Control.TaskReviewRequested': 'approval',

  // 任务实施 — the execution facts (also the default for Task.* and workflow steps).
  'Workflow.InstanceStarted': 'implementation',
  'Workflow.InstanceCompleted': 'implementation',
  'Workflow.InstanceAborted': 'implementation',
  'Workflow.InstanceBlocked': 'implementation',
  'Workflow.InstanceResumed': 'implementation',
  'Workflow.InstanceDeleted': 'implementation',
  'Workflow.StepEntered': 'implementation',
  'Workflow.StepCompleted': 'implementation',
  'Workflow.StepRejected': 'implementation',
  'Control.AgentInstructed': 'implementation',
  'Control.TaskInjected': 'implementation',

  // 发布 — M3.8 local publication facts. Only a real draft/confirmation/attempt emits these.
  'Document.PublicationDrafted': 'release',
  'Document.PublicationConfirmed': 'release',
  'Document.PublicationPublished': 'release',
  'Document.PublicationPartiallyPublished': 'release',
  'Document.PublicationFailed': 'release',
});

/** Capability → stage. Only capabilities whose *work* defines the phase are listed. */
const STAGE_BY_CAPABILITY: Readonly<Record<string, TheaterStageId>> = Object.freeze({
  product_requirement: 'sandbox',
  requirements: 'sandbox',
  requirement: 'sandbox',
  discovery: 'sandbox',
  research: 'sandbox',
  planning: 'orchestration',
  orchestration: 'orchestration',
  assignment: 'canvas',
  marketing: 'promotion',
  promotion: 'promotion',
  growth: 'promotion',
  go_to_market: 'promotion',
  gtm: 'promotion',
  release: 'release',
  deployment: 'release',
  publish: 'release',
  launch: 'release',
  approval: 'approval',
  sign_off: 'approval',
  technical_design: 'implementation',
  implementation: 'implementation',
  testing: 'implementation',
  qa: 'implementation',
  backend: 'implementation',
  frontend: 'implementation',
  design: 'implementation',
});

function normalizeCapability(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** The stage an event type proves on its own; `null` when the type names no phase. */
export function stageOfEventType(type: string): TheaterStageId | null {
  const direct = STAGE_BY_EVENT_TYPE[type];
  if (direct !== undefined) return direct;
  // Execution facts by aggregate: every Task.* fact is work happening in the implementation
  // phase unless the task's declared capability says otherwise (handled by the tracker).
  if (type.startsWith('Task.')) return 'implementation';
  return null;
}

/** The stage a declared capability proves; `null` for a capability the model does not know. */
export function stageOfCapability(capability: string | null): TheaterStageId | null {
  if (capability === null) return null;
  const normalized = normalizeCapability(capability);
  if (normalized === '') return null;
  return STAGE_BY_CAPABILITY[normalized] ?? null;
}

function payloadOf(event: EventView): Readonly<Record<string, unknown>> {
  const payload = event.payload;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Remembers the stage each task belongs to, so a task's later facts do not fall back to
 * "execution" just because `Task.ProgressReported` carries no capability.
 *
 * The tracker is fed events in log order. A caller that starts mid-stream (the SSE tail) primes
 * it with the recent history it already read; a caller that projects one session feeds the
 * session from its beginning.
 */
export class TheaterStageTracker {
  private readonly taskStages = new Map<string, TheaterStageId>();

  constructor(seed: readonly TheaterStageSeed[] = []) {
    for (const item of seed) {
      const stage = stageOfCapability(item.capability);
      if (stage !== null) this.taskStages.set(item.taskId, stage);
    }
  }

  /** The stage learned for a task, or `null` when the task never declared one. */
  stageOfTask(taskId: string): TheaterStageId | null {
    return this.taskStages.get(taskId) ?? null;
  }

  /**
   * Learn from this event and decide its stage. Learning happens even when the event itself
   * resolves by type (an approval gate on a marketing task still teaches the task's stage).
   */
  observe(event: EventView): TheaterStageView {
    const payload = payloadOf(event);
    const taskId = readString(payload, 'taskId');
    const capability =
      readString(payload, 'capability') ?? readString(payload, 'requiredCapability');

    const capabilityStage = stageOfCapability(capability);
    if (taskId !== null && capabilityStage !== null) this.taskStages.set(taskId, capabilityStage);

    // An unconfirmed canvas draft is the orchestration's output, not execution: the instance
    // exists (awaitConfirmation) but no step has been entered and no task exists.
    const context = payload['context'];
    const isDraftInstance =
      event.type === 'Workflow.InstanceStarted' &&
      typeof context === 'object' &&
      context !== null &&
      (context as Readonly<Record<string, unknown>>)['draft'] === true;
    if (isDraftInstance) return { stage: 'orchestration', basis: 'event-type' };

    const typeStage = stageOfEventType(event.type);
    // 1. A boundary the event type itself names (approval, canvas, orchestration, sandbox).
    if (typeStage !== null && typeStage !== 'implementation') {
      return { stage: typeStage, basis: 'event-type' };
    }
    // 2. The capability carried by this very event — the strongest evidence on the event itself.
    if (capabilityStage !== null) return { stage: capabilityStage, basis: 'capability' };
    // 3. The task's own stage, learned earlier from its capability.
    const taskStage = taskId === null ? null : this.taskStages.get(taskId) ?? null;
    if (taskStage !== null) return { stage: taskStage, basis: 'task' };
    // 4. The type default (execution).
    if (typeStage !== null) return { stage: typeStage, basis: 'event-type' };
    // 5. No proof → no stage. A message or an operator pause is not a business phase.
    return { stage: null, basis: null };
  }
}

/** Attach the tracker's answer to one event. */
export function theaterEventOf(event: EventView, tracker: TheaterStageTracker): TheaterEventView {
  const view = tracker.observe(event);
  return Object.freeze({
    seq: event.seq,
    eventId: event.eventId,
    type: event.type,
    occurredAtSim: event.occurredAtSim,
    actorKind: event.actorKind,
    actorId: event.actorId,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    payload: event.payload,
    stage: view.stage,
    stageBasis: view.basis,
  });
}

/**
 * Project a chronological slice of the log with one tracker, so each event's stage can build on
 * the ones before it. The tracker is observation-only; nothing here writes or re-runs work.
 */
export function buildTheaterEvents(
  events: readonly EventView[],
  tracker: TheaterStageTracker = new TheaterStageTracker(),
): readonly TheaterEventView[] {
  return Object.freeze(events.map((event) => theaterEventOf(event, tracker)));
}
