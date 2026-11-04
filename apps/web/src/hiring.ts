import { readString, type Row } from './api';

/**
 * Hiring, read straight off the read models the console already polls.
 *
 * A hiring request *is* a workflow instance: the kernel opens one `hire-gate` instance per
 * recommended seat (A4), carrying the seat, the requester and the rationale in its own fields
 * (`title` / `goal` / `initiatedBy`). Its `correlationId` is the same id the originating work
 * brief carries, so the tasks that share it are exactly the objectives the request is holding.
 *
 * This module only *derives* that view — no second state machine, no new events, no stored
 * hiring state. Pending / approved / rejected is the gate's own approval status; who joined is
 * the roster the snapshot already reports; the related tasks are the brief's own items.
 */

export const HIRING_WORKFLOW_ID = 'hire-gate';

export type HiringStatus = 'pending' | 'approved' | 'rejected';

/** One task a hiring request is holding — the brief's own item, verbatim. */
export interface HiringTaskRef {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
}

/** One hiring request as the pages render it. */
export interface HiringRequest {
  readonly instanceId: string;
  readonly status: HiringStatus;
  /** The seat to fill (`engineer`), and how the seat reads to a person. */
  readonly seatId: string;
  readonly seatTitle: string;
  /** Why the organization needs the hire — the gate's own objective sentence. */
  readonly rationale: string;
  /** The employee who raised the request. */
  readonly requesterId: string;
  /** Every task linked to this request, de-duplicated by task id. */
  readonly relatedTasks: readonly HiringTaskRef[];
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `true` for the kernel-owned hiring gate — never for a generated delivery workflow. */
export function isHiringGate(workflow: Row): boolean {
  return readString(workflow['workflowId'], '') === HIRING_WORKFLOW_ID;
}

/**
 * The gate's decision as the three words the operator reads. The approval summary is the
 * authority; a decided gate whose summary has rolled into the instance status still resolves,
 * so a reload never loses the outcome.
 */
export function hiringStatus(workflow: Row): HiringStatus | null {
  const approval = workflow['approval'];
  const approvalStatus = isRow(approval) ? readString(approval['status'], '') : '';
  if (approvalStatus === 'open') return 'pending';
  if (approvalStatus === 'granted') return 'approved';
  if (approvalStatus === 'denied') return 'rejected';
  const instanceStatus = readString(workflow['status'], '');
  if (instanceStatus === 'aborted') return 'rejected';
  if (instanceStatus === 'completed') return 'approved';
  return null;
}

/** The seat the gate targets, read from its title, then from its objective sentence. */
export function hireSeatId(workflow: Row): string {
  const title = readString(workflow['title'], '').trim();
  const titled = / for ([^\s]+)$/.exec(title);
  if (titled !== null && titled[1] !== undefined) return titled[1];
  const goal = readString(workflow['goal'], '');
  const seated = /seat "([^"]+)"/.exec(goal);
  return seated !== null && seated[1] !== undefined ? seated[1] : '';
}

/** The job title a person reads: `Hire Software Engineer for engineer` → `Software Engineer`. */
export function hireSeatTitle(workflow: Row, seatId: string): string {
  const title = readString(workflow['title'], '').trim();
  const titled = /^Hire (.*) for [^\s]+$/.exec(title);
  if (titled !== null && titled[1] !== undefined && titled[1] !== '') return titled[1];
  return seatId;
}

function relatedTasksOf(gate: Row, briefs: readonly Row[]): readonly HiringTaskRef[] {
  const correlationId = readString(gate['correlationId'], '');
  if (correlationId === '') return [];
  const brief = briefs.find((row) => readString(row['correlationId'], '') === correlationId);
  if (brief === undefined) return [];
  const items = Array.isArray(brief['items']) ? (brief['items'] as readonly unknown[]) : [];
  const seen = new Set<string>();
  const refs: HiringTaskRef[] = [];
  for (const item of items) {
    if (!isRow(item)) continue;
    const taskId = readString(item['taskId'], '');
    if (taskId === '' || seen.has(taskId)) continue;
    seen.add(taskId);
    refs.push({
      taskId,
      title: readString(item['title'], ''),
      status: readString(item['status'], ''),
    });
  }
  return refs;
}

const STATUS_ORDER: Readonly<Record<HiringStatus, number>> = {
  pending: 0,
  approved: 1,
  rejected: 2,
};

/**
 * Every hiring request, one entry per gate — never one per task and never a duplicate card for
 * a request that several tasks reference (R9). Pending requests lead, so "a decision is owed"
 * is the first thing the operator sees.
 */
export function hiringRequests(
  workflows: readonly Row[],
  briefs: readonly Row[],
): readonly HiringRequest[] {
  const seen = new Set<string>();
  const requests: HiringRequest[] = [];
  for (const workflow of workflows) {
    if (!isHiringGate(workflow)) continue;
    const instanceId = readString(workflow['instanceId'], '');
    if (instanceId === '' || seen.has(instanceId)) continue;
    const status = hiringStatus(workflow);
    if (status === null) continue;
    seen.add(instanceId);
    const seatId = hireSeatId(workflow);
    requests.push({
      instanceId,
      status,
      seatId,
      seatTitle: hireSeatTitle(workflow, seatId),
      rationale: readString(workflow['goal'], ''),
      requesterId: readString(workflow['initiatedBy'], ''),
      relatedTasks: relatedTasksOf(workflow, briefs),
    });
  }
  return requests.sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status]);
}

/**
 * The hiring request each linked task belongs to, so a task card can tell why it is waiting.
 * A task linked to several gates keeps the first (pending leads), matching the card order.
 */
export function hiringByTask(requests: readonly HiringRequest[]): ReadonlyMap<string, HiringRequest> {
  const map = new Map<string, HiringRequest>();
  for (const request of requests) {
    for (const task of request.relatedTasks) {
      if (!map.has(task.taskId)) map.set(task.taskId, request);
    }
  }
  return map;
}

/** The people now holding a seat — who joined once a hiring request was approved. */
export function membersAtSeat(agents: readonly Row[], seatId: string): readonly Row[] {
  if (seatId === '') return [];
  return agents.filter((agent) => readString(agent['positionId'], '') === seatId);
}
