/**
 * M1.4 acceptance 3 — "控制台一屏 任务书 → 各项 → 状态" — on a real browser.
 *
 * The whole promise of the entry-point convergence (§5.7) is that one screen takes an
 * operator from a written brief to visible work items to a decision, without the console
 * ever jumping away on its own. This script walks exactly that path against the real API:
 *
 *   fill the brief on Overview -> Start Work (held) -> the brief decomposes into work items
 *   -> instruct the Chief Officer (Agent.Instruct, now a diagnostic inside the record)
 *   -> step the held runtime until the approval gate opens -> Approve -> runtime resumes
 *   -> the workflow reaches completed
 *
 * Run:  node tests/e2e/work-brief.mjs
 * The vitest config excludes tests/e2e, so this never runs inside `pnpm test`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { enterConsole } from './gate.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const API_PORT = 3204;
const CDP_PORT = 9448;
const ARTIFACTS = path.join(ROOT, 'tests', 'e2e', 'artifacts');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stdout.write(`${message}\n`);
const fail = (message) => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };

/**
 * Windows reserves dynamic port ranges (Hyper-V) that move between reboots, and a reserved
 * range makes `listen` fail with EACCES rather than EADDRINUSE — so the preview port is probed
 * instead of assumed: the preferred 4184 first, then outward until one the OS will hand over.
 * The scan has to be wide enough to clear a whole exclusion block (they come in 100-port
 * blocks and can start just below the preference).
 */
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
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '');
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) fail('Chrome not found — set CHROME_PATH to a Chrome binary');
  return found;
}

/** A run killed before cleanup leaves a stale listener behind; take the port back explicitly. */
async function ensurePortFree(port) {
  const { stdout } = await new Promise((resolve) => {
    const child = spawn('netstat', ['-ano'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { buffer += chunk; });
    child.on('close', () => resolve({ stdout: buffer }));
  });
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
    });
  }
  if (pids.size > 0) await sleep(500);
}

function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

/** Minimal CDP client: request/response over the DevTools websocket. */
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
      if (Date.now() > deadline) {
        const diagnostics = await this.evaluate(
          `JSON.stringify({ h1: document.querySelector('h1')?.textContent ?? null, feedback: document.querySelector('.feedback')?.textContent ?? null })`,
        );
        fail(`timed out waiting for ${label}; page state: ${String(diagnostics)}`);
      }
      await sleep(250);
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

/** Every feedback banner the console shows — transient, so the history is kept instead of raced. */
const INSTALL_RECORDER = `
(() => {
  window.__feedbackLog = [];
  const record = () => {
    const node = document.querySelector('.feedback b');
    const text = node ? node.textContent : null;
    if (text && window.__feedbackLog[window.__feedbackLog.length - 1] !== text) window.__feedbackLog.push(text);
  };
  new MutationObserver(record).observe(document.body, { childList: true, subtree: true, characterData: true });
  record();
  return true;
})()`;

const NAVIGATE = (page) => `
(() => {
  const button = [...document.querySelectorAll('nav button')].find((b) => b.textContent.trim() === ${JSON.stringify(page)});
  if (!button) return false;
  button.click();
  return true;
})()`;

/**
 * Type the brief the way an operator would. `#start-work` exposes title / priority / due /
 * reason as plain inputs and goal / context / keys as textareas, so the indexes are asserted
 * rather than guessed: a field that moves is reported as `fields-missing`, not silently
 * submitted empty.
 */
const FILL_BRIEF = `
(() => {
  const grid = document.querySelector('#start-work');
  if (!grid) return 'form-missing';
  const set = (element, value) => {
    const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const inputs = [...grid.querySelectorAll('input:not([type])')];
  const areas = [...grid.querySelectorAll('textarea')];
  if (inputs.length < 4 || areas.length < 3) return 'fields-missing';
  set(inputs[0], 'Ship the changelog');
  set(areas[0], 'Publish the release notes for this cycle to the docs site');
  set(areas[1], 'Draft from the last three merges; cite the source of every number');
  set(areas[2], 'changelog.md\\n/whats-new');
  set(inputs[3], 'Quarterly release');
  return 'ok';
})()`;

const CLICK_START = `
(() => {
  const grid = document.querySelector('#start-work');
  const button = [...(grid?.querySelectorAll('button.primary') ?? [])].find((b) => b.textContent.includes('Start Work'));
  if (!button) return false;
  button.click();
  return true;
})()`;

/** Open one agent's record and show its diagnostic instruction block (§5.7). */
const CLICK_AGENT_ACTION = (name, label) => `
(() => {
  const card = [...document.querySelectorAll('.person-card')].find((node) => node.textContent.includes(${JSON.stringify(name)}));
  const button = card === undefined ? undefined : [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)});
  if (!button || button.disabled) return false;
  button.click();
  return true;
})()`;

const SEND_DIAGNOSTIC = `
(() => {
  const area = document.querySelector('.record-advanced textarea');
  if (!area) return 'record-missing';
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(area, 'Prepare the release announcement for the docs site');
  area.dispatchEvent(new window.Event('input', { bubbles: true }));
  const button = document.querySelector('.record-advanced button.primary');
  if (!button || button.disabled) return 'send-missing';
  button.click();
  return 'ok';
})()`;

const HAS_OPEN_GATE = `
(async () => {
  const rows = await (await fetch('/api/workflows')).json();
  return Array.isArray(rows) && rows.some((row) => row && row.approval && row.approval.status === 'open');
})()`;

const CLICK_STEP_ONCE = `
(() => {
  const button = [...document.querySelectorAll('.runtime-hero-actions button')].find((b) => b.textContent.trim() === 'Step once');
  if (!button || button.disabled) return false;
  button.click();
  return true;
})()`;

const CLICK_APPROVE = `
(() => {
  const button = [...document.querySelectorAll('.approval-actions button.primary')].find((b) => b.textContent.trim() === 'Approve');
  if (!button || button.disabled) return false;
  button.click();
  return true;
})()`;

async function main() {
  const chromePath = findChrome();
  const profile = path.join(tmpdir(), `maoeh-brief-e2e-${String(Date.now())}`);
  const WEB_PORT = await pickBindablePort(4184);
  if (WEB_PORT !== 4184) log(`[setup] preview port 4184 is reserved by the OS — using ${String(WEB_PORT)}`);
  const consoleUrl = `http://127.0.0.1:${String(WEB_PORT)}/`;
  await mkdir(ARTIFACTS, { recursive: true });

  log(`[setup] chrome: ${chromePath}`);
  await ensurePortFree(API_PORT);
  await ensurePortFree(WEB_PORT);
  await ensurePortFree(CDP_PORT);

  // A throwaway event log: the console is persistent by default, and this run must neither
  // replay a previous run's company nor leave one behind.
  const apiEventLog = path.join(profile, 'events.jsonl');
  const api = spawn(process.execPath, ['apps/api/dist/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(API_PORT), MAOEH_EVENT_LOG: apiEventLog, MAOEH_OWNERSHIP: 'memory', MAOEH_REQUIRE_PLAN_CONFIRMATION: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const preview = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'],
    { cwd: path.join(ROOT, 'apps', 'web'), env: { ...process.env, PORT: String(API_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${String(CDP_PORT)}`,
    `--user-data-dir=${profile}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=1440,960',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let cdp = null;
  const children = [api, preview, chrome];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (cdp !== null) { try { cdp.close(); } catch { /* already closed */ } }
    for (const child of children) stopTree(child);
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  const capture = (prefix, stream) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim() !== '') log(`[${prefix}] ${line}`);
    });
  };
  capture('api', api.stdout);
  capture('api', api.stderr);
  capture('web', preview.stdout);
  capture('web', preview.stderr);

  try {
    log('[setup] waiting for API and console');
    await waitForHttp(`http://127.0.0.1:${String(API_PORT)}/api/simulation`, 'the API server');
    await waitForHttp(consoleUrl, 'the console preview');

    const target = await (
      await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/new?${encodeURIComponent(consoleUrl)}`, { method: 'PUT' })
    ).json();
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTALL_ERROR_WATCH });
    await cdp.send('Page.reload', { ignoreCache: true });

    log('[1] loading the console');
    await enterConsole(cdp);
    await cdp.waitFor(`document.querySelector('h1')?.textContent === 'Overview'`, 'the Overview page');
    await cdp.waitFor(`Array.isArray(window.__pageErrors)`, 'the error watcher to be installed');
    check(await cdp.evaluate(INSTALL_RECORDER), 'the feedback recorder must be installed');

    log('[2] one screen: the brief form, typed in by the operator');
    check((await cdp.evaluate(FILL_BRIEF)) === 'ok', 'the brief form must expose title/goal/context/keys/reason');
    await cdp.waitFor(
      `document.querySelector('#start-work input[type=checkbox]')?.checked === true`,
      'the hold checkbox to be on by default',
    );
    check(await cdp.evaluate(CLICK_START), 'the Start Work button must be clickable');

    // The brief becomes a capability-routed *workflow* (M1.6): its work items are created one per
    // workflow step as the held run advances, so the panel may legitimately show the first item
    // alone. What must never be missing is the workflow itself and a taskId to click through to.
    log('[3] the brief becomes a workflow with its first work item');
    await cdp.waitFor(
      `(window.__feedbackLog ?? []).some((line) => line.includes('Brief submitted'))`,
      'the "Brief submitted" feedback',
      90_000,
    );
    await cdp.waitFor(
      `document.querySelectorAll('.brief-detail .brief-item').length >= 1`,
      'the brief detail to show its work items',
      90_000,
    );
    const items = await cdp.evaluate(`document.querySelectorAll('.brief-detail .brief-item').length`);
    log(`      brief shows ${String(items)} work item(s) so far`);
    // The submit report under the button is the operator's answer: it must name the workflow the
    // command started and at least one work item by the taskId the Tasks page addresses, without
    // leaving the panel.
    await cdp.waitFor(
      `document.querySelectorAll('[data-testid="brief-result-workflow"]').length >= 1 &&
        (document.querySelector('[data-testid="brief-result-workflow"]')?.textContent ?? '').trim().length > 0`,
      'the inline submission report to name the workflow the brief started',
      90_000,
    );
    await cdp.waitFor(
      `document.querySelectorAll('[data-testid="brief-result-task-id"]').length >= 1`,
      'the inline submission report to name the created work items by taskId',
      90_000,
    );
    const reportStage = await cdp.evaluate(
      `document.querySelector('[data-testid="brief-result"]')?.getAttribute('data-stage')`,
    );
    check(['held', 'approval'].includes(String(reportStage)), `the report must show the paused/approval state, got ${String(reportStage)}`);
    log(`      inline submit report stage: ${String(reportStage)}`);
    const briefShot = path.join(ARTIFACTS, 'work-brief-items.png');
    await cdp.screenshot(briefShot);
    log(`[3b] brief screenshot: ${briefShot}`);

    log('[4] the Chief Officer is instructed from inside its own record (§5.7)');
    check(await cdp.evaluate(NAVIGATE('Agents')), 'the Agents nav button must be clickable');
    await cdp.waitFor(`document.querySelector('h1')?.textContent === 'Agents'`, 'the Agents page');
    check(await cdp.evaluate(CLICK_AGENT_ACTION('Alex', 'Details')), 'the Details button on the Chief Officer card');
    await cdp.waitFor(`document.querySelector('.record-advanced textarea') !== null`, 'the diagnostic instruction block');
    check((await cdp.evaluate(SEND_DIAGNOSTIC)) === 'ok', 'the diagnostic instruction must be sendable');
    await cdp.waitFor(
      `(window.__feedbackLog ?? []).some((line) => line.includes('Instruction sent'))`,
      'the "Instruction sent" feedback',
      60_000,
    );

    log('[5] the held runtime is stepped until the approval gate opens');
    check(await cdp.evaluate(NAVIGATE('Runtime')), 'the Runtime nav button must be clickable');
    await cdp.waitFor(`document.querySelector('h1')?.textContent === 'Runtime'`, 'the Runtime page');
    let gateOpen = false;
    for (let attempt = 0; attempt < 60 && !gateOpen; attempt += 1) {
      gateOpen = (await cdp.evaluate(HAS_OPEN_GATE)) === true;
      if (gateOpen) break;
      await cdp.evaluate(CLICK_STEP_ONCE);
      await sleep(500);
    }
    check(gateOpen, 'an approval gate must open within 60 one-tick steps');

    log('[6] the operator decides');
    check(await cdp.evaluate(NAVIGATE('Approvals')), 'the Approvals nav button must be clickable');
    await cdp.waitFor(`document.querySelector('h1')?.textContent === 'Approvals'`, 'the Approvals page');
    await cdp.waitFor(`document.querySelector('.approval-card') !== null`, 'an open approval card');
    await cdp.waitFor(
      `document.querySelector('.side-foot span')?.textContent === 'HELD FOR YOU'`,
      'the sidebar to report the console is holding the runtime',
    );
    const decisionShot = path.join(ARTIFACTS, 'work-brief-approval.png');
    await cdp.screenshot(decisionShot);
    log(`[6b] approval screenshot: ${decisionShot}`);
    check(await cdp.evaluate(CLICK_APPROVE), 'the Approve button must be clickable');
    await cdp.waitFor(
      `(window.__feedbackLog ?? []).some((line) => line.includes('Approved'))`,
      'the approval feedback',
      60_000,
    );
    await cdp.waitFor(
      `document.querySelector('.side-foot span')?.textContent === 'LIVE'`,
      'the runtime to be released after the decision',
    );

    log('[7] the company finishes the work');
    check(await cdp.evaluate(NAVIGATE('Workflows')), 'the Workflows nav button must be clickable');
    await cdp.waitFor(`document.querySelector('h1')?.textContent === 'Workflows'`, 'the Workflows page');
    await cdp.waitFor(
      `[...document.querySelectorAll('.table .tr')].some((row) => row.children[1]?.textContent?.trim() === 'completed')`,
      'a completed workflow row',
      90_000,
    );
    const finalShot = path.join(ARTIFACTS, 'work-brief-completed.png');
    await cdp.screenshot(finalShot);
    log(`[7b] workflow screenshot: ${finalShot}`);

    const errors = JSON.parse(await cdp.evaluate('JSON.stringify(window.__pageErrors ?? [])'));
    check(errors.length === 0, `browser errors: ${JSON.stringify(errors)}`);
    log(`[done] brief -> items -> status verified in Chrome — screenshot: ${finalShot}`);
  } catch (cause) {
    if (cdp !== null) {
      const failureShot = path.join(ARTIFACTS, 'work-brief-failed.png');
      try { await cdp.screenshot(failureShot); log(`[fail] screenshot: ${failureShot}`); } catch { /* page may be gone */ }
    }
    log(`[fail] ${cause instanceof Error ? cause.message : String(cause)}`);
    cleanup();
    process.exit(1);
  }

  cleanup();
  process.exit(0);
}

await main();
