import type { EmployeeId } from '@maoeh/shared-types';
import type { OwnershipState } from '@maoeh/organization-model';
import type { ControlCommand, ControlPlane, ControlQuery, EventStreamFilter } from '@maoeh/organization-control';
import { PreviewUnavailableError, UnknownPreviewTaskError, type PreviewStatus } from './preview-runtime.js';
import type { CreateCompanyInput, OwnershipResult } from './ownership-store.js';

export interface LlmObservation {
  readonly callCount: number;
  readonly provider?: string;
  /** Which substrate is answering: the deterministic mock, or a live provider. */
  readonly mode?: 'mock' | 'live';
  readonly model?: string;
}
/**
 * M1.5 · company ownership, the non-login kind.
 *
 * The three questions a founder asks the backend: who are the founders, which companies exist
 * and who owns them, and — after creating one or signing in — which company the runtime is
 * running right now. There is no credential check anywhere in here, by design.
 */
export interface OwnershipApi {
  state(): OwnershipState;
  createCompany(input: CreateCompanyInput): Promise<OwnershipResult>;
  activate(organizationId: string): Promise<OwnershipResult>;
}
/**
 * The Preview Runtime as the HTTP layer sees it (M1.6 preview).
 *
 * A preview is deliberately *not* part of the runtime's control plane: it spawns a child process
 * over bytes a delivery already carries, it is disposable, and it must never be able to block or
 * corrupt the organization. So it gets its own three-verb surface instead of a control command,
 * which also keeps `/api/command` exactly as audited as it was.
 */
export interface PreviewApi {
  status(taskId: string): Promise<PreviewStatus>;
  start(taskId: string): Promise<PreviewStatus>;
  stop(taskId: string): Promise<PreviewStatus>;
}
export interface ApiRuntime {
  readonly control: ControlPlane;
  readonly query: ControlQuery;
  readonly tick?: () => Promise<unknown>;
  /** LLM call counters for observation; absent when no provider is wired. */
  readonly llm?: () => LlmObservation;
  /** Company ownership (M1.5); absent only in a runtime composed without it. */
  readonly ownership?: OwnershipApi;
  /** Delivered-artifact previews; absent when this runtime runs without a preview runner. */
  readonly preview?: PreviewApi;
}
let runtime: ApiRuntime | null = null;
export function configureApiRuntime(next: ApiRuntime): void { runtime = next; }
export function createApiHandler(apiRuntime: ApiRuntime): (request: Request) => Promise<Response> { return (request) => handleApiRequest(request, apiRuntime); }
export async function handleApiRequest(request: Request, apiRuntime: ApiRuntime | null = runtime): Promise<Response> {
  if (apiRuntime === null) return json({ error: 'API runtime is not configured' }, 503);
  const url = new URL(request.url); const path = url.pathname.replace(/^\/api\/?/, '/');
  try {
    // Preview is handled before the generic method switch: it is the one endpoint that starts a
    // child process, and keeping it in its own branch means no control command can ever be
    // shadowed by it.
    if (path === '/preview' || path.startsWith('/preview/')) return await previewRoute(path, request, apiRuntime);
    if (request.method === 'GET') return await queryRoute(path, url.searchParams, apiRuntime);
    if (request.method === 'POST' && path === '/command') return json(await apiRuntime.control.execute((await request.json()) as ControlCommand));
    if (request.method === 'POST' && path === '/tick') { if (apiRuntime.tick === undefined) return json({ error: 'tick is unavailable' }, 409); return json(await apiRuntime.tick()); }
    if (request.method === 'POST' && (path === '/ownership/companies' || path === '/ownership/session')) return await ownershipCommand(path, request, apiRuntime);
    return json({ error: 'Not found' }, 404);
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Request failed' }, 400); }
}
/**
 * `GET /api/preview/:taskId`, `POST /api/preview/:taskId/start`, `POST /api/preview/:taskId/stop`.
 *
 * The status read is a GET so the delivery page can poll it like every other read model, while
 * starting and stopping a child process are explicit POSTs. Three outcomes are distinguished
 * because the console treats them differently: an unknown task is `404` (there is nothing to
 * preview), a delivery with no runnable web entry point is `422` with the reason (the answer is
 * still about this task), and anything else is `200` with the status the page renders.
 */
async function previewRoute(path: string, request: Request, api: ApiRuntime): Promise<Response> {
  const preview = api.preview;
  if (preview === undefined) return json({ error: 'preview_unavailable', message: 'this runtime has no preview runner' }, 501);
  const segments = path.split('/').filter((segment) => segment !== '');
  // `/preview/:taskId[/start|/stop]` — anything else is not an endpoint this API has.
  if (segments.length < 2 || segments.length > 3 || segments[0] !== 'preview') return json({ error: 'Not found' }, 404);
  let taskId: string;
  try {
    taskId = decodeURIComponent(segments[1] ?? '');
  } catch {
    return json({ error: 'invalid task id encoding' }, 400);
  }
  const action = segments[2];
  const method = (request.method ?? 'GET').toUpperCase();
  if (taskId.trim() === '') return json({ error: 'invalid task id' }, 400);
  if (action !== undefined && (method !== 'POST' || (action !== 'start' && action !== 'stop'))) {
    return json({ error: 'Not found' }, 404);
  }
  if (action === undefined && method !== 'GET') return json({ error: 'Not found' }, 404);
  try {
    const status = action === 'start'
      ? await preview.start(taskId)
      : action === 'stop' ? await preview.stop(taskId) : await preview.status(taskId);
    return json(status);
  } catch (error) {
    if (error instanceof UnknownPreviewTaskError) return json({ error: error.message }, 404);
    if (error instanceof PreviewUnavailableError) return json({ error: error.message, taskId }, 422);
    return json({ error: error instanceof Error ? error.message : 'preview failed' }, 500);
  }
}
/**
 * Create a company (`/ownership/companies`) or sign in to one (`/ownership/session`).
 *
 * A refused request answers `422` with the store's machine-readable `code` — the console
 * localizes it, so the founder reads "your company needs a name" in their own language instead
 * of a server sentence.
 */
async function ownershipCommand(path: string, request: Request, api: ApiRuntime): Promise<Response> {
  const ownership = api.ownership;
  if (ownership === undefined) return json({ error: 'ownership_unavailable', message: 'ownership is unavailable' }, 501);
  const body = (await request.json()) as Record<string, unknown>;
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const result = path === '/ownership/companies'
    ? await ownership.createCompany({ founderName: text(body['founderName']), companyName: text(body['companyName']) })
    : await ownership.activate(text(body['organizationId']));
  if (!result.ok) return json({ error: result.code, message: result.message }, 422);
  return json({ user: result.user, organization: result.organization }, path === '/ownership/companies' ? 201 : 200);
}
/** How the query string says yes: `?flag=1` or `?flag=true`. */
const truthy = (value: string | null): boolean => value === '1' || value === 'true';

async function queryRoute(path: string, params: URLSearchParams, api: ApiRuntime): Promise<Response> {
  const q = api.query; const limit = Number(params.get('limit')) > 0 ? Number(params.get('limit')) : 100;
  // Read one agent (M1.3 Agent Management): the by-id counterpart of the roster list. Archived
  // agents are readable too — archive is a status, never a deletion.
  if (path.startsWith('/agents/')) {
    const agentId = decodeURIComponent(path.slice('/agents/'.length));
    const agent = agentId === '' ? null : q.getAgent(agentId as EmployeeId);
    return agent === null ? json({ error: `unknown agent "${agentId}"` }, 404) : json(agent);
  }
  // Read one task (M1.4 Deliverables): the record carries the submitted result — summary,
  // deliverable data and artifact references — which the list projection deliberately omits.
  if (path.startsWith('/tasks/')) {
    const taskId = decodeURIComponent(path.slice('/tasks/'.length));
    const task = taskId === '' ? null : q.getTask(taskId);
    return task === null ? json({ error: `unknown task "${taskId}"` }, 404) : json(task);
  }
  // Read one work brief (M1.4 §5.7): the by-id counterpart of the brief list, same 404 shape
  // as `/agents/:id` and `/tasks/:id`. The read model is the log itself, so it is awaited.
  if (path.startsWith('/work-briefs/')) {
    const briefId = decodeURIComponent(path.slice('/work-briefs/'.length));
    const brief = briefId === '' ? null : await q.getWorkBrief(briefId);
    return brief === null ? json({ error: `unknown work brief "${briefId}"` }, 404) : json(brief);
  }
  switch (path) {
    case '/snapshot': return snapshotResponse(await q.getOrganizationSnapshot()); case '/simulation': return json(q.getSimulationState()); case '/agents': return json(q.getAgents()); case '/tasks': return json(q.getTasks());
    // M1.4 §5.7 任务书列表: every brief with the decomposition grouped under its correlationId.
    // A named envelope (like `/approvals` → `{ pending }`), because a brief list is a domain
    // view rather than a raw entity roster; it is the shape the console panel reads.
    case '/work-briefs': return json({ briefs: await q.listWorkBriefs() });
    // M1.5: the founder/company record behind the console's "Create Your AI Company" gate.
    case '/ownership': return api.ownership === undefined ? json({ error: 'ownership_unavailable', message: 'ownership is unavailable' }, 501) : json(api.ownership.state());
    // The console renders objectives, step progress and open approval gates from the same
    // list it already polls: summaries composed with the existing `getWorkflow` detail.
    case '/workflows': return json(q.getWorkflows().map((summary) => q.getWorkflow(summary.instanceId) ?? summary));
    case '/approvals': return json({ pending: q.getPendingApprovals() }); case '/audits': return json(q.getRecentAudits(limit));
    // Default is company activity: `getRecentEvents` holds `BACKGROUND_EVENT_TYPE_PREFIXES`
    // (the per-tick `System.SimClockTicked` marker) back unless the caller narrows the query
    // themselves — `?prefix=System.` therefore still returns the raw clock markers. Work the
    // log records as removed is held back too; `?includeDeleted=1` reads that history again.
    case '/events': return json(await q.getRecentEvents({ limit, ...(params.get('prefix') ? { eventTypePrefix: params.get('prefix')! } : {}), ...(truthy(params.get('includeDeleted')) ? { includeDeleted: true } : {}) } satisfies EventStreamFilter));
    case '/llm': return json(api.llm?.() ?? { callCount: 0 });
    case '/communications': return json(await q.getRecentEvents({ limit, eventTypePrefix: 'Communication.' })); case '/runtime': return json(q.getControlState()); default: return json({ error: 'Not found' }, 404);
  }
}
/**
 * The snapshot contract the console parses (`parseSnapshot` in `apps/web/src/api.ts`).
 *
 * These are the array fields all eight pages read — `positions` above all, because the
 * organization chart (including positions nobody staffs) is built from it. The API checks
 * its own payload before it ships: a query that drops a field must fail here, where the
 * message names the exact path, instead of on every page of the console at once. The
 * console keeps its own strict check; neither side substitutes `field ?? []`.
 */
export const SNAPSHOT_ARRAY_FIELDS = [
  'departments',
  'positions',
  'employees',
  'agents',
  'workflows',
  'tasks',
  'recentEvents',
  'recentAudits',
] as const;

/** First violated path of the snapshot contract, or `null` when the payload is complete. */
export function snapshotContractViolation(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'snapshot must be an object';
  const record = value as Readonly<Record<string, unknown>>;
  for (const field of SNAPSHOT_ARRAY_FIELDS) {
    if (Array.isArray(record[field])) continue;
    const offending = record[field];
    const received = offending === null ? 'null' : offending === undefined ? 'undefined' : typeof offending;
    return `snapshot.${field} must be an array, received ${received}`;
  }
  return null;
}

function snapshotResponse(snapshot: unknown): Response {
  const violation = snapshotContractViolation(snapshot);
  if (violation !== null) return json({ error: `GET /api/snapshot contract violated: ${violation}` }, 500);
  return json(snapshot);
}

function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }); }
