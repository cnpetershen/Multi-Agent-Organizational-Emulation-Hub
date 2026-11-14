/**
 * Transport + contract layer for the operator console.
 *
 * Every backend response is checked twice before it reaches React:
 *   1. HTTP status + JSON parseability (transport).
 *   2. The exact structural shape the view renders (contract).
 *
 * A violation throws `ApiError` with the offending path, so the failure is shown to the
 * operator instead of reaching `Table`/`Overview` and taking the whole tree down.
 * Nothing here fabricates data: an unparsable response is an error, never an empty list.
 *
 * The contracts themselves are locale-independent — endpoints, HTTP statuses, parse rules and
 * the wire paths quoted in a message never change. Only the prose around them is localized, so
 * a Chinese operator reads why a response was rejected without losing the path to fix.
 */

import { t } from './i18n';

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Row = Record<string, unknown>;

export interface SimulationView {
  readonly paused: boolean;
  readonly tick: number;
  readonly simTime: number;
  readonly queueDepth: number;
  /** Full payload as received, for the raw-state panel. */
  readonly raw: Row;
}

export interface Snapshot {
  readonly company: { readonly id: string; readonly name: string };
  readonly simulation: SimulationView;
  /** Organization chart: every position, including the ones no employee staffs yet. */
  readonly positions: readonly Row[];
  /** Departments with their position/employee counts — the agent record names one by id. */
  readonly departments: readonly Row[];
  readonly employees: readonly Row[];
  readonly agents: readonly Row[];
  readonly tasks: readonly Row[];
  readonly workflows: readonly Row[];
  readonly recentEvents: readonly Row[];
  readonly recentAudits: readonly Row[];
}

export interface CommandOutcome {
  readonly status: 'accepted' | 'rejected' | 'failed';
  readonly commandType: string;
  readonly failure: string | null;
}

/** A submitted command's lifecycle, rendered by the console-wide feedback banner. */
export interface Feedback {
  readonly kind: 'pending' | 'success' | 'error';
  readonly title: string;
  readonly detail: string | null;
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function readString(value: unknown, fallback = '—'): string {
  if (typeof value === 'string' && value !== '') return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return t('api.receivedArray');
  if (typeof value === 'object') return t('api.receivedObject');
  return t('api.receivedType', { type: typeof value });
}

function snippet(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean === '') return t('api.emptyBody');
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}

function recordOf(value: unknown, where: string): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(t('api.object', { where, received: describeType(value) }));
  }
  return value as Row;
}

function arrayOfRows(value: unknown, where: string): readonly Row[] {
  if (!Array.isArray(value)) {
    throw new ApiError(t('api.array', { where, received: describeType(value) }));
  }
  return value.map((item, index) => recordOf(item, `${where}[${String(index)}]`));
}

function requiredString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(t('api.string', { where, received: describeType(value) }));
  }
  return value;
}

function requiredNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(t('api.number', { where, received: describeType(value) }));
  }
  return value;
}

function requiredBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ApiError(t('api.boolean', { where, received: describeType(value) }));
  }
  return value;
}

function failureDetail(body: unknown, text: string): string {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const error = (body as Row)['error'];
    if (typeof error === 'string' && error !== '') return `: ${error}`;
  }
  return `: ${snippet(text)}`;
}

/**
 * Fetch a JSON document. Throws `ApiError` for unreachable endpoints, non-2xx statuses
 * and non-JSON bodies — the message is what the operator sees, so it must be complete.
 */
export async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const method = (init?.method ?? 'GET').toUpperCase();
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (cause) {
    throw new ApiError(t('api.unreachable', { method, path, cause: messageOf(cause) }));
  }
  const text = await response.text();
  let body: unknown = null;
  let parsed = false;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
      parsed = true;
    } catch {
      parsed = false;
    }
  }
  if (!response.ok) {
    throw new ApiError(t('api.httpFailure', { method, path, status: response.status, detail: failureDetail(body, text) }));
  }
  if (!parsed && text.length > 0) {
    throw new ApiError(t('api.nonJson', { method, path, status: response.status, snippet: snippet(text) }));
  }
  return body;
}

export function parseSimulation(value: unknown, where: string): SimulationView {
  const root = recordOf(value, where);
  return {
    paused: requiredBoolean(root['paused'], `${where}.paused`),
    tick: requiredNumber(root['tick'], `${where}.tick`),
    simTime: requiredNumber(root['simTime'], `${where}.simTime`),
    queueDepth: requiredNumber(root['queueDepth'], `${where}.queueDepth`),
    raw: root,
  };
}

export function parseSnapshot(value: unknown): Snapshot {
  const root = recordOf(value, 'GET /api/snapshot response');
  const company = recordOf(root['company'], 'snapshot.company');
  return {
    company: {
      id: requiredString(company['id'], 'snapshot.company.id'),
      name: requiredString(company['name'], 'snapshot.company.name'),
    },
    simulation: parseSimulation(root['simulation'], 'snapshot.simulation'),
    positions: arrayOfRows(root['positions'], 'snapshot.positions'),
    departments: arrayOfRows(root['departments'], 'snapshot.departments'),
    employees: arrayOfRows(root['employees'], 'snapshot.employees'),
    agents: arrayOfRows(root['agents'], 'snapshot.agents'),
    tasks: arrayOfRows(root['tasks'], 'snapshot.tasks'),
    workflows: arrayOfRows(root['workflows'], 'snapshot.workflows'),
    recentEvents: arrayOfRows(root['recentEvents'], 'snapshot.recentEvents'),
    recentAudits: arrayOfRows(root['recentAudits'], 'snapshot.recentAudits'),
  };
}

export function parseApprovals(value: unknown, path: string): readonly Row[] {
  const root = recordOf(value, `${path} response`);
  return arrayOfRows(root['pending'], `${path} response.pending`);
}

export function parseRows(value: unknown, path: string): readonly Row[] {
  return arrayOfRows(value, `${path} response`);
}

function briefItems(value: unknown, where: string): readonly Row[] {
  return arrayOfRows(value, where).map((item, index) => {
    const at = `${where}[${String(index)}]`;
    requiredString(item['taskId'], `${at}.taskId`);
    requiredString(item['title'], `${at}.title`);
    requiredString(item['status'], `${at}.status`);
    return item;
  });
}

function briefCounts(value: unknown, where: string): Row {
  const counts = recordOf(value, where);
  for (const key of ['total', 'assigned', 'completed', 'blocked', 'rejected'] as const) {
    requiredNumber(counts[key], `${where}.${key}`);
  }
  return counts;
}

/**
 * Every 任务书 the read model knows, oldest first (`GET /api/work-briefs` → `{ briefs }`).
 *
 * The panel's whole job is "任务书 → 各项 → 状态", so the decomposition is contract-checked
 * here: a brief whose `items` or `counts` are malformed fails with the offending path instead
 * of rendering as a brief the organization never broke down.
 */
export function parseWorkBriefs(value: unknown, path: string): readonly Row[] {
  const where = `${path} response`;
  const root = recordOf(value, where);
  return arrayOfRows(root['briefs'], `${where}.briefs`).map((brief, index) => {
    const at = `${where}.briefs[${String(index)}]`;
    requiredString(brief['briefId'], `${at}.briefId`);
    requiredString(brief['commandId'], `${at}.commandId`);
    requiredString(brief['agentId'], `${at}.agentId`);
    requiredString(brief['operatorId'], `${at}.operatorId`);
    requiredString(brief['reason'], `${at}.reason`);
    requiredString(brief['correlationId'], `${at}.correlationId`);
    requiredString(brief['title'], `${at}.title`);
    requiredString(brief['goal'], `${at}.goal`);
    stringArrayOf(brief['verificationKeys'], `${at}.verificationKeys`);
    requiredNumber(brief['submittedAtSim'], `${at}.submittedAtSim`);
    briefItems(brief['items'], `${at}.items`);
    briefCounts(brief['counts'], `${at}.counts`);
    return brief;
  });
}

/** The work product an executor submitted for one task (absent until something is delivered). */
export interface TaskResultView {
  readonly taskId: string;
  readonly producedBy: string;
  readonly summary: string;
  readonly data: Row;
  readonly artifacts: readonly string[];
}

/**
 * One task record — what `GET /api/tasks/:id` answers and what the delivery page
 * (`/results/:taskId`) renders: the brief (`goal`, `detail`), the delivery (`result`,
 * `outputs`), its acceptance (`verification`, `reviews`) and the two timestamps the header
 * shows. The workspace list stays on `TaskSummary`; only a delivery page pulls this payload.
 */
export interface TaskRecord {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly goal: string;
  readonly detail: string | null;
  readonly positionId: string | null;
  readonly assigneeEmployeeId: string | null;
  readonly workflowInstanceId: string | null;
  readonly workflowStepId: string | null;
  /** F3: the brief/correlation that produced this task; `null` when the API omits it. */
  readonly correlationId: string | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Simulated time the work was created — the only clock this system keeps. */
  readonly createdAtSim: number;
  /** Simulated time the work finished, or `null` while it is still running. */
  readonly completedAtSim: number | null;
  readonly blockedReason: string | null;
  readonly rejectReason: string | null;
  readonly outputs: readonly string[];
  readonly result: TaskResultView | null;
  readonly reviews: readonly {
    readonly reviewerId: string;
    readonly verdict: string;
    readonly reason: string | null;
  }[];
  readonly verification: { readonly kind: string; readonly requiredOutputKeys: readonly string[] } | null;
}

/** A value the API may legitimately omit: `null` instead of a fabricated empty string. */
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function stringArrayOf(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ApiError(t('api.array', { where, received: describeType(value) }));
  }
  return value.map((item, index) => requiredString(item, `${where}[${String(index)}]`));
}

function parseTaskResult(value: unknown, where: string): TaskResultView | null {
  if (value === null || value === undefined) return null;
  const result = recordOf(value, where);
  return {
    taskId: requiredString(result['taskId'], `${where}.taskId`),
    producedBy: requiredString(result['producedBy'], `${where}.producedBy`),
    summary: requiredString(result['summary'], `${where}.summary`),
    data: recordOf(result['data'], `${where}.data`),
    artifacts: stringArrayOf(result['artifacts'], `${where}.artifacts`),
  };
}

function parseTaskVerification(value: unknown, where: string): TaskRecord['verification'] {
  if (value === null || value === undefined) return null;
  const verification = recordOf(value, where);
  return {
    kind: requiredString(verification['kind'], `${where}.kind`),
    requiredOutputKeys: stringArrayOf(verification['requiredOutputKeys'], `${where}.requiredOutputKeys`),
  };
}

/** Parse one task record, naming the exact path of the first field the view cannot render. */
export function parseTaskRecord(value: unknown, path: string): TaskRecord {
  const where = `${path} response`;
  const root = recordOf(value, where);
  return {
    taskId: requiredString(root['taskId'], `${where}.taskId`),
    title: requiredString(root['title'], `${where}.title`),
    status: requiredString(root['status'], `${where}.status`),
    goal: requiredString(root['goal'], `${where}.goal`),
    detail: optionalString(root['detail']),
    positionId: optionalString(root['positionId']),
    assigneeEmployeeId: optionalString(root['assigneeEmployeeId']),
    workflowInstanceId: optionalString(root['workflowInstanceId']),
    workflowStepId: optionalString(root['workflowStepId']),
    correlationId: optionalString(root['correlationId']),
    attempt: requiredNumber(root['attempt'], `${where}.attempt`),
    maxAttempts: requiredNumber(root['maxAttempts'], `${where}.maxAttempts`),
    createdAtSim: requiredNumber(root['createdAtSim'], `${where}.createdAtSim`),
    completedAtSim:
      root['completedAtSim'] === null || root['completedAtSim'] === undefined
        ? null
        : requiredNumber(root['completedAtSim'], `${where}.completedAtSim`),
    blockedReason: optionalString(root['blockedReason']),
    rejectReason: optionalString(root['rejectReason']),
    outputs: stringArrayOf(root['outputs'], `${where}.outputs`),
    result: parseTaskResult(root['result'], `${where}.result`),
    reviews: arrayOfRows(root['reviews'], `${where}.reviews`).map((review, index) => ({
      reviewerId: requiredString(review['reviewerId'], `${where}.reviews[${String(index)}].reviewerId`),
      verdict: requiredString(review['verdict'], `${where}.reviews[${String(index)}].verdict`),
      reason: optionalString(review['reason']),
    })),
    verification: parseTaskVerification(root['verification'], `${where}.verification`),
  };
}
/** The LLM substrate the runtime reports (`GET /api/llm`): who is thinking, and how much. */
export interface LlmView {
  readonly callCount: number;
  readonly provider: string | null;
  readonly mode: 'mock' | 'live' | null;
  readonly model: string | null;
}

/** Parse `/api/llm` defensively: callCount is the only field the Network metrics require. */
export function parseLlm(value: unknown): LlmView {
  const root = recordOf(value, 'GET /api/llm response');
  const mode = root['mode'];
  return {
    callCount: typeof root['callCount'] === 'number' && Number.isFinite(root['callCount']) ? root['callCount'] : 0,
    provider: optionalString(root['provider']),
    mode: mode === 'mock' || mode === 'live' ? mode : null,
    model: optionalString(root['model']),
  };
}

export function parseCommandOutcome(value: unknown): CommandOutcome {
  const root = recordOf(value, 'POST /api/command response');
  const status = requiredString(root['status'], 'command.status');
  if (status !== 'accepted' && status !== 'rejected' && status !== 'failed') {
    throw new ApiError(t('api.unknownStatus', { status }));
  }
  const failureValue = root['failure'];
  let failure: string | null = null;
  if (failureValue !== null && failureValue !== undefined) {
    const failureObject = recordOf(failureValue, 'command.failure');
    const code = readString(failureObject['code'], 'UNKNOWN');
    const issues = Array.isArray(failureObject['issues']) ? failureObject['issues'] : [];
    const details = issues
      .map((issue) => recordOf(issue, 'command.failure.issues[]'))
      .map((issue) => `${readString(issue['field'], 'field')}: ${readString(issue['reason'], 'reason')}`)
      .join(' · ');
    failure = details === '' ? code : `${code} — ${details}`;
  }
  return {
    status,
    commandType: readString(root['commandType'], t('api.unknownCommand')),
    failure,
  };
}

let commandSequence = 0;

/** Unique idempotency key per operator action; never reused between clicks. */
export function nextCommandId(): string {
  commandSequence += 1;
  return `ui-${String(Date.now())}-${String(commandSequence)}`;
}
