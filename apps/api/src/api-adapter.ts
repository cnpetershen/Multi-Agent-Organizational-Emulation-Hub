import type { EmployeeId, PositionId } from '@maoeh/shared-types';
import type { OwnershipState } from '@maoeh/organization-model';
import type { ControlCommand, ControlPlane, ControlQuery, EventStreamFilter } from '@maoeh/organization-control';
import { ContentStudioError, type ContentStudioInput, type ContentStudioResult } from './content-studio.js';
import {
  SandboxBriefError,
  buildSandboxBriefCommand,
  buildSandboxBriefDraft,
  normalizeSandboxBriefInput,
} from './sandbox-brief.js';
import {
  SandboxError,
  type SandboxSession,
  type SandboxSessionInput,
} from './sandbox-session.js';
import { PreviewUnavailableError, UnknownPreviewTaskError, type PreviewStatus } from './preview-runtime.js';
import { TranslationError, type TranslationInput } from './translation.js';
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
/**
 * 一鱼多吃 as the HTTP layer sees it.
 *
 * Deliberately a tool surface (`page` + `generate`) rather than a control command: it generates
 * copy from material the operator supplies, writes no event, and has no workflow semantics. The
 * two together keep the workbench reachable without pretending the organization did the work.
 */
export interface ContentStudioApi {
  page(): string;
  generate(input: ContentStudioInput): Promise<ContentStudioResult>;
}
/**
 * 赛博沙盘 as the HTTP layer sees it: a page, a start verb and two read verbs.
 *
 * A session is a few minutes of real model calls, so it is started and observed rather than being
 * a control command hidden in `/api/command`; the two read verbs are what let the page reopen a
 * finished session after a reload.
 */
export interface SandboxApi {
  page(): string;
  start(input: SandboxSessionInput): Promise<SandboxSession>;
  list(limit?: number): Promise<readonly SandboxSession[]>;
  get(sessionId: string): Promise<SandboxSession | null>;
}
export interface ApiRuntime {
  readonly control: ControlPlane;
  readonly query: ControlQuery;
  /**
   * M2: the company this runtime serves. The sandbox-brief route uses it to prove the session
   * belongs to the company the brief will be filed in; absent only in minimal test doubles.
   */
  readonly companyId?: string;
  readonly tick?: () => Promise<unknown>;
  /** LLM call counters for observation; absent when no provider is wired. */
  readonly llm?: () => LlmObservation;
  /** Company ownership (M1.5); absent only in a runtime composed without it. */
  readonly ownership?: OwnershipApi;
  /** Delivered-artifact previews; absent when this runtime runs without a preview runner. */
  readonly preview?: PreviewApi;
  /** Document translation for bilingual delivery pages; absent when no provider is wired. */
  readonly translate?: (input: TranslationInput) => Promise<string>;
  /** 一鱼多吃 workbench: the page plus its generation endpoint. Absent when no provider is wired. */
  readonly content?: ContentStudioApi;
  /** 赛博沙盘: real multi-role adversarial sessions in an isolated runtime. */
  readonly sandbox?: SandboxApi;
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
    // The 一鱼多吃 workbench is served by the API itself: same origin as its endpoint, no build
    // step, and no API key anywhere near the browser.
    if (request.method === 'GET' && path === '/studio') return await contentPageRoute(apiRuntime);
    if (request.method === 'POST' && path === '/content/generate') return await contentGenerateRoute(request, apiRuntime);
    // M2: the sandbox → brief bridge. It lives before the generic sandbox route because that
    // route owns every `/sandbox/*` path and has no access to the main company's control plane.
    if (path.startsWith('/sandbox/sessions/') && path.endsWith('/brief')) {
      return await sandboxBriefRoute(path, request, apiRuntime);
    }
    if (path === '/sandbox' || path.startsWith('/sandbox/')) return await sandboxRoute(path, request, apiRuntime);
    if (request.method === 'POST' && path === '/translate') return await translateRoute(request, apiRuntime);
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
 * `GET /api/studio` — the 一鱼多吃 workbench.
 *
 * A missing content service is a `503` page rather than a JSON error: this route is opened in a
 * browser tab, and a person should read a sentence, not a payload.
 */
async function contentPageRoute(api: ApiRuntime): Promise<Response> {
  const content = api.content;
  if (content === undefined) {
    return html(
      '<!doctype html><meta charset="utf-8"><title>内容工坊不可用</title>'
      + '<p style="font:14px system-ui;padding:24px">这个运行时没有接入内容生成服务（没有可用的 LLM provider）。</p>',
      503,
    );
  }
  return html(content.page());
}

/**
 * `POST /api/content/generate` — one source, one brief per platform, the model's own copy back.
 *
 * A refused input is `400`; a provider failure is `502` — the page shows which, so an operator can
 * tell "my request was wrong" from "the model failed" without guessing.
 */
async function contentGenerateRoute(request: Request, api: ApiRuntime): Promise<Response> {
  const content = api.content;
  if (content === undefined) {
    return json({ error: 'content_unavailable', message: 'this runtime has no content studio' }, 501);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_content', message: 'body must be JSON' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json({ error: 'invalid_content', message: 'body must be an object' }, 400);
  }
  const record = body as Readonly<Record<string, unknown>>;
  const source = typeof record['source'] === 'string' ? record['source'] : '';
  const requested = record['platforms'];
  const platforms = Array.isArray(requested)
    ? requested.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  try {
    return json(await content.generate({ source, ...(platforms === undefined ? {} : { platforms }) }));
  } catch (error) {
    if (error instanceof ContentStudioError && error.code === 'invalid') {
      return json({ error: 'invalid_content', message: error.message }, 400);
    }
    if (error instanceof ContentStudioError) {
      return json({ error: 'content_generation_failed', message: error.message }, 502);
    }
    return json(
      { error: 'content_generation_failed', message: error instanceof Error ? error.message : 'generation failed' },
      502,
    );
  }
}

/**
 * `GET /api/sandbox`, `POST /api/sandbox/session`, `GET /api/sandbox/sessions[/:id]`.
 *
 * Four verbs, each with one honest failure mode: a page, a start that can be refused because the
 * company has too few seats (`409`) or because the model failed (`502`), and two reads that return
 * `null` when the session is unknown.
 */
/**
 * `GET /api/sandbox/sessions/:id/brief` — the editable draft; `POST` with `confirm: true`
 * submits it as a `Work.SubmitBrief` command.
 *
 * The bridge is deliberately one-way and explicit:
 *
 * - the draft is derived from the session's own messages and score, never from a second model
 *   call, so the operator can diff what they watched against what will be submitted;
 * - GET writes nothing, so previewing cannot start work;
 * - POST requires `confirm: true` (an accidental request cannot submit), refuses a second brief
 *   for the same session, and only then executes the existing command — the workflow still has
 *   to be confirmed on the canvas, because the console runs with plan confirmation on.
 *
 * It also refuses sessions that cannot prove ownership (written before sessions carried a
 * `companyId`) rather than guessing which company a brief should belong to.
 */
async function sandboxBriefRoute(
  path: string,
  request: Request,
  api: ApiRuntime,
): Promise<Response> {
  const sandbox = api.sandbox;
  if (sandbox === undefined) {
    return json({ error: 'sandbox_unavailable', message: 'this runtime has no sandbox service' }, 501);
  }
  const rawId = path.slice('/sandbox/sessions/'.length, path.length - '/brief'.length);
  const sessionId = decodeURIComponent(rawId).replace(/\/+$/u, '');
  if (sessionId === '') {
    return json({ error: 'invalid_session', message: 'session id is required' }, 400);
  }
  let session: SandboxSession | null;
  try {
    session = await sandbox.get(sessionId);
  } catch (error) {
    return json({ error: 'sandbox_failed', message: error instanceof Error ? error.message : 'sandbox read failed' }, 500);
  }
  if (session === null) {
    return json({ error: 'unknown_session', message: `unknown sandbox session "${sessionId}"` }, 404);
  }

  const companyId = api.companyId;
  if (companyId === undefined || session.companyId === undefined) {
    return json(
      {
        error: 'sandbox_session_legacy',
        message: 'this session has no recorded company; run a new session before converting it to a brief',
      },
      409,
    );
  }
  if (session.companyId !== companyId) {
    return json(
      {
        error: 'sandbox_session_other_company',
        message: `session "${sessionId}" belongs to company "${session.companyId}", not "${companyId}"`,
      },
      409,
    );
  }
  if (session.turns.length < 2) {
    return json(
      {
        error: 'sandbox_session_not_ready',
        message: `session "${sessionId}" has ${String(session.turns.length)} turn(s); at least two are needed`,
      },
      422,
    );
  }

  let draft: ReturnType<typeof buildSandboxBriefDraft>;
  try {
    draft = buildSandboxBriefDraft(session);
  } catch (error) {
    if (error instanceof SandboxBriefError) {
      return json({ error: error.code, message: error.message }, 422);
    }
    throw error;
  }

  const briefs = await api.query.listWorkBriefs();
  const existing = briefs.find((brief) => brief.sourceSessionId === sessionId) ?? null;
  const submitted =
    existing === null
      ? null
      : { briefId: existing.briefId, commandId: existing.commandId };

  if (request.method === 'GET') {
    return json({ draft, submitted });
  }
  if (request.method !== 'POST') {
    return json({ error: 'method_not_allowed', message: 'use GET for the draft or POST to confirm' }, 405);
  }
  if (existing !== null) {
    return json(
      {
        error: 'already_converted',
        message: `session "${sessionId}" already produced brief "${existing.briefId}"`,
        briefId: existing.briefId,
        commandId: existing.commandId,
      },
      409,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_brief', message: 'body must be JSON' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json({ error: 'invalid_brief', message: 'body must be an object' }, 400);
  }
  if ((body as Readonly<Record<string, unknown>>)['confirm'] !== true) {
    return json(
      {
        error: 'confirmation_required',
        message: 'the brief is only submitted with "confirm": true after the operator reviewed it',
      },
      400,
    );
  }
  let input: ReturnType<typeof normalizeSandboxBriefInput>;
  try {
    input = normalizeSandboxBriefInput(body, draft);
  } catch (error) {
    if (error instanceof SandboxBriefError) {
      return json({ error: error.code, message: error.message }, 400);
    }
    throw error;
  }

  const agents = api.query.getAgents().filter((agent) => agent.lifecycle === 'active');
  const chief = agents.find((agent) => agent.positionId === 'ceo') ?? agents[0];
  if (chief === undefined) {
    return json({ error: 'no_target_agent', message: 'the company has no active employee to brief' }, 409);
  }
  const command = buildSandboxBriefCommand({
    commandId: `sandbox-brief-${sessionId}`,
    actor: {
      operatorId: 'ceo-alex' as EmployeeId,
      displayName: 'Alex',
      positionId: 'ceo' as PositionId,
      kind: 'human',
    },
    targetAgentId: String(chief.employeeId),
    simTime: api.query.getSimulationState().simTime,
    draft,
    input,
    turns: session.turns,
    reason: `Convert 赛博沙盘 session ${sessionId} into a work brief from the console`,
  });

  let outcome;
  try {
    outcome = await api.control.execute(command);
  } catch (error) {
    return json({ error: 'command_failed', message: error instanceof Error ? error.message : 'command failed' }, 500);
  }
  if (outcome.status !== 'accepted') {
    const code = outcome.failure?.code ?? 'command_refused';
    const denied = code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'OUT_OF_SCOPE';
    return json(
      {
        error: 'command_refused',
        message: `the work brief was refused (${code})`,
        code,
        failure: outcome.failure,
      },
      denied ? 403 : 409,
    );
  }

  const after = await api.query.listWorkBriefs();
  const created =
    after.find((brief) => brief.sourceSessionId === sessionId) ??
    after.find((brief) => brief.commandId === command.commandId) ??
    null;
  return json(
    {
      draft,
      submitted:
        created === null
          ? { briefId: null, commandId: command.commandId }
          : { briefId: created.briefId, commandId: created.commandId },
      replayed: outcome.replayed,
    },
    201,
  );
}

async function sandboxRoute(path: string, request: Request, api: ApiRuntime): Promise<Response> {
  const sandbox = api.sandbox;
  if (sandbox === undefined) {
    if (path === '/sandbox' && request.method === 'GET') {
      return html(
        '<!doctype html><meta charset="utf-8"><title>赛博沙盘不可用</title>'
        + '<p style="font:14px system-ui;padding:24px">这个运行时没有接入沙盘会话服务。</p>',
        503,
      );
    }
    return json({ error: 'sandbox_unavailable', message: 'this runtime has no sandbox service' }, 501);
  }
  const method = (request.method ?? 'GET').toUpperCase();
  if (path === '/sandbox' && method === 'GET') return html(sandbox.page());
  if (path === '/sandbox/session' && method === 'POST') {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_sandbox', message: 'body must be JSON' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return json({ error: 'invalid_sandbox', message: 'body must be an object' }, 400);
    }
    const record = body as Readonly<Record<string, unknown>>;
    const topic = typeof record['topic'] === 'string' ? record['topic'] : '';
    const rounds = typeof record['rounds'] === 'number' ? record['rounds'] : undefined;
    try {
      return json(await sandbox.start({ topic, ...(rounds === undefined ? {} : { rounds }) }), 201);
    } catch (error) {
      return sandboxFailure(error);
    }
  }
  if (path === '/sandbox/sessions' && method === 'GET') {
    try {
      return json({ sessions: await sandbox.list(10) });
    } catch (error) {
      return sandboxFailure(error);
    }
  }
  if (path.startsWith('/sandbox/sessions/') && method === 'GET') {
    const sessionId = decodeURIComponent(path.slice('/sandbox/sessions/'.length));
    if (sessionId.trim() === '') return json({ error: 'invalid_sandbox', message: 'session id is required' }, 400);
    try {
      const session = await sandbox.get(sessionId);
      return session === null ? json({ error: 'unknown_session' }, 404) : json(session);
    } catch (error) {
      return sandboxFailure(error);
    }
  }
  return json({ error: 'Not found' }, 404);
}

function sandboxFailure(error: unknown): Response {
  if (error instanceof SandboxError) {
    switch (error.code) {
      case 'invalid':
        return json({ error: 'invalid_sandbox', message: error.message }, 400);
      case 'no_roles':
        return json({ error: 'sandbox_no_roles', message: error.message }, 409);
      case 'provider':
        return json({ error: 'sandbox_generation_failed', message: error.message }, 502);
      case 'unavailable':
        return json({ error: 'sandbox_unavailable', message: error.message }, 503);
      default:
        return json({ error: 'sandbox_failed', message: error.message }, 500);
    }
  }
  return json(
    { error: 'sandbox_failed', message: error instanceof Error ? error.message : 'sandbox failed' },
    500,
  );
}

/**
 * `POST /api/translate` — translate one delivered document for the bilingual sheet.
 *
 * This is a read-only convenience over bytes the delivery already carries: it writes no event and
 * has no actor semantics. A missing provider is `501`, malformed input `400`, a provider failure
 * `502`, so the document page can say which of those happened without guessing.
 */
async function translateRoute(request: Request, api: ApiRuntime): Promise<Response> {
  if (api.translate === undefined) {
    return json({ error: 'translation_unavailable', message: 'this runtime has no translation provider' }, 501);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_translation', message: 'body must be JSON' }, 400);
  }
  if (typeof body !== 'object' || body === null) {
    return json({ error: 'invalid_translation', message: 'body must be an object' }, 400);
  }
  const record = body as Record<string, unknown>;
  const text = typeof record['text'] === 'string' ? record['text'] : '';
  const target = record['target'];
  if (target !== 'en' && target !== 'zh') {
    return json({ error: 'invalid_translation', message: 'target must be en or zh' }, 400);
  }
  try {
    const translated = await api.translate({ text, target });
    return json({ text: translated });
  } catch (error) {
    if (error instanceof TranslationError && error.code === 'invalid') {
      return json({ error: 'invalid_translation', message: error.message }, 400);
    }
    if (error instanceof TranslationError && error.code === 'unavailable') {
      return json({ error: 'translation_unavailable', message: error.message }, 501);
    }
    return json({ error: 'translation_failed', message: error instanceof Error ? error.message : 'translation failed' }, 502);
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
function html(body: string, status = 200): Response { return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } }); }
