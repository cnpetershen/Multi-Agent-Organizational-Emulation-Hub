import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { enterConsole } from './gate.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const apiPort = 3201;
const cdpPort = 9445;
const pages = ['Overview', 'Network', 'Agents', 'Deliverables', 'Tasks', 'Workflows', 'Canvas', 'Approvals', 'Communications', 'Runtime', 'Events'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const findEdge = () => ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((candidate) => existsSync(candidate));
const edgePath = findEdge();
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
const webPort = await pickBindablePort(4181);
const url = `http://127.0.0.1:${String(webPort)}/`;

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
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
    const id = ++this.nextId;
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
  async waitFor(expression, label) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await this.evaluate(expression) === true) return;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${label}`);
  }
  close() { this.socket.close(); }
}

const waitHttp = async (target) => {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try { if ((await fetch(target)).ok) return; } catch { /* starting */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${target}`);
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
const apiLog = path.join(tmpdir(), `maoeh-viewport-api-${String(Date.now())}`, 'events.jsonl');
const api = spawn(process.execPath, ['apps/api/dist/index.js'], { cwd: root, env: { ...process.env, PORT: String(apiPort), MAOEH_EVENT_LOG: apiLog, MAOEH_OWNERSHIP: 'memory' }, stdio: 'ignore' });
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { cwd: path.join(root, 'apps', 'web'), env: { ...process.env, PORT: String(apiPort) }, stdio: 'ignore' });
const edge = spawn(edgePath, ['--headless=new', `--remote-debugging-port=${String(cdpPort)}`, `--user-data-dir=${path.join(tmpdir(), `maoeh-viewport-${String(Date.now())}`)}`, '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--window-size=1024,900', 'about:blank'], { stdio: 'ignore' });
let cdp;
try {
  await waitHttp(`http://127.0.0.1:${String(apiPort)}/api/simulation`);
  await waitHttp(url);
  const version = await (await fetch(`http://127.0.0.1:${String(cdpPort)}/json/version`)).json();
  const target = await (await fetch(`http://127.0.0.1:${String(cdpPort)}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__pageErrors = []; const e = console.error; console.error = (...args) => { window.__pageErrors.push(args.map(String).join(' ')); e(...args); }; window.addEventListener('error', (event) => window.__pageErrors.push(String(event.message))); window.addEventListener('unhandledrejection', (event) => window.__pageErrors.push(String(event.reason))); })()` });
  await cdp.send('Page.reload', { ignoreCache: true });
  // M1.5: a fresh profile lands on the company gate, so sign in before the shell assertions.
  await enterConsole(cdp);
  await cdp.waitFor(`document.querySelector('h1')?.textContent === 'Overview'`, 'overview');
  console.log(`[edge] ${String(version.Browser)} connected`);
  for (const [width, height] of [[1024, 900], [390, 844]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.reload', { ignoreCache: true });
    await cdp.waitFor(`document.querySelector('h1')?.textContent === 'Overview'`, `overview at ${String(width)}px`);
    for (const page of pages) {
      await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === ${JSON.stringify(page)}); if (!button) throw new Error('missing nav'); button.click(); return true; })()`);
      await cdp.waitFor(`document.querySelector('h1')?.textContent === ${JSON.stringify(page)}`, page);
      await sleep(400);
      const state = await cdp.evaluate(`JSON.stringify({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, errors: window.__pageErrors ?? [], failure: document.querySelector('.failure')?.textContent ?? null, boundary: document.querySelector('.boundary')?.textContent ?? null })`);
      const parsed = JSON.parse(state);
      if (parsed.scrollWidth > parsed.width + 1) throw new Error(`${page} overflow at ${String(width)}px: ${String(parsed.scrollWidth)} > ${String(parsed.width)}`);
      if (parsed.errors.length > 0) throw new Error(`${page} browser errors at ${String(width)}px: ${String(parsed.errors)}`);
      if (parsed.failure !== null || parsed.boundary !== null) throw new Error(`${page} rendered an error at ${String(width)}px`);
    }
    console.log(`[edge] ${String(width)}px: 11 pages clean, no horizontal overflow, no React/console errors`);
  }
} finally {
  if (cdp !== undefined) cdp.close();
  stop(edge); stop(web); stop(api);
}
