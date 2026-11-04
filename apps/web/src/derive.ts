import { readNumber, readString, type Row } from './api';
import type { MessageKey } from './i18n';

/**
 * Presentation lookups over the read model. Every value shown in the console is resolved
 * from an API payload here — no label is stored in the frontend, so a page can only ever
 * display what the backend actually reports.
 */

export function findPosition(snapshotPositions: readonly Row[], positionId: string): Row | null {
  return snapshotPositions.find((row) => readString(row['positionId'], '') === positionId) ?? null;
}

export function positionTitle(positions: readonly Row[], positionId: string): string {
  const row = findPosition(positions, positionId);
  return row === null ? positionId : readString(row['title'], positionId);
}

/** The capability vocabulary the routing engine accepts — ids, never display copy. */
export const CAPABILITY_IDS = [
  'product_requirement',
  'technical_design',
  'implementation',
  'frontend',
  'backend',
  'testing',
  'marketing',
] as const;

const CAPABILITY_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  product_requirement: 'agents.create.capabilityLabels.product_requirement',
  technical_design: 'agents.create.capabilityLabels.technical_design',
  implementation: 'agents.create.capabilityLabels.implementation',
  frontend: 'agents.create.capabilityLabels.frontend',
  backend: 'agents.create.capabilityLabels.backend',
  testing: 'agents.create.capabilityLabels.testing',
  marketing: 'agents.create.capabilityLabels.marketing',
};

/**
 * A capability id as the operator reads it. An id outside the vocabulary (a seat written before
 * the vocabulary closed) passes through untouched rather than rendering as a blank chip.
 */
export function capabilityLabel(capability: string, t: (key: MessageKey) => string): string {
  const key = CAPABILITY_LABEL_KEYS[capability];
  return key === undefined ? capability : t(key);
}

/** Every id in a payload array that is a non-empty string; `null`/objects are not ids. */
function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/** The capabilities a seat declares — what the assignment engine routes this seat's work by. */
export function positionCapabilities(
  positions: readonly Row[],
  positionId: string,
): readonly string[] {
  const row = findPosition(positions, positionId);
  return row === null ? [] : stringList(row['capabilities']);
}

/** Capabilities the assignment engine matched when this task was assigned; empty when it was not. */
export function matchedCapabilities(task: Row): readonly string[] {
  return stringList(task['matchedCapabilities']);
}

/**
 * The person's own specializations, as the API reports them (`employees` / `agents` rows carry
 * `expertise` after M1.6). Distinct from the seat's `capabilities`: this is what the individual
 * brings, and what capability matching may route on even when the seat does not declare it.
 */
export function expertiseOf(row: Row): readonly string[] {
  return stringList(row['expertise']);
}

/** The backend's own sentence for "why this task sits here"; `''` when it never said. */
export function assignmentReason(task: Row): string {
  return readString(task['assignmentReason'], '');
}

/**
 * The seats nobody staffs — every position the organization chart declares but no employee
 * holds. A holder counts only while their employment is live: an `offboarded` employee keeps
 * their `positionId` for the audit trail, so both the chart's `employeeIds` and the roster are
 * read through that status before a seat may be called vacant. This is what lets the team page
 * show *all* positions instead of only the staffed ones, without counting a seat twice.
 */
export function vacantPositions(
  positions: readonly Row[],
  employees: readonly Row[],
): readonly Row[] {
  const offboarded = new Set(
    employees
      .filter((row) => readString(row['status'], '') === 'offboarded')
      .map((row) => readString(row['employeeId'], '')),
  );
  return positions.filter((position) => {
    const positionId = readString(position['positionId'], '');
    if (positionId === '') return false;
    const listed = (Array.isArray(position['employeeIds'])
      ? (position['employeeIds'] as readonly unknown[])
      : []
    )
      .map((id) => String(id))
      .filter((id) => id !== '' && !offboarded.has(id));
    if (listed.length > 0) return false;
    return !employees.some(
      (row) =>
        readString(row['positionId'], '') === positionId &&
        readString(row['status'], '') !== 'offboarded',
    );
  });
}

/** The payload of one `Communication.CollaborationRequested` event, or null for any other. */
export interface CollaborationRequest {
  readonly collaborationId: string;
  readonly fromAgentId: string;
  readonly toAgentId: string;
  readonly taskId: string;
  readonly purpose: string;
}

export function collaborationRequest(event: Row): CollaborationRequest | null {
  if (readString(event['type'], '') !== 'Communication.CollaborationRequested') return null;
  const payload = event['payload'];
  const body = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Row)
    : {};
  const fromAgentId = readString(body['fromAgentId'], '');
  const toAgentId = readString(body['toAgentId'], '');
  if (fromAgentId === '' || toAgentId === '') return null;
  return {
    collaborationId: readString(body['collaborationId'], ''),
    fromAgentId,
    toAgentId,
    taskId: readString(body['taskId'], ''),
    purpose: readString(body['purpose'], ''),
  };
}

export function employeeName(employees: readonly Row[], employeeId: string | null): string {
  if (employeeId === null || employeeId === '') return '—';
  const row = employees.find((entry) => readString(entry['employeeId'], '') === employeeId) ?? null;
  return row === null ? employeeId : readString(row['name'], employeeId);
}

/**
 * The roster record behind an agent id. The console reads the agent's `employeeNo` and `kind`
 * here rather than from `/api/agents`: those are employee facts, and the roster is the read
 * model that already carries them.
 */
export function employeeOf(employees: readonly Row[], employeeId: string): Row | null {
  if (employeeId === '') return null;
  return employees.find((row) => readString(row['employeeId'], '') === employeeId) ?? null;
}

/** The department name behind a department id; empty for a company-level position (the CEO). */
export function departmentName(departments: readonly Row[], departmentId: string | null): string {
  if (departmentId === null || departmentId === '') return '';
  const row = departments.find((entry) => readString(entry['departmentId'], '') === departmentId) ?? null;
  return row === null ? departmentId : readString(row['name'], departmentId);
}

/** Direct reports: the employees whose `managerEmployeeId` is this employee. */
export function reportsOf(employees: readonly Row[], employeeId: string): readonly Row[] {
  if (employeeId === '') return [];
  return employees.filter((row) => readString(row['managerEmployeeId'], '') === employeeId);
}

/**
 * The head of a department — the `headPositionId` the org chart declares — as `Title · Name`.
 * An unstaffed head still reports its position title, which is how "部门 → 员工" stays visible
 * for a department nobody heads yet. Empty when the agent sits outside any department.
 */
export function departmentHeadOf(
  departments: readonly Row[],
  positions: readonly Row[],
  employees: readonly Row[],
  departmentId: string | null,
): string {
  if (departmentId === null || departmentId === '') return '';
  const department = departments.find((row) => readString(row['departmentId'], '') === departmentId) ?? null;
  if (department === null) return '';
  const headPositionId = readString(department['headPositionId'], '');
  if (headPositionId === '') return '';
  const title = positionTitle(positions, headPositionId);
  const holder = employees.find((row) => readString(row['positionId'], '') === headPositionId) ?? null;
  const name = holder === null ? '' : readString(holder['name'], '');
  return name === '' ? title : `${title} · ${name}`;
}

/** Peers: the other agents holding the same position. */
export function peersOf(agents: readonly Row[], agent: Row): readonly Row[] {
  const positionId = readString(agent['positionId'], '');
  if (positionId === '') return [];
  return agents.filter(
    (row) => readString(row['positionId'], '') === positionId && !isSameAgent(row, agent),
  );
}

/** Colleagues: the other agents in the same department. A company-level position has none. */
export function colleaguesOf(agents: readonly Row[], agent: Row): readonly Row[] {
  const departmentId = readString(agent['departmentId'], '');
  if (departmentId === '') return [];
  return agents.filter(
    (row) => readString(row['departmentId'], '') === departmentId && !isSameAgent(row, agent),
  );
}

function isSameAgent(row: Row, agent: Row): boolean {
  const id = readString(row['employeeId'], '');
  return id !== '' && id === readString(agent['employeeId'], '');
}

/** The runtime focus reference (`task · task-3`); empty when the runtime reports none. */
export function focusRef(runtime: Row | null): string {
  if (runtime === null) return '';
  const focus = runtime['focus'];
  if (typeof focus !== 'object' || focus === null || Array.isArray(focus)) return '';
  const refType = readString((focus as Row)['refType'], '');
  const refId = readString((focus as Row)['refId'], '');
  if (refType === '') return refId;
  return refId === '' ? refType : `${refType} · ${refId}`;
}

export function employeeLabel(employees: readonly Row[], positions: readonly Row[], employeeId: string | null): string {
  if (employeeId === null || employeeId === '') return '—';
  const row = employees.find((entry) => readString(entry['employeeId'], '') === employeeId) ?? null;
  if (row === null) return employeeId;
  const title = positionTitle(positions, readString(row['positionId'], ''));
  return `${title} · ${readString(row['name'], employeeId)}`;
}

export function taskById(tasks: readonly Row[], taskId: string | null): Row | null {
  if (taskId === null || taskId === '') return null;
  return tasks.find((row) => readString(row['taskId'], '') === taskId) ?? null;
}

export function workflowById(workflows: readonly Row[], instanceId: string | null): Row | null {
  if (instanceId === null || instanceId === '') return null;
  return workflows.find((row) => readString(row['instanceId'], '') === instanceId) ?? null;
}

export function approvalOf(workflow: Row): Row | null {
  const approval = workflow['approval'];
  return typeof approval === 'object' && approval !== null && !Array.isArray(approval)
    ? (approval as Row)
    : null;
}

export function approvalStatus(workflow: Row): string {
  const approval = approvalOf(workflow);
  return approval === null ? '' : readString(approval['status'], '');
}

export function isOpenApproval(workflow: Row): boolean {
  return approvalStatus(workflow) === 'open';
}

/**
 * Workflow step progress as `{ done, total }`, read from the `stepStates` the API returns.
 * A finished step is `done` (the workflow engine's own status word) — this is the single
 * counting shared by every page that shows `n / m 步骤`, so the register, the board and the
 * runtime console can never disagree about the same instance.
 */
export function stepProgress(workflow: Row): { readonly done: number; readonly total: number } {
  const steps = Array.isArray(workflow['stepStates']) ? workflow['stepStates'] : [];
  let done = 0;
  for (const step of steps) {
    if (typeof step !== 'object' || step === null || Array.isArray(step)) continue;
    if (readString((step as Row)['status'], '').toLowerCase() === 'done') done += 1;
  }
  return { done, total: steps.length };
}

export interface WorkBriefProgress {
  /** Work items the briefed agent decomposed this brief into; 0 while it is still a brief. */
  readonly total: number;
  readonly assigned: number;
  readonly completed: number;
  readonly blocked: number;
  readonly rejected: number;
  /** Completion as a whole percentage — what the 任务书卡片 in §5.7 shows as 达成度. */
  readonly percent: number;
  /** Blocked or rejected work: the brief needs a human before it can reach 完成. */
  readonly hasBlockers: boolean;
}

/**
 * One 任务书's decomposition, read from the `counts` the read model already groups by
 * `correlationId` (§5.4). Same contract as `stepProgress`: the number the card shows and the
 * number the detail panel shows are computed in one place, so they can never disagree.
 */
export function briefProgress(brief: Row): WorkBriefProgress {
  const counts =
    typeof brief['counts'] === 'object' && brief['counts'] !== null && !Array.isArray(brief['counts'])
      ? (brief['counts'] as Row)
      : {};
  const total = readNumber(counts['total'], 0);
  const completed = readNumber(counts['completed'], 0);
  const blocked = readNumber(counts['blocked'], 0);
  const rejected = readNumber(counts['rejected'], 0);
  return {
    total,
    assigned: readNumber(counts['assigned'], 0),
    completed,
    blocked,
    rejected,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    hasBlockers: blocked > 0 || rejected > 0,
  };
}

/** A brief a human has to look at before it can finish: a blocked or rejected work item. */
export function briefNeedsAttention(brief: Row): boolean {
  return briefProgress(brief).hasBlockers;
}

export type BriefStateKind = 'pending' | 'attention' | 'completed' | 'running';

/**
 * The pill on a 任务书 card (§5.7) — one state word for the whole brief, derived only from
 * its own progress. `pillValue` is an existing status token, so `StatusPill` keeps deciding
 * the colour and switching to 中文 cannot repaint the card.
 */
export interface BriefState {
  readonly kind: BriefStateKind;
  readonly pillValue: string;
  readonly labelKey: MessageKey;
}

export function briefState(brief: Row): BriefState {
  const progress = briefProgress(brief);
  if (progress.total === 0) return { kind: 'pending', pillValue: 'idle', labelKey: 'overview.briefs.pending' };
  if (briefNeedsAttention(brief)) return { kind: 'attention', pillValue: 'blocked', labelKey: 'status.needsAttention' };
  if (progress.completed === progress.total) return { kind: 'completed', pillValue: 'completed', labelKey: 'status.completed' };
  return { kind: 'running', pillValue: 'active', labelKey: 'status.inProgress' };
}

/**
 * The brief a submitted command produced, or null. The console polls for the row whose own
 * `commandId` it just sent, so it never mistakes a brief someone else filed for its own.
 */
export function selectBrief(briefs: readonly Row[], commandId: string): Row | null {
  if (commandId === '') return null;
  return briefs.find((brief) => readString(brief['commandId'], '') === commandId) ?? null;
}

/**
 * One work item of a brief, as the read model reports it.
 *
 * `taskId` is the operator's handle on the work: it is what the Tasks page, the delivery page
 * and the audit trail all address, so the console shows it next to the title instead of making
 * the human guess which row their brief became.
 */
export interface BriefItemView {
  readonly taskId: string;
  readonly title: string;
  readonly positionId: string;
  readonly assigneeEmployeeId: string;
  readonly status: string;
}

/** The work items a brief was decomposed into; `[]` while the organization has not split it yet. */
export function briefItemViews(brief: Row | null): readonly BriefItemView[] {
  if (brief === null) return [];
  const items = Array.isArray(brief['items']) ? (brief['items'] as readonly unknown[]) : [];
  return items
    .filter((item): item is Row => typeof item === 'object' && item !== null && !Array.isArray(item))
    .map((item) => ({
      taskId: readString(item['taskId'], ''),
      title: readString(item['title'], ''),
      positionId: readString(item['positionId'], ''),
      assigneeEmployeeId: readString(item['assigneeEmployeeId'], ''),
      status: readString(item['status'], ''),
    }))
    .filter((item) => item.taskId !== '');
}

/**
 * The workflow instances one submitted command produced.
 *
 * A brief carries its `commandId` as the workflow's `correlationId` (§5.4), so the console links
 * a submission to the workflow it started without a second event source — and can therefore name
 * the gate the operator is being asked to decide.
 */
export function workflowsForCommand(workflows: readonly Row[], commandId: string): readonly Row[] {
  if (commandId === '') return [];
  return workflows.filter((workflow) => readString(workflow['correlationId'], '') === commandId);
}

/** The first open approval gate in a set of workflows — the decision the operator owes. */
export function openGate(workflows: readonly Row[]): Row | null {
  return workflows.find(isOpenApproval) ?? null;
}

/** Everything the submit result block shows about one accepted command, read back from the API. */
export interface BriefSubmission {
  readonly commandId: string;
  readonly brief: Row | null;
  readonly items: readonly BriefItemView[];
  readonly workflows: readonly Row[];
  /** The gate that is waiting for the operator, or `null` when this brief owes no decision. */
  readonly gate: Row | null;
}

/**
 * Resolve one submitted command against the two read models the console already polls.
 *
 * Nothing here is invented: the brief must come back from `/api/work-briefs` under the operator's
 * own `commandId`, and the workflow must carry that same id as its correlation. A submission
 * whose record has not arrived yet is reported as `brief: null`, never as an empty success.
 */
export function briefSubmission(
  briefs: readonly Row[],
  workflows: readonly Row[],
  commandId: string,
): BriefSubmission {
  const brief = selectBrief(briefs, commandId);
  const mine = workflowsForCommand(workflows, commandId);
  return { commandId, brief, items: briefItemViews(brief), workflows: mine, gate: openGate(mine) };
}

/** The stage the submit result block is in. The word the operator reads comes from `labelKey`. */
export type SubmissionStage =
  | 'creating'
  | 'failed'
  | 'filed'
  | 'decomposing'
  | 'running'
  | 'held'
  | 'approval'
  | 'completed';

export interface SubmissionStatus {
  readonly stage: SubmissionStage;
  /** An existing status token, so `StatusPill` keeps deciding the colour across locales. */
  readonly tone: string;
  readonly labelKey: MessageKey;
}

const SUBMISSION_TONES: Readonly<Record<SubmissionStage, string>> = {
  creating: 'idle',
  failed: 'failed',
  filed: 'idle',
  decomposing: 'pending',
  running: 'active',
  held: 'paused',
  approval: 'pending',
  completed: 'completed',
};

function submissionStatusOf(stage: SubmissionStage): SubmissionStatus {
  return {
    stage,
    tone: SUBMISSION_TONES[stage],
    labelKey: `overview.brief.result.status.${stage}` as MessageKey,
  };
}

/**
 * What the submit result block says *right now*: the local command stage first (the click was
 * registered, or the command failed), then the read model (no record yet → still filing; no work
 * item yet → still decomposing), and finally the state that needs the human — an open gate, or a
 * runtime the console holds paused. Only when none of those apply is the work merely in motion.
 */
export function submissionStatus(input: {
  readonly stage: 'creating' | 'failed' | 'filed';
  readonly submission: BriefSubmission;
  readonly held: boolean;
  readonly paused: boolean;
  /** The open gate waiting for the operator, or `null` when no decision is owed right now. */
  readonly gate: Row | null;
}): SubmissionStatus {
  if (input.stage === 'creating') return submissionStatusOf('creating');
  if (input.stage === 'failed') return submissionStatusOf('failed');
  if (input.gate !== null) return submissionStatusOf('approval');
  if (input.submission.brief === null) return submissionStatusOf('filed');
  if (input.submission.items.length === 0) return submissionStatusOf('decomposing');
  if (input.submission.items.every((item) => item.status.trim().toLowerCase() === 'completed')) {
    return submissionStatusOf('completed');
  }
  if (input.held || input.paused) return submissionStatusOf('held');
  return submissionStatusOf('running');
}

/** The two translators the derived labels need; `useI18n()` satisfies this shape. */
export interface StateTranslator {
  readonly t: (key: MessageKey) => string;
  readonly presence: (value: string) => string;
}

export type AgentStateKind = 'archived' | 'paused' | 'working' | 'present' | 'idle';

export interface AgentWorkState {
  readonly kind: AgentStateKind;
  readonly tone: string;
  readonly presence: string;
}

/**
 * The agent work state the console shows, derived from the runtime facts the API returns:
 * archived → Archived, paused → Paused, holding a current task → Working, an explicit presence
 * → that presence, otherwise → Idle.
 *
 * The *kind* is the contract: pages branch on it instead of matching on label text, so the
 * copy under each state is free to be localized without touching behaviour.
 */
export function agentState(agent: Row): AgentWorkState {
  const presence = readString(agent['presence'], '');
  if (readString(agent['lifecycle'], '') === 'archived') return { kind: 'archived', tone: 'archived', presence };
  if (agent['paused'] === true) return { kind: 'paused', tone: 'warn', presence };
  if (readString(agent['currentTaskId'], '') !== '') return { kind: 'working', tone: 'ok', presence };
  if (presence !== '' && presence !== 'idle' && presence !== 'unknown') {
    return { kind: 'present', tone: 'neutral', presence };
  }
  return { kind: 'idle', tone: 'muted', presence };
}

/** The localized state label — `Working · Quantify Q3 churn`, `Paused`, a presence, or `Idle`. */
export function agentStateLabel(state: AgentWorkState, taskTitle: string, i18n: StateTranslator): string {
  if (state.kind === 'archived') return i18n.t('status.archived');
  if (state.kind === 'paused') return i18n.t('status.paused');
  if (state.kind === 'working') {
    const working = i18n.t('status.working');
    return taskTitle === '' ? working : `${working} · ${taskTitle}`;
  }
  if (state.kind === 'present') return i18n.presence(state.presence);
  return i18n.t('status.idle');
}

/** The pill on a person card only ever distinguishes archived / paused / working / idle. */
export function agentPillLabel(kind: string, i18n: StateTranslator): string {
  if (kind === 'archived') return i18n.t('status.archived');
  if (kind === 'paused') return i18n.t('status.paused');
  if (kind === 'working') return i18n.t('status.working');
  return i18n.t('status.idle');
}

/** The M1.3 agent lifecycle token (`active` / `archived`) the roster rows carry. */
export function isArchivedAgent(agent: Row): boolean {
  return readString(agent['lifecycle'], '') === 'archived';
}

/**
 * The work product folded onto a task record (`result`), or `null` when nothing was delivered.
 * `TaskSummary` rows carry no result at all; only the record read (`GET /api/tasks/:id`) does.
 */
export function resultOf(task: Row): Row | null {
  const result = task['result'];
  return typeof result === 'object' && result !== null && !Array.isArray(result)
    ? (result as Row)
    : null;
}

/** The role (position title) behind an employee — a role, never the person's id. */
export function employeeRole(employees: readonly Row[], positions: readonly Row[], employeeId: string): string {
  const employee = employeeOf(employees, employeeId);
  return employee === null ? '' : positionTitle(positions, readString(employee['positionId'], ''));
}

export type DeliverableStateKind = 'running' | 'needAction' | 'completed';

export interface DeliverableState {
  readonly kind: DeliverableStateKind;
  readonly tone: string;
  /** The visible label. A cancelled task reads as cancelled while still counting as finished. */
  readonly labelKey: MessageKey;
}

/**
 * The three states the CEO workspace groups work by — Running, Need action, Completed.
 *
 * `kind` is the contract (pages filter on it); `tone` keeps the pill colour stable across
 * locales, exactly like `status.ts` does for API tokens. "Need action" means the organization
 * has stopped and is waiting for a human: an open approval gate on the task's workflow, or a
 * task that is blocked, failed or rejected. A cancelled task is finished work — it sits in
 * Completed but keeps its own label.
 */
export function deliverableState(taskStatus: string, gateOpen: boolean): DeliverableState {
  const code = taskStatus.trim().toLowerCase();
  if (gateOpen || code === 'blocked' || code === 'failed' || code === 'rejected') {
    return { kind: 'needAction', tone: 'warn', labelKey: 'deliverables.state.needAction' };
  }
  if (code === 'completed') return { kind: 'completed', tone: 'ok', labelKey: 'deliverables.state.completed' };
  if (code === 'cancelled' || code === 'canceled') {
    return { kind: 'completed', tone: 'muted', labelKey: 'status.cancelled' };
  }
  return { kind: 'running', tone: 'neutral', labelKey: 'deliverables.state.running' };
}
