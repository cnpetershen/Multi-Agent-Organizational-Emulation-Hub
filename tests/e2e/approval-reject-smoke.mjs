import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { enterConsole } from './gate.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const apiPort = 3202;
const cdpPort = 9446;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const edgePath = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((candidate) => existsSync(candidate));
if (edgePath === undefined) throw new Error('Microsoft Edge executable not found');

/**
 * Windows reserves dynamic port ranges (Hyper-V) that move between reboots, and a reserved
 * range makes `listen` fail with EACCES rather than EADDRINUSE — so the preview port is probed
 * instead of assumed, scanning far enough to clear a whole exclusion block.
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
  throw new Error(`no bindable preview port near ${String(preferred)}`);
}
const webPort = await pickBindablePort(4182);
const url = `http://127.0.0.1:${String(webPort)}/`;

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }
  static async connect(wsUrl) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const socket = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('connect timeout')), 1000);
          socket.addEventListener('open', () => { clearTimeout(timer); resolve(); });
          socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('connect failed')); });
        });
        return new Cdp(socket);
      } catch { await sleep(100); }
    }
    throw new Error('timed out connecting to Edge CDP');
  }
  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async waitFor(expression, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.evaluate(expression) === true) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await sleep(250);
    }
  }
  close() { this.socket.close(); }
}

const waitHttp = async (target) => {
  const deadline = Date.now() + 40_000;
  for (;;) {
    try { if ((await fetch(target)).ok) return; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${target}`);
    await sleep(200);
  }
};
const stop = (child) => {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
};

// A throwaway event log: the console is persistent by default, and a test must neither read
// a previous run's company nor leave one behind. `MAOEH_OWNERSHIP=memory` keeps the
// founder/company record in memory for the same reason: a smoke run never writes the real
// `companies.json`.
const apiLog = path.join(tmpdir(), `maoeh-reject-api-${String(Date.now())}`, 'events.jsonl');
const api = spawn(process.execPath, ['apps/api/dist/index.js'], { cwd: root, env: { ...process.env, PORT: String(apiPort), MAOEH_EVENT_LOG: apiLog, MAOEH_OWNERSHIP: 'memory' }, stdio: 'ignore' });
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { cwd: path.join(root, 'apps', 'web'), env: { ...process.env, PORT: String(apiPort) }, stdio: 'ignore' });
const edge = spawn(edgePath, ['--headless=new', `--remote-debugging-port=${String(cdpPort)}`, `--user-data-dir=${path.join(tmpdir(), `maoeh-reject-${String(Date.now())}`)}`, '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--window-size=1440,960', 'about:blank'], { stdio: 'ignore' });
let cdp;
try {
  await waitHttp(`http://127.0.0.1:${String(apiPort)}/api/simulation`);
  await waitHttp(url);
  const target = await (await fetch(`http://127.0.0.1:${String(cdpPort)}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__pageErrors = []; const original = console.error; console.error = (...args) => { window.__pageErrors.push(args.map(String).join(' ')); original(...args); }; window.addEventListener('error', (event) => window.__pageErrors.push(String(event.message))); window.addEventListener('unhandledrejection', (event) => window.__pageErrors.push(String(event.reason))); })()` });
  await cdp.send('Page.reload', { ignoreCache: true });
  // M1.5: a fresh profile lands on the company gate, so sign in before the shell assertions.
  await enterConsole(cdp);
  await cdp.waitFor(`document.querySelector('h1')?.textContent === 'Overview'`, 'overview');
  const fill = await cdp.evaluate(`(() => { const grid = document.querySelector('#start-work'); const set = (element, value) => { const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }; const inputs = [...(grid?.querySelectorAll('input:not([type])') ?? [])]; const areas = grid?.querySelectorAll('textarea'); if (inputs.length < 4 || !areas || areas.length < 3) return false; set(inputs[0], 'Reject path smoke'); set(areas[0], 'Verify the real browser rejection path'); set(areas[1], 'Reject this approval and record the outcome'); set(areas[2], 'rejection-record.md'); set(inputs[3], 'Regression cover for the reject path'); return true; })()`);
  if (fill !== true) throw new Error('Start Work form missing');
  await cdp.waitFor(`document.querySelector('#start-work input[type=checkbox]')?.checked === true`, 'hold checkbox');
  const started = await cdp.evaluate(`(() => { const button = [...(document.querySelector('#start-work')?.querySelectorAll('button.primary') ?? [])].find((item) => item.textContent.includes('Start Work')); if (!button) return false; button.click(); return true; })()`);
  if (started !== true) throw new Error('Start Work button missing');
  // §5.7: Start Work files a 任务书, which opens no gate by itself. The proposal comes from
  // the Chief Officer's instruction — now a diagnostic inside that agent's own record — and
  // the held runtime has to be stepped for the gate to arrive.
  const go = async (page) => {
    await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === ${JSON.stringify(page)}); if (!button) throw new Error('${page} nav missing'); button.click(); return true; })()`);
    await cdp.waitFor(`document.querySelector('h1')?.textContent === ${JSON.stringify(page)}`, `${page} page`);
  };
  await go('Agents');
  const details = await cdp.evaluate(`(() => { const card = [...document.querySelectorAll('.person-card')].find((node) => node.textContent.includes('Alex')); const button = card === undefined ? undefined : [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Details'); if (!button || button.disabled) return false; button.click(); return true; })()`);
  if (details !== true) throw new Error('Details button missing');
  await cdp.waitFor(`document.querySelector('.record-advanced textarea') !== null`, 'diagnostic instruction block');
  const instructed = await cdp.evaluate(`(() => { const area = document.querySelector('.record-advanced textarea'); if (!area) return false; Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(area, 'Verify the real browser rejection path'); area.dispatchEvent(new Event('input', { bubbles: true })); const button = document.querySelector('.record-advanced button.primary'); if (!button || button.disabled) return false; button.click(); return true; })()`);
  if (instructed !== true) throw new Error('diagnostic instruction missing');
  await go('Runtime');
  let gateOpen = false;
  for (let attempt = 0; attempt < 60 && !gateOpen; attempt += 1) {
    gateOpen = (await cdp.evaluate(`(async () => { const rows = await (await fetch('/api/workflows')).json(); return Array.isArray(rows) && rows.some((row) => row && row.approval && row.approval.status === 'open'); })()`)) === true;
    if (gateOpen) break;
    await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('.runtime-hero-actions button')].find((b) => b.textContent.trim() === 'Step once'); if (!button || button.disabled) return false; button.click(); return true; })()`);
    await sleep(500);
  }
  if (gateOpen !== true) throw new Error('no approval gate opened');
  // The console no longer parks on a page by itself — the operator walks to the inbox.
  await go('Approvals');
  await cdp.waitFor(`[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === 'Reject')`, 'Reject action');
  await cdp.waitFor(`document.querySelector('.side-foot span')?.textContent === 'HELD FOR YOU'`, 'runtime hold');
  const rejected = await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Reject'); if (!button) return false; button.click(); return true; })()`);
  if (rejected !== true) throw new Error('Reject button missing');
  await cdp.waitFor(`document.querySelector('.feedback b')?.textContent?.includes('Rejected') === true`, 'rejection feedback');
  await cdp.waitFor(`document.querySelector('.side-foot span')?.textContent === 'LIVE'`, 'runtime resume after rejection');
  await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === 'Workflows'); if (!button) throw new Error('Workflows nav missing'); button.click(); return true; })()`);
  await cdp.waitFor(`document.querySelector('h1')?.textContent === 'Workflows'`, 'Workflows page');
  await cdp.waitFor(`[...document.querySelectorAll('.table .tr')].some((row) => row.children[1]?.textContent?.trim() === 'aborted')`, 'aborted workflow');
  await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === 'Events'); if (!button) throw new Error('Events nav missing'); button.click(); return true; })()`);
  await cdp.waitFor(`document.querySelector('h1')?.textContent === 'Events'`, 'Events page');
  await cdp.waitFor(`document.body.textContent.includes('Workflow.ApprovalDenied')`, 'approval denied event');
  const errors = await cdp.evaluate('JSON.stringify(window.__pageErrors ?? [])');
  if (JSON.parse(errors).length > 0) throw new Error(`browser errors: ${errors}`);
  console.log('[edge] Reject path: real Reject -> resumed runtime -> aborted workflow -> ApprovalDenied event');
} finally {
  if (cdp !== undefined) cdp.close();
  stop(edge); stop(web); stop(api);
}
