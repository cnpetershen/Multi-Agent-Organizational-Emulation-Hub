/**
 * Preview planning: *what* a delivered artifact is, and *how* to start it.
 *
 * The Preview Runtime cannot start "the project" in the abstract — an artifact is a bag of
 * files, and only its contents say whether it is a runnable web app, what the entry point is,
 * and whether that entry point can be moved off its default port. This module answers exactly
 * that, and deliberately answers nothing else: it is pure (no filesystem, no child processes,
 * no clock), so the decision can be unit-tested on the real delivered bytes and cannot drift
 * into "start whatever is there and hope".
 *
 * Two rules the whole module obeys:
 *
 * - **No constants about any particular product.** Nothing here knows the word "tetris", a task
 *   id, or a project name. Every decision is read from the delivered files, so the next product
 *   the organization ships is served by the same code.
 * - **Verified, not guessed.** A file only biases the launch plan when its *content* shows the
 *   thing that makes it launchable (a `serve_forever`, an HTTP server, a listening socket). A
 *   delivery whose files merely resemble a web app is reported as `available: false` instead of
 *   being started as something it is not — a preview that hangs forever is worse than no preview.
 */

/** One delivered file, with the bytes it was handed over as (`result.data.files[]`). */
export interface ArtifactFile {
  readonly path: string;
  readonly language: string;
  readonly content: string;
}

/**
 * How the entry point learns which port to listen on.
 *
 * - `env`: the code reads the port from the environment (`os.environ["PORT"]`,
 *   `process.env.PORT`), so a free port can be injected and two previews never collide.
 * - `probe`: the port is fixed in the code. The plan records the port it found so readiness can
 *   be probed on it, and the run is marked as non-portable — two previews of the same project
 *   would fight over it.
 * - `default`: nothing states a port, so the server's own default is used and the plan probes
 *   the per-runtime default.
 */
export type PortMode = 'env' | 'probe' | 'default';

/** One way to start the artifact, chosen from what the delivered files actually contain. */
export interface LaunchPlan {
  readonly plan: 'python-server' | 'node-server' | 'launcher' | 'static' | 'html';
  /** The delivered file that gets started (or, for `static`/`html`, the one that gets served). */
  readonly entryPath: string;
  /**
   * The command **inside** the artifact, with no interpreter decision: `server/app.py`.
   * The runtime owns which executable runs it; the console shows this as the run command.
   */
  readonly entryCommand: string;
  readonly portMode: PortMode;
  /** The fixed port `portMode === 'probe'` probes, else `null`. */
  readonly fixedPort: number | null;
  /** Readiness path: the service's own health endpoint when it declares one, else `/`. */
  readonly readinessPath: string;
  /** A runnable launcher was delivered and can be used when the entry point is not portable. */
  readonly launcherPath: string | null;
}

export interface ArtifactPlan {
  /** `null` when the delivery is not a runnable web app — the console then shows no preview. */
  readonly plan: LaunchPlan | null;
  /** Why there is no plan, for the runtime's own logs and for a test's benefit. */
  readonly reason: string | null;
  /**
   * What to call the running project on screen. Read from the delivery itself (its own README
   * heading), never from a hardcoded table, and never blank: an unnamed artifact falls back to
   * the task title the caller passes in.
   */
  readonly projectName: string;
}

/** Just enough of a file to plan against — `ArtifactFile` satisfies it. */
export interface PlannedFile {
  readonly path: string;
  readonly content: string;
}

/* --- Recovering files from a delivery's `result.data` ----------------------------- */

/**
 * The file extensions a delivery may expose as a *data key* rather than inside `files[]`.
 *
 * Some executors hand back `{ "index.html": "<!doctype html>…", playable: true }` instead of the
 * richer `{ files: [{ path, content }] }` shape — both are valid deliveries, but only the second
 * one is visible to a planner that reads `files` alone. A standalone game delivered as a single
 * `index.html` key is exactly the case this list exists for.
 */
const DELIVERY_EXTENSIONS = new Set([
  '.html', '.htm', '.md', '.markdown', '.txt', '.rst', '.css', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.json', '.py', '.sh', '.svg', '.yml', '.yaml', '.sql',
]);

/** A data key shaped like an artifact-relative file path (`index.html`, `client/app.js`). */
const FILE_SHAPED_KEY = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9]+$/;

/** The coarse language tag the console and the planner use for a delivered path. */
export function languageOfPath(path: string): string {
  switch (extensionOf(path)) {
    case '.html':
    case '.htm':
      return 'html';
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.py':
      return 'python';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.css':
      return 'css';
    case '.json':
      return 'json';
    case '.sql':
      return 'sql';
    case '.yml':
    case '.yaml':
      return 'yaml';
    case '.svg':
      return 'svg';
    default:
      return 'text';
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function looksLikeHtml(content: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(content);
}

/**
 * Every file a delivery carries, including the ones a delivery exposed as data keys.
 *
 * Three shapes are read, in this order, so the richest record wins and a duplicate path is never
 * counted twice:
 *
 * 1. `data.files[]` — the canonical `{ path, language, content }` list.
 * 2. A data key that *is* a path (`"index.html": "<!doctype html>…"`). This is how a live model
 *    that was asked for a single-file page often answers, and without it a real, playable game
 *    reports "the delivery carries no files".
 * 3. `data.entrypoint` + `data.content` — the older single-file contract; a bare HTML `content`
 *    with no entrypoint is named `index.html` so it can still be served.
 *
 * Paths are normalized and an escaping path (`../x`, an absolute path) is dropped here, before it
 * can ever reach the preview runtime's working directory.
 */
export function deliveryFilesFromData(data: unknown): readonly ArtifactFile[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return [];
  const row = data as Readonly<Record<string, unknown>>;
  const files = new Map<string, ArtifactFile>();
  const add = (rawPath: string, content: string, language?: string): void => {
    if (content === '') return;
    const path = normalizePath(rawPath);
    if (path === null || files.has(path)) return;
    files.set(path, Object.freeze({ path, language: language === undefined || language === '' ? languageOfPath(path) : language, content }));
  };

  const listed = row['files'];
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const file = entry as Readonly<Record<string, unknown>>;
      add(textOf(file['path']), textOf(file['content']), textOf(file['language']));
    }
  }

  for (const [key, value] of Object.entries(row)) {
    if (key === 'files' || typeof value !== 'string' || value === '') continue;
    if (!FILE_SHAPED_KEY.test(key)) continue;
    if (!DELIVERY_EXTENSIONS.has(extensionOf(key))) continue;
    add(key, value);
  }

  const entrypoint = textOf(row['entrypoint']).trim();
  const content = textOf(row['content']);
  if (entrypoint !== '' && content !== '') add(entrypoint, content);
  if (entrypoint === '' && content !== '' && looksLikeHtml(content)) add('index.html', content);

  return Object.freeze([...files.values()]);
}

/* --- Path handling --------------------------------------------------------------- */

/**
 * A delivered path as an artifact-relative POSIX path, or `null` when it cannot be one.
 *
 * Delivered paths are data, so they are treated as hostile: an absolute path, a `..` segment or
 * a Windows drive letter would escape the copied project directory, and a NUL byte is never a
 * path. Anything rejected here is simply not part of the plan.
 */
export function normalizePath(path: string): string | null {
  const trimmed = path.trim().replace(/\\/g, '/');
  if (trimmed === '' || trimmed.includes('\0')) return null;
  if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('/')) return null;
  const segments: string[] = [];
  for (const segment of trimmed.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join('/');
}

/** The basename of a delivered path (`server/app.py` → `app.py`). */
export function baseName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

/** The lower-cased extension of a delivered path, with the dot (`app.py` → `.py`). */
export function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

/* --- Content evidence ------------------------------------------------------------ */

/** The head of a file, so a huge delivered asset does not cost a full regex scan. */
const SCAN_LIMIT = 200_000;

function scan(content: string): string {
  return content.length > SCAN_LIMIT ? content.slice(0, SCAN_LIMIT) : content;
}

/**
 * Does this Python file start an HTTP server?
 *
 * `http.server` plus one of `serve_forever` / `BaseHTTPRequestHandler` is the standard-library
 * shape the platform's own deliveries use, and `WSGIServer`/`Flask`/`FastAPI` cover the rest.
 * A file that only binds a socket is *not* enough on its own — plenty of ordinary scripts open
 * one — so it must also look like a server that keeps running.
 */
export function looksLikePythonHttpServer(content: string): boolean {
  const text = scan(content);
  const keepsRunning = /serve_forever|BaseHTTPRequestHandler|HTTPServer|WSGIServer|uvicorn\.run|app\.run\(|werkzeug/i.test(text);
  if (!keepsRunning) return false;
  return /http\.server|http\.server\.|socketserver|flask|fastapi|django|aiohttp|bottle|tornado|starlette/i.test(text)
    || /\bimport\s+socket\b/.test(text);
}

/** Does this JavaScript/TypeScript file start an HTTP server? */
export function looksLikeNodeHttpServer(content: string): boolean {
  const text = scan(content);
  if (!/\.listen\s*\(/.test(text)) return false;
  return /node:http|node:https|require\(['"]http['"]\)|express|fastify|koa|hapi|polka|sirv|serve-handler|createServer\s*\(/i.test(text);
}

/**
 * Does the file read its port from the environment? This is what makes a preview *portable*:
 * without it the server would take its default port, so two artifacts in one process collide.
 */
export function readsPortFromEnv(content: string, kind: 'python' | 'node'): boolean {
  const text = scan(content);
  if (kind === 'python') {
    return /os\.environ(?:\.get)?\s*[([\]]*\s*['"]PORT['"]/i.test(text)
      || /getenv\s*\(\s*['"]PORT['"]/i.test(text);
  }
  return /process\.env(?:\.PORT|\[\s*['"]PORT['"]\s*\])/.test(text);
}

/** A port literal standing where a server socket is bound, never an arbitrary number. */
const PYTHON_BIND_PATTERNS: readonly RegExp[] = Object.freeze([
  // `PORT = 8000`, `self.port: int = 8000`
  /\bPORT\s*[:=][^=\n]*?(\d{2,5})\b/gi,
  // an address tuple: `("127.0.0.1", 8000)`, `("", 8080)`, `(HOST, port)` has no literal to find
  /\(\s*(?:['"][^'"]*['"]|[A-Za-z_][\w.]*)\s*,\s*(\d{2,5})\s*\)/g,
  // an explicit bind: `sock.bind(("127.0.0.1", 8000))`, `.bind((HOST, 8000))`
  /\.bind\s*\(\s*\(\s*[^()]*?,\s*(\d{2,5})\s*\)/g,
]);

const NODE_BIND_PATTERNS: readonly RegExp[] = Object.freeze([
  // `server.listen(3000)`, `.listen({ port: 3000 })`, `.listen(3000, '0.0.0.0')`
  /\.listen\s*\(\s*(?:\{[^}]*?port\s*:\s*)?(\d{2,5})\b/g,
  // `const PORT = 3000;` then `listen(PORT)`
  /\bPORT\s*[:=][^=\n]*?(\d{2,5})\b/gi,
]);

/**
 * The first literal port a file listens on, or `null` — used when the port is not injectable.
 *
 * Only a number standing where a socket is *bound* counts. Matching any plausible integer would
 * turn an unrelated constant into "the port this service uses", and the preview would then wait
 * on a port nothing listens to and report a failure that is not the artifact's fault.
 */
export function fixedPortOf(content: string, kind: 'python' | 'node'): number | null {
  const text = scan(content);
  const patterns = kind === 'python' ? PYTHON_BIND_PATTERNS : NODE_BIND_PATTERNS;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isInteger(value) && value > 0 && value < 65_536) return value;
    }
  }
  return null;
}

/**
 * The readiness path the service itself declares.
 *
 * A health endpoint is the only readiness signal that means "the service is up", rather than
 * "somebody is listening": a static file server answers `/` before its application is ready,
 * and a service that exposes `/api/health` should be polled there. When the delivery declares
 * none, `/` is the honest default.
 *
 * The path is matched after a non-path character (a quote in `"/api/health"`, whitespace in a
 * docstring's `GET  /api/health`, a paren in `... ("/api/health")`), because a path-shaped
 * *suffix* of a longer route is not an endpoint: `/api/healthcheck` must not be probed at
 * `/api/health`.
 */
export function readinessPathOf(content: string): string {
  const match = /(?:^|[^A-Za-z0-9/_-])(\/(?:api\/)?(?:health|healthz|status|ready|ping))(?![A-Za-z0-9_-])/im.exec(scan(content));
  return match?.[1] ?? '/';
}

/* --- Project naming -------------------------------------------------------------- */

/**
 * The goal wrapper the workflow engine writes for a generated step, re-declared here so this
 * module stays free of the delivery layer's imports:
 *
 *     Complete step "<step>" of workflow "<product>": <the product's own goal>
 *
 * A preview is opened from one step but runs the whole product, so the *product's* name is the
 * honest heading — reading it back out of the wrapper is what avoids showing "Implementation"
 * over a running tetris game.
 */
const STEP_GOAL_PATTERN = /^Complete step "[^"]*" of workflow "([^"]*)": ([\s\S]*)$/;

/** The product a workflow step belongs to, for a heading a person recognizes. */
export function productNameOf(goal: string, fallback: string): string {
  const match = STEP_GOAL_PATTERN.exec(goal.trim());
  const name = match?.[1]?.trim();
  if (name !== undefined && name !== '') return name;
  const text = goal.trim().replace(/\s+/g, ' ');
  return text === '' ? fallback : text;
}

/**
 * What to call the running project.
 *
 * The delivery's own README heading is the artifact naming itself, so it wins; the seed falls
 * back to the task title and finally to a neutral word. Nothing here is a lookup table of known
 * products — a new product is named by the files it shipped.
 */
export function projectNameOf(files: readonly PlannedFile[], fallback: string): string {
  const readmes = files
    .filter((file) => /(^|\/)readme\.md$/i.test(file.path))
    .sort((left, right) => left.path.split('/').length - right.path.split('/').length);
  for (const readme of readmes) {
    const heading = /^#\s+(.+)$/m.exec(scan(readme.content));
    const name = heading?.[1]?.trim().replace(/\s+/g, ' ');
    if (name !== undefined && name !== '') return name;
  }
  const title = fallback.trim().replace(/\s+/g, ' ');
  return title === '' ? 'Delivery' : title;
}

/* --- The plan -------------------------------------------------------------------- */

const PYTHON_SERVER_NAMES = /^(app|main|server|api|wsgi|asgi)\.py$/i;
const NODE_SERVER_NAMES = /^(server|app|index|main)\.m?js$/i;

function asFiles(files: readonly PlannedFile[]): readonly (PlannedFile & { readonly path: string })[] {
  return files.flatMap((file) => {
    const path = normalizePath(file.path);
    return path === null ? [] : [{ path, content: file.content }];
  });
}

/** Files in delivery order, so a plan is stable across two reads of the same record. */
function byPath(files: readonly (PlannedFile & { readonly path: string })[]): readonly (PlannedFile & { readonly path: string })[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path));
}

function pythonServerPlan(
  entry: PlannedFile & { readonly path: string },
  launcherPath: string | null,
): LaunchPlan {
  const portMode: PortMode = readsPortFromEnv(entry.content, 'python')
    ? 'env'
    : fixedPortOf(entry.content, 'python') === null ? 'default' : 'probe';
  return {
    plan: 'python-server',
    entryPath: entry.path,
    entryCommand: entry.path,
    portMode,
    fixedPort: portMode === 'probe' ? fixedPortOf(entry.content, 'python') : null,
    readinessPath: readinessPathOf(entry.content),
    launcherPath,
  };
}

function nodeServerPlan(
  entry: PlannedFile & { readonly path: string },
  launcherPath: string | null,
): LaunchPlan {
  const portMode: PortMode = readsPortFromEnv(entry.content, 'node')
    ? 'env'
    : fixedPortOf(entry.content, 'node') === null ? 'default' : 'probe';
  return {
    plan: 'node-server',
    entryPath: entry.path,
    entryCommand: entry.path,
    portMode,
    fixedPort: portMode === 'probe' ? fixedPortOf(entry.content, 'node') : null,
    readinessPath: readinessPathOf(entry.content),
    launcherPath,
  };
}

/**
 * Decide how (or whether) to start one delivered artifact.
 *
 * The order is "most specific evidence wins": a service the content proves is an HTTP server
 * beats a launcher, because the launcher would start that same service anyway but through an
 * extra process whose port we cannot control. A launcher is still valuable — it is the artifact
 * author's own documented way in — so it is used when the entry point turns out to be
 * non-portable or when nothing else can be started but a shell exists.
 *
 * Returns `plan: null` with a `reason` for anything that is not a web app: a report, a bare
 * test report, a delivery with no client at all.
 */
export function planArtifact(files: readonly PlannedFile[], fallbackName = ''): ArtifactPlan {
  const normalized = byPath(asFiles(files));
  const projectName = projectNameOf(normalized, fallbackName);
  const none = (reason: string): ArtifactPlan => ({ plan: null, reason, projectName });
  if (normalized.length === 0) return none('the delivery carries no files');

  const find = (pattern: RegExp): (PlannedFile & { readonly path: string }) | undefined =>
    normalized.find((file) => pattern.test(file.path));

  const launcher = find(/(^|\/)run\.(py|mjs|js|sh)$/i);
  const launcherPath = launcher?.path ?? null;
  const hasClientShell = normalized.some((file) => /(^|\/)(index|main)\.html?$/i.test(file.path));

  // 1. A Python service the content proves is an HTTP server. Prefer the conventional entry
  //    names so `app.py` wins over an unrelated script that happens to call `serve_forever`.
  const pythonFiles = normalized.filter((file) => extensionOf(file.path) === '.py');
  const pythonEntry =
    pythonFiles.find((file) => PYTHON_SERVER_NAMES.test(baseName(file.path)) && looksLikePythonHttpServer(file.content))
    ?? pythonFiles.find((file) => looksLikePythonHttpServer(file.content));
  if (pythonEntry !== undefined) return { plan: pythonServerPlan(pythonEntry, launcherPath), reason: null, projectName };

  // 2. The same for Node.
  const nodeFiles = normalized.filter((file) => ['.js', '.mjs', '.cjs', '.ts'].includes(extensionOf(file.path)));
  const nodeEntry =
    nodeFiles.find((file) => NODE_SERVER_NAMES.test(baseName(file.path)) && looksLikeNodeHttpServer(file.content))
    ?? nodeFiles.find((file) => looksLikeNodeHttpServer(file.content));
  if (nodeEntry !== undefined) return { plan: nodeServerPlan(nodeEntry, launcherPath), reason: null, projectName };

  // 3. A launcher with a client beside it: the author's own entry point, which decides for
  //    itself whether to start a service or serve the client.
  if (launcher !== undefined && hasClientShell) {
    return {
      plan: {
        plan: 'launcher',
        entryPath: launcher.path,
        entryCommand: launcher.path,
        // A launcher that reads PORT can be moved; one that does not still has a client to
        // serve, so its default port is probed rather than refused.
        portMode: extensionOf(launcher.path) === '.py'
          ? readsPortFromEnv(launcher.content, 'python') ? 'env' : 'default'
          : readsPortFromEnv(launcher.content, 'node') ? 'env' : 'default',
        fixedPort: null,
        readinessPath: '/',
        launcherPath: launcher.path,
      },
      reason: null,
      projectName,
    };
  }

  // 4. A client shell with no service: served as static files on a port this runtime picks.
  const shell = normalized.find((file) => /(^|\/)index\.html?$/i.test(file.path));
  if (shell !== undefined) {
    return {
      plan: {
        plan: 'static',
        entryPath: shell.path,
        entryCommand: shell.path,
        portMode: 'env',
        fixedPort: null,
        readinessPath: '/',
        launcherPath,
      },
      reason: null,
      projectName,
    };
  }

  // 5. A single page under any name: same treatment, still a web page a person can look at.
  const page = normalized.find((file) => extensionOf(file.path) === '.html' || extensionOf(file.path) === '.htm');
  if (page !== undefined) {
    return {
      plan: {
        plan: 'html',
        entryPath: page.path,
        entryCommand: page.path,
        portMode: 'env',
        fixedPort: null,
        readinessPath: '/',
        launcherPath,
      },
      reason: null,
      projectName,
    };
  }

  return none('the delivery has no web entry point (no service, no launcher with a client, no page)');
}
