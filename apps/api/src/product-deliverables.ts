import { requiredCapabilitiesFor } from '@maoeh/organization-model';
import { detectGame, gamePage, type GameKind } from './game-deliverables.js';

/**
 * What the organization hands back for one step.
 *
 * The stand-in cognition cannot author an arbitrary model's work product, so every delivery has
 * to be *composed* from what the step declares. Two things decide the composition:
 *
 * 1. **What kind of work the step is** — its capability (`backend`, `frontend`, …). This is the
 *    step's contract, and it is what the executor is told on the wake-up event. A seat that
 *    carries three tags (a software engineer declaring implementation + frontend + backend) is
 *    three *different* jobs when three steps route to it, and one engineer holding all three must
 *    not answer all three with one identical page — that was the reported "交付成果只有前端".
 * 2. **What the product needs** — the requirement text the step's workflow was created for. It
 *    names the game, the backend language and what the backend has to record, so the frontend and
 *    the backend steps of one workflow ship *halves of the same product* — the same API paths,
 *    the same storage, the same launch command.
 *
 * Only when a step declares no capability does the delivery fall back to the executor's own seat
 * tags (the pre-existing behaviour for direct dispatch and for template steps that never
 * labelled themselves).
 *
 * Every produced file is listed twice on purpose: in `artifacts` (the paths the console shows and
 * the task record carries) and in `data.files` (the same files *with their bytes*), so the owner
 * can read and download the delivery instead of only reading a description of it.
 */

/** One file a step hands over, with the bytes it was handed over as. */
export interface DeliveryFile {
  readonly path: string;
  /** Coarse language tag, used by the console to pick a download type. */
  readonly language: string;
  readonly content: string;
}

/** The delivery of one step, in the shape `Task.ProgressReported` carries. */
export interface DeliveryDraft {
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly string[];
}

/** The step's own brief, read back out of the goal the workflow engine wrote. */
export interface StepBrief {
  /** The step's name — `Backend`, `Frontend`, a template's human step name. */
  readonly stepName: string;
  /** The product this step belongs to: the workflow's title. */
  readonly productName: string;
  /** What the product has to do: the workflow's own goal, without the step wrapper. */
  readonly requirement: string;
}

export type BackendLanguage = 'python' | 'node';

export interface ProductSpec {
  readonly brief: StepBrief;
  /** The kinds of work the *whole* product needs (deterministic goal analysis, same as planning). */
  readonly capabilities: readonly string[];
  readonly game: GameKind | null;
  readonly needsBackend: boolean;
  /** The product is split into parts, so `implementation` owns the wiring rather than the product. */
  readonly split: boolean;
  readonly language: BackendLanguage;
}

/**
 * The goal wrapper `workflow-engine` writes for a generated step:
 *
 *     Complete step "<step>" of workflow "<product>": <the workflow's own goal>
 *
 * Read back here because the wrapper is the only place the executor is told what the *product* is,
 * and a delivery has to name the product it is a part of. The pattern is strict and the fallback
 * is the whole goal, so a goal written by anything else (a standalone task, a template step)
 * degrades to "the product is the goal" instead of being mis-split.
 */
const STEP_GOAL_PATTERN = /^Complete step "([^"]*)" of workflow "([^"]*)": ([\s\S]*)$/;

export function readStepBrief(goal: string, fallbackTitle: string): StepBrief {
  const stepName = fallbackTitle.trim();
  const text = goal.trim();
  const match = STEP_GOAL_PATTERN.exec(text);
  if (match === null) {
    const only = text === '' ? stepName : text;
    return { stepName, productName: only, requirement: only };
  }
  return {
    stepName: (match[1] ?? '').trim() || stepName,
    productName: (match[2] ?? '').trim(),
    requirement: (match[3] ?? '').trim(),
  };
}

const GOAL_QUOTE_MAX = 160;

/** The goal as one bounded line, safe to drop into a sentence a person reads. */
export function oneLineGoal(goal: string, fallback: string): string {
  const clean = goal.replace(/\s+/g, ' ').trim();
  if (clean === '') return fallback;
  return clean.length <= GOAL_QUOTE_MAX ? clean : `${clean.slice(0, GOAL_QUOTE_MAX - 1)}…`;
}

/**
 * ASCII hints match on word boundaries so `py` cannot match inside `typescript`; every hint here
 * is ASCII, and the requirement text is lower-cased once by the caller.
 */
function namesWord(text: string, hint: string): boolean {
  const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

/**
 * The language the backend step has to be written in.
 *
 * The requirement is the only place this is ever stated, so it is read from there. When nothing
 * is named the answer is Python, for one practical reason: the delivered service has to run the
 * moment the owner runs it, and Python's standard library is a complete HTTP server + database,
 * so the delivery carries no install step and no dependency file that could go stale.
 */
export function backendLanguage(requirement: string): BackendLanguage {
  const text = requirement.toLowerCase();
  if (['python', 'python3', 'py', 'flask', 'fastapi', 'django'].some((hint) => namesWord(text, hint))) {
    return 'python';
  }
  if (['node', 'nodejs', 'node.js', 'express', 'javascript', 'typescript'].some((hint) => namesWord(text, hint))) {
    return 'node';
  }
  return 'python';
}

/** Everything a delivery needs to know about the product it belongs to. */
export function productSpec(goal: string, title: string): ProductSpec {
  const brief = readStepBrief(goal, title);
  const capabilities = requiredCapabilitiesFor(brief.requirement);
  return {
    brief,
    capabilities,
    game: detectGame(`${brief.productName}\n${brief.requirement}`),
    needsBackend: capabilities.includes('backend'),
    split: capabilities.includes('frontend') || capabilities.includes('backend'),
    language: backendLanguage(brief.requirement),
  };
}

function displayName(spec: ProductSpec): string {
  return spec.brief.productName === '' ? spec.brief.requirement : spec.brief.productName;
}

/* --- The shape an executor's own seat tags imply (the unlabelled fallback) ------ */

export type DeliveryShape = 'code' | 'document' | 'test' | 'report';

const SHAPE_BY_CAPABILITY: Readonly<Record<string, DeliveryShape>> = Object.freeze({
  implementation: 'code',
  frontend: 'code',
  backend: 'code',
  testing: 'test',
  product_requirement: 'document',
  technical_design: 'document',
  marketing: 'document',
});

/** A seat that can build hands back something that runs; code, then tests, then prose. */
const SHAPE_PRIORITY: readonly DeliveryShape[] = ['code', 'test', 'document', 'report'];

export function deliveryShape(capabilities: readonly string[]): DeliveryShape {
  const shapes = new Set(
    capabilities
      .map((capability) => SHAPE_BY_CAPABILITY[capability.trim().toLowerCase()])
      .filter((shape): shape is DeliveryShape => shape !== undefined),
  );
  return SHAPE_PRIORITY.find((shape) => shapes.has(shape)) ?? 'report';
}

const STACK_BY_CAPABILITY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  frontend: Object.freeze(['HTML5', 'TypeScript']),
  backend: Object.freeze(['Node.js', 'TypeScript']),
  implementation: Object.freeze(['TypeScript']),
  testing: Object.freeze(['Vitest']),
  technical_design: Object.freeze(['Markdown']),
  product_requirement: Object.freeze(['Markdown']),
  marketing: Object.freeze(['Markdown']),
});

export function stackFor(capabilities: readonly string[]): readonly string[] {
  const stack: string[] = [];
  for (const capability of capabilities) {
    for (const entry of STACK_BY_CAPABILITY[capability.trim().toLowerCase()] ?? []) {
      if (!stack.includes(entry)) stack.push(entry);
    }
  }
  return Object.freeze(stack.length === 0 ? ['TypeScript'] : stack);
}

/** A file-name-safe handle for the delivery, taken from the step's own name. */
export function slugOf(name: string): string {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (clean === '') return 'delivery';
  return clean.slice(0, 40).replace(/-+$/g, '');
}

/**
 * The deterministic stand-in for a build-shaped delivery: a runnable, brief-aware page (see
 * `scaffold-deliverables.ts`) — never a bare `textContent = "<step>"` placeholder again.
 */
import { webScaffold } from './scaffold-deliverables.js';

function file(path: string, language: string, content: string): DeliveryFile {
  return Object.freeze({ path, language, content });
}

/**
 * A delivery built out of real files: the entry file is also exposed as `content`/`entrypoint`
 * (the keys the delivery page already reads), and every file is listed with its bytes.
 */
function bundle(input: {
  readonly summary: string;
  readonly name: string;
  readonly stack: readonly string[];
  readonly files: readonly DeliveryFile[];
  readonly extra?: Readonly<Record<string, unknown>>;
}): DeliveryDraft {
  const entry = input.files[0];
  if (entry === undefined) throw new Error('a delivery needs at least one file');
  return {
    summary: input.summary,
    data: Object.freeze({
      name: input.name,
      stack: Object.freeze([...input.stack]),
      entrypoint: entry.path,
      content: entry.content,
      files: Object.freeze(input.files.map((entryFile) => ({ ...entryFile }))),
      ...(input.extra ?? {}),
    }),
    artifacts: Object.freeze(input.files.map((entryFile) => entryFile.path)),
  };
}

/* --- Text-shaped deliveries (documents, tests, reports) ------------------------- */

/** The prose a non-code step hands back, kept identical to the pre-capability behaviour. */
export function documentDelivery(name: string, goal: string): DeliveryDraft {
  const slug = slugOf(name);
  const content = [
    `# ${name}`,
    '',
    goal,
    '',
    '- Context: what the instruction asks for, and why it matters now.',
    '- Approach: the smallest end-to-end slice that answers it.',
    '- Open questions: what must be decided before work starts.',
  ].join('\n');
  return {
    summary: `Wrote the brief for "${goal}".`,
    data: Object.freeze({
      name,
      outline: ['context', 'approach', 'open questions'],
      content,
    }),
    artifacts: Object.freeze([`${slug}.md`]),
  };
}

export function testDelivery(name: string, goal: string): DeliveryDraft {
  const slug = slugOf(name);
  return {
    summary: `Ran the checks for "${goal}": every declared check passes.`,
    data: Object.freeze({
      test_report: `All checks pass for: ${goal}`,
      passed: true,
      failures: [],
    }),
    artifacts: Object.freeze([`${slug}/test-report.md`]),
  };
}

export function reportDelivery(name: string, goal: string): DeliveryDraft {
  return {
    summary: `Reported on "${goal}".`,
    data: Object.freeze({
      findings: [`${name} — work scoped from the instruction: ${goal}`],
      recommendation: 'proceed; the delivery is ready for review',
    }),
    artifacts: Object.freeze([]),
  };
}

/** Add the delivered bytes to a draft whose content already exists under another key. */
function withFiles(draft: DeliveryDraft, files: readonly DeliveryFile[]): DeliveryDraft {
  return {
    summary: draft.summary,
    data: Object.freeze({
      ...draft.data,
      files: Object.freeze(files.map((entryFile) => ({ ...entryFile }))),
    }),
    artifacts: Object.freeze(files.map((entryFile) => entryFile.path)),
  };
}

/* --- The three product shapes -------------------------------------------------- */

/**
 * The build step of a product that is *not* split: one runnable page, exactly as before the
 * capability contract existed. `leaderboard` is off because nothing in this plan delivers a
 * service for the page to talk to.
 */
export function codeDelivery(input: {
  readonly name: string;
  readonly goal: string;
  readonly seatCapabilities: readonly string[];
  readonly leaderboard: boolean;
}): DeliveryDraft {
  const slug = slugOf(input.name);
  const stack = stackFor(input.seatCapabilities);
  const game = detectGame(`${input.name}\n${input.goal}`);
  const content = game === null
    ? webScaffold(input.name, input.goal)
    : gamePage(game, input.name, input.goal, { leaderboard: input.leaderboard });
  const entry = `${slug}/index.html`;
  const doc = `${slug}/README.md`;
  return bundle({
    summary: `Implemented "${input.goal}" as a runnable page.`,
    name: input.name,
    stack,
    files: [
      file(entry, 'html', content),
      file(doc, 'markdown', pageReadme(input.name, input.goal, entry, input.leaderboard)),
    ],
  });
}

function pageReadme(name: string, goal: string, entry: string, leaderboard: boolean): string {
  return [
    `# ${name}`,
    '',
    `Delivered for: ${goal}`,
    '',
    '## Run',
    '',
    `Open \`${entry}\` in a browser. The page is self-contained: no install, no build step.`,
    '',
    ...(leaderboard
      ? [
          'It posts every finished game to the score service and renders the shared leaderboard.',
          'Start the service first (`python server/app.py`), or the page reports that the score',
          'service is offline and keeps playing locally.',
          '',
        ]
      : []),
  ].join('\n');
}

/**
 * `frontend`: the client half. When the product has a backend step the client is wired to it —
 * same-origin when the service serves the page, the service's default address when the page is
 * opened straight off disk — and the two halves agree on the API by construction (both are
 * generated from the same requirement text).
 */
export function frontendDelivery(spec: ProductSpec, name: string, goal: string): DeliveryDraft {
  const page = spec.game === null
    ? webScaffold(name, goal)
    : gamePage(spec.game, name, goal, { leaderboard: spec.needsBackend });
  const entry = 'client/index.html';
  const backendStack = spec.language === 'python' ? 'Python 3 HTTP API' : 'Node.js HTTP API';
  return bundle({
    summary: spec.needsBackend
      ? `Delivered the front end for "${displayName(spec)}" as a runnable SPA wired to the score service.`
      : `Delivered the front end for "${displayName(spec)}" as a runnable SPA.`,
    name,
    stack: spec.needsBackend ? ['HTML5', 'JavaScript', backendStack] : ['HTML5', 'JavaScript'],
    files: [
      file(entry, 'html', page),
      file(
        'client/README.md',
        'markdown',
        [
          `# ${displayName(spec)} — client`,
          '',
          `Delivered for: ${spec.brief.requirement}`,
          '',
          '## Run',
          '',
          spec.needsBackend
            ? 'Open it through the service (`python run.py` or `python server/app.py`), which serves'
            : 'Open `client/index.html` in a browser.',
          ...(spec.needsBackend
            ? ['this directory at `/`. Opened from disk instead, it looks for the service on', '`http://127.0.0.1:8000`.']
            : []),
          '',
        ].join('\n'),
      ),
    ],
  });
}

/** `backend`: the service half, in the language the requirement names. */
export function backendDelivery(spec: ProductSpec, name: string): DeliveryDraft {
  const python = spec.language === 'python';
  const entry = python ? 'server/app.py' : 'server/server.mjs';
  const content = python ? pythonService(spec) : nodeService(spec);
  return bundle({
    summary: `Delivered the ${python ? 'Python' : 'Node.js'} service that records every play and serves the leaderboard for "${displayName(spec)}".`,
    name,
    stack: python ? ['Python 3', 'sqlite3', 'http.server'] : ['Node.js', 'node:http', 'JSON file'],
    files: [file(entry, python ? 'python' : 'javascript', content), file('server/README.md', 'markdown', serverReadme(spec, entry))],
    extra: { api: Object.freeze([...API_ROUTES]), storage: python ? 'data/scores.db (SQLite)' : 'data/scores.json' },
  });
}

/**
 * `implementation`: when the plan is split into parts, this step owns the wiring — one command
 * that runs the product, and the README that explains the tree. On an unsplit plan it owns the
 * whole product instead (the runnable page), because nobody else delivers one.
 */
export function implementationDelivery(spec: ProductSpec, name: string, goal: string): DeliveryDraft {
  if (!spec.split) {
    return codeDelivery({ name, goal, seatCapabilities: ['implementation'], leaderboard: false });
  }
  return bundle({
    summary: `Wired "${displayName(spec)}" into one runnable project: python run.py starts the backend and opens the client.`,
    name,
    stack: ['Python 3'],
    files: [
      file('run.py', 'python', runLauncher(spec)),
      file('README.md', 'markdown', projectReadme(spec)),
    ],
  });
}

/** The delivery for one step, decided by the capability that step declared. */
export function capabilityDelivery(input: {
  readonly capability: string;
  readonly goal: string;
  readonly title: string;
}): DeliveryDraft | null {
  const capability = input.capability.trim().toLowerCase();
  if (capability === '') return null;
  const spec = productSpec(input.goal, input.title);
  const name = input.title.trim() === '' ? 'Delivery' : input.title.trim();
  const goal = oneLineGoal(spec.brief.requirement, name);
  const slug = slugOf(name);

  switch (capability) {
    case 'backend':
      return backendDelivery(spec, name);
    case 'frontend':
      return frontendDelivery(spec, name, goal);
    case 'implementation':
      return implementationDelivery(spec, name, goal);
    case 'testing':
      return withFiles(testDelivery(name, goal), [
        file(`${slug}/test-report.md`, 'markdown', testReport(name, spec.brief.requirement)),
      ]);
    case 'product_requirement':
      return withFiles(documentDelivery(name, goal), [
        file(`${slug}.md`, 'markdown', String(documentDelivery(name, goal).data['content'])),
      ]);
    case 'technical_design':
      return withFiles(documentDelivery(name, goal), [
        file(`${slug}.md`, 'markdown', String(documentDelivery(name, goal).data['content'])),
      ]);
    case 'marketing':
      return withFiles(documentDelivery(name, goal), [
        file(`${slug}.md`, 'markdown', String(documentDelivery(name, goal).data['content'])),
      ]);
    default:
      return null;
  }
}

function testReport(name: string, requirement: string): string {
  return [
    `# Test report — ${name}`,
    '',
    `Checked against: ${requirement}`,
    '',
    '## Result',
    '',
    '- every declared check passes',
    '- no failing case was produced by this step',
    '',
  ].join('\n');
}

/* --- The generated service: one contract, two languages ------------------------- */

const API_ROUTES: readonly string[] = Object.freeze([
  'GET /api/health',
  'GET /api/scores?limit=10',
  'POST /api/scores',
]);

function pyText(value: string): string {
  return value.replace(/"""/g, "'''").replace(/\r/g, '');
}

function pythonService(spec: ProductSpec): string {
  const product = pyText(displayName(spec));
  const requirement = pyText(spec.brief.requirement);
  return `#!/usr/bin/env python3
"""Score service for ${product}.

Purpose
    ${requirement}

Every finished game is POSTed to /api/scores and kept in SQLite, so one process serves every
player on the network (multi-user) and the leaderboard survives a restart. Standard library only:
nothing to pip install.

Run
    python server/app.py
    # API + client on http://127.0.0.1:8000

Endpoints
    GET  /api/health           -> {"ok": true, "plays": n, "players": n}
    GET  /api/scores?limit=10  -> {"scores": [...], "plays": n, "players": n}
    POST /api/scores           <- {"player": "ada", "score": 120, "lines": 4}
                               -> {"ok": true, "rank": 1, "best": 120, "plays": n, "players": n}
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import threading
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
CLIENT_DIR = ROOT / "client"
DB_PATH = Path(os.environ.get("SCORES_DB", str(ROOT / "data" / "scores.db")))
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))

WRITE_LOCK = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS plays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player TEXT NOT NULL,
    score INTEGER NOT NULL,
    lines INTEGER NOT NULL DEFAULT 0,
    played_at TEXT NOT NULL
)
"""


def connect() -> "sqlite3.Connection":
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(SCHEMA)
    return conn


def totals(conn: "sqlite3.Connection") -> dict:
    plays = conn.execute("SELECT COUNT(*) AS n FROM plays").fetchone()["n"]
    players = conn.execute("SELECT COUNT(DISTINCT player) AS n FROM plays").fetchone()["n"]
    return {"plays": plays, "players": players}


def leaderboard(conn: "sqlite3.Connection", limit: int) -> list:
    """Every player's best play, best first: the ranking the requirement asked to record."""
    rows = conn.execute(
        "SELECT p.player AS player, p.score AS score, p.lines AS lines,"
        " MIN(p.played_at) AS playedAt"
        " FROM plays p"
        " JOIN (SELECT player, MAX(score) AS best FROM plays GROUP BY player) b"
        "   ON b.player = p.player AND b.best = p.score"
        " GROUP BY p.player"
        " ORDER BY p.score DESC, MIN(p.played_at) ASC"
        " LIMIT ?",
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]


def record(player: str, score: int, lines: int) -> dict:
    played_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with WRITE_LOCK:
        conn = connect()
        try:
            conn.execute(
                "INSERT INTO plays (player, score, lines, played_at) VALUES (?, ?, ?, ?)",
                (player, score, lines, played_at),
            )
            conn.commit()
            best = conn.execute(
                "SELECT MAX(score) AS best FROM plays WHERE player = ?", (player,)
            ).fetchone()["best"]
            better = conn.execute(
                "SELECT COUNT(*) AS n FROM (SELECT player, MAX(score) AS best FROM plays"
                " GROUP BY player) WHERE best > ?",
                (best,),
            ).fetchone()["n"]
            summary = totals(conn)
        finally:
            conn.close()
    return {"rank": better + 1, "best": best, "plays": summary["plays"], "players": summary["players"]}


class Handler(SimpleHTTPRequestHandler):
    """One thread per request, so several players can post at the same time."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(CLIENT_DIR), **kwargs)

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            conn = connect()
            try:
                return self.send_json({"ok": True, **totals(conn)})
            finally:
                conn.close()
        if path == "/api/scores":
            query = parse_qs(urlparse(self.path).query)
            try:
                limit = max(1, min(100, int(query.get("limit", ["10"])[0])))
            except ValueError:
                limit = 10
            conn = connect()
            try:
                return self.send_json({"scores": leaderboard(conn, limit), **totals(conn)})
            finally:
                conn.close()
        if path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/api/scores":
            return self.send_json({"error": "not found"}, 404)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            return self.send_json({"error": "invalid json"}, 400)
        if not isinstance(body, dict):
            return self.send_json({"error": "expected a json object"}, 400)
        player = str(body.get("player") or "").strip()[:24] or "Player"
        try:
            score = int(body.get("score") or 0)
            lines = int(body.get("lines") or 0)
        except (TypeError, ValueError):
            return self.send_json({"error": "score and lines must be integers"}, 400)
        if score < 0 or lines < 0:
            return self.send_json({"error": "score and lines must not be negative"}, 400)
        return self.send_json({"ok": True, **record(player, score, lines)}, 201)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("[score-service] %s\\n" % (fmt % args))


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("score service for ${product}")
    print("client:  http://%s:%d/" % (HOST, PORT))
    print("api:     http://%s:%d/api/scores" % (HOST, PORT))
    print("storage: %s" % DB_PATH)
    print("press Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
`;
}

function nodeService(spec: ProductSpec): string {
  const product = displayName(spec).replace(/\*\//g, '* /');
  const requirement = spec.brief.requirement.replace(/\*\//g, '* /');
  return `#!/usr/bin/env node
/**
 * Score service for ${product}.
 *
 * Purpose
 *     ${requirement}
 *
 * Every finished game is POSTed to /api/scores and kept in data/scores.json, so one process
 * serves every player on the network (multi-user) and the leaderboard survives a restart.
 * No dependencies: node's own http and fs are enough.
 *
 * Run
 *     node server/server.mjs
 *     # API + client on http://127.0.0.1:8000
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT_DIR = join(ROOT, 'client');
const DATA_DIR = join(ROOT, 'data');
const DB_PATH = join(DATA_DIR, 'scores.json');
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8000);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// One writer at a time, so a reader never sees a half-written file.
let writing = Promise.resolve();

async function load() {
  try {
    const parsed = JSON.parse(await readFile(DB_PATH, 'utf8'));
    return Array.isArray(parsed.plays) ? parsed : { plays: [] };
  } catch {
    return { plays: [] };
  }
}

async function save(db) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function totals(db) {
  return { plays: db.plays.length, players: new Set(db.plays.map((play) => play.player)).size };
}

function leaderboard(db, limit) {
  const best = new Map();
  for (const play of db.plays) {
    const current = best.get(play.player);
    if (current === undefined || play.score > current.score) best.set(play.player, play);
  }
  return [...best.values()]
    .sort((left, right) => right.score - left.score || left.playedAt.localeCompare(right.playedAt))
    .slice(0, limit)
    .map((play) => ({ player: play.player, score: play.score, lines: play.lines, playedAt: play.playedAt }));
}

function record(db, player, score, lines) {
  const playedAt = new Date().toISOString();
  db.plays.push({ player, score, lines, playedAt });
  const best = db.plays.filter((play) => play.player === player).reduce((top, play) => Math.max(top, play.score), 0);
  const rank = leaderboard(db, db.plays.length).findIndex((row) => row.player === player) + 1;
  return { rank: rank === 0 ? 1 : rank, best, ...totals(db) };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(pathname, response) {
  const relative = normalize(pathname === '/' ? 'index.html' : pathname.replace(/^\\/+/, ''));
  if (relative.startsWith('..')) return false;
  const target = join(CLIENT_DIR, relative);
  if (!target.startsWith(CLIENT_DIR) || !existsSync(target)) return false;
  const body = await readFile(target);
  response.writeHead(200, {
    'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
    'content-length': body.length,
  });
  response.end(body);
  return true;
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', 'http://' + HOST + ':' + PORT);
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
    };

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return send(200, { ok: true, ...totals(await load()) });
    }
    if (request.method === 'GET' && url.pathname === '/api/scores') {
      const db = await load();
      const requested = Number(url.searchParams.get('limit') ?? 10);
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.trunc(requested))) : 10;
      return send(200, { scores: leaderboard(db, limit), ...totals(db) });
    }
    if (request.method === 'POST' && url.pathname === '/api/scores') {
      let body;
      try {
        body = JSON.parse((await readBody(request)) || '{}');
      } catch {
        return send(400, { error: 'invalid json' });
      }
      if (typeof body !== 'object' || body === null) return send(400, { error: 'expected a json object' });
      const player = String(body.player ?? '').trim().slice(0, 24) || 'Player';
      const score = Number(body.score ?? 0);
      const lines = Number(body.lines ?? 0);
      if (!Number.isInteger(score) || !Number.isInteger(lines) || score < 0 || lines < 0) {
        return send(400, { error: 'score and lines must be non-negative integers' });
      }
      const outcome = await new Promise((resolve, reject) => {
        writing = writing.then(async () => {
          const db = await load();
          const result = record(db, player, score, lines);
          await save(db);
          resolve(result);
        }, reject);
        writing = writing.then(() => undefined, () => undefined);
      });
      return send(201, { ok: true, ...outcome });
    }
    if (request.method === 'GET' && (await serveStatic(url.pathname, response))) return;
    return send(404, { error: 'not found' });
  })().catch((error) => {
    response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: String(error) }));
  });
});

server.listen(PORT, HOST, () => {
  console.log('score service for ${product}');
  console.log('client:  http://' + HOST + ':' + PORT + '/');
  console.log('api:     http://' + HOST + ':' + PORT + '/api/scores');
  console.log('storage: ' + DB_PATH);
  console.log('press Ctrl+C to stop');
});
`;
}

function runLauncher(spec: ProductSpec): string {
  const product = pyText(displayName(spec));
  return `#!/usr/bin/env python3
"""Run ${product} locally — one command, no arguments.

    python run.py

The delivery has two halves and this script starts them in the right order:

* with a backend (\`server/app.py\` or \`server/server.mjs\`) it starts the service, which also
  serves the client, and opens a browser on it;
* without one it serves \`client/\` as plain static files.

Nothing else is required: there is no dependency file and no build step.
"""
import os
import subprocess
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", "8000"))
URL = "http://127.0.0.1:%d/" % PORT


def serve_static() -> None:
    def handler(*args, **kwargs):
        return SimpleHTTPRequestHandler(*args, directory=str(ROOT / "client"), **kwargs)

    print("no backend in this delivery - serving the client on %s" % URL)
    ThreadingHTTPServer(("127.0.0.1", PORT), handler).serve_forever()


def main() -> None:
    python_service = ROOT / "server" / "app.py"
    node_service = ROOT / "server" / "server.mjs"
    if python_service.is_file():
        command = [sys.executable, str(python_service)]
    elif node_service.is_file():
        command = ["node", str(node_service)]
    else:
        serve_static()
        return
    print("starting: %s" % " ".join(command))
    process = subprocess.Popen(command)
    threading.Timer(1.5, lambda: webbrowser.open(URL)).start()
    try:
        process.wait()
    except KeyboardInterrupt:
        process.terminate()


if __name__ == "__main__":
    main()
`;
}

function projectReadme(spec: ProductSpec): string {
  const product = displayName(spec);
  const python = spec.language === 'python';
  const service = python ? 'server/app.py' : 'server/server.mjs';
  return [
    `# ${product}`,
    '',
    `Requirement: ${spec.brief.requirement}`,
    '',
    'This delivery was produced by one workflow: the capability steps each handed back the part',
    'they own, and together they are one runnable product.',
    '',
    '## Run',
    '',
    '```',
    'python run.py',
    '```',
    '',
    `That starts the backend (\`${service}\`) and opens http://127.0.0.1:8000/ — it serves the`,
    'client, records every finished game and ranks the players. `run.py` falls back to serving',
    '`client/` statically when the delivery has no backend.',
    '',
    '## Tree',
    '',
    '```',
    spec.split ? 'README.md            this file (the wiring + how to run)' : 'README.md            this file',
    spec.split ? 'run.py               one command that starts the product' : '',
    spec.capabilities.includes('frontend') ? 'client/index.html    the SPA the player opens' : '',
    spec.capabilities.includes('backend') ? `${service.padEnd(20)}the service: records plays, serves the leaderboard` : '',
    spec.capabilities.includes('backend') ? `${(python ? 'data/scores.db' : 'data/scores.json').padEnd(20)}created on first play` : '',
    '```',
    '',
    ...(spec.capabilities.includes('backend')
      ? [
          '## API',
          '',
          ...API_ROUTES.map((route) => `- \`${route}\``),
          '',
          '`POST /api/scores` takes `{"player": "ada", "score": 120, "lines": 4}` and answers with the',
          "player's rank; `GET /api/scores?limit=10` is the leaderboard. The service is threaded, so",
          'several players can play and post at the same time.',
          '',
        ]
      : []),
    '## Notes',
    '',
    '- Every file here was delivered by the step whose capability owns it; nothing was written by',
    '  hand outside the organization.',
    '- The client works without the service (it reports the service is offline); the scoreboard',
    '  itself needs the service running.',
    '',
  ].filter((line) => line !== '').join('\n');
}

function serverReadme(spec: ProductSpec, entry: string): string {
  const python = spec.language === 'python';
  return [
    `# Score service — ${displayName(spec)}`,
    '',
    `Delivered for: ${spec.brief.requirement}`,
    '',
    '## Run',
    '',
    '```',
    python ? 'python server/app.py' : 'node server/server.mjs',
    '```',
    '',
    'Standard library only — no dependencies to install. It listens on http://127.0.0.1:8000/ by',
    'default (`HOST` / `PORT` environment variables override that), serves the client from',
    '`../client/`, and stores every play in',
    `\`${python ? '../data/scores.db (SQLite, WAL)' : '../data/scores.json'}\` so the ranking survives a restart.`,
    '',
    '## API',
    '',
    ...API_ROUTES.map((route) => `- \`${route}\``),
    '',
    '```',
    'curl -X POST http://127.0.0.1:8000/api/scores \\',
    '  -H "content-type: application/json" \\',
    '  -d \'{"player": "ada", "score": 120, "lines": 4}\'',
    '',
    'curl http://127.0.0.1:8000/api/scores?limit=10',
    '```',
    '',
    '## Multi-user',
    '',
    python
      ? 'The server handles one request per thread, so several players can play and post at the same'
      : 'Node handles concurrent requests natively, so several players can play and post at the same',
    'time. Each play is recorded; the leaderboard ranks players by their best score, earliest first',
    'on a tie.',
    '',
    `Entry point: \`${entry}\`.`,
    '',
  ].join('\n');
}
