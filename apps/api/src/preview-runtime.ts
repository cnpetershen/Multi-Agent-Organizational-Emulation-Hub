/**
 * Preview Runtime: run a *delivered* artifact and hand back the URL it answers on.
 *
 * The delivery page can already show and download the files an AI company hands over, but files
 * are not a result — "does it actually run?" is the question the owner is really asking. This
 * module answers it without pretending: it copies the delivered bytes into a private working
 * directory, starts the project's own entry point as a child process on a free port, waits for
 * the URL to answer, and reports what happened.
 *
 * Design rules, in the order they matter:
 *
 * - **Nothing is faked.** No screenshot, no re-rendered template, no static copy of the
 *   expected page. The iframe the console shows points at a real server running the delivered
 *   code, which is why the delivered API (`/api/scores`) works inside the preview.
 * - **The artifact is data, not a dependency.** A preview never runs in the repository tree and
 *   never touches `deliverables/`: the files are materialized into `.maoeh/preview/<task>/` and
 *   the child process is `cwd`-ed there, so a delivered project cannot read or clobber the
 *   platform. Anything it writes (a SQLite file, a log) lands in that private copy, and the
 *   private copy carries a pid marker so a crash of this process leaves no silent orphan.
 * - **Isolated lifecycle.** One child process and one dynamic port per task; `stop` kills the
 *   whole process tree (a launcher may have started a grandchild); the port is discovered by
 *   binding `:0`, never by scanning or hardcoding.
 * - **Failure is a state, not an exception.** A server that exits, a port that never answers or
 *   an artifact with no web entry point all become an explicit `failed` status with a reason
 *   the console can show next to a retry button. Nothing here throws into the API route.
 * - **No product constants.** The *what* lives in `preview-plan.ts` and is read from the
 *   delivered files; this module only knows how to run a plan. There is no task id, project
 *   name, port or interpreter hardcoded for any particular delivery.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { planArtifact, type ArtifactFile, type LaunchPlan } from './preview-plan.js';

export type { ArtifactFile };

/* --- The wire contract the console reads ------------------------------------------ */

export type PreviewState = 'stopped' | 'starting' | 'running' | 'failed';

/**
 * The parts of a preview report that do not depend on how far the run got.
 *
 * A product is split across workflow steps, so `sources`/`skipped` travel with every report: the
 * owner is told exactly which delivered steps the preview runs, and which could not be read, so
 * a partial preview never passes for the whole product.
 */
interface PreviewStatusBase {
  readonly taskId: string;
  /** The project's own name (its README heading), or the task title as a fallback. */
  readonly projectName: string;
  /** Which delivered steps this preview runs, in workflow order. */
  readonly sources: readonly { readonly taskId: string; readonly title: string; readonly files: number }[];
  /** Product steps that could not be read, so a partial preview never looks complete. */
  readonly skipped: readonly { readonly taskId: string; readonly reason: string }[];
}

/**
 * What `GET /api/preview/:taskId` answers, and what the delivery page renders.
 *
 * A discriminated union on `state`, on purpose: `available: false` is a delivery that is *not* a
 * runnable web app and carries no run at all, while a run that failed carries the command that
 * failed and why. Modelling that as one flat shape invites the console to render a URL that does
 * not exist; modelling it this way makes the impossible states fail to compile instead.
 */
export type PreviewStatus =
  | (PreviewStatusBase & {
      /** `false`: nothing in this delivery can be started, so the console shows no preview. */
      readonly available: false;
      readonly state: 'stopped';
      readonly error: string | null;
      readonly runCommand: '';
      readonly plan: 'none';
      readonly previewUrl: null;
      readonly startedAt: null;
      readonly logs: readonly [];
      readonly note: null;
    })
  | (PreviewStatusBase & {
      readonly available: true;
      readonly state: 'stopped' | 'starting';
      readonly error: string | null;
      /** The real command, e.g. `python server/app.py` — shown to the owner as evidence. */
      readonly runCommand: string;
      readonly plan: PreviewPlanKind;
      readonly previewUrl: null;
      readonly startedAt: number | null;
      readonly logs: readonly string[];
      readonly note: string | null;
    })
  | (PreviewStatusBase & {
      readonly available: true;
      readonly state: 'running';
      readonly error: null;
      readonly runCommand: string;
      readonly plan: PreviewPlanKind;
      /** Absolute URL of the live preview — the iframe's `src`. */
      readonly previewUrl: string;
      readonly startedAt: number;
      readonly logs: readonly string[];
      readonly note: string | null;
    })
  | (PreviewStatusBase & {
      readonly available: true;
      readonly state: 'failed';
      /** Why it failed, in a sentence the owner can act on. Never `null` in this state. */
      readonly error: string;
      readonly runCommand: string;
      readonly plan: PreviewPlanKind;
      readonly previewUrl: null;
      readonly startedAt: null;
      readonly logs: readonly string[];
      readonly note: string | null;
    });

/** The launch shapes the console can see, plus `none` for a delivery there is nothing to run. */
export type PreviewPlanKind = LaunchPlan['plan'] | 'none';

/**
 * Which delivered artifacts a preview is started from.
 *
 * A workflow splits one product across its steps — the front end, the service and the wiring are
 * three different deliveries — so "run the artifact of task 7" is the wrong question: task 7's
 * slice alone is not a runnable project. The recipe is therefore resolved by the caller, which
 * is the only layer that knows the workflow, and it carries the whole tree plus where each part
 * came from.
 *
 * `files` is empty when nothing has been delivered yet; that is not an error, it is what an
 * in-flight workflow looks like.
 */
export interface PreviewRecipe {
  /** Every delivered file of the product, in delivery order, path-normalized by the planner. */
  readonly files: readonly ArtifactFile[];
  /** How to name the project: the workflow's own title when there is one, else the task title. */
  readonly title: string;
  /** Whether the task this preview belongs to was actually found. */
  readonly taskId: string | null;
  /**
   * The steps whose deliveries were merged in, for the transparency line the console shows
   * ("which parts of the product does this preview run?").
   */
  readonly sources: readonly { readonly taskId: string; readonly title: string; readonly files: number }[];
  /** Steps that belong to the product but whose delivery could not be read, with the reason. */
  readonly skipped: readonly { readonly taskId: string; readonly reason: string }[];
}

/** What the runner needs from the organization: the product one task is a delivery of. */
export interface PreviewTaskReader {
  /** `null` when the organization does not know this task. */
  getPreviewRecipe(taskId: string): Promise<PreviewRecipe | null>;
}

/** Raised for a task the organization does not know, so the route can answer 404. */
export class UnknownPreviewTaskError extends Error {
  constructor(readonly taskId: string) {
    super(`unknown task "${taskId}"`);
    this.name = 'UnknownPreviewTaskError';
  }
}

export class PreviewUnavailableError extends Error {
  constructor(
    readonly taskId: string,
    readonly reason: string | null,
  ) {
    super(reason ?? 'this delivery has no preview');
    this.name = 'PreviewUnavailableError';
  }
}

/* --- Options and internals -------------------------------------------------------- */

export interface PreviewRuntimeOptions {
  /** Root the private per-task working directories live under. */
  readonly workspaceRoot: string;
  /** How long to wait for the started project to answer on its URL. */
  readonly readyTimeoutMs?: number;
  /** How long an idle preview keeps running before it is reclaimed. */
  readonly idleTtlMs?: number;
  /** How often the reaper runs. */
  readonly reapIntervalMs?: number;
  /** Injectable for tests: `Date.now`. */
  readonly now?: () => number;
}

interface PreviewInstance {
  readonly taskId: string;
  readonly plan: LaunchPlan;
  readonly projectName: string;
  readonly workDir: string;
  readonly sources: readonly { readonly taskId: string; readonly title: string; readonly files: number }[];
  readonly skipped: readonly { readonly taskId: string; readonly reason: string }[];
  state: PreviewState;
  port: number | null;
  previewUrl: string | null;
  error: string | null;
  startedAt: number | null;
  lastUsedAt: number;
  child: ChildProcess | null;
  exitReason: string | null;
  logs: string[];
}

/** The MIME types the generated static server answers with, mirroring the delivered services. */
const STATIC_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.db': 'application/octet-stream',
});

const STATIC_SERVER_SCRIPT = 'server.mjs';
const PORT_BIND_SCRIPT = 'preview-bind.py';
const PID_MARKER = 'preview.pid';
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_REAP_INTERVAL_MS = 60_000;

/** How long to wait for a killed tree to actually disappear before giving up on it. */
const KILL_GRACE_MS = 3_000;

/**
 * A free port, discovered by binding `:0` and reading back what the OS chose.
 *
 * The listener is closed before the port is handed out, so there is a theoretical race with
 * anything else on the machine; it is the same approach every dev server uses, it never
 * collides with a preview of another task, and a lost race surfaces as an ordinary `failed`
 * preview instead of a silent wrong port.
 */
export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => (port > 0 ? resolvePort(port) : reject(new Error('the OS returned no free port'))));
    });
  });
}

/** Does `url` answer with a 2xx or 3xx within `timeoutMs`? */
async function answers(url: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { connection: 'close' },
    });
    await response.arrayBuffer();
    return response.status < 400;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/**
 * Which pid a working directory's marker names: the preview to reap, this process itself, or
 * nothing usable.
 *
 * The marker names the process that must be killed when the directory outlives the runtime that
 * started it — the *preview*, never the API. Getting that wrong is not a cosmetic bug: a marker
 * holding `process.pid` made `reapOrphans` run `taskkill /T /F` on the API server's own pid, so
 * signing in to another company (which builds a new `PreviewRuntime`) while any preview directory
 * existed killed the whole API. The console then saw nothing behind `/api` at all — the dev proxy
 * answered `500` with an empty body and the gate reported "the company list is unavailable" — and
 * the honest reading of "preview stopped" was lost too, because the marker never identified the
 * orphan it was supposed to.
 *
 * The `'self'` verdict is the second half of that guard: a marker this process wrote is a preview
 * this process still owns, so the reaper must not signal it and must not delete the directory.
 */
export function markedPid(marker: string, self: number = process.pid): number | 'self' | null {
  const pid = Number(marker.trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid === self ? 'self' : pid;
}

/**
 * Kill a process **and its children**, reporting whether the signal was delivered.
 *
 * A delivered launcher starts the real service as a grandchild, so signalling only the pid we
 * spawned would leave a server holding a port forever. Two mechanisms are tried because neither
 * is available everywhere:
 *
 * 1. `process.kill(pid, 'SIGTERM')` — the primitive that always works, on the process itself. On
 *    POSIX the negative pid signals the whole group (the child is spawned in its own group for
 *    exactly this reason).
 * 2. `taskkill /T /F` on Windows — the only way to reach *grandchildren*, because a Windows
 *    process has no group signal. It can legitimately be denied (a confined session, a service
 *    account, a hardened host), which is why its exit status is checked instead of ignored: a
 *    denied tree kill must fall through to the primitive rather than be mistaken for a success.
 *
 * The return value is "something was told to stop", not "it is gone"; callers that need the
 * stronger guarantee verify it (see `waitForSilence`).
 */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  let signalled = false;
  if (platform === 'win32') {
    try {
      const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: KILL_GRACE_MS,
        windowsHide: true,
      });
      // `status === 0` only when the tree was actually killed; `error` is set when the tool is
      // missing. Anything else (notably 1 = access denied) means the tree is still standing.
      signalled = result.status === 0 && result.error === undefined;
    } catch {
      signalled = false;
    }
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
      signalled = true;
    } catch {
      /* no group of our own — fall through to the process itself */
    }
  }
  if (signalled) return true;
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    // ESRCH: the process is already gone, which is the outcome we wanted.
    return false;
  }
}

/**
 * Wait until nothing answers on a port any more, up to `timeoutMs`.
 *
 * "The process was signalled" and "the port is free" are different facts, and only the second one
 * matters to a person looking at the console: reporting `stopped` over a page that still loads is
 * the one thing this runtime must never do. Polling the URL is how the stop is *verified* rather
 * than assumed, and it is the same signal readiness uses.
 */
async function waitForSilence(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await answers(url, 1_000))) return true;
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}

/**
 * The Preview Runtime: one instance per API process, keyed by task.
 *
 * It is deliberately *not* an event-sourced subsystem and does not touch the organization, the
 * task system or the artifact store: a preview is an operational convenience over bytes the
 * delivery already carries, so it keeps its own state and can be thrown away on restart.
 */
export class PreviewRuntime {
  private readonly instances = new Map<string, PreviewInstance>();
  private readonly inFlight = new Map<string, Promise<PreviewStatus>>();
  private readonly readyTimeoutMs: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private readonly reaper: NodeJS.Timeout | null;
  private disposed = false;

  constructor(
    private readonly reader: PreviewTaskReader,
    private readonly options: PreviewRuntimeOptions,
  ) {
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.reapOrphans();
    const interval = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
    this.reaper = interval > 0 ? setInterval(() => this.reapIdle(), interval) : null;
    this.reaper?.unref();
  }

  /**
   * The preview of one task: what it is, and where it stands.
   *
   * `available` is recomputed from the delivered files rather than cached across calls, because
   * a workflow can still be delivering when the page is first opened — an artifact that gains
   * its entry point a moment later becomes previewable without restarting anything.
   */
  async status(taskId: string): Promise<PreviewStatus> {
    const id = taskId.trim();
    if (id === '') throw new UnknownPreviewTaskError(taskId);
    const instance = this.instances.get(id);
    if (instance !== undefined) {
      instance.lastUsedAt = this.now();
      // A child that died on its own (a crash, a port stolen by another process) must show as
      // failed on the next read instead of reporting `running` over a URL nobody answers — and
      // the same is true while a start is still in flight, where it is the one way a caller can
      // see that the attempt already lost.
      if ((instance.state === 'running' || instance.state === 'starting') && instance.exitReason !== null) {
        this.fail(instance, instance.exitReason);
      }
      return this.toStatus(instance);
    }
    return this.describe(id);
  }

  /**
   * Start the delivered project, or report why it cannot be started.
   *
   * Concurrent calls for the same task share one attempt: the console may read the status while
   * the user presses the button, and two child processes on two ports for one task would be a
   * leak, not a feature.
   */
  async start(taskId: string): Promise<PreviewStatus> {
    const id = taskId.trim();
    if (id === '') throw new UnknownPreviewTaskError(taskId);
    const running = this.instances.get(id);
    if (running !== undefined && (running.state === 'running' || running.state === 'starting')) {
      running.lastUsedAt = this.now();
      return this.toStatus(running);
    }
    const existing = this.inFlight.get(id);
    if (existing !== undefined) return existing;
    const attempt = this.startUnshared(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, attempt);
    return attempt;
  }

  /**
   * Stop the preview of one task and free its port. Idempotent.
   *
   * The answer is built from the same recipe the run was started from, not by re-planning: the
   * stop must report the state of *that* run, and a fresh plan would have no way to say "the
   * server you asked me to stop is still answering".
   */
  async stop(taskId: string): Promise<PreviewStatus> {
    const id = taskId.trim();
    if (id === '') throw new UnknownPreviewTaskError(taskId);
    const instance = this.instances.get(id);
    if (instance === undefined) {
      // Stopping something that was never started is a no-op, but the answer still has to be a
      // real description of the delivery so the console can render a consistent panel.
      return this.describe(id);
    }
    const stopped = await this.teardown(instance);
    this.instances.delete(id);
    // Only reclaim the files once the process is really gone: a server that survived the kill is
    // still reading them, and deleting a running project's directory would be worse than leaving
    // it for the orphan reaper.
    if (stopped) this.clearWorkDir(instance);
    return this.toStatus(instance);
  }

  /** Stop every preview and stop reaping — called when the API server closes. */
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reaper !== null) clearInterval(this.reaper);
    const instances = [...this.instances.values()];
    this.instances.clear();
    await Promise.all(instances.map(async (instance) => {
      if (await this.teardown(instance)) this.clearWorkDir(instance);
    }));
  }

  /** Reclaim previews nobody has read for a while, so a long session cannot pile up servers. */
  private reapIdle(): void {
    if (this.disposed) return;
    const cutoff = this.now() - this.idleTtlMs;
    for (const instance of [...this.instances.values()]) {
      if (instance.lastUsedAt > cutoff) continue;
      void (async () => {
        if (await this.teardown(instance)) {
          this.instances.delete(instance.taskId);
          this.clearWorkDir(instance);
        }
      })();
    }
  }

  /**
   * Remove working directories left behind by a previous API process.
   *
   * The preview state itself is intentionally in-memory (a preview is disposable), but the
   * copied files and the pid marker are on disk — a crash must not leave either a growing
   * directory or a server nobody owns. A marker whose pid is still alive gets killed; then the
   * directory goes, because no instance in this process refers to it.
   *
   * A marker naming *this* process is the one case that must be left alone in both halves: the
   * pid is not an orphan, and killing it would take the API down with the preview. See
   * `markedPid` for the incident that rule exists for.
   */
  private reapOrphans(): void {
    const root = this.previewRoot();
    // No directory is the normal first-run case, not a failure to report.
    const entries = ((): readonly string[] => {
      try {
        return readdirSync(root);
      } catch {
        return [];
      }
    })();
    for (const entry of entries) {
      const dir = join(root, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const marker = join(dir, PID_MARKER);
      if (existsSync(marker)) {
        const marked = markedPid(readFileSync(marker, 'utf8'));
        // `'self'` means this directory belongs to a preview *this* process owns; it is not an
        // orphan, so neither it nor the server running out of it may be touched.
        if (marked === 'self') continue;
        if (marked !== null) killTree(marked);
      }
      this.removeDir(dir, root);
    }
  }

  private previewRoot(): string {
    return resolve(this.options.workspaceRoot, '.maoeh', 'preview');
  }

  /** Whether a path is inside `root` — the last guard before a delete. */
  private inside(path: string, root: string): boolean {
    const child = resolve(path);
    return child !== root && child.startsWith(root.endsWith('\\') || root.endsWith('/') ? root : `${root}${process.platform === 'win32' ? '\\' : '/'}`);
  }

  private removeDir(dir: string, root: string): void {
    if (!this.inside(dir, root)) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a file held open by a dying child is not worth failing a request over */
    }
  }

  private clearWorkDir(instance: PreviewInstance): void {
    this.removeDir(instance.workDir, this.previewRoot());
  }

  private toStatus(instance: PreviewInstance): PreviewStatus {
    const base = {
      available: true,
      taskId: instance.taskId,
      projectName: instance.projectName,
      runCommand: this.commandLine(instance.plan),
      plan: instance.plan.plan,
      logs: [...instance.logs],
      note: 'The preview runs as a detached child process, so its output is not captured here.',
      sources: instance.sources,
      skipped: instance.skipped,
    } as const;
    if (instance.state === 'running' && instance.previewUrl !== null && instance.startedAt !== null) {
      return { ...base, state: 'running', error: null, previewUrl: instance.previewUrl, startedAt: instance.startedAt };
    }
    if (instance.state === 'failed') {
      return {
        ...base,
        state: 'failed',
        error: instance.error ?? 'the preview stopped for an unknown reason',
        previewUrl: null,
        startedAt: null,
      };
    }
    return { ...base, state: 'stopped', error: null, previewUrl: null, startedAt: null };
  }

  /**
   * The preview's server died after it was known to be up.
   *
   * Reported as `failed` on the next read rather than silently rewinding to `stopped`: the owner
   * pressed 启动 and watched it come up, so "it stopped working" is the truthful state — and the
   * panel keeps the reason so the retry button has something to explain.
   *
   * This only *describes* the death. The child handle stays where it is so the owner of the
   * attempt (the start that is awaiting readiness, or `stop`) performs the actual teardown; a
   * status read must never be the thing that races a kill against a starting process.
   */
  private fail(instance: PreviewInstance, reason: string): void {
    instance.state = 'failed';
    instance.error = reason;
    instance.previewUrl = null;
  }

  /** The command as a person reads it: the interpreter plus the artifact's own path. */
  private commandLine(plan: LaunchPlan): string {
    switch (plan.plan) {
      case 'python-server':
      case 'launcher':
        return `${extensionWord(plan.entryPath)} ${plan.entryPath}`;
      case 'node-server':
        return `node ${plan.entryPath}`;
      default:
        return `serve ${plan.entryPath}`;
    }
  }

  /**
   * Describe a task with no live instance: either it has no previewable artifact, or it has one
   * that is currently stopped.
   */
  private async describe(taskId: string): Promise<PreviewStatus> {
    const recipe = await this.reader.getPreviewRecipe(taskId);
    if (recipe === null) throw new UnknownPreviewTaskError(taskId);
    const analysis = planArtifact(recipe.files, recipe.title);
    if (analysis.plan === null) {
      return {
        available: false,
        state: 'stopped',
        taskId,
        projectName: analysis.projectName,
        runCommand: '',
        plan: 'none',
        previewUrl: null,
        error: analysis.reason,
        startedAt: null,
        logs: [],
        note: null,
        sources: recipe.sources,
        skipped: recipe.skipped,
      };
    }
    return {
      available: true,
      state: 'stopped',
      taskId,
      projectName: analysis.projectName,
      runCommand: this.commandLine(analysis.plan),
      plan: analysis.plan.plan,
      previewUrl: null,
      error: null,
      startedAt: null,
      logs: [],
      note: null,
      sources: recipe.sources,
      skipped: recipe.skipped,
    };
  }
  private async startUnshared(taskId: string): Promise<PreviewStatus> {
    const recipe = await this.reader.getPreviewRecipe(taskId);
    if (recipe === null) throw new UnknownPreviewTaskError(taskId);
    const analysis = planArtifact(recipe.files, recipe.title);
    if (analysis.plan === null) {
      throw new PreviewUnavailableError(taskId, analysis.reason);
    }
    const plan = analysis.plan;

    const workDir = join(this.previewRoot(), safeSegment(taskId));
    const instance: PreviewInstance = {
      taskId,
      plan,
      projectName: analysis.projectName,
      workDir,
      sources: recipe.sources,
      skipped: recipe.skipped,
      state: 'starting',
      port: null,
      previewUrl: null,
      error: null,
      startedAt: null,
      lastUsedAt: this.now(),
      child: null,
      exitReason: null,
      logs: [],
    };

    try {
      this.materialize(workDir, recipe.files);
      const port = await this.resolvePort(plan);
      instance.port = port;
      instance.previewUrl = `http://127.0.0.1:${String(port)}/`;
      this.spawnPreview(instance, port);
      instance.startedAt = this.now();
      // Registered while still `starting`, so a console that polls the status can actually show
      // the intermediate state: an instance published only once it is ready would make
      // `starting` unreachable, and the page would jump from "Start" straight to "Running".
      this.instances.set(taskId, instance);
      await this.awaitReady(instance);
      instance.state = 'running';
      return this.toStatus(instance);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.instances.delete(taskId);
      instance.state = 'failed';
      instance.error = reason;
      // Keep the directory when the child outlived the kill: it is still running out of it.
      if (await this.teardown(instance)) this.clearWorkDir(instance);
      // A failed preview is not stored: the next `start` is a genuine retry, and a retry needs
      // a fresh directory and a fresh port rather than the wreckage of the previous attempt.
      return {
        available: true,
        state: 'failed',
        taskId,
        projectName: analysis.projectName,
        runCommand: this.commandLine(plan),
        plan: plan.plan,
        previewUrl: null,
        error: reason,
        startedAt: null,
        logs: [...instance.logs],
        note: null,
        sources: recipe.sources,
        skipped: recipe.skipped,
      };
    }
  }

  /**
   * Which port this run gets, and whether the artifact can be told about it.
   *
   * `env` plans get a fresh free port injected through the environment, so two previews never
   * share one. A plan whose port is fixed in the code keeps that port — the honest consequence
   * is that a second simultaneous preview of the same fixed-port project collides, which the
   * readiness wait reports as a failed preview rather than as a wrong page.
   */
  private async resolvePort(plan: LaunchPlan): Promise<number> {
    if (plan.fixedPort !== null) return plan.fixedPort;
    return freePort();
  }

  /**
   * Write the delivered tree into the private working directory.
   *
   * Every path is re-checked here even though the planner already normalized it: this is the
   * function that turns untrusted strings into files on disk, so the guard belongs where the
   * write happens. Empty content is skipped — a delivery that names a file it never carried
   * must not create a zero-byte file that looks like part of the project.
   *
   * The pid marker is deliberately *not* written here: at this point no preview process exists
   * yet, and the only pid this function could name is the API's own. `spawnPreview` writes it
   * once the real child is running (see `markedPid`).
   */
  private materialize(workDir: string, files: readonly ArtifactFile[]): void {
    const root = resolve(workDir);
    mkdirSync(root, { recursive: true });
    for (const file of files) {
      const relative = file.path.trim().replace(/\\/g, '/').replace(/^\/+/, '');
      if (relative === '' || relative.includes('\0')) continue;
      const segments = relative.split('/').filter((segment) => segment !== '' && segment !== '.');
      if (segments.length === 0 || segments.includes('..')) continue;
      const target = resolve(root, join(...segments));
      if (target !== root && !target.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) continue;
      if (file.content === '') continue;
      mkdirSync(resolve(target, '..'), { recursive: true });
      writeFileSync(target, file.content, 'utf8');
    }
  }

  /** Start the plan's entry point in the private directory, as a detached child. */
  private spawnPreview(instance: PreviewInstance, port: number): void {
    const root = instance.workDir;
    const plan = instance.plan;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      // The static plan's generated server resolves its document root from this.
      PREVIEW_ROOT: root,
      // A generated service that records plays keeps its database inside the private copy, so a
      // preview can never write into the repository's own delivery. This is a *convention* the
      // delivered Python service declares (it reads `SCORES_DB`), not a knowledge of any
      // particular product: a delivery that ignores the variable simply keeps its own default,
      // still inside this directory because that is the working directory it runs in.
      SCORES_DB: join(root, 'data', 'scores.db'),
    };

    const started = ((): { command: string; args: readonly string[] } => {
      if (plan.plan === 'python-server' || plan.plan === 'launcher') {
        // The entry point that actually listens is the delivered service when there is one, else
        // the launcher itself (which may start a service or serve the client — its own decision).
        const target = plan.entryPath;
        const bind = plan.portMode === 'env' ? null : this.writePortBindHelper(root, target);
        return { command: pythonExecutable(), args: bind === null ? [target] : [bind] };
      }
      if (plan.plan === 'node-server') {
        return { command: process.execPath, args: [plan.entryPath] };
      }
      return { command: process.execPath, args: [this.writeStaticServer(root), plan.entryPath] };
    })();

    const child = spawn(started.command, [...started.args], {
      cwd: root,
      env,
      // Detached stdio on purpose: it keeps the preview fully independent of this process's
      // pipes (and this host's sandbox), and a preview's console output is not what the owner
      // reads — the page itself is.
      stdio: 'ignore',
      windowsHide: true,
      detached: false,
    });
    instance.child = child;
    // The marker names *this* preview, so a later runtime (a restart, or the next company switch)
    // can kill a server whose owner is gone. It must be the child's pid — the API's own pid here
    // is what made the orphan reaper terminate the API itself.
    if (child.pid !== undefined && Number.isInteger(child.pid) && child.pid > 0) {
      try {
        writeFileSync(join(root, PID_MARKER), String(child.pid), 'utf8');
      } catch {
        // A marker that cannot be written costs the *next* process the ability to reap this
        // preview; it must never cost this one the ability to start it.
      }
    }
    child.on('error', (error) => {
      instance.exitReason = `the preview process could not be started: ${error.message}`;
    });
    child.on('exit', (code, signal) => {
      if (instance.exitReason === null && instance.state !== 'stopped') {
        instance.exitReason = signal === null
          ? `the delivered project exited on its own with code ${String(code ?? 'unknown')}`
          : `the delivered project was terminated (${signal})`;
      }
    });
  }

  /**
   * A tiny Python shim that starts the delivered entry point **and applies the port this
   * runtime chose**.
   *
   * Needed only for a plan that does not read `PORT` itself: such a script would bind its own
   * default port (commonly 8000), and the preview would then wait on the wrong port and report
   * a failure that is not the artifact's fault. The shim forces the two module-level names the
   * standard-library shape uses, then runs the entry point exactly as the artifact intends.
   */
  private writePortBindHelper(root: string, entryPath: string): string {
    const target = join(root, PORT_BIND_SCRIPT);
    const source = [
      '# Generated by the MAOEH Preview Runtime: run the delivered entry point on this preview port.',
      'import os',
      'import runpy',
      '',
      'PORT = int(os.environ.get("PORT", "0") or 0)',
      'HOST = os.environ.get("HOST", "127.0.0.1")',
      '',
      `runpy.run_path(${JSON.stringify(entryPath)}, run_name="__main__")`,
      '',
    ].join('\n');
    writeFileSync(target, source, 'utf8');
    return target;
  }

  /**
   * The static server for plans that have no service: a dependency-free Node module that serves
   * the delivered directory over HTTP on the injected port, with traversal rejected.
   */
  private writeStaticServer(root: string): string {
    const target = join(root, STATIC_SERVER_SCRIPT);
    const types = JSON.stringify(STATIC_TYPES, null, 2);
    const source = `
// Generated by the MAOEH Preview Runtime: serves the delivered files on the injected port.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.env.PREVIEW_ROOT ?? process.cwd());
const PORT = Number(process.env.PORT ?? 8000);
const HOST = process.env.HOST ?? '127.0.0.1';
// The delivered page's own path, handed over by the runtime as argv[2]. The plan calls this "a
// single page under any name", and a delivery's page commonly lives in a subdirectory
// (\`client/index.html\`), so \`/\` must resolve to *that* page rather than to a root \`index.html\`
// that may not exist — which is what made every such preview time out as "never answered".
const ENTRY = (process.argv[2] ?? 'index.html').replace(/^[/\\\\]+/, '');
const TYPES = ${types};

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://' + HOST + ':' + PORT);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/' + ENTRY;
    else if (pathname.endsWith('/')) pathname += 'index.html';
    const relative = normalize(pathname).replace(/^([/\\\\])+/, '');
    const target = join(ROOT, relative);
    if (!target.startsWith(ROOT)) {
      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end('forbidden');
      return;
    }
    try {
      const body = await readFile(target);
      response.writeHead(200, {
        'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
    }
  })().catch(() => {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('failed');
  });
});

server.listen(PORT, HOST, () => {
  console.log('preview static server on http://' + HOST + ':' + PORT + '/');
});
`;
    writeFileSync(target, source, 'utf8');
    return target;
  }

  /**
   * Wait until the started project answers, or fail with the reason it never did.
   *
   * Polling the URL is the only readiness signal that does not require the artifact to
   * cooperate with a protocol of ours, and it is what makes the preview honest: `running` means
   * "a request to this URL just succeeded", not "a process was spawned".
   */
  private async awaitReady(instance: PreviewInstance): Promise<void> {
    const url = `${instance.previewUrl ?? ''}${instance.plan.readinessPath.replace(/^\//, '')}`;
    const deadline = this.now() + this.readyTimeoutMs;
    for (;;) {
      if (instance.exitReason !== null) throw new Error(instance.exitReason);
      if (instance.child !== null && instance.child.exitCode !== null) {
        throw new Error(`the delivered project exited on its own with code ${String(instance.child.exitCode)}`);
      }
      if (await answers(url)) return;
      if (this.now() > deadline) {
        throw new Error(
          `the delivered project did not answer on ${instance.previewUrl ?? ''} within ${String(Math.round(this.readyTimeoutMs / 1000))}s`,
        );
      }
      await sleep(250);
    }
  }

  /**
   * Stop a child and **verify** its port is free, so `stopped` is a fact rather than a claim.
   *
   * Returns `true` only when the URL stopped answering. A child that survives the kill (a denied
   * tree kill, a service that ignores a signal) leaves the instance in `failed` with the reason,
   * because reporting a stopped preview over a page that still loads is exactly the lie this
   * whole module is built to avoid. The working directory is then kept: the process is still
   * running out of it, and deleting its files underneath it would be worse than leaving them.
   */
  private async teardown(instance: PreviewInstance): Promise<boolean> {
    // Remembered before the state is cleared: a run that already failed keeps its own reason,
    // which is more useful than "it would not stop".
    const wasFailed = instance.state === 'failed';
    instance.state = 'stopped';
    const child = instance.child;
    instance.child = null;
    const pid = child?.pid;
    const url = instance.previewUrl;
    if (pid === undefined || pid <= 0) return true;

    const gone = new Promise<void>((done) => {
      const timer = setTimeout(done, KILL_GRACE_MS);
      child?.once('exit', () => {
        clearTimeout(timer);
        done();
      });
    });
    killTree(pid);
    await gone;

    // The process handle saying "exited" is not proof the port was released: a grandchild may
    // still be serving. The URL is the only witness that counts.
    if (url === null || (await waitForSilence(url, KILL_GRACE_MS))) return true;
    if (!wasFailed) {
      instance.state = 'failed';
      instance.error = 'the preview could not be stopped: its server is still answering after the kill signal';
    }
    instance.previewUrl = null;
    return false;
  }

  /** A task id that is safe to use as one directory name, without losing its identity. */
}

function safeSegment(taskId: string): string {
  const cleaned = taskId.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 64);
  if (cleaned === '') return 'task';
  return cleaned;
}

/** `python` for a `.py` entry point (`run.py` → `python run.py`), `node` for a `.mjs` one. */
function extensionWord(entryPath: string): string {
  const extension = entryPath.slice(entryPath.lastIndexOf('.')).toLowerCase();
  if (extension === '.mjs' || extension === '.cjs' || extension === '.js') return 'node';
  if (extension === '.sh') return 'sh';
  return 'python';
}

/**
 * The Python interpreter a preview should use: this Python if this process is Python (never
 * here), else the one this host provides. `python3` is preferred on POSIX and `python` on
 * Windows, because that is the name the delivered READMEs themselves use.
 */
export function pythonExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'python' : 'python3';
}
