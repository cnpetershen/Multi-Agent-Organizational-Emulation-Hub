/**
 * M1.5 end-to-end: the headline flow, in a real browser.
 *
 *   load console -> the "Create Your AI Company" gate -> Founder -> Company Name -> 创建
 *   -> the console opens *their* company (name in the sidebar, one generated CEO agent)
 *   -> "Switch company" puts the founder back on the gate
 *
 * The API assertions run against the same server the browser talks to, so this proves the whole
 * chain: form -> POST /api/ownership/companies -> runtime switch -> snapshot.
 *
 * Run:  node tests/e2e/create-company-smoke.mjs
 * The vitest config excludes tests/e2e, so this never runs inside `pnpm test`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..', '..');
const CDP_PORT = 9450;
const ARTIFACTS = path.join(root, 'tests', 'e2e', 'artifacts');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => process.stdout.write(`${message}\n`);
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

/**
 * Windows reserves dynamic port ranges (Hyper-V) that move between reboots, and a reserved
 * range makes `listen` fail with EACCES rather than EADDRINUSE — so both ports are probed.
 */
async function pickBindablePort(preferred) {
  const candidates = [preferred, ...Array.from({ length: 160 }, (_, index) => preferred + 1 + index)];
  for (const port of candidates) {
    const bindable = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (bindable) return port;
  }
  throw new Error(`no bindable port near ${String(preferred)}`);
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
  if (found === undefined) throw new Error('Chrome not found — set CHROME_PATH to a Chrome binary');
  return found;
}

const waitHttp = async (target, label, timeoutMs = 40_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(target)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (${target})`);
    await sleep(200);
  }
};

const stop = (child) => {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
};

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
    throw new Error('timed out connecting to Chrome CDP');
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
  async waitFor(expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.evaluate(expression)) === true) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await sleep(250);
    }
  }
  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(shot.data, 'base64'));
  }
  close() { this.socket.close(); }
}

/** A React controlled input only reacts to the native setter + a bubbling `input` event. */
const SET_VALUE = (selector, value) => `
(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  if (!input) return false;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  return true;
})()`;

const CLICK = (selector) => `
(() => {
  const button = document.querySelector(${JSON.stringify(selector)});
  if (!button) return false;
  button.click();
  return true;
})()`;

mkdirSync(ARTIFACTS, { recursive: true });
const apiPort = await pickBindablePort(3210);
const webPort = await pickBindablePort(4250);
const url = `http://127.0.0.1:${String(webPort)}/`;
const chromePath = findChrome();
const profile = path.join(tmpdir(), `maoeh-create-company-${String(Date.now())}`);

// Isolated run: in-memory event log and in-memory ownership record, so a smoke run never
// reads a previous company and never writes the real `companies.json`.
const api = spawn(process.execPath, ['apps/api/dist/index.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(apiPort), MAOEH_EVENT_LOG: 'memory', MAOEH_OWNERSHIP: 'memory' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const web = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
  cwd: path.join(root, 'apps', 'web'),
  env: { ...process.env, PORT: String(apiPort) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
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

let cdp;
try {
  await waitHttp(`http://127.0.0.1:${String(apiPort)}/api/simulation`, 'the API server');
  await waitHttp(url, 'the console preview');

  const target = await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__pageErrors = []; const original = console.error; console.error = (...args) => { window.__pageErrors.push(args.map(String).join(' ')); original(...args); }; window.addEventListener('error', (event) => window.__pageErrors.push(String(event.message))); window.addEventListener('unhandledrejection', (event) => window.__pageErrors.push(String(event.reason))); })()` });
  await cdp.send('Page.reload', { ignoreCache: true });

  log('[1] the Create Your AI Company gate');
  await cdp.waitFor(`document.querySelector('[data-testid="foundry-create"]') !== null`, 'the company gate');
  // The default company must already be a sign-in destination before anyone creates anything.
  await cdp.waitFor(`document.querySelector('[data-testid="foundry-signin"]') !== null`, 'the default sign-in destination');
  const gateShot = path.join(ARTIFACTS, 'create-company-gate.png');
  await cdp.screenshot(gateShot);
  log(`      gate screenshot: ${gateShot}`);

  log('[2] Founder -> Company Name');
  check(await cdp.evaluate(CLICK('[data-testid="foundry-create"]')), 'the create CTA must be clickable');
  await cdp.waitFor(`document.querySelector('[data-testid="foundry-founder"]') !== null`, 'the founder field');
  check(await cdp.evaluate(SET_VALUE('[data-testid="foundry-founder"]', 'Ada Lovelace')), 'the founder field must accept text');
  check(await cdp.evaluate(CLICK('[data-testid="foundry-continue"]')), 'Continue must be clickable');
  await cdp.waitFor(`document.querySelector('[data-testid="foundry-company-name"]') !== null`, 'the company name field');
  check(await cdp.evaluate(SET_VALUE('[data-testid="foundry-company-name"]', 'Neural Bakery')), 'the company name field must accept text');
  check(await cdp.evaluate(CLICK('[data-testid="foundry-submit"]')), 'Create company must be clickable');

  log('[3] the console opens their company');
  await cdp.waitFor(
    `document.querySelector('h1')?.textContent === 'Overview' && document.querySelector('.company-block strong')?.textContent === 'Neural Bakery'`,
    'the new company console',
    45_000,
  );
  await cdp.waitFor(`document.querySelector('.founder-line')?.textContent === 'Ada Lovelace'`, 'the founder line in the sidebar');
  const createdShot = path.join(ARTIFACTS, 'create-company-done.png');
  await cdp.screenshot(createdShot);
  log(`      console screenshot: ${createdShot}`);

  log('[4] the API agrees: one company, its owner, one CEO agent');
  const ownership = await (await fetch(`http://127.0.0.1:${String(apiPort)}/api/ownership`)).json();
  check(ownership.activeOrganizationId === 'neural-bakery', `active company is ${String(ownership.activeOrganizationId)}`);
  const company = (ownership.organizations ?? []).find((entry) => entry.id === 'neural-bakery');
  check(company !== undefined, 'the new company must be listed');
  check(company.ownerId === 'user-ada-lovelace', `owner is ${String(company.ownerId)}`);
  check(company.seed === 'starter', `seed is ${String(company.seed)}`);

  const agents = await (await fetch(`http://127.0.0.1:${String(apiPort)}/api/agents`)).json();
  check(Array.isArray(agents) && agents.length === 1, `expected exactly one agent, got ${JSON.stringify(agents)}`);
  check(agents[0].employeeId === 'ceo-alex', `the generated agent is ${String(agents[0].employeeId)}`);
  check(agents[0].organizationId === 'neural-bakery', `organizationId is ${String(agents[0].organizationId)}`);

  const snapshot = await (await fetch(`http://127.0.0.1:${String(apiPort)}/api/snapshot`)).json();
  check(snapshot.company.name === 'Neural Bakery', `snapshot company is ${String(snapshot.company?.name)}`);
  check(snapshot.company.ownerId === 'user-ada-lovelace', `snapshot ownerId is ${String(snapshot.company?.ownerId)}`);

  log('[5] Switch company puts the founder back on the gate');
  check(await cdp.evaluate(CLICK('.founder-switch')), 'the switch-company control must be clickable');
  await cdp.waitFor(`document.querySelector('[data-testid="foundry"]') !== null`, 'the gate again');

  const errors = await cdp.evaluate('JSON.stringify(window.__pageErrors ?? [])');
  check(JSON.parse(errors).length === 0, `browser errors: ${errors}`);
  log('[done] create-company verified in Chrome: gate -> Founder -> Company -> console -> back to the gate');
} finally {
  if (cdp !== undefined) cdp.close();
  stop(chrome); stop(web); stop(api);
}
