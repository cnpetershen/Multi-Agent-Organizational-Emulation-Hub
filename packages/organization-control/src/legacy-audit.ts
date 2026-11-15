import type { OrgEvent } from '@maoeh/shared-types';
import type { Organization } from '@maoeh/organization-model';
import { isExecutableEmployment } from '@maoeh/organization-model';
import type { Task, TaskStatus } from '@maoeh/task-system';
import { applyTaskEvent } from '@maoeh/task-system';

/**
 * M3.0 · Legacy-work audit.
 *
 * ## Why an audit instead of a cleanup script
 *
 * The production company accumulated work whose *record* and whose *meaning* disagree: tasks that
 * were completed with nothing in the delivery, tasks whose terminal fact is stamped before their
 * creation (a control command carrying a stale `createdAtSim`), accepted tasks that nothing will
 * ever move, and handoffs still waiting on a colleague who has since left. A cleanup that simply
 * deletes rows would destroy the evidence of how the company got there, which is exactly what the
 * milestone forbids ("不得直接删除未知来源的数据，保留历史数据和审计记录").
 *
 * So this module is a **read-only auditor**. It answers three questions per work item:
 *
 *   1. is this record internally inconsistent (terminal before created, delivery without content,
 *      completed without its verification keys)?
 *   2. is this open work genuinely unable to progress (stalled longer than the watchdog window,
 *      submitted with no path to settlement, handoff waiting on an unavailable colleague)?
 *   3. what may the business legally do about it — `cancel` through the task state machine, or
 *      `none` because no transition exists and a human must decide?
 *
 * The "no transition exists" answer is deliberate: the log is append-only, and you cannot
 * un-complete a task. `legacyRepairPlan()` therefore only ever proposes commands the domain
 * actually allows (cancellation of open work), and every other finding is reported for a human
 * decision instead of being rewritten.
 */

export type LegacyFindingCode =
  | 'empty_delivery'
  | 'unverified_delivery'
  | 'chronology_violation'
  | 'orphaned_submission'
  | 'stalled_open_task'
  | 'dangling_handoff';

export type LegacyFindingSeverity = 'critical' | 'warning' | 'info';

/**
 * `cancel` = a legal, history-preserving task transition exists; `none` = no transition may be
 * taken by an automated cleanup, so the finding is handed to a human.
 */
export type LegacyRepairAction = 'cancel' | 'none';

export interface LegacyFinding {
  readonly code: LegacyFindingCode;
  readonly taskId: string;
  readonly title: string;
  readonly severity: LegacyFindingSeverity;
  /**
   * Where the evidence still lives. `deleted` means the record was removed from the active board
   * (a legal `Task.Deleted` fact) but its history — including a fake delivery — is still on the
   * append-only log and must stay in the audit instead of disappearing with the row.
   */
  readonly record: 'active' | 'deleted';
  /** The events that prove the finding, oldest first. */
  readonly evidenceEventIds: readonly string[];
  /** What is wrong, in words an operator can act on. */
  readonly detail: string;
  readonly repair: LegacyRepairAction;
  /** Why that repair is (or is not) allowed by the domain. */
  readonly repairReason: string;
}

export interface LegacyAuditReport {
  readonly companyId: string;
  /** The clock the staleness judgement used (explicit simTime, else the newest event's sim). */
  readonly evaluatedAtSim: number;
  readonly taskCount: number;
  /** Records the fold hides because a `Task.Deleted` fact removed them from the active board. */
  readonly archivedTaskCount: number;
  readonly findings: readonly LegacyFinding[];
  readonly summary: {
    readonly total: number;
    readonly byCode: Readonly<Record<LegacyFindingCode, number>>;
    readonly repairable: number;
  };
}

export interface LegacyRepairCommand {
  readonly taskId: string;
  readonly action: 'cancel';
  readonly reason: string;
  /** The findings one command settles. */
  readonly codes: readonly LegacyFindingCode[];
}

export interface LegacyAuditInput {
  readonly tasks: readonly Task[];
  readonly events: readonly OrgEvent[];
  readonly organization: Organization;
  /** The clock to judge staleness by. Defaults to the newest event's `occurredAtSim`. */
  readonly simTime?: number;
  /** Same window the runtime watchdog uses (`STALL_THRESHOLD_TICKS`). */
  readonly stallThresholdTicks?: number;
}

const DEFAULT_STALL_THRESHOLD = 45;

const OPEN_STATUSES: readonly TaskStatus[] = ['created', 'assigned', 'accepted', 'started', 'blocked'];

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  'Task.Completed',
  'Task.Failed',
  'Task.Rejected',
  'Task.Cancelled',
  'Task.Deleted',
]);

const SEVERITY_ORDER: Readonly<Record<LegacyFindingSeverity, number>> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function payloadOf(event: OrgEvent): Readonly<Record<string, unknown>> {
  return typeof event.payload === 'object' && event.payload !== null
    ? (event.payload as Readonly<Record<string, unknown>>)
    : {};
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/** A delivery is real when at least one field carries content (`false`/`0` count: they are data). */
function hasDeliveryContent(task: Task): boolean {
  if (task.result === null) return false;
  const data = task.result.data;
  const entries = Object.entries(data);
  if (entries.length === 0) return false;
  return entries.some(([, value]) => !isEmptyValue(value));
}

function unverifiedKeys(task: Task): readonly string[] {
  const required = task.verification?.requiredOutputKeys ?? [];
  if (required.length === 0) return [];
  const data = task.result?.data ?? {};
  return required.filter((key) => isEmptyValue(data[key]));
}

function groupByTask(events: readonly OrgEvent[]): Map<string, OrgEvent[]> {
  const groups = new Map<string, OrgEvent[]>();
  for (const event of events) {
    if (!event.type.startsWith('Task.')) continue;
    const taskId = readString(payloadOf(event), 'taskId');
    if (taskId === null) continue;
    const list = groups.get(taskId) ?? [];
    list.push(event);
    groups.set(taskId, list);
  }
  return groups;
}

/**
 * The last state of every task the log records as deleted.
 *
 * `applyTaskEvent` turns a stream into `null` at `Task.Deleted`, which is right for the live board
 * — the record is gone — but wrong for an audit: the fabrication a record carried before it was
 * deleted is exactly what must not vanish with it. Folding up to the deletion keeps the evidence
 * while leaving the live read model untouched.
 */
function archivedTasksOf(events: readonly OrgEvent[]): readonly Task[] {
  const archived: Task[] = [];
  for (const group of groupByTask(events).values()) {
    let current: Task | null = null;
    let lastBeforeDelete: Task | null = null;
    for (const event of group) {
      if (event.type === 'Task.Deleted' && current !== null) lastBeforeDelete = current;
      current = applyTaskEvent(current, event);
    }
    if (lastBeforeDelete !== null) archived.push(lastBeforeDelete);
  }
  return archived;
}

function lastActivityOf(task: Task, taskEvents: readonly OrgEvent[]): number {
  let last = Number(task.createdAtSim);
  for (const event of taskEvents) {
    last = Math.max(last, Number(event.occurredAtSim));
  }
  return last;
}

function finding(
  input: Omit<LegacyFinding, 'evidenceEventIds'> & { readonly evidenceEventIds: readonly string[] },
): LegacyFinding {
  return Object.freeze({ ...input, evidenceEventIds: Object.freeze([...input.evidenceEventIds]) });
}

/**
 * Audit the work items. Pure: it reads the fold (`Task[]`) and the log (`OrgEvent[]`) and returns a
 * report; it never mutates a task, never writes an event and never touches the filesystem.
 */
export function auditLegacyWork(input: LegacyAuditInput): LegacyAuditReport {
  const threshold = input.stallThresholdTicks ?? DEFAULT_STALL_THRESHOLD;
  const groups = groupByTask(input.events);
  const newestEventSim = input.events.reduce(
    (max, event) => Math.max(max, Number(event.occurredAtSim)),
    0,
  );
  const now = input.simTime ?? newestEventSim;
  const findings: LegacyFinding[] = [];
  const archived = archivedTasksOf(input.events);

  for (const task of input.tasks) {
    const taskEvents = groups.get(task.taskId) ?? [];
    const created = taskEvents.find((event) => event.type === 'Task.Created');
    const terminal = [...taskEvents].reverse().find((event) => TERMINAL_EVENT_TYPES.has(event.type));
    const evidenceOf = (...events: (OrgEvent | undefined)[]): string[] =>
      events.flatMap((event) => (event === undefined ? [] : [event.eventId]));
    const record: LegacyFinding['record'] = 'active';
    const archivedNote = '';

    // 1. A terminal fact stamped before the task existed is not a business outcome; it is a broken
    //    timeline (the control plane once stamped commands with the browser's stale clock).
    if (created !== undefined && terminal !== undefined) {
      if (Number(terminal.occurredAtSim) < Number(created.occurredAtSim)) {
        findings.push(
          finding({
            code: 'chronology_violation',
            taskId: task.taskId,
            title: task.title,
            severity: 'critical',
            record,
            evidenceEventIds: evidenceOf(created, terminal),
            detail: `${terminal.type} is stamped at sim ${String(terminal.occurredAtSim)}, before the task was created at sim ${String(created.occurredAtSim)} — the terminal state cannot be trusted as a business fact.${archivedNote}`,
            repair: 'none',
            repairReason:
              'The event log is append-only: a wrong timestamp is corrected by fixing the writer and recording a new fact, never by rewriting or deleting the old one. The control plane now stamps with the kernel clock.',
          }),
        );
      }
    }

    // 2. "Completed" with nothing delivered. The record claims an outcome the organization cannot
    //    show; it is reported, not silently re-labelled (there is no un-complete transition).
    if (task.status === 'completed' && !hasDeliveryContent(task)) {
      findings.push(
        finding({
          code: 'empty_delivery',
          taskId: task.taskId,
          title: task.title,
          severity: 'critical',
          record,
          evidenceEventIds: evidenceOf(
            taskEvents.find((event) => event.type === 'Task.Completed'),
          ),
          detail:
            task.result === null
              ? 'The task is completed but carries no result at all.'
              : 'The task is completed but its result data is empty — a completion without a deliverable.' + archivedNote,
          repair: 'none',
          repairReason:
            'A completed task has no legal transition left. Rewriting it would falsify history; a human must accept it as a bad record or close the related work.',
        }),
      );
    }

    const missingKeys = unverifiedKeys(task);
    if (task.status === 'completed' && missingKeys.length > 0) {
      findings.push(
        finding({
          code: 'unverified_delivery',
          taskId: task.taskId,
          title: task.title,
          severity: 'critical',
          record,
          evidenceEventIds: evidenceOf(
            taskEvents.find((event) => event.type === 'Task.Completed'),
            taskEvents.find((event) => event.type === 'Task.ProgressReported'),
          ),
          detail: `The task is completed but its verification keys are missing or empty: ${missingKeys.join(', ')} — "passed" cannot be substantiated.${archivedNote}`,
          repair: 'none',
          repairReason:
            'Completion is a past fact. The finding is a delivery-quality defect to report, not a state to rewrite.',
        }),
      );
    }

    // 3. Submitted forever. A standalone task with deterministic verification is settled by the
    //    reactor, so a stale submission means it never could be; a review-kind task is legitimately
    //    waiting for a human and is not an inconsistency.
    if (task.status === 'submitted' && task.workflowInstanceId === null) {
      const reviewKind = task.verification?.kind === 'review';
      const stale = now - lastActivityOf(task, taskEvents) >= threshold;
      if (!reviewKind && stale) {
        findings.push(
          finding({
            code: 'orphaned_submission',
            taskId: task.taskId,
            title: task.title,
            severity: 'warning',
            record,
            evidenceEventIds: evidenceOf(
              taskEvents.find((event) => event.type === 'Task.ProgressReported'),
            ),
            detail: `The task was submitted at sim ${String(task.submittedAtSim ?? lastActivityOf(task, taskEvents))} and nothing has settled it for more than ${String(threshold)} ticks.`,
            repair: 'cancel',
            repairReason:
              'Cancellation is a legal transition from `submitted` and preserves the submitted result on the log, so the work stops owning the board without losing its history.',
          }),
        );
      }
    }

    // 4. Open work that cannot move. Standalone work may be cancelled; a workflow step is reported
    //    instead, because cancelling it aborts the whole instance (M2 semantic).
    if (OPEN_STATUSES.includes(task.status)) {
      const last = lastActivityOf(task, taskEvents);
      if (now - last >= threshold) {
        const inWorkflow = task.workflowInstanceId !== null;
        findings.push(
          finding({
            code: 'stalled_open_task',
            taskId: task.taskId,
            title: task.title,
            severity: inWorkflow ? 'warning' : 'critical',
            record,
            evidenceEventIds: evidenceOf(created, taskEvents[taskEvents.length - 1]),
            detail: `The task has been ${task.status} with no activity since sim ${String(last)} (${String(now - last)} ticks).`,
            repair: inWorkflow ? 'none' : 'cancel',
            repairReason: inWorkflow
              ? `The task belongs to workflow "${task.workflowInstanceId}"; cancelling it aborts the instance (workflow-engine treats a cancelled step as instance-level abort), so that decision stays with a human.`
              : 'It belongs to no workflow, so cancelling it stops nothing else and keeps every event.',
          }),
        );
      }
    }

    // 5. A handoff nobody can answer: the receiver is gone, or the task is already terminal.
    const handoff = task.handoff;
    if (handoff !== null && handoff.status === 'requested') {
      const receiver = input.organization.employees.find(
        (employee) => String(employee.id) === String(handoff.toEmployeeId),
      );
      const unavailable = receiver === undefined || !isExecutableEmployment(receiver.status);
      const stale = now - Number(handoff.requestedAtSim) >= threshold;
      if (unavailable || stale) {
        findings.push(
          finding({
            code: 'dangling_handoff',
            taskId: task.taskId,
            title: task.title,
            severity: 'warning',
            record,
            evidenceEventIds: evidenceOf(taskEvents.find((event) => event.type === 'Task.HandoffRequested')),
            detail: unavailable
              ? `Handoff "${handoff.handoffId}" waits on "${String(handoff.toEmployeeId)}", who can no longer take work.`
              : `Handoff "${handoff.handoffId}" has waited ${String(now - Number(handoff.requestedAtSim))} ticks without an answer.`,
            repair: 'cancel',
            repairReason:
              'The sender can cancel the task; cancellation settles the open handoff as `cancelled` and keeps the chain on the log.',
          }),
        );
      }
    }
  }

  // 6. Records the fold no longer shows. A `Task.Deleted` row was removed from the active board,
  //    but its history is still on the append-only log. Once a deleted record carried a fake
  //    completion, deleting it must not delete the audit of it — so the historical rules (1 and 2)
  //    run over the record's last state before deletion. Live-work rules (3–5) do not apply: the
  //    record no longer occupies the board, and proposing a cancel for it would be meaningless.
  for (const task of archived) {
    const taskEvents = groups.get(task.taskId) ?? [];
    const created = taskEvents.find((event) => event.type === 'Task.Created');
    const deleted = taskEvents.find((event) => event.type === 'Task.Deleted');
    const evidenceOf = (...events: (OrgEvent | undefined)[]): string[] =>
      events.flatMap((event) => (event === undefined ? [] : [event.eventId]));
    const archivedNote =
      ' The record was later deleted from the active board; this finding is historical and stays in the audit instead of disappearing with the row.';

    if (created !== undefined) {
      if (deleted !== undefined && Number(deleted.occurredAtSim) < Number(created.occurredAtSim)) {
        findings.push(
          finding({
            code: 'chronology_violation',
            taskId: task.taskId,
            title: task.title,
            severity: 'warning',
            record: 'deleted',
            evidenceEventIds: evidenceOf(created, deleted),
            detail: `Task.Deleted is stamped at sim ${String(deleted.occurredAtSim)}, before the task was created at sim ${String(created.occurredAtSim)} — the deletion's timing cannot be trusted.${archivedNote}`,
            repair: 'none',
            repairReason:
              'The deletion already happened and the log is append-only; the record is reported as history, not re-timed or restored.',
          }),
        );
      }
    }

    if (task.status === 'completed' && !hasDeliveryContent(task)) {
      findings.push(
        finding({
          code: 'empty_delivery',
          taskId: task.taskId,
          title: task.title,
          severity: 'warning',
          record: 'deleted',
          evidenceEventIds: evidenceOf(
            taskEvents.find((event) => event.type === 'Task.Completed'),
            deleted,
          ),
          detail:
            (task.result === null
              ? 'The task was completed but carried no result at all.'
              : 'The task was completed but its result data was empty — a completion without a deliverable.') +
            archivedNote,
          repair: 'none',
          repairReason:
            'The record is gone from the board, so no transition can be offered; the finding exists so the fake completion remains auditable.',
        }),
      );
    }

    const missingKeys = unverifiedKeys(task);
    if (task.status === 'completed' && missingKeys.length > 0) {
      findings.push(
        finding({
          code: 'unverified_delivery',
          taskId: task.taskId,
          title: task.title,
          severity: 'warning',
          record: 'deleted',
          evidenceEventIds: evidenceOf(
            taskEvents.find((event) => event.type === 'Task.Completed'),
            deleted,
          ),
          detail: `The task was completed without its verification keys: ${missingKeys.join(', ')}.${archivedNote}`,
          repair: 'none',
          repairReason:
            'The record is deleted; the finding preserves the fact that "passed" was never substantiated.',
        }),
      );
    }
  }

  findings.sort((left, right) => {
    const severity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
    if (severity !== 0) return severity;
    // Live work first: it is the work an operator can still act on.
    if (left.record !== right.record) return left.record === 'active' ? -1 : 1;
    return left.taskId.localeCompare(right.taskId);
  });

  const byCode: Record<LegacyFindingCode, number> = {
    empty_delivery: 0,
    unverified_delivery: 0,
    chronology_violation: 0,
    orphaned_submission: 0,
    stalled_open_task: 0,
    dangling_handoff: 0,
  };
  for (const item of findings) byCode[item.code] += 1;

  return Object.freeze({
    companyId: String(input.organization.company.id),
    evaluatedAtSim: now,
    taskCount: input.tasks.length,
    archivedTaskCount: archived.length,
    findings: Object.freeze(findings),
    summary: Object.freeze({
      total: findings.length,
      byCode: Object.freeze(byCode),
      repairable: findings.filter((item) => item.repair === 'cancel').length,
    }),
  });
}

/**
 * One cancellation per task, carrying every code it settles. The reasons are dated and explain the
 * finding, because the cancellation event is what a human will read later.
 */
export function legacyRepairPlan(report: LegacyAuditReport): readonly LegacyRepairCommand[] {
  const byTask = new Map<string, LegacyFinding[]>();
  for (const item of report.findings) {
    if (item.repair !== 'cancel') continue;
    const list = byTask.get(item.taskId) ?? [];
    list.push(item);
    byTask.set(item.taskId, list);
  }
  return Object.freeze(
    [...byTask.entries()].map(([taskId, items]) =>
      Object.freeze({
        taskId,
        action: 'cancel' as const,
        reason: `legacy audit at sim ${String(report.evaluatedAtSim)}: ${items
          .map((item) => item.detail)
          .join(' ')}`.slice(0, 1000),
        codes: Object.freeze(items.map((item) => item.code)),
      }),
    ),
  );
}
