/**
 * M1.2-C end-to-end check on a real browser.
 *
 * Drives the built console in headless Chrome over the DevTools protocol (no extra
 * dependency: Node ships a WebSocket client) against the real API server, and walks the
 * whole operator loop:
 *
 *   load console -> Start Work (hold) -> the brief decomposes into work items
 *   -> instruct the Chief Officer from inside its own record -> step the held runtime
 *   until the approval gate opens -> Approve -> runtime resumes -> the workflow reaches
 *   completed
 *
 * Run:  node tests/e2e/console-loop.mjs
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
const API_PORT = 3199;
const CDP_PORT = 9444;
const ARTIFACTS = path.join(ROOT, 'tests', 'e2e', 'artifacts');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (message) => {
  process.stdout.write(`${message}\n`);
};

function fail(message) {
  throw new Error(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

/**
 * Windows reserves dynamic port ranges (Hyper-V) that move between reboots, and a reserved
 * range makes `listen` fail with EACCES rather than EADDRINUSE —so the preview port is probed
 * instead of assumed: the preferred 4173 first, then outward until one the OS will hand over.
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

const WEB_PORT = await pickBindablePort(4173);
if (WEB_PORT !== 4173) log(`[setup] preview port 4173 is reserved by the OS —using ${String(WEB_PORT)}`);
const CONSOLE_URL = `http://127.0.0.1:${String(WEB_PORT)}/`;

async function waitForHttp(url, label, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) fail(`timed out waiting for ${label} (${url})`);
    await sleep(200);
  }
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
  if (found === undefined) fail('Chrome not found —set CHROME_PATH to a Chrome binary');
  return found;
}

/**
 * Reclaim this script's own ports. A run that was killed before it could clean up leaves
 * an orphaned preview or Chrome behind, and the next run would silently talk to the stale
 * one —so the ports are taken back explicitly instead of being "already in use".
 */
async function ensurePortFree(port) {
  const { stdout } = await new Promise((resolve) => {
    const child = spawn('netstat', ['-ano'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
    });
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

/** Minimal CDP client: request/response plus fire-and-forget events. */
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

  /** Evaluate an expression in the page and return its JSON value. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails !== undefined) {
      fail(`page evaluation threw: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value;
  }

  async waitFor(expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.evaluate(expression);
      if (value === true) return;
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

/**
 * Record every feedback banner the console shows. The banner is the operator's proof that
 * a command was accepted, but it is transient (it clears itself), so the observer keeps the
 * full history instead of racing the 8-second window with polling.
 */
const INSTALL_RECORDER = `
(() => {
  window.__feedbackLog = [];
  const record = () => {
    const node = document.querySelector('.feedback b');
    const text = node ? node.textContent : null;
    if (text && window.__feedbackLog[window.__feedbackLog.length - 1] !== text) {
      window.__feedbackLog.push(text);
    }
  };
  new MutationObserver(record).observe(document.body, { childList: true, subtree: true, characterData: true });
  record();
  return true;
})()`;

/**
 * Installed before the document loads, so a failure during the very first snapshot fetch is
 * recorded too: `console.error` (which the ErrorBoundary uses), uncaught errors and
 * unhandled rejections all land in `window.__pageErrors`.
 */
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
  console.error = (...args) => {
    record('console.error', args.map(text).join(' '));
    return originalError.apply(console, args);
  };
  window.addEventListener('error', (event) => { record('error', String(event.message)); });
  window.addEventListener('unhandledrejection', (event) => { record('unhandledrejection', text(event.reason)); });
  return true;
})()`;

/** The eleven destinations every operator page must render from the real snapshot. */
const PAGES = ['Overview', 'Network', 'Agents', 'Deliverables', 'Tasks', 'Workflows', 'Canvas', 'Approvals', 'Communications', 'Runtime', 'Events'];

const FILL = `
(() => {
  const grid = document.querySelector('#start-work');
  if (!grid) return 'form-missing';
  const set = (element, value) => {
    const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const inputs = [...grid.querySelectorAll('input:not([type])')];
  const areas = grid.querySelectorAll('textarea');
  if (inputs.length < 4 || areas.length < 3) return 'fields-missing';
  set(inputs[0], 'Churn driver report');
  set(areas[0], 'Find the driver of churn in enterprise accounts and ship a recommendation');
  set(areas[1], 'Last quarter only; cite the source of every number');
  set(areas[2], 'churn-report.md');
  set(inputs[3], 'Quarterly retention review');
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

const CLICK_APPROVE = `
(() => {
  const button = [...document.querySelectorAll('button.primary')].find((b) => b.textContent.trim() === 'Approve');
  if (!button) return false;
  button.click();
  return true;
})()`;

/** §5.7: the instruction now lives inside the agent's own record, not in a top-level panel. */
const SEND_DIAGNOSTIC = `
(() => {
  const area = document.querySelector('.record-advanced textarea');
  if (!area) return 'record-missing';
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(area, 'Find the driver of churn in enterprise accounts');
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

const NAVIGATE = (page) => `
(() => {
  const button = [...document.querySelectorAll('nav button')].find((b) => b.textContent.trim() === ${JSON.stringify(page)});
  if (!button) return false;
  button.click();
  return true;
})()`;

/**
 * M1.3 Agent Management: fill the create form the way an operator would. `setValue` uses the
 * native setter so React's synthetic onChange fires (a plain `element.value =` would be
 * swallowed). The employee id is typed last, after the name, so the form's auto-slug has run.
 */
const FILL_AGENT = `
(() => {
  const grid = document.querySelector('#create-agent');
  if (!grid) return 'form-missing';
  const setValue = (element, value, proto) => {
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const inputs = grid.querySelectorAll('input:not([type])');
  const textareas = grid.querySelectorAll('textarea');
  const select = grid.querySelector('select');
  if (inputs.length < 3 || textareas.length < 1 || !select) return 'fields-missing';
  setValue(inputs[0], 'Priya', window.HTMLInputElement.prototype);
  setValue(inputs[1], 'qa-priya', window.HTMLInputElement.prototype);
  setValue(inputs[2], 'FAL-004', window.HTMLInputElement.prototype);
  setValue(textareas[0], 'test_strategy\\nrelease_verification', window.HTMLTextAreaElement.prototype);
  setValue(select, 'qa', window.HTMLSelectElement.prototype);
  return 'ok';
})()`;

const CLICK_CREATE_AGENT = `
(() => {
  const grid = document.querySelector('#create-agent');
  const button = [...(grid?.querySelectorAll('button.primary') ?? [])][0];
  if (!button) return false;
  button.click();
  return true;
})()`;

/** Click a named button inside the person card of one agent (M1.3 roster actions). */
const CLICK_AGENT_ACTION = (name, label) => `
(() => {
  const card = [...document.querySelectorAll('.person-card')].find((node) =>
    node.textContent.includes(${JSON.stringify(name)}));
  const button = card === undefined ? undefined : [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)});
  if (!button || button.disabled) return false;
  button.click();
  return true;
})()`;

const CLICK_ARCHIVE_CONFIRM = `
(() => {
  const button = document.querySelector('.archive-row button.primary');
  if (!button) return false;
  button.click();
  return true;
})()`;

async function main() {
  const chromePath = findChrome();
  const profile = path.join(tmpdir(), `maoeh-e2e-${String(Date.now())}`);
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
    env: {
      ...process.env,
      PORT: String(API_PORT),
      MAOEH_EVENT_LOG: apiEventLog,
      MAOEH_OWNERSHIP: 'memory',
      // This harness drives the pre-M1.9 autonomous loop; the draft-confirm path is exercised
      // by the Canvas UI and `tests/integration/draft-confirm.test.ts`.
      MAOEH_REQUIRE_PLAN_CONFIRMATION: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // vite runs the production bundle in front of a proxy to the API —no extra tooling.
  const preview = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(WEB_PORT), '--strictPort'],
    {
      cwd: path.join(ROOT, 'apps', 'web'),
      env: { ...process.env, PORT: String(API_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const chrome = spawn(
    chromePath,
    [
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
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let cdp = null;
  const children = [api, preview, chrome];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (cdp !== null) {
      try {
        cdp.close();
      } catch {
        /* already closed */
      }
    }
    for (const child of children) stopTree(child);
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  const capture = (prefix, stream) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() !== '') log(`[${prefix}] ${line}`);
      }
    });
  };
  capture('api', api.stdout);
  capture('api', api.stderr);
  capture('web', preview.stdout);
  capture('web', preview.stderr);

  try {
    log('[setup] waiting for API and console');
    await waitForHttp(`http://127.0.0.1:${String(API_PORT)}/api/simulation`, 'the API server');
    await waitForHttp(CONSOLE_URL, 'the console preview');

    const version = await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/version`)).json();
    log(`[setup] chrome devtools: ${String(version['Browser'])}`);
    const target = await (
      await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/new?${encodeURIComponent(CONSOLE_URL)}`, {
        method: 'PUT',
      })
    ).json();
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // The target already navigated during `/json/new`, so install the watcher and reload:
    // the first snapshot fetch must run with the recorder in place.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTALL_ERROR_WATCH });
    await cdp.send('Page.reload', { ignoreCache: true });

    log('[1] loading the console');
    // M1.5: a fresh profile lands on the company gate —capture it, then sign in to the lab.
    await cdp.waitFor(
      `document.querySelector('[data-testid="foundry-signin"]') !== null`,
      'the Create Your AI Company gate',
    );
    const gateShot = path.join(ARTIFACTS, 'company-gate.png');
    await cdp.screenshot(gateShot);
    log(`[1b] company gate screenshot: ${gateShot}`);
    await enterConsole(cdp);
    await cdp.waitFor(
      `document.querySelector('h1')?.textContent === 'Overview' && document.querySelectorAll('nav button').length === 11`,
      'the console shell with its eleven nav destinations',
    );
    // Prove the watcher is really installed (installed before the document loads) and that it
    // records —otherwise the "no console.error" assertions below would pass vacuously.
    await cdp.waitFor(
      `Array.isArray(window.__pageErrors)`,
      'the error watcher to be installed before the document loads',
    );
    await cdp.evaluate(`console.error('__watch_probe')`);
    await cdp.waitFor(
      `(window.__pageErrors ?? []).some((line) => line.includes('__watch_probe'))`,
      'the error watcher to record console.error',
    );
    await cdp.evaluate(
      `window.__pageErrors = (window.__pageErrors ?? []).filter((line) => !line.includes('__watch_probe'))`,
    );
    await cdp.waitFor(
      `document.querySelectorAll('.metric').length === 4 && [...document.querySelectorAll('.metric strong')].some((n) => Number(n.textContent) > 0)`,
      'the overview metrics to be filled from the snapshot',
    );
    check(
      (await cdp.evaluate(`document.querySelector('.side-foot span')?.textContent ?? ''`)) !== '',
      'the sidebar must show the runtime state',
    );

    log('[2] Start Work with the runtime held for the operator');
    check(await cdp.evaluate(INSTALL_RECORDER), 'the feedback recorder must be installed');
    check((await cdp.evaluate(FILL)) === 'ok', 'the Start Work form must expose title/objective/context');
    await cdp.waitFor(
      `document.querySelector('#start-work input[type=checkbox]')?.checked === true`,
      'the hold checkbox to be on by default',
    );
    check(await cdp.evaluate(CLICK_START), 'the Start Work button must be clickable');

    log('[3] the brief is submitted and decomposed into work items');
    await cdp.waitFor(
      `(window.__feedbackLog ?? []).some((line) => line.includes('Brief submitted'))`,
      'the "Brief submitted" feedback',
      90_000,
    );
    // A brief becomes a capability-routed workflow whose items appear one per step, so the first
    // item is the earliest honest answer; the workflow itself must be there with it.
    await cdp.waitFor(
      `document.querySelectorAll('.brief-detail .brief-item').length >= 1 &&
        document.querySelectorAll('[data-testid="brief-result-workflow"]').length >= 1`,
      'the brief detail to show its work item and the workflow behind it',
      90_000,
    );
    log(`      feedback log: ${await cdp.evaluate('JSON.stringify(window.__feedbackLog)')}`);

    log('[4] the Chief Officer is instructed from inside its own record (§5.7)');
    check(await cdp.evaluate(NAVIGATE('Agents')), 'the Agents nav button must be clickable');
    await cdp.waitFor(`document.querySelector('h1')?.textContent === 'Agents'`, 'the Agents page');
    check(
      await cdp.evaluate(CLICK_AGENT_ACTION('Alex', 'Details')),
      'the Details button on the Chief Officer card',
    );
    await cdp.waitFor(`document.querySelector('.record-advanced textarea') !== null`, 'the diagnostic instruction block');
    check((await cdp.evaluate(SEND_DIAGNOSTIC)) === 'ok', 'the diagnostic instruction must be sendable');
    await cdp.waitFor(
      `(window.__feedbackLog ?? []).some((line) => line.includes('Instruction sent'))`,
      'the "Instruction sent" feedback',
      60_000,
    );
    log(`      feedback log: ${await cdp.evaluate('JSON.stringify(window.__feedbackLog)')}`);

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
    check(await cdp.evaluate(NAVIGATE('Approvals')), 'the Approvals nav button must be clickable');
    await cdp.waitFor(`document.querySelector('h1')?.textContent === 'Approvals'`, 'the Approvals page');
    await cdp.waitFor(
      `[...document.querySelectorAll('.table .tr')].some((row) => row.textContent.includes('Approve'))`,
      'an open approval gate row',
    );
    await cdp.waitFor(
      `document.querySelector('.side-runtime')?.textContent === 'HELD FOR YOU'`,
      'the sidebar to report the console is holding the runtime',
    );

    log('[6] the operator approves');
    check(await cdp.evaluate(CLICK_APPROVE), 'the Approve button must be clickable');
    await cdp.waitFor(
      `(window.__feedbackLog ?? []).some((line) => line.includes('Approved'))`,
      'the approval feedback',
    );
    await cdp.waitFor(
      `document.querySelector('.side-runtime')?.textContent === 'LIVE'`,
      'the runtime to be released after the decision',
    );

    log('[7] the company finishes the work');
    check(await cdp.evaluate(NAVIGATE('Workflows')), 'the Workflows nav button must be clickable');
    await cdp.waitFor(
      `[...document.querySelectorAll('.table .tr')].some((row) => row.children[1]?.textContent?.trim() === 'completed')`,
      'a completed workflow row',
      60_000,
    );

    const finalShot = path.join(ARTIFACTS, 'console-loop-completed.png');
    await cdp.screenshot(finalShot);
    log(`[6b] workflow screenshot: ${finalShot}`);

    log('[6c] M1.3 agent management: create an agent, read its record, archive it');
    check(await cdp.evaluate(NAVIGATE('Agents')), 'the Agents nav button must be clickable');
    await cdp.waitFor(`document.querySelector('#create-agent') !== null`, 'the create-agent form');
    check(
      (await cdp.evaluate(FILL_AGENT)) === 'ok',
      'the create form must expose name / employee id / position / responsibilities',
    );
    check(await cdp.evaluate(CLICK_CREATE_AGENT), 'the Create agent button must be clickable');
    await cdp.waitFor(
      `(window.__feedbackLog ?? []).some((line) => line.includes('Agent created'))`,
      'the "Agent created" feedback',
      30_000,
    );
    await cdp.waitFor(
      `[...document.querySelectorAll('.person-card h3')].some((node) => node.textContent.trim() === 'Priya')`,
      'the new agent to appear on the roster',
      30_000,
    );
    log('[6d] the agent record is readable from the API payload');
    check(
      await cdp.evaluate(CLICK_AGENT_ACTION('Priya', 'Details')),
      'the Details button on the new agent card',
    );
    await cdp.waitFor(
      `document.querySelector('.detail-grid')?.textContent?.includes('qa-priya') === true`,
      'the agent record (employee id) to render',
    );
    log('[6e] archiving is a status change, not a deletion');
    check(
      await cdp.evaluate(CLICK_AGENT_ACTION('Priya', 'Archive')),
      'the Archive button on the new agent card',
    );
    await cdp.waitFor(
      `document.querySelector('.archive-row button.primary') !== null`,
      'the archive confirmation panel',
    );
    check(await cdp.evaluate(CLICK_ARCHIVE_CONFIRM), 'the confirm-archive button must be clickable');
    await cdp.waitFor(
      `(window.__feedbackLog ?? []).some((line) => line.includes('Agent archived'))`,
      'the "Agent archived" feedback',
      30_000,
    );
    await cdp.waitFor(
      `document.querySelector('.archived-row')?.textContent?.includes('Priya') === true`,
      'the agent to move into the archived roster',
      30_000,
    );
    const agentShot = path.join(ARTIFACTS, 'agent-management-archived.png');
    await cdp.screenshot(agentShot);
    log(`[6f] agent management screenshot: ${agentShot}`);

    log('[6g] M1.5 delivery centre: the CEO workspace opens a task delivery page');
    check(await cdp.evaluate(NAVIGATE('Deliverables')), 'the Deliverables nav button must be clickable');
    await cdp.waitFor(
      `document.querySelectorAll('.project-card').length > 0`,
      'the deliverable workspace cards',
      30_000,
    );
    // Open the most finished card the workspace shows: a completed task carries the strongest
    // delivery evidence, and every card deep-links to its own delivery page.
    check(
      await cdp.evaluate(
        `(() => {
           const cards = [...document.querySelectorAll('.project-card')];
           const card = cards.find((node) => node.textContent.includes('Completed')) ?? cards[0];
           const button = card?.querySelector('button.primary');
           if (!button || button.disabled) return false;
           button.click();
           return true;
         })()`,
      ),
      'the View result button on a workspace card must be clickable',
    );
    await cdp.waitFor(
      `location.pathname.startsWith('/results/') && location.pathname.length > '/results/'.length`,
      'the delivery route to own the address bar',
      30_000,
    );
    await cdp.waitFor(
      `document.querySelector('.result-hero') !== null`,
      'the delivery header with its state, creator and completion time',
      30_000,
    );
    await cdp.waitFor(
      `document.querySelector('.result-summary .field-label')?.textContent === 'User goal'`,
      'the executive summary opening on the user goal',
      30_000,
    );
    await cdp.waitFor(
      `document.querySelector('#final-deliverable') !== null && document.querySelector('.journey .journey-step') !== null`,
      'the deliverable and the work journey sections',
      30_000,
    );
    // The delivery page is taller than the fold: bring it to the top so the screenshot shows
    // the header and the summary, not the workspace that was on screen a moment ago.
    await cdp.evaluate(`(() => { document.querySelector('.result-page')?.scrollIntoView({ block: 'start' }); return true; })()`);
    await sleep(300);
    const deliverableShot = path.join(ARTIFACTS, 'deliverables-result.png');
    await cdp.screenshot(deliverableShot);
    log(`[6h] delivery centre screenshot: ${deliverableShot}`);

    log('[6i] the delivery centre switches to Chinese');
    check(
      await cdp.evaluate(
        `(() => { const button = document.querySelectorAll('.lang-switch button')[0]; if (!button) return false; button.click(); return true; })()`,
      ),
      'the CN language button must be clickable',
    );
    await cdp.waitFor(
      `document.querySelector('h1')?.textContent === '成果交付中心'`,
      'the Chinese delivery heading',
    );
    await cdp.waitFor(
      `document.querySelector('.result-summary .field-label')?.textContent === '用户目标'`,
      'the Chinese summary labels',
      30_000,
    );
    const chineseShot = path.join(ARTIFACTS, 'deliverables-result.zh-CN.png');
    await cdp.screenshot(chineseShot);
    log(`[6j] delivery centre screenshot (zh-CN): ${chineseShot}`);
    check(
      await cdp.evaluate(
        `(() => { const button = document.querySelectorAll('.lang-switch button')[1]; if (!button) return false; button.click(); return true; })()`,
      ),
      'the US language button must be clickable',
    );
    await cdp.waitFor(`document.querySelector('h1')?.textContent === 'Delivery Center'`, 'the English delivery heading');
    // A deep link is a page, not a dead end: the operator can walk back to the workspace.
    check(
      await cdp.evaluate(
        `(() => { const button = document.querySelector('.page-intro-actions button.link'); if (!button) return false; button.click(); return true; })()`,
      ),
      'the back-to-workspace link must be clickable',
    );
    await cdp.waitFor(
      `location.pathname === '/' && document.querySelectorAll('.project-card').length > 0`,
      'the workspace to take over from the delivery link',
      30_000,
    );

    log('[7] every one of the eleven pages renders from the real snapshot');
    for (const page of PAGES) {
      // Network and Canvas are canvases, not card stacks: their own surfaces are the panel the
      // snapshot must fill.
      const panelSelector = page === 'Network'
        ? '.network-deck'
        : page === 'Canvas' ? '.canvas-board' : '.panel';
      check(await cdp.evaluate(NAVIGATE(page)), `${page} nav button must be clickable`);
      await cdp.waitFor(
        `document.querySelector('h1')?.textContent === ${JSON.stringify(page)}`,
        `${page} heading`,
        30_000,
      );
      await cdp.waitFor(
        `document.querySelectorAll(${JSON.stringify(panelSelector)}).length > 0`,
        `${page} panels`,
        30_000,
      );
      // One full poll cycle: the snapshot is re-read every 2500 ms, so a contract failure on
      // the *next* refresh must be observed too, not only on the first render.
      await sleep(2_700);
      const state = JSON.parse(
        await cdp.evaluate(
          `JSON.stringify({
            heading: document.querySelector('h1')?.textContent ?? null,
            panels: document.querySelectorAll(${JSON.stringify(panelSelector)}).length,
            failure: document.querySelector('.failure')?.textContent ?? null,
            boundary: document.querySelector('.boundary')?.textContent ?? null,
            errors: window.__pageErrors ?? [],
          })`,
        ),
      );
      check(state.heading === page, `${page} heading drifted to ${String(state.heading)}`);
      check(state.failure === null, `${page} shows a load failure: ${String(state.failure)}`);
      check(state.boundary === null, `${page} hit the ErrorBoundary: ${String(state.boundary)}`);
      check(Array.isArray(state.errors) && state.errors.length === 0, `${page} logged: ${String(state.errors)}`);
      log(`      ${page}: clean (${String(state.panels)} panels)`);
    }

    log(`[done] operator loop verified in Chrome — screenshot: ${finalShot}`);
  } catch (cause) {
    if (cdp !== null) {
      const failureShot = path.join(ARTIFACTS, 'console-loop-failed.png');
      try {
        await cdp.screenshot(failureShot);
        log(`[fail] screenshot: ${failureShot}`);
      } catch {
        /* page may be gone */
      }
    }
    log(`[fail] ${cause instanceof Error ? cause.message : String(cause)}`);
    cleanup();
    process.exit(1);
  }

  cleanup();
  process.exit(0);
}

await main();

