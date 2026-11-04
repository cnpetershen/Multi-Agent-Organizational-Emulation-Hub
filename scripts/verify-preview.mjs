/**
 * Preview Runtime verification on the REAL tetris artifact (adversarial, read-only w.r.t. product code).
 *
 * What this script does, in order:
 *   1. boot the built API (`apps/api/dist/index.js`) on a free port with a throwaway event log
 *   2. drive the REAL workflow with the tetris mandate (`Agent.Instruct`, the same command
 *      `scripts/deliver-product.mjs` sends) and wait for the delivered tasks
 *   3. exercise `GET/POST /api/preview/:taskId[/start|/stop]` against those real deliveries
 *   4. open the preview URL in headless Chrome over the DevTools protocol (no Playwright, no new
 *      dependency) and prove the game is alive and controllable from the rendered pixels
 *   5. print raw evidence per numbered item and write screenshots + a JSON report
 *
 * Modes:
 *   node scripts/verify-preview.mjs                 # live: drive the real workflow
 *   node scripts/verify-preview.mjs --mode=broken   # seed log whose delivered service cannot start
 *   node scripts/verify-preview.mjs --mode=docs     # seed log whose delivery has no web entry point
 *   node scripts/verify-preview.mjs --mode=project  # seed log with the whole tree on one task
 *
 * The seed logs are copies of a real run's event log (see .tmp-diag/e2e/build-seeds.mjs); booting
 * the API on one is the kernel's own recovery path, so no preview data is hand-written into the
 * product.
 *
 * Sandbox note: this host cannot open named pipes for a child process, so every `spawn` here uses
 * stdio 'ignore' or 'inherit' — a piped child fails with EPERM before it starts.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import { deflateSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '.tmp-diag', 'e2e');
const MANDATE = '开发一个俄罗斯方块程序\n前端Web SPA 后端用python，后端用来记录每次排名和得分';
const MODE = (process.argv.find((arg) => arg.startsWith('--mode=')) ?? '--mode=live').slice('--mode='.length);
const SEED_LOG_NAME = { broken: 'seed-broken.jsonl', docs: 'seed-docs.jsonl', project: 'seed-project.jsonl' }[MODE] ?? null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stdout.write(`${message}\n`);

/* --- Evidence ------------------------------------------------------------------------ */

const items = [];
const startedAt = new Date().toISOString();

function item(number, title, pass, command, raw, extra = undefined) {
  const verdict = pass === 'substitute' ? 'SUBSTITUTE' : pass ? 'PASS' : 'FAIL';
  const entry = { item: number, title, verdict, pass: pass === true, substitute: pass === 'substitute', command, raw, ...(extra === undefined ? {} : { extra }) };
  items.push(entry);
  log(`[item ${String(number)}] ${verdict} — ${title}`);
  log(`  command: ${command}`);
  log(`  raw: ${typeof raw === 'string' ? raw : JSON.stringify(raw)}`);
  return entry;
}

function fatal(number, title, command, error) {
  return item(number, title, false, command, `THREW: ${error instanceof Error ? error.message : String(error)}`);
}

/* --- Ports, processes, HTTP ----------------------------------------------------------- */

async function pickBindablePort(preferred) {
  for (let port = preferred; port < preferred + 900; port += 1) {
    const bindable = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (bindable) return port;
  }
  throw new Error(`no bindable port near ${String(preferred)}`);
}

function stopTree(child) {
  if (child === undefined || child === null || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  child.kill('SIGTERM');
}

/** Is anything answering on this URL? Returns the status or `null`. */
async function statusOf(url, timeoutMs = 1_500) {
  try {
    const response = await fetch(url, { headers: { connection: 'close' }, signal: AbortSignal.timeout(timeoutMs) });
    await response.arrayBuffer();
    return response.status;
  } catch {
    return null;
  }
}

async function waitForHttp(url, label, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await statusOf(url)) !== null) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (${url})`);
    await sleep(200);
  }
}

/** One HTTP call, returning status/headers/text and the parsed body when it is JSON. */
async function http(url, init = {}) {
  const began = Date.now();
  const response = await fetch(url, { ...init, headers: { connection: 'close', ...(init.headers ?? {}) } });
  const text = await response.text();
  let body;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, headers: Object.fromEntries(response.headers), text, body, ms: Date.now() - began };
}

/* --- The API under test ---------------------------------------------------------------- */

class Api {
  constructor(port, child, base) {
    this.port = port;
    this.child = child;
    this.base = base;
  }

  static async boot(seedLogName) {
    const port = await pickBindablePort(3100 + Math.floor(Math.random() * 200));
    const eventLog = path.join(OUT, seedLogName === null ? `verify-${MODE}-events.jsonl` : seedLogName);
    if (seedLogName !== null) await copyFile(path.join(OUT, seedLogName), eventLog);
    else await writeFile(eventLog, '', 'utf8');
    const child = spawn(process.execPath, ['apps/api/dist/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), MAOEH_EVENT_LOG: eventLog, MAOEH_OWNERSHIP: 'memory' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const base = `http://127.0.0.1:${String(port)}/api`;
    await waitForHttp(`${base}/simulation`, 'the API server');
    return new Api(port, child, base);
  }

  get(pathname) {
    return http(`${this.base}${pathname}`);
  }

  post(pathname, payload) {
    return http(`${this.base}${pathname}`, {
      method: 'POST',
      ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
    });
  }

  /** `GET /api/preview/:taskId`, unwrapped from either `{status}` envelope or a bare object. */
  async previewStatus(taskId) {
    const response = await this.get(`/preview/${encodeURIComponent(taskId)}`);
    return { ...response, preview: response.body?.status ?? response.body };
  }

  async previewStart(taskId) {
    const response = await this.post(`/preview/${encodeURIComponent(taskId)}/start`);
    return { ...response, preview: response.body?.status ?? response.body };
  }

  async previewStop(taskId) {
    const response = await this.post(`/preview/${encodeURIComponent(taskId)}/stop`);
    return { ...response, preview: response.body?.status ?? response.body };
  }
}

/* --- Chrome over the DevTools protocol (the technique tests/e2e/console-loop.mjs uses) --- */

function findChrome() {
  const candidates = [
    process.env['CHROME_PATH'],
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '');
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error('Chrome/Brave/Edge not found — set CHROME_PATH');
  return found;
}

/** Read the tail of a browser log file (the browser's stderr is captured to a file, not a pipe). */
function readChromeLog(file, lines = 12) {
  try {
    const text = readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter((line) => line.trim() !== '').slice(-lines).join(' | ');
  } catch {
    return '(no browser log)';
  }
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  static async connect(wsUrl, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const socket = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('websocket connect timeout')), 5_000);
          socket.addEventListener('open', () => {
            clearTimeout(timer);
            resolve();
          });
          socket.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('websocket connect failed'));
          });
        });
        return new Cdp(socket);
      } catch (cause) {
        if (Date.now() > deadline) throw cause;
        await sleep(300);
      }
    }
  }

  send(method, params = {}) {
    this.sequence += 1;
    const id = this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails !== undefined) throw new Error(`page evaluation threw: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  }

  async waitFor(expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.evaluate(expression)) === true) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await sleep(200);
    }
  }

  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(file, Buffer.from(shot.data, 'base64'));
    return file;
  }

  async key(key, code, virtualKeyCode) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
  }
}

/**
 * Read the rendered board as a 10x20 occupancy grid by sampling each cell's centre pixel, plus
 * the DOM HUD values. This is the artifact's own drawing, so it is the strongest available
 * evidence that the canvas is not blank and that input actually changed what is rendered.
 */
const READ_BOARD = `(() => {
  const canvas = document.getElementById('board');
  if (!canvas) return { error: 'no #board canvas' };
  const ctx = canvas.getContext('2d');
  const width = canvas.width, height = canvas.height, block = 24;
  const data = ctx.getImageData(0, 0, width, height).data;
  const cell = (col, row) => {
    const x = col * block + 12, y = row * block + 12;
    if (x >= width || y >= height) return null;
    const i = (y * width + x) * 4;
    const isBackground = data[i] === 16 && data[i + 1] === 20 && data[i + 2] === 28;
    return isBackground ? '0' : '1';
  };
  const rows = [];
  let occupied = 0;
  for (let row = 0; row < 20; row += 1) {
    let line = '';
    for (let col = 0; col < 10; col += 1) { const value = cell(col, row) ?? '0'; line += value; if (value === '1') occupied += 1; }
    rows.push(line);
  }
  return {
    grid: rows,
    occupied,
    score: document.getElementById('score')?.textContent ?? null,
    lines: document.getElementById('lines')?.textContent ?? null,
    status: document.getElementById('status')?.textContent ?? null,
    boardStatus: document.getElementById('board-status')?.textContent ?? null,
    boardList: document.getElementById('board-list')?.textContent ?? null,
    title: document.title,
    origin: location.origin,
  };
})()`;

/**
 * The falling piece, as the window of rows that starts at the topmost occupied cell.
 *
 * The board is reset with `R` before every probe, so nothing but the falling piece is on the
 * grid and this window is exactly the piece — which makes a one-column move measurable.
 */
function topCells(grid) {
  const top = grid.findIndex((row) => row.includes('1'));
  if (top < 0) return [];
  const cells = [];
  for (let row = top; row < Math.min(20, top + 4); row += 1) {
    for (let col = 0; col < 10; col += 1) if (grid[row][col] === '1') cells.push([col, row]);
  }
  return cells;
}

function columns(cells) {
  return [...new Set(cells.map(([col]) => col))].sort((left, right) => left - right);
}

function shapeKey(cells) {
  if (cells.length === 0) return 'empty';
  const minCol = Math.min(...cells.map(([col]) => col));
  const minRow = Math.min(...cells.map(([, row]) => row));
  return cells.map(([col, row]) => `${String(col - minCol)},${String(row - minRow)}`).sort().join(' ');
}

/**
 * How deep the landed blocks reach: the last occupied row + 1 (the falling piece counts, which is
 * why a fresh `R` reset reads 2 here and a stack of hard-dropped pieces reads ~20).
 */
function stackHeight(grid) {
  for (let row = 19; row >= 0; row -= 1) if (grid[row].includes('1')) return row + 1;
  return 0;
}

/* --- The verification --------------------------------------------------------------- */

let api = null;
let chrome = null;
let cdp = null;
const cleanup = [];

async function main() {
  await mkdir(OUT, { recursive: true });
  log(`[setup] mode=${MODE} root=${ROOT}`);

  // Seed-based modes boot the API straight on a real (mutated) event log.
  if (SEED_LOG_NAME !== null) {
    api = await Api.boot(SEED_LOG_NAME);
    log(`[setup] API on ${api.base} replaying ${SEED_LOG_NAME}`);
  } else {
    api = await Api.boot(null);
    log(`[setup] API on ${api.base} (empty log)`);
    await instructMandate();
  }
  cleanup.push(() => stopTree(api.child));

  const tasks = await listTasks();
  log(`[setup] tasks: ${JSON.stringify(tasks.map((task) => `${task.taskId}:${task.title}:${task.status}`))}`);

  const tetrisTasks = [];
  const deliveredTasks = [];
  for (const summary of tasks) {
    const record = (await api.get(`/tasks/${encodeURIComponent(summary.taskId)}`)).body;
    if (record?.result == null) continue;
    deliveredTasks.push(record);
    const files = record.result?.data?.files ?? [];
    if (files.some((file) => String(file.content ?? '').includes('俄罗斯方块'))) tetrisTasks.push(record);
  }
  // Live/project runs must find the tetris delivery; the docs fixture is deliberately a
  // report-only delivery, so it falls back to any delivered task.
  const candidates = tetrisTasks.length > 0 ? tetrisTasks : deliveredTasks;
  if (candidates.length === 0) {
    item(1, 'START — a task with the tetris delivery exists', false, 'GET /api/tasks/:id', 'no task carries a delivery');
    return;
  }
  const target = candidates[0];

  if (MODE === 'live' || MODE === 'project') {
    await verifyPreviewLifecycle(target);
    await verifyDownloads(tetrisTasks);
    await verifyNoConstants();
  } else if (MODE === 'broken') {
    await verifyFailurePath(target);
  } else if (MODE === 'docs') {
    await verifyUnavailable(target);
  }
}

/** Hand the CEO the mandate the way scripts/deliver-product.mjs does. */
async function instructMandate() {
  const stamp = String(Date.now());
  const response = await api.post('/command', {
    commandId: `verify-instruct-${stamp}`,
    actor: { operatorId: 'ceo-alex', displayName: 'Alex', positionId: 'ceo', kind: 'human' },
    reason: 'preview verification: board directive',
    correlationId: `verify-${stamp}`,
    causationId: null,
    createdAtSim: 0,
    commandType: 'Agent.Instruct',
    target: { targetType: 'agent', targetId: 'ceo-alex' },
    instruction: MANDATE,
  });
  log(`[setup] Agent.Instruct -> ${String(response.status)} ${JSON.stringify(response.body?.status ?? response.body)}`);
  const deadline = Date.now() + 180_000;
  for (;;) {
    const list = await listTasks();
    const settled = list.length >= 3 && list.every((task) => ['completed', 'rejected', 'cancelled'].includes(task.status));
    if (settled) return;
    if (Date.now() > deadline) throw new Error(`the workflow did not settle: ${JSON.stringify(list.map((task) => `${task.title}=${task.status}`))}`);
    await sleep(1_000);
  }
}

async function listTasks() {
  return (await api.get('/tasks')).body ?? [];
}

/** Items 1-6: status, client, backend, gameplay, stop, rerun. */
async function verifyPreviewLifecycle(target) {
  const taskId = String(target.taskId);

  // --- 1. START ---------------------------------------------------------------------
  let first;
  try {
    const statusBefore = await api.previewStatus(taskId);
    const started = await api.previewStart(taskId);
    first = started.preview;
    const answers = first?.previewUrl === null || first?.previewUrl === undefined ? null : await statusOf(first.previewUrl);
    const unknown = await api.previewStatus('task-does-not-exist');
    const sources = Array.isArray(first?.sources) ? first.sources : [];
    const skipped = Array.isArray(first?.skipped) ? first.skipped : [];
    item(
      1,
      "START: POST /api/preview/:taskId/start becomes 'running' and previewUrl answers real HTTP",
      started.status === 200 &&
        first?.state === 'running' &&
        first?.available === true &&
        answers !== null &&
        answers < 400 &&
        sources.length === 3 &&
        skipped.length === 0 &&
        unknown.status === 404,
      `GET ${api.base}/preview/${taskId} ; POST ${api.base}/preview/${taskId}/start ; GET <previewUrl> ; GET ${api.base}/preview/task-does-not-exist`,
      JSON.stringify({
        before: { httpStatus: statusBefore.status, preview: statusBefore.preview },
        startHttpStatus: started.status,
        after: first,
        previewUrlHttpStatus: answers,
        mergedSources: sources,
        skipped,
        unknownTask: { httpStatus: unknown.status, body: unknown.body },
      }),
      { taskId },
    );
  } catch (error) {
    fatal(1, 'START', `POST ${api.base}/preview/${taskId}/start`, error);
    return;
  }
  if (first?.state !== 'running' || first?.previewUrl === null || first?.previewUrl === undefined) {
    item(2, 'CLIENT: skipped (the preview never reached running)', false, 'n/a', JSON.stringify(first));
    return;
  }
  const url = String(first.previewUrl);
  cleanup.push(async () => { await api.previewStop(taskId); });

  // --- 2. CLIENT --------------------------------------------------------------------
  const page = await http(url);
  const bodyIsDeliveredSpa =
    page.text.includes('<canvas id="board"') &&
    page.text.includes('俄罗斯方块') &&
    page.text.includes('requestAnimationFrame') &&
    page.text.includes('ArrowLeft');
  item(
    2,
    'CLIENT: GET <previewUrl> serves the delivered SPA itself (not a screenshot/mock/placeholder)',
    page.status === 200 &&
      String(page.headers['content-type'] ?? '').includes('text/html') &&
      bodyIsDeliveredSpa &&
      page.text.length > 5_000,
    `GET ${url}`,
    JSON.stringify({
      httpStatus: page.status,
      contentType: page.headers['content-type'],
      bytes: Buffer.byteLength(page.text, 'utf8'),
      hasCanvasBoard: page.text.includes('<canvas id="board"'),
      hasTetrisScript: page.text.includes('requestAnimationFrame'),
      hasMandateText: page.text.includes('俄罗斯方块'),
      firstLine: page.text.split('\n')[0],
    }),
  );

  // --- 3. BACKEND -------------------------------------------------------------------
  const health = await http(new URL('/api/health', url).href);
  const play = await http(new URL('/api/scores', url).href, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ player: 'verify-ada', score: 260, lines: 8 }),
  });
  const board = await http(new URL('/api/scores?limit=10', url).href);
  const recorded = Array.isArray(board.body?.scores) && board.body.scores.some((row) => row.player === 'verify-ada' && Number(row.score) === 260);
  item(
  3,
    'BACKEND: the delivered python service is really running (/api/health, POST /api/scores 201 + rank, GET leaderboard)',
    health.status === 200 &&
      health.body?.ok === true &&
      play.status === 201 &&
      typeof play.body?.rank === 'number' &&
      board.status === 200 &&
      recorded,
    `GET ${url}api/health ; POST ${url}api/scores ; GET ${url}api/scores?limit=10`,
    JSON.stringify({ health: { status: health.status, body: health.body }, post: { status: play.status, body: play.body }, leaderboard: { status: board.status, body: board.body } }),
  );

  // --- 4. GAMEPLAY ------------------------------------------------------------------
  await verifyGameplay(url, play.body?.rank);

  // --- 5. STOP ----------------------------------------------------------------------
  const stopBegan = Date.now();
  const stopped = await api.previewStop(taskId);
  const stopMs = Date.now() - stopBegan;
  const statusAfterStop = await api.previewStatus(taskId);
  // Poll the old port for a few seconds: "stopped" must mean the port is really free, not that a
  // kill was attempted.
  const poll = [];
  let stillAnswering = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(300);
    const status = await statusOf(url, 1_000);
    poll.push({ atMs: Date.now() - stopBegan, status });
    if (status !== null) stillAnswering = Date.now() - stopBegan;
    else break;
  }
  item(
    5,
    "STOP: POST /api/preview/:taskId/stop frees the port and the next status is 'stopped'",
    stopped.status === 200 &&
      (stopped.preview?.state === 'stopped' || statusAfterStop.preview?.state === 'stopped') &&
      stillAnswering === null,
    `POST ${api.base}/preview/${taskId}/stop ; poll GET ${url} until it stops answering ; GET ${api.base}/preview/${taskId}`,
    JSON.stringify({
      stopHttpStatus: stopped.status,
      stopPreview: stopped.preview,
      stopDurationMs: stopMs,
      portPollAfterStop: poll,
      portStillAnsweredForMsAfterStop: stillAnswering,
      nextStatus: statusAfterStop.preview,
    }),
  );

  // --- 6. RERUN ---------------------------------------------------------------------
  const second = await api.previewStart(taskId);
  const secondUrl = second.preview?.previewUrl ?? null;
  const secondPage = secondUrl === null ? null : await http(secondUrl);
  const secondHealth = secondUrl === null ? null : await http(new URL('/api/health', secondUrl).href);
  item(
    6,
    'RERUN: start after stop returns running on a fresh URL/port and still serves the game',
    second.status === 200 &&
      second.preview?.state === 'running' &&
      secondUrl !== null &&
      secondUrl !== url &&
      secondPage?.status === 200 &&
      secondPage.text.includes('<canvas id="board"') &&
      secondHealth?.body?.ok === true,
    `POST ${api.base}/preview/${taskId}/start ; GET ${String(secondUrl)} ; GET ${String(secondUrl)}api/health`,
    JSON.stringify({
      startHttpStatus: second.status,
      state: second.preview?.state,
      firstUrl: url,
      secondUrl,
      freshPort: secondUrl !== url,
      secondPageStatus: secondPage?.status ?? null,
      secondPageHasBoard: secondPage?.text.includes('<canvas id="board"') ?? null,
      secondHealth: secondHealth?.body ?? null,
    }),
  );

  // --- 7a. NON-BLOCKING (running) ---------------------------------------------------
  await verifyNonBlocking(taskId, secondUrl);

  // leave nothing running
  await api.previewStop(taskId);
}

/* --- The engine harness: run the DELIVERED client script with no browser ------------------ */

/**
 * A minimal PNG writer (no dependency), used only to visualise the grid the delivered engine
 * drew. `zlib` and a CRC table are all a PNG needs.
 */
function pngBytes(width, height, rgba) {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc32 = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Draw the recorded cells so a reader can see the board the engine produced. */
async function writeBoardPng(file, cells, width = 240, height = 480, block = 24) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = 16;
    rgba[index * 4 + 1] = 20;
    rgba[index * 4 + 2] = 28;
    rgba[index * 4 + 3] = 255;
  }
  for (const [key, color] of cells) {
    const [col, row] = key.split(',').map(Number);
    const hex = /^#([0-9a-f]{6})$/i.exec(String(color));
    const red = hex === null ? 255 : parseInt(hex[1].slice(0, 2), 16);
    const green = hex === null ? 255 : parseInt(hex[1].slice(2, 4), 16);
    const blue = hex === null ? 255 : parseInt(hex[1].slice(4, 6), 16);
    for (let y = row * block; y < Math.min(height, row * block + block - 1); y += 1) {
      for (let x = col * block; x < Math.min(width, col * block + block - 1); x += 1) {
        const index = (y * width + x) * 4;
        rgba[index] = red;
        rgba[index + 1] = green;
        rgba[index + 2] = blue;
      }
    }
  }
  await writeFile(file, pngBytes(width, height, rgba));
  return file;
}

/**
 * Execute the delivered page's own `<script type="module">` in a `vm` context with a recording 2D
 * context, and drive it with the page's own keydown handler.
 *
 * This is a SUBSTITUTE for a browser run, and is labelled as one everywhere it appears: it is not
 * a screenshot of a page and not GPU pixels. What it does prove is that the delivered game code —
 * byte-for-byte the module the preview served — is alive and controllable, and that its own score
 * reporting reaches the delivered service over real HTTP.
 */
async function createEngineClient(url) {
  const page = await http(url);
  const match = /<script type="module">([\s\S]*?)<\/script>/.exec(page.text);
  if (match === null) throw new Error('the delivered page has no module script');
  const handlers = { keydown: [] };
  const boardCells = new Map();
  const nextCells = new Map();
  const fetchCalls = [];
  let rafCallback = null;
  let now = 0;

  const contextFor = (cells, block, originX = 0, originY = 0) => ({
    fillStyle: null,
    fillRect(x, y, w, h) {
      if (x === 0 && y === 0 && w === 240 && h === 480) {
        cells.clear();
        return;
      }
      if (x === 0 && y === 0 && w === 88 && h === 88) {
        cells.clear();
        return;
      }
      const col = Math.round((x - originX) / block);
      const row = Math.round((y - originY) / block);
      cells.set(`${String(col)},${String(row)}`, this.fillStyle);
    },
  });

  const boardCtx = contextFor(boardCells, 24);
  const nextCtx = contextFor(nextCells, 16);
  const elements = new Map([
    ['board', { id: 'board', width: 240, height: 480, getContext: () => boardCtx, addEventListener: () => undefined }],
    ['next', { id: 'next', width: 88, height: 88, getContext: () => nextCtx }],
    ['score', { id: 'score', textContent: '0' }],
    ['lines', { id: 'lines', textContent: '0' }],
    ['status', { id: 'status', textContent: '' }],
    ['player', { id: 'player', value: '' }],
    ['board-status', { id: 'board-status', textContent: '' }],
  ]);
  const listChildren = [];
  const list = {
    id: 'board-list',
    get innerHTML() {
      return '';
    },
    set innerHTML(_value) {
      listChildren.length = 0;
    },
    appendChild(child) {
      listChildren.push(child);
    },
  };
  elements.set('board-list', list);

  const sandbox = {
    console,
    location: { protocol: 'http:', host: new URL(url).host, href: url, origin: new URL(url).origin },
    document: {
      getElementById: (id) => elements.get(id) ?? null,
      addEventListener: (type, handler) => {
        (handlers[type] ??= []).push(handler);
      },
      createElement: () => ({ textContent: '', style: {} }),
      body: { focus: () => undefined },
    },
    requestAnimationFrame: (callback) => {
      rafCallback = callback;
      return 1;
    },
    fetch: (input, init) => {
      const promise = fetch(new URL(String(input), url).href, init);
      fetchCalls.push(promise);
      return promise;
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(match[1], sandbox, { filename: 'delivered-client-index.html.module.js' });

  const read = () => {
    const rows = [];
    let occupied = 0;
    for (let row = 0; row < 20; row += 1) {
      let line = '';
      for (let col = 0; col < 10; col += 1) {
        const value = boardCells.has(`${String(col)},${String(row)}`) ? '1' : '0';
        line += value;
        if (value === '1') occupied += 1;
      }
      rows.push(line);
    }
    return {
      grid: rows,
      occupied,
      score: elements.get('score').textContent,
      lines: elements.get('lines').textContent,
      status: elements.get('status').textContent,
      boardStatus: elements.get('board-status').textContent,
      boardList: listChildren.map((child) => child.textContent),
    };
  };

  return {
    read,
    cells: boardCells,
    /** Advance the delivered requestAnimationFrame loop by `ms`, in 100 ms frames. */
    tick(ms) {
      for (let elapsed = 0; elapsed < ms; elapsed += 100) {
        now += 100;
        const callback = rafCallback;
        rafCallback = null;
        if (callback !== null) callback(now);
      }
    },
    /** Dispatch a keydown exactly as the page's own listener receives it. */
    press(key) {
      for (const handler of handlers.keydown) handler({ key, preventDefault: () => undefined });
    },
    /** Let the delivered fetch calls settle (the leaderboard reads and the score POST). */
    async settle() {
      for (let round = 0; round < 4; round += 1) {
        await Promise.allSettled([...fetchCalls, new Promise((resolve) => setTimeout(resolve, 30))]);
      }
    },
    hasScoreHook: typeof sandbox.maoehScore === 'function',
    fetchCount: () => fetchCalls.length,
  };
}

/** Item 4 with no browser available: the delivered client script, executed and driven directly. */
async function verifyGameplayInEngine(url) {
  const engine = await createEngineClient(url);
  await engine.settle();
  const loaded = engine.read();
  const loadedPng = await writeBoardPng(path.join(OUT, `gameplay-reconstructed-1-loaded-${MODE}.png`), engine.cells);

  // (a) the delivered loop runs by itself
  engine.tick(2_000);
  const afterIdle = engine.read();
  const loopAlive = afterIdle.grid.join('') !== loaded.grid.join('') && afterIdle.occupied > 0;

  // (b) ArrowLeft / ArrowRight move the falling piece by exactly one column
  engine.press('r');
  const before = engine.read();
  const beforeCols = columns(topCells(before.grid));
  engine.press('ArrowLeft');
  const afterLeft = engine.read();
  const leftCols = columns(topCells(afterLeft.grid));
  engine.press('ArrowRight');
  const afterRight = engine.read();
  const rightCols = columns(topCells(afterRight.grid));
  const leftShift = beforeCols.length > 0 && leftCols.length > 0 ? Math.min(...leftCols) - Math.min(...beforeCols) : null;
  const rightShift = rightCols.length > 0 && leftCols.length > 0 ? Math.min(...rightCols) - Math.min(...leftCols) : null;

  // (c) ArrowUp rotates, retried over fresh pieces (the O piece is invariant)
  const rotations = [];
  let rotationProven = false;
  for (let attempt = 0; attempt < 8 && !rotationProven; attempt += 1) {
    engine.press('r');
    const reset = engine.read();
    const beforeShape = shapeKey(topCells(reset.grid));
    engine.press('ArrowUp');
    const after = engine.read();
    const afterShape = shapeKey(topCells(after.grid));
    rotations.push({ beforeShape, afterShape, changed: beforeShape !== afterShape });
    if (beforeShape !== afterShape) rotationProven = true;
  }

  // (d) Space hard-drops: the stack grows under the piece
  engine.press('r');
  const beforeDrops = engine.read();
  const stackBefore = stackHeight(beforeDrops.grid);
  for (let drop = 0; drop < 3; drop += 1) engine.press(' ');
  const afterDrops = engine.read();
  const stackAfter = stackHeight(afterDrops.grid);
  const gameplayPng = await writeBoardPng(path.join(OUT, `gameplay-reconstructed-2-after-input-${MODE}.png`), engine.cells);

  // (e) keyboard-only play to game over; the delivered page then posts its own score
  let gameOver = false;
  for (let attempt = 0; attempt < 60 && !gameOver; attempt += 1) {
    engine.press(' ');
    gameOver = String(engine.read().status ?? '').includes('Game Over');
  }
  await engine.settle();
  const finalState = engine.read();
  const gameOverPng = await writeBoardPng(path.join(OUT, `gameplay-reconstructed-3-game-over-${MODE}.png`), engine.cells);
  const board = await http(new URL('/api/scores?limit=10', url).href);
  const pagePostedPlay =
    Array.isArray(board.body?.scores) &&
    board.body.plays >= 2 &&
    board.body.scores.some((row) => row.player === 'Player');

  const pass =
    loaded.occupied > 0 &&
    loopAlive &&
    leftShift === -1 &&
    rightShift === 1 &&
    rotationProven &&
    stackAfter > stackBefore &&
    gameOver &&
    pagePostedPlay &&
    engine.hasScoreHook &&
    engine.fetchCount() >= 3;
  return {
    pass,
    evidence: {
      substituteFor: 'a real browser run (Chrome cannot start in this session: see the browser item)',
      howItWasRun: 'the delivered <script type="module"> from the preview URL, executed unmodified in node:vm with a recording 2D context; requestAnimationFrame timestamps and keydown events supplied by the harness; fetch pointed at the live preview service',
      reconstructedImages: { loaded: loadedPng, afterInput: gameplayPng, gameOver: gameOverPng },
      initialOccupiedCells: loaded.occupied,
      loopAliveWithoutInput: { occupiedBefore: loaded.occupied, occupiedAfter: afterIdle.occupied, changed: loopAlive },
      move: { beforeColumns: beforeCols, afterArrowLeft: leftCols, afterArrowRight: rightCols, leftShift, rightShift },
      rotations,
      hardDrop: { stackHeightBefore: stackBefore, stackHeightAfter: stackAfter, gridAfterDrops: afterDrops.grid },
      gameOver,
      finalHud: { score: finalState.score, lines: finalState.lines, status: finalState.status, boardStatus: finalState.boardStatus, boardList: finalState.boardList },
      leaderboardAfterEnginePlay: board.body,
      deliveredScoreHookPresent: engine.hasScoreHook,
      fetchCallsMadeByTheDeliveredPage: engine.fetchCount(),
    },
  };
}

/** Item 4: a real browser drives the real page; the pixels must change under input. */
async function attemptBrowserGameplay(url, recordedRank) {
  const chromePath = findChrome();
  const cdpPort = await pickBindablePort(9500 + Math.floor(Math.random() * 300));
  const profile = path.join(OUT, `chrome-profile-${MODE}`);
  const chromeLog = path.join(OUT, `chrome-${MODE}.err`);
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  // The browser's own stderr goes to a file descriptor, not a pipe: this host cannot open named
  // pipes for a child process, and the log is exactly the evidence needed when it cannot start.
  const logFd = openSync(chromeLog, 'w');
  chrome = spawn(
    chromePath,
    [
      // `--headless=new` is rejected by Chrome 134 (it becomes a positional target and trips
      // "Multiple targets are not supported in headless mode"); plain `--headless` is the new
      // headless mode since Chrome 132.
      '--headless',
      `--remote-debugging-port=${String(cdpPort)}`,
      `--user-data-dir=${profile}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--enable-logging=stderr',
      '--window-size=1440,960',
      'about:blank',
    ],
    { stdio: ['ignore', logFd, logFd] },
  );
  cleanup.push(() => {
    stopTree(chrome);
    try {
      closeSync(logFd);
    } catch {
      /* already closed */
    }
  });

  const version = await (async () => {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        return await (await fetch(`http://127.0.0.1:${String(cdpPort)}/json/version`)).json();
      } catch {
        if (chrome.exitCode !== null) {
          throw new Error(`the browser exited with code ${String(chrome.exitCode)} before DevTools answered; stderr: ${readChromeLog(chromeLog)}`);
        }
        if (Date.now() > deadline) throw new Error(`chrome devtools never answered; stderr: ${readChromeLog(chromeLog)}`);
        await sleep(300);
      }
    }
  })();
  log(`[gameplay] browser: ${String(version['Browser'])} (${chromePath})`);

  const target = await (
    await fetch(`http://127.0.0.1:${String(cdpPort)}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  ).json();
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  cleanup.push(() => cdp?.close());
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // Record page errors before the document loads, so a broken delivered page cannot pass by
  // staying quiet.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => { window.__pageErrors = []; window.addEventListener('error', (e) => window.__pageErrors.push('error: ' + e.message)); window.addEventListener('unhandledrejection', (e) => window.__pageErrors.push('rejection: ' + String(e.reason))); return true; })()`,
  });
  await cdp.send('Page.reload', { ignoreCache: true });
  await cdp.waitFor(`document.getElementById('board') !== null`, 'the delivered #board canvas');
  await cdp.send('Page.bringToFront');
  await cdp.evaluate(`window.dispatchEvent(new Event('focus')); document.body.focus(); true`);

  const press = async (key, code, virtualKeyCode) => cdp.key(key, code, virtualKeyCode);
  const restart = async () => {
    await press('r', 'KeyR', 82);
    await sleep(120);
    return cdp.evaluate(READ_BOARD);
  };

  const loaded = await cdp.evaluate(READ_BOARD);
  const loadedShot = await cdp.screenshot(path.join(OUT, `gameplay-1-loaded-${MODE}.png`));

  // (a) the loop runs by itself: the falling piece moves with no input at all
  await sleep(1_800);
  const afterIdle = await cdp.evaluate(READ_BOARD);
  const loopAlive = afterIdle.grid.join('') !== loaded.grid.join('') && afterIdle.occupied > 0;

  // (b) ArrowLeft / ArrowRight move the falling piece by exactly one column. `R` resets the
  //     board first, so the piece is alone on the grid and its columns are unambiguous.
  const before = await restart();
  const beforeCols = columns(topCells(before.grid));
  await press('ArrowLeft', 'ArrowLeft', 37);
  const afterLeft = await cdp.evaluate(READ_BOARD);
  const leftCols = columns(topCells(afterLeft.grid));
  await press('ArrowRight', 'ArrowRight', 39);
  const afterRight = await cdp.evaluate(READ_BOARD);
  const rightCols = columns(topCells(afterRight.grid));
  const leftShift = beforeCols.length > 0 && leftCols.length > 0 ? Math.min(...leftCols) - Math.min(...beforeCols) : null;
  const rightShift = rightCols.length > 0 && leftCols.length > 0 ? Math.min(...rightCols) - Math.min(...leftCols) : null;

  // (c) ArrowUp rotates: retried over fresh pieces, because one tetromino (O) is invariant under
  //     rotation, so a single unchanged reading would prove nothing.
  const rotations = [];
  let rotationProven = false;
  for (let attempt = 0; attempt < 8 && !rotationProven; attempt += 1) {
    const reset = await restart();
    const beforeShape = shapeKey(topCells(reset.grid));
    await press('ArrowUp', 'ArrowUp', 38);
    const after = await cdp.evaluate(READ_BOARD);
    const afterShape = shapeKey(topCells(after.grid));
    const changed = beforeShape !== afterShape;
    rotations.push({ beforeShape, afterShape, changed });
    if (changed) rotationProven = true;
  }

  // (d) Space hard-drops: the piece leaves the top and the stack grows under it
  await restart();
  const beforeDrops = await cdp.evaluate(READ_BOARD);
  const stackBefore = stackHeight(beforeDrops.grid);
  for (let drop = 0; drop < 3; drop += 1) {
    await press(' ', 'Space', 32);
    await sleep(150);
  }
  await sleep(300);
  const afterDrops = await cdp.evaluate(READ_BOARD);
  const stackAfter = stackHeight(afterDrops.grid);
  const gameplayShot = await cdp.screenshot(path.join(OUT, `gameplay-2-after-input-${MODE}.png`));

  // (e) play to game over with the keyboard only: the delivered page then posts its own score to
  //     the delivered service, which proves the SPA and the backend are one running product.
  let gameOver = false;
  for (let attempt = 0; attempt < 40 && !gameOver; attempt += 1) {
    await press(' ', 'Space', 32);
    await sleep(120);
    const state = await cdp.evaluate(READ_BOARD);
    gameOver = String(state.status ?? '').includes('Game Over');
  }
  await sleep(1_500);
  const finalState = await cdp.evaluate(READ_BOARD);
  const gameOverShot = await cdp.screenshot(path.join(OUT, `gameplay-3-game-over-${MODE}.png`));
  const pageErrors = await cdp.evaluate(`window.__pageErrors ?? []`);

  // The play the page posted by itself must appear in the service's leaderboard. The rank banner
  // is transient (the page immediately re-reads the board and replaces it), so the durable proof
  // is the recorded row plus the page's own counts.
  const board = await http(new URL('/api/scores?limit=10', url).href);
  const pagePostedPlay =
    Array.isArray(board.body?.scores) &&
    board.body.plays >= 2 &&
    board.body.scores.some((row) => row.player === 'Player');

  const pass =
    loaded.occupied > 0 &&
    loopAlive &&
    leftShift === -1 &&
    rightShift === 1 &&
    rotationProven &&
    stackAfter > stackBefore &&
    gameOver &&
    pagePostedPlay &&
    pageErrors.length === 0;

  return {
    pass,
    browser: String(version['Browser']),
    command: `"${chromePath}" --headless + CDP Input.dispatchKeyEvent ArrowLeft/ArrowRight/ArrowUp/Space/R on ${url}`,
    evidence: {
      chrome: String(version['Browser']),
      chromePath,
      screenshots: { loaded: loadedShot, afterInput: gameplayShot, gameOver: gameOverShot },
      initialOccupiedCells: loaded.occupied,
      loopAliveWithoutInput: { occupiedBefore: loaded.occupied, occupiedAfter: afterIdle.occupied, changed: loopAlive },
      restartResetScore: { score: before.score, lines: before.lines, stackHeight: stackHeight(before.grid) },
      move: { beforeColumns: beforeCols, afterArrowLeft: leftCols, afterArrowRight: rightCols, leftShift, rightShift },
      rotations,
      hardDrop: { stackHeightBefore: stackBefore, stackHeightAfter: stackAfter, gridAfterDrops: afterDrops.grid },
      gameOver,
      finalHud: { score: finalState.score, lines: finalState.lines, status: finalState.status, boardStatus: finalState.boardStatus, boardList: finalState.boardList },
      directPlayRecordedEarlierRank: recordedRank ?? null,
      leaderboardAfterBrowserPlay: board.body,
      pageErrors,
    },
  };
}

/**
 * Item 4: prove the delivered game is alive and controllable.
 *
 * A real browser is the honest instrument and is tried first. When this host cannot start one
 * (a confined session denies Chrome its crashpad `OpenProcess` and its named-pipe IPC), the raw
 * browser failure is kept as evidence and the delivered client script is instead executed
 * unmodified and driven directly — reported as SUBSTITUTE, never as a browser run.
 */
async function verifyGameplay(url, recordedRank) {
  let browserResult;
  let browserError;
  try {
    browserResult = await attemptBrowserGameplay(url, recordedRank);
    if (browserResult.pass) {
      item(4, 'GAMEPLAY: the delivered page is alive and controllable in a real browser (rendered pixels change under keys)', true, browserResult.command, JSON.stringify(browserResult.evidence));
      return;
    }
    browserError = `the browser drove the page but the assertions did not hold: ${JSON.stringify(browserResult.evidence)}`;
  } catch (error) {
    browserError = error instanceof Error ? error.message : String(error);
  }
  log(`[gameplay] a real browser could not run here: ${browserError}`);
  await stopTree(chrome);

  const engine = await verifyGameplayInEngine(url);
  item(
    4,
    'GAMEPLAY (SUBSTITUTE — a real browser cannot start in this session): the delivered client script, executed unmodified, is alive and controllable and reaches the delivered service',
    engine.pass ? 'substitute' : false,
    `node scripts/verify-preview.mjs --mode=${MODE} (engine fallback) ; for the real browser: run this same command outside the DSH sandbox — "${findChrome()}" --headless + CDP on ${url}`,
    JSON.stringify({ browserAttempt: { failed: true, reason: browserError, chromeStderrTail: readChromeLog(path.join(OUT, `chrome-${MODE}.err`), 6) }, ...engine.evidence }),
  );
}

/** Item 7: the normal API stays responsive while a preview starts and while one runs. */
async function verifyNonBlocking(taskId, runningUrl) {
  const endpoints = ['/snapshot', '/tasks', '/workflows'];
  const probe = async (label) => {
    const results = await Promise.all(endpoints.map(async (endpoint) => {
      const response = await api.get(endpoint);
      return { endpoint, status: response.status, ms: response.ms };
    }));
    const allOk = results.every((result) => result.status === 200 && result.ms < 2_000);
    return { label, allOk, results, slowestMs: Math.max(...results.map((result) => result.ms)) };
  };

  // Stop whatever item 6 left running, so the next start really goes through 'starting' rather
  // than returning an already-running instance immediately.
  await api.previewStop(taskId);

  // Observe the state while the start is in flight, and hit the normal API at the same time.
  const observedStates = [];
  let watching = true;
  let startResolvedAt = null;
  const watcher = (async () => {
    while (watching) {
      const response = await api.previewStatus(taskId);
      observedStates.push(String(response.preview?.state ?? 'unknown'));
      await sleep(60);
    }
  })();
  const probeBeganAt = Date.now();
  const starting = api.previewStart(taskId).then((value) => {
    startResolvedAt = Date.now();
    return value;
  });
  const duringStart = await probe('while a preview start is in flight');
  const probeEndedAt = Date.now();
  const settled = await starting;
  watching = false;
  await watcher;
  const startDurationMs = startResolvedAt - probeBeganAt;
  const overlappedTheStart = startResolvedAt === null || startResolvedAt >= probeBeganAt;
  const whileRunning = await probe(`while a preview is running (${String(settled.preview?.previewUrl ?? runningUrl)})`);

  // A report-only delivery: starting it must not be attempted, and the API stays fast.
  const injected = await api.post('/command', {
    commandId: `verify-inject-${String(Date.now())}`,
    commandType: 'Organization.InjectTask',
    actor: { operatorId: 'ceo-alex', displayName: 'Alex', positionId: 'ceo', kind: 'human' },
    target: { targetType: 'organization', targetId: 'future-ai-lab' },
    positionId: 'ceo',
    title: 'Churn driver brief',
    goal: 'Publish a written churn driver analysis with sources',
    reason: 'preview verification: a delivery that is not a web app',
    correlationId: `verify-inject-${String(Date.now())}`,
    causationId: null,
    createdAtSim: 0,
  });
  let docTask = null;
  const deadline = Date.now() + 90_000;
  for (;;) {
    const list = await listTasks();
    const found = list.find((task) => task.title === 'Churn driver brief' && task.status === 'completed');
    if (found !== undefined) {
      docTask = (await api.get(`/tasks/${encodeURIComponent(found.taskId)}`)).body;
      break;
    }
    if (Date.now() > deadline) break;
    await sleep(500);
  }
  let docPreview = null;
  let docProbe = null;
  let docStarted = { status: 0, body: null };
  if (docTask !== null) {
    docPreview = await api.previewStatus(String(docTask.taskId));
    docStarted = await api.previewStart(String(docTask.taskId));
    docProbe = await probe('while a report-only delivery is inspected');
  }
  const docEffective = docTask === null ? null : await api.previewStatus(String(docTask.taskId));

  const pass =
    duringStart.allOk &&
    overlappedTheStart &&
    whileRunning.allOk &&
    settled.preview?.state === 'running' &&
    docTask !== null &&
    docPreview?.preview?.available === false &&
    docPreview?.preview?.state === 'stopped' &&
    docStarted.status === 422 &&
    docProbe.allOk;

  item(
    7,
    'NON-BLOCKING: /api/snapshot, /api/tasks, /api/workflows stay 200 and fast while a preview starts/runs, and a report-only delivery is available:false (422 on start)',
    pass,
    `concurrent GET ${endpoints.map((endpoint) => api.base + endpoint).join(' , ')} ; GET+POST ${api.base}/preview/<report-only task>`,
    JSON.stringify({
      duringStart,
      startOverlap: { probeBeganAt, probeEndedAt, startResolvedAt, startDurationMs, probeWasInsideTheStartingWindow: overlappedTheStart },
      previewStatesObservedWhileStarting: [...new Set(observedStates)],
      observation:
        "the runtime's 'starting' state was never observable over HTTP: while a start is in flight the instance is not yet in the runtime's map, so GET /api/preview/:taskId answers the re-planned 'stopped' status, and POST /start only answers once the run is ready or failed. A console that renders 'starting' from polling will not see it.",
      startSettled: settled.preview,
      whileRunning,
      injectedCommand: { httpStatus: injected.status, body: injected.body },
      reportOnlyTask: docTask === null ? null : {
        taskId: docTask.taskId,
        artifacts: docTask.result?.artifacts ?? null,
        dataKeys: docTask.result?.data ? Object.keys(docTask.result.data) : null,
        hasFiles: Array.isArray(docTask.result?.data?.files),
      },
      reportOnlyPreview: docPreview?.preview ?? null,
      reportOnlyStartAttempt: { httpStatus: docStarted.status, body: docStarted.body },
      reportOnlyProbe: docProbe,
      reportOnlyPreviewAgain: docEffective?.preview ?? null,
    }),
  );
}

/** Item 8: the existing delivery/download surface still carries every byte. */
async function verifyDownloads(tetrisTasks) {
  const rows = [];
  let totalBytes = 0;
  let allBytesMatch = true;
  for (const record of tetrisTasks) {
    const files = record.result?.data?.files ?? [];
    const artifacts = record.result?.artifacts ?? [];
    const detail = [];
    for (const file of files) {
      const bytes = Buffer.byteLength(String(file.content ?? ''), 'utf8');
      totalBytes += bytes;
      const disk = path.join(ROOT, 'deliverables', 'ss-tetris', ...String(file.path).split('/'));
      const onDisk = existsSync(disk) ? Buffer.byteLength(await readFile(disk, 'utf8'), 'utf8') : null;
      if (onDisk === null || onDisk !== bytes) allBytesMatch = false;
      detail.push({ path: file.path, language: file.language, bytes, diskBytes: onDisk, entrypoint: record.result?.data?.entrypoint === file.path });
    }
    rows.push({ taskId: record.taskId, title: record.title, artifacts, files: detail, artifactsCoverFiles: files.every((file) => artifacts.includes(file.path)) });
  }
  const union = rows.flatMap((row) => row.files.map((file) => file.path));
  item(
    8,
    'DOWNLOADS INTACT: GET /api/tasks/:id still carries every delivered file with its bytes, and result.artifacts lists them',
    rows.length === 3 && union.length === 6 && new Set(union).size === 6 && allBytesMatch && rows.every((row) => row.artifactsCoverFiles),
    `GET ${api.base}/tasks/task-1|task-2|task-3`,
    JSON.stringify({ perTask: rows, unionFiles: union, distinct: new Set(union).size, totalBytes, allBytesMatchOnDiskArtifact: allBytesMatch }),
  );
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Item 9: a delivered entry that dies immediately must be a reported failure, not a leak. */
async function verifyFailurePath(target) {
  const taskId = String(target.taskId);
  let started;
  try {
    started = await api.previewStart(taskId);
  } catch (error) {
    fatal(9, 'FAILURE PATH', `POST ${api.base}/preview/${taskId}/start`, error);
    return;
  }
  const health = await Promise.all(['/snapshot', '/tasks', '/workflows'].map(async (endpoint) => {
    const response = await api.get(endpoint);
    return { endpoint, status: response.status, ms: response.ms };
  }));
  const statusAfter = await api.previewStatus(taskId);
  const workRoot = path.join(ROOT, '.maoeh', 'preview');
  const dirs = await readdir(workRoot).catch(() => []);
  const leftover = dirs.filter((entry) => entry.includes(taskId.replace(/[^A-Za-z0-9._-]+/g, '_')));

  item(
    9,
    "FAILURE PATH: an entry point that exits immediately becomes state 'failed' with a non-empty error, the API stays healthy, and the failed attempt leaves no work directory",
    started.status === 200 &&
      started.preview?.state === 'failed' &&
      started.preview?.available === true &&
      typeof started.preview?.error === 'string' &&
      started.preview.error.length > 0 &&
      started.preview?.previewUrl === null &&
      health.every((result) => result.status === 200 && result.ms < 2_000) &&
      leftover.length === 0,
    `POST ${api.base}/preview/${taskId}/start ; GET ${api.base}/preview/${taskId} ; GET ${api.base}/snapshot,/tasks,/workflows ; ls .maoeh/preview`,
    JSON.stringify({
      startHttpStatus: started.status,
      startPreview: started.preview,
      statusAfterFailedStart: statusAfter.preview,
      note: 'the failure is not sticky: the next GET re-plans the delivery and reports it as available/stopped, which is what a retry button needs',
      apiHealthAfterFailure: health,
      previewWorkDirs: dirs,
      leftoverWorkDirsForTask: leftover,
      deliveredEntryHead: (target.result?.data?.files ?? []).find((file) => file.path === 'server/app.py')?.content?.split('\n').slice(0, 10),
    }),
  );

  // The orphan guard: a work directory left behind by a previous API process carries a pid marker,
  // and constructing a new PreviewRuntime must kill that pid and remove the directory. The pid is
  // a live process this harness spawns, so the check cannot pass vacuously.
  const guardDir = path.join(workRoot, 'orphan-guard-probe');
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await mkdir(guardDir, { recursive: true });
  await writeFile(path.join(guardDir, 'preview.pid'), String(sleeper.pid), 'utf8');
  const sleeperAliveBefore = isAlive(sleeper.pid);
  const secondApi = await Api.boot(SEED_LOG_NAME);
  await sleep(1_000);
  const sleeperAliveAfter = isAlive(sleeper.pid);
  const guardDirGone = !existsSync(guardDir);
  stopTree(secondApi.child);
  if (sleeperAliveAfter) {
    try {
      process.kill(sleeper.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  item(
    '9b',
    'ORPHAN GUARD: constructing a new PreviewRuntime kills a pid left in .maoeh/preview/<task>/preview.pid and removes that directory',
    sleeperAliveBefore && !sleeperAliveAfter && guardDirGone,
    `spawn a sleeper, write .maoeh/preview/orphan-guard-probe/preview.pid = <pid>, boot a second API (new PreviewRuntime), check the pid and the directory`,
    JSON.stringify({
      sleeperPid: sleeper.pid,
      aliveBefore: sleeperAliveBefore,
      aliveAfter: sleeperAliveAfter,
      directoryRemoved: guardDirGone,
      remainingPreviewWorkDirs: await readdir(workRoot).catch(() => []),
      note: 'the reaping kill goes through the same taskkill path as stop (see item 5)',
    }),
  );
}

/** Item 7 (report-only half): a delivery with no web entry point is `available:false`. */
async function verifyUnavailable(target) {
  const taskId = String(target.taskId);
  const status = await api.previewStatus(taskId);
  const started = await api.previewStart(taskId);
  const probe = await Promise.all(['/snapshot', '/tasks', '/workflows'].map(async (endpoint) => {
    const response = await api.get(endpoint);
    return { endpoint, status: response.status, ms: response.ms };
  }));
  const deliveredFiles = (target.result?.data?.files ?? []).map((file) => file.path);
  item(
    7,
    'NON-BLOCKING (report-only delivery): available:false, no process started, API still 200/fast',
    status.status === 200 &&
      status.preview?.available === false &&
      status.preview?.state === 'stopped' &&
      probe.every((result) => result.status === 200 && result.ms < 2_000),
    `GET ${api.base}/preview/${taskId} ; POST ${api.base}/preview/${taskId}/start ; concurrent GET /snapshot,/tasks,/workflows`,
    JSON.stringify({ deliveredFiles, status: status.preview, startAttempt: { httpStatus: started.status, body: started.body }, probe }),
  );
}

/** Item 10: nothing in the implementation keys off the product name or a task id. */
async function verifyNoConstants() {
  const files = ['preview-plan.ts', 'preview-runtime.ts', 'api-adapter.ts', 'composition.ts'];
  const findings = [];
  for (const name of files) {
    const target = path.join(ROOT, 'apps', 'api', 'src', name);
    if (!existsSync(target)) {
      findings.push({ file: name, exists: false });
      continue;
    }
    const lines = (await readFile(target, 'utf8')).split(/\r?\n/);
    const nameHits = [];
    const taskIdHits = [];
    const portLiterals = [];
    const productEnvNames = [];
    const isComment = (line, index) => /^\s*(\*|\/\/|\/\*)/.test(line) || (line.indexOf('//') !== -1 && line.indexOf('//') < index);
    lines.forEach((line, lineIndex) => {
      for (const match of line.matchAll(/tetris|ss-tetris|俄罗斯方块/gi)) {
        nameHits.push({ line: lineIndex + 1, text: line.trim(), inComment: isComment(line, match.index ?? 0) });
      }
      for (const match of line.matchAll(/['"`]task-\d+['"`]/g)) {
        taskIdHits.push({ line: lineIndex + 1, text: line.trim(), inComment: isComment(line, match.index ?? 0) });
      }
      for (const match of line.matchAll(/(?:listen\s*\(\s*|PORT\s*(?:\?\?|=)\s*|:\s*)(\d{4,5})\b/g)) {
        const literal = { line: lineIndex + 1, text: line.trim(), value: Number(match[1]), inComment: isComment(line, match.index ?? 0) };
        portLiterals.push(literal);
      }
      if (/SCORES_DB|scores\.db/.test(line)) {
        productEnvNames.push({ line: lineIndex + 1, text: line.trim() });
      }
    });
    findings.push({
      file: name,
      exists: true,
      bytes: Buffer.byteLength(lines.join('\n'), 'utf8'),
      productNameHits: nameHits,
      productNameHitsInCode: nameHits.filter((hit) => !hit.inComment),
      hardcodedTaskIds: taskIdHits.filter((hit) => !hit.inComment),
      portLiterals,
      productSpecificNames: productEnvNames,
    });
  }
  const codeNameHits = findings.flatMap((finding) => finding.productNameHitsInCode ?? []);
  const codeTaskIds = findings.flatMap((finding) => finding.hardcodedTaskIds ?? []);
  // A port literal is only disqualifying when it is code that fixes a listen port. Comment lines
  // that document the *detection patterns* are prose, and `process.env.PORT ?? 8000` is a fallback
  // in a generated helper that this runtime always injects PORT into.
  const fixedPorts = findings.flatMap((finding) => (finding.portLiterals ?? []).filter((literal) =>
    !literal.inComment && !/process\.env\.PORT\s*\?\?\s*\d+/.test(literal.text) && literal.value !== 3001));
  const clean = codeNameHits.length === 0 && codeTaskIds.length === 0;
  item(
    10,
    'NO-CONSTANT check: no tetris/ss-tetris/taskId constant in code, and no fixed preview port',
    clean && fixedPorts.length === 0,
    `grep -in 'tetris|ss-tetris' + taskId-literal + port-literal scan over apps/api/src/{preview-plan,preview-runtime,api-adapter,composition}.ts`,
    JSON.stringify({
      verdict: {
        productNameMentionsAreAllInComments: findings.every((finding) => (finding.productNameHitsInCode ?? []).length === 0),
        codeProductNameHits: codeNameHits,
        codeTaskIdLiterals: codeTaskIds,
        disqualifyingPortLiterals: fixedPorts,
        freePortBindingPresent: (await readFile(path.join(ROOT, 'apps', 'api', 'src', 'preview-runtime.ts'), 'utf8')).includes('probe.listen(0'),
      },
      observations: [
        'preview-runtime.ts line ~688 sets SCORES_DB to <workdir>/data/scores.db: not a product name or a task id, but a constant about the shape of the platform-generated Python service (it assumes the delivered service reads SCORES_DB and keeps its DB at data/scores.db).',
        'preview-runtime.ts line ~768 defaults the generated static server to port 8000 when PORT is missing, but the runtime always injects PORT, so it is a fallback rather than a fixed preview port.',
        'composition.ts 3001 is the pre-existing API default port, untouched by this feature.',
      ],
      findings,
    }, null, 2),
  );
}

/* --- Run ----------------------------------------------------------------------------- */

try {
  await main();
} catch (error) {
  log(`[fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  for (const step of cleanup.reverse()) {
    try {
      await step();
    } catch {
      /* best effort */
    }
  }
  await sleep(500);
  stopTree(api?.child);
  await sleep(300);
  const report = {
    mode: MODE,
    startedAt,
    finishedAt: new Date().toISOString(),
    apiPort: api?.port ?? null,
    mandate: MANDATE,
    items,
    passed: items.filter((entry) => entry.pass).length,
    substitute: items.filter((entry) => entry.substitute).length,
    failed: items.filter((entry) => !entry.pass && !entry.substitute).length,
  };
  await writeFile(path.join(OUT, `verify-preview-${MODE}.json`), JSON.stringify(report, null, 2), 'utf8');
  log(`[done] mode=${MODE} passed=${String(report.passed)} substitute=${String(report.substitute)} failed=${String(report.failed)} report=.tmp-diag/e2e/verify-preview-${MODE}.json`);
  process.exit(report.failed === 0 && items.length > 0 ? 0 : 1);
}
