/**
 * Acceptance gate for "发起公司任务书 → 开始工作".
 *
 * The report this pins down: *"clicking Start Work leaves the page unchanged"*. The chain was
 * reaching the API the whole time — what was missing is the answer being on screen where the
 * operator is standing. So this gate asserts, on a real browser against the real API:
 *
 *   1. the click produces a visible state change in the brief panel within 1s (the inline
 *      submission report), before the first round trip has even answered;
 *   2. the report names the created brief and every work item by `taskId`;
 *   3. with "Pause at approval gates" checked, the runtime is held and the report says so
 *      (paused / pending approval) instead of leaving the form looking untouched;
 *   4. the task is visible on the Tasks page;
 *   5. an API that is down is reported verbatim — no silent failure, no fake success;
 *   6. the browser console stays clean.
 *
 * Run: node tests/e2e/startwork-probe.mjs
 *
 * Child processes write to log files instead of pipes: the harness sandbox denies named pipes, and
 * a gate that cannot run in the environment it is meant to protect is not a gate.
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const API_PORT = 3211;
const CDP_PORT = 9455;
const ARTIFACTS = path.join(ROOT, 'tests', 'e2e', 'artifacts');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stdout.write(`${message}\n`);
const fail = (message) => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };

async function pickBindablePort(preferred) {
  const candidates = [preferred, ...Array.from({ length: 800 }, (_, index) => preferred + 1 + index)];
  for (const port of candidates) {
    const bindable = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (bindable) return port;
  }
  fail(`no bindable preview port near ${String(preferred)}`);
}

function findChrome() {
  const candidates = [
    process.env['CHROME_PATH'],
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '');
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) fail('Chrome not found — set CHROME_PATH to a Chrome binary');
  return found;
}

/** Spawn with stdout/stderr appended to one file — no pipes, so the run works under the sandbox. */
function spawnToLog(command, args, options, logPath) {
  const fd = openSync(logPath, 'a');
  return spawn(command, args, { ...options, stdio: ['ignore', fd, fd] });
}

/** A stale listener from a killed run owns the port: find its PID through a netstat dump file. */
async function ensurePortFree(port, logPath) {
  const dump = path.join(tmpdir(), `maoeh-netstat-${String(Date.now())}.txt`);
  await new Promise((resolve) => {
    const child = spawn('netstat', ['-ano'], { stdio: ['ignore', openSync(dump, 'w'), 'ignore'] });
    child.on('close', resolve);
    child.on('error', resolve);
  });
  if (!existsSync(dump)) return;
  const stdout = await readFile(dump, 'utf8');
  const pids = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5) continue;
    if (!columns[0].toUpperCase().includes('TCP')) continue;
    if (columns[3].toUpperCase() !== 'LISTENING') continue;
    if (!columns[1].endsWith(`:${String(port)}`)) continue;
    const pid = Number(columns[4]);
    if (Number.isInteger(pid) && pid !== process.pid) pids.add(pid);
  }
  for (const pid of pids) {
    log(`[setup] reclaiming port ${String(port)} from PID ${String(pid)}`);
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      killer.on('close', resolve);
      killer.on('error', resolve);
    });
  }
  if (pids.size > 0) await sleep(500);
  log(`[setup] netstat dump: ${logPath}`);
}

function stopTree(child) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = [];
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) {
        for (const listener of this.listeners) listener(message);
        return;
      }
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(`${message.error.message}`));
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
          socket.addEventListener('open', () => { clearTimeout(timer); resolve(); });
          socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('websocket connect failed')); });
        });
        return new Cdp(socket);
      } catch (cause) {
        if (Date.now() > deadline) throw cause;
        await sleep(300);
      }
    }
  }

  onEvent(listener) { this.listeners.push(listener); }

  send(method, params = {}) {
    this.sequence += 1;
    const id = this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.socket.close(); }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails !== undefined) fail(`page evaluation threw: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  }

  async waitFor(expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.evaluate(expression)) === true) return;
      if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
      await sleep(200);
    }
  }

  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(file, Buffer.from(shot.data, 'base64'));
  }
}

const waitForHttp = async (target, label, timeoutMs = 40_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await fetch(target)).ok) return; } catch { /* starting */ }
    if (Date.now() > deadline) fail(`timed out waiting for ${label} (${target})`);
    await sleep(200);
  }
};

const INSTALL_ERROR_WATCH = `
(() => {
  if (window.__pageErrors) return true;
  window.__pageErrors = [];
  const text = (value) => {
    if (value instanceof Error) return value.message;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const record = (kind, message) => { window.__pageErrors.push(kind + ': ' + message); };
  const originalError = console.error;
  console.error = (...args) => { record('console.error', args.map(text).join(' ')); return originalError.apply(console, args); };
  window.addEventListener('error', (event) => { record('error', String(event.message)); });
  window.addEventListener('unhandledrejection', (event) => { record('unhandledrejection', text(event.reason)); });
  return true;
})()`;

/** Enter a named company (`PROBE_COMPANY`), else the first one the gate lists. */
const ENTER_COMPANY = `
(() => {
  const name = ${JSON.stringify(process.env['PROBE_COMPANY'] ?? '')};
  const buttons = [...document.querySelectorAll('[data-testid="foundry-company"]')];
  const target = name === '' ? buttons[0] : buttons.find((b) => b.textContent.includes(name));
  if (!target) return false;
  target.click();
  return true;
})()`;

const SWITCH_TO_ZH = `
(() => {
  const buttons = [...document.querySelectorAll('.lang-switch button')];
  const cn = buttons.find((b) => b.textContent.includes('CN'));
  if (!cn) return false;
  cn.click();
  return true;
})()`;

/** Fill the brief by field semantics, not by index, and report which fields were found. */
const FILL_BRIEF = (title, goal) => `
(() => {
  const grid = document.querySelector('#start-work');
  if (!grid) return 'form-missing';
  const set = (element, value) => {
    const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const labelOf = (node) => (node.closest('label')?.querySelector('.field-label')?.textContent ?? '').trim();
  const byLabel = (needle) => [...grid.querySelectorAll('input,textarea')].find((node) => labelOf(node).includes(needle));
  const title = byLabel('标题') ?? byLabel('title');
  const goal = byLabel('目标') ?? byLabel('Objective') ?? byLabel('objective');
  const keys = byLabel('验收键') ?? byLabel('Verification keys');
  const reason = byLabel('原因') ?? byLabel('Reason');
  if (!title || !goal || !keys || !reason) return 'fields-missing';
  set(title, ${JSON.stringify(title)});
  set(goal, ${JSON.stringify(goal)});
  set(keys, 'probe-key');
  set(reason, 'probe run');
  return 'ok';
})()`;

const CLICK_START = `
(() => {
  const grid = document.querySelector('#start-work');
  const button = [...(grid?.querySelectorAll('button.primary') ?? [])].at(-1);
  if (!button) return false;
  button.click();
  return true;
})()`;

/** The submit report the operator reads, exactly as the DOM exposes it. */
const SNAPSHOT_UI = `
(() => {
  const block = document.querySelector('[data-testid="brief-result"]');
  return {
    feedback: [...document.querySelectorAll('.feedback')].map((n) => n.className + ' :: ' + n.textContent.trim()),
    button: (() => { const b = document.querySelector('#start-work button.primary'); return b ? { text: b.textContent.trim(), disabled: b.disabled } : null; })(),
    report: block === null ? null : {
      stage: block.getAttribute('data-stage'),
      headline: block.querySelector('h4')?.textContent ?? null,
      status: block.querySelector('[data-testid="brief-result-status"]')?.textContent ?? null,
      detail: block.querySelector('[data-testid="brief-result-detail"]')?.textContent ?? null,
      briefId: block.querySelector('[data-testid="brief-result-brief"]')?.textContent ?? null,
      taskIds: [...block.querySelectorAll('[data-testid="brief-result-task-id"]')].map((n) => n.textContent.trim()),
      gate: block.querySelector('[data-testid="brief-result-gate"]')?.textContent ?? null,
    },
    briefs: document.querySelectorAll('.brief-detail').length,
    briefItems: document.querySelectorAll('.brief-detail .brief-item').length,
    sideRuntime: document.querySelector('.side-foot span.side-runtime')?.textContent ?? null,
    errors: window.__pageErrors ?? [],
  };
})()`;

const OPEN_TASKS_PAGE = `
(() => {
  const block = document.querySelector('[data-testid="brief-result"]');
  const button = [...(block?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('Tasks'));
  if (!button) return false;
  button.click();
  return true;
})()`;

const TASK_IDS_ON_TASKS_PAGE = `
[...document.querySelectorAll('.task-card')].map((card) => card.textContent)
`;

async function main() {
  const chromePath = findChrome();
  const runDir = path.join(tmpdir(), `maoeh-probe-${String(Date.now())}`);
  const WEB_PORT = await pickBindablePort(4187);
  const consoleUrl = `http://127.0.0.1:${String(WEB_PORT)}/`;
  await mkdir(ARTIFACTS, { recursive: true });
  await mkdir(runDir, { recursive: true });

  await ensurePortFree(API_PORT, path.join(ARTIFACTS, 'probe-run.log'));
  await ensurePortFree(WEB_PORT, path.join(ARTIFACTS, 'probe-run.log'));
  await ensurePortFree(CDP_PORT, path.join(ARTIFACTS, 'probe-run.log'));

  const apiEventLog = process.env['PROBE_EVENT_LOG'] ?? path.join(runDir, 'events.jsonl');
  const apiOwnership = process.env['PROBE_OWNERSHIP'] ?? 'memory';
  const apiLog = path.join(ARTIFACTS, 'probe-api.log');
  const webLog = path.join(ARTIFACTS, 'probe-web.log');
  const chromeLog = path.join(ARTIFACTS, 'probe-chrome.log');
  log(`[setup] event log: ${apiEventLog}`);
  log(`[setup] ownership: ${apiOwnership}`);
  const api = spawnToLog(process.execPath, ['apps/api/dist/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(API_PORT), MAOEH_EVENT_LOG: apiEventLog, MAOEH_OWNERSHIP: apiOwnership, MAOEH_REQUIRE_PLAN_CONFIRMATION: '0' },
  }, apiLog);
  const preview = spawnToLog(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'],
    { cwd: path.join(ROOT, 'apps', 'web'), env: { ...process.env, PORT: String(API_PORT) } },
    webLog,
  );
  const chrome = spawnToLog(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${String(CDP_PORT)}`,
    `--user-data-dir=${runDir}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=1440,960',
    'about:blank',
  ], {}, chromeLog);

  let cdp = null;
  const children = [api, preview, chrome];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (cdp !== null) { try { cdp.close(); } catch { /* closed */ } }
    for (const child of children) stopTree(child);
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  const evidence = { calls: [] };

  try {
    await waitForHttp(`http://127.0.0.1:${String(API_PORT)}/api/simulation`, 'the API server');
    await waitForHttp(consoleUrl, 'the console preview');

    const target = await (
      await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/new?${encodeURIComponent(consoleUrl)}`, { method: 'PUT' })
    ).json();
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTALL_ERROR_WATCH });

    const calls = evidence.calls;
    cdp.onEvent(async (message) => {
      if (message.method === 'Network.requestWillBeSent') {
        const url = message.params.request.url;
        if (url.includes('/api/')) {
          calls.push({ at: Date.now(), method: message.params.request.method, url, requestId: message.params.requestId, post: message.params.request.postData ?? null });
        }
      }
      if (message.method === 'Network.responseReceived') {
        const entry = [...calls].reverse().find((c) => c.requestId === message.params.requestId);
        if (entry) {
          entry.status = message.params.response.status;
          try { entry.body = String((await cdp.send('Network.getResponseBody', { requestId: message.params.requestId })).body).slice(0, 600); } catch { entry.body = null; }
        }
      }
      if (message.method === 'Network.loadingFailed') {
        const entry = [...calls].reverse().find((c) => c.requestId === message.params.requestId);
        if (entry) entry.failed = message.params.errorText;
      }
    });

    await cdp.send('Page.reload', { ignoreCache: true });
    await cdp.waitFor(
      `document.querySelector('[data-testid="foundry-signin"]') !== null || document.querySelector('[data-testid="foundry-company"]') !== null`,
      'the Create Your AI Company gate',
    );
    await cdp.evaluate(
      `(() => { const b = document.querySelector('[data-testid="foundry-signin"]'); if (b) b.click(); return true; })()`,
    );
    await cdp.waitFor(`document.querySelector('[data-testid="foundry-company"]') !== null`, 'the company list');
    check(await cdp.evaluate(ENTER_COMPANY), 'the company must be enterable');
    await cdp.waitFor(`document.querySelector('h1')?.textContent === 'Overview'`, 'the Overview page');
    await cdp.waitFor(`Array.isArray(window.__pageErrors)`, 'the error watcher');
    check(await cdp.evaluate(SWITCH_TO_ZH), 'the CN language switch must be clickable');
    await cdp.waitFor(`document.querySelector('#start-work .button-row button.primary')?.textContent.trim() === '开始工作'`, 'the zh-CN Start Work label');

    log('[1] the operator types a brief and leaves "pause at approval gates" on');
    check((await cdp.evaluate(FILL_BRIEF('Probe brief', 'Prove the Start Work chain reaches the API'))) === 'ok', 'the brief form must expose title/goal/keys/reason');
    check(await cdp.evaluate(`document.querySelector('#start-work input[type=checkbox]').checked === true`), 'the hold checkbox must be on by default');
    const before = JSON.parse(await cdp.evaluate('JSON.stringify(' + SNAPSHOT_UI + ')'));
    check(before.report === null, 'no submission report may exist before the click');
    evidence.before = before;
    log(`[ui] before: ${JSON.stringify(before)}`);

    log('[2] the click produces a visible change in the panel inside the 1s budget');
    const clickedAt = Date.now();
    check(await cdp.evaluate(CLICK_START), 'the Start Work button must be clickable');
    // Poll the real DOM rather than assuming React flushed in the click's own task: what the
    // acceptance asks for is the *time to a visible change*, measured from the operator's click.
    let firstSeenMs = null;
    let firstStage = null;
    let firstButton = null;
    while (Date.now() - clickedAt < 1000) {
      const seen = await cdp.evaluate(`(() => {
        const block = document.querySelector('[data-testid="brief-result"]');
        const button = document.querySelector('#start-work button.primary');
        return { stage: block === null ? null : block.getAttribute('data-stage'), buttonText: button === null ? null : button.textContent.trim(), busy: button === null ? null : button.disabled };
      })()`);
      firstButton = firstButton ?? seen.buttonText;
      if (seen.stage !== null) { firstSeenMs = Date.now() - clickedAt; firstStage = seen.stage; break; }
      await sleep(10);
    }
    evidence.immediate = { firstSeenMs, firstStage, firstButton };
    log(`[ui] first visible change: ${String(firstSeenMs)}ms (stage ${String(firstStage)}, button was "${String(firstButton)}")`);
    check(firstSeenMs !== null, 'no change was visible within 1s of the click');
    await sleep(300);
    const at300 = JSON.parse(await cdp.evaluate('JSON.stringify(' + SNAPSHOT_UI + ')'));
    evidence.at300 = { ...at300, elapsed: Date.now() - clickedAt };
    log(`[ui] +${String(Date.now() - clickedAt)}ms: ${JSON.stringify(at300)}`);
    check(at300.report !== null, 'the submit report must still be on screen after 300ms');
    check(
      ['creating', 'filed', 'decomposing', 'running', 'held', 'approval', 'completed'].includes(String(at300.report.stage)),
      `unexpected report stage ${String(at300.report.stage)}`,
    );

    log('[3] the brief is created and the report names every work item by taskId');
    await cdp.waitFor(
      `['held','approval'].includes(String(document.querySelector('[data-testid="brief-result"]')?.getAttribute('data-stage')))`,
      'the report to name the paused / waiting-for-approval state',
      90_000,
    );
    const held = JSON.parse(await cdp.evaluate('JSON.stringify(' + SNAPSHOT_UI + ')'));
    evidence.held = held;
    log(`[ui] held: ${JSON.stringify(held)}`);
    check(held.report.briefId !== null, 'the report must name the created brief id');
    check(held.report.taskIds.length >= 1, 'the report must list at least one taskId');
    check(held.sideRuntime === '已为你挂起', `the console must report the hold, got ${String(held.sideRuntime)}`);
    check(held.briefItems >= 1, 'the brief panel must show the decomposed work items');

    const runtime = await (await fetch(`http://127.0.0.1:${String(API_PORT)}/api/runtime`)).json();
    evidence.runtime = { simulationPaused: runtime.simulationPaused, tick: runtime.tick };
    check(runtime.simulationPaused === true, 'the held runtime must actually be paused on the server');
    const tasks = await (await fetch(`http://127.0.0.1:${String(API_PORT)}/api/tasks`)).json();
    for (const taskId of held.report.taskIds) {
      check(tasks.some((task) => task.taskId === taskId), `GET /api/tasks must contain ${taskId}`);
    }
    log(`[api] the report's taskIds exist on GET /api/tasks: ${held.report.taskIds.join(', ')}`);
    await cdp.evaluate(`(() => { document.querySelector('[data-testid="brief-result"]')?.scrollIntoView({ block: 'center' }); return true; })()`);
    await sleep(500);
    await cdp.screenshot(path.join(ARTIFACTS, 'startwork-probe-report.png'));

    log('[4] the same task is on the Tasks page');
    check(await cdp.evaluate(OPEN_TASKS_PAGE), 'the "在 Tasks 页查看" action must be clickable');
    await cdp.waitFor(`document.querySelector('h1')?.textContent === '任务'`, 'the Tasks page');
    await cdp.waitFor(
      `[...document.querySelectorAll('.task-card')].some((card) => card.textContent.includes(${JSON.stringify(held.report.taskIds[0])}))`,
      'the created task card',
    );
    const taskCards = await cdp.evaluate(TASK_IDS_ON_TASKS_PAGE);
    evidence.tasksPage = { cards: taskCards.length, first: String(taskCards[0] ?? '').slice(0, 200) };
    log(`[ui] Tasks page shows ${String(taskCards.length)} card(s), including ${held.report.taskIds[0]}`);

    log('[5] an API that is down is reported verbatim, never as a silent click');
    stopTree(api);
    await sleep(1500);
    check(await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('nav button')].find((n) => n.textContent.includes('总览')); if (!b) return false; b.click(); return true; })()`), 'the Overview nav button must be clickable');
    await cdp.waitFor(`document.querySelector('#start-work') !== null`, 'the brief form again');
    await sleep(2600);
    check((await cdp.evaluate(FILL_BRIEF('Probe brief offline', 'Prove a refused command is reported'))) === 'ok', 'the brief form must still be fillable');
    check(await cdp.evaluate(CLICK_START), 'the Start Work button must still be clickable');
    await cdp.waitFor(
      `document.querySelector('[data-testid="brief-result"]')?.getAttribute('data-stage') === 'failed'`,
      'the failure report',
      20_000,
    );
    const failed = JSON.parse(await cdp.evaluate('JSON.stringify(' + SNAPSHOT_UI + ')'));
    evidence.failed = failed;
    log(`[ui] offline: ${JSON.stringify(failed)}`);
    check(
      String(failed.report.detail).includes('/api/command') || /unreachable|Failed to fetch|fetch failed|HTTP \d{3}/i.test(String(failed.report.detail)),
      `the failure must carry the real reason, got ${String(failed.report.detail)}`,
    );

    log('[6] the browser console stays clean');
    const errors = JSON.parse(await cdp.evaluate('JSON.stringify(window.__pageErrors ?? [])'));
    check(errors.length === 0, `browser errors: ${JSON.stringify(errors)}`);

    await writeFile(path.join(ARTIFACTS, 'startwork-probe.json'), JSON.stringify(evidence, null, 2));
    log(`[net] ${String(calls.length)} API calls:`);
    for (const call of calls) {
      log(`      ${String(call.status ?? '???')} ${call.method} ${call.url.replace(consoleUrl, '/')}${call.post ? ` body=${String(call.post).slice(0, 200)}` : ''}${call.failed ? ` FAILED ${String(call.failed)}` : ''}`);
    }
    log('[done] start-work chain verified: click -> visible report -> briefId + taskIds -> Tasks page -> verbatim failure');
    log(`[done] evidence written to tests/e2e/artifacts/startwork-probe.json`);
  } catch (cause) {
    if (cdp !== null) {
      try { await cdp.screenshot(path.join(ARTIFACTS, 'startwork-probe-failed.png')); } catch { /* page may be gone */ }
    }
    log(`[fail] ${cause instanceof Error ? cause.message : String(cause)}`);
    await writeFile(path.join(ARTIFACTS, 'startwork-probe.json'), JSON.stringify(evidence, null, 2));
    cleanup();
    process.exit(1);
  }

  cleanup();
  process.exit(0);
}

await main();
