/**
 * The delivery page's Run Preview panel, end to end, in a real browser.
 *
 * `tests/e2e/console-loop.mjs` proves the operator loop; `tests/integration/preview-runtime-http
 * .test.ts` proves the preview API. Neither proves the thing the owner actually looks at: that
 * opening a finished delivery shows a *running* game inside the console, and that the buttons
 * around it work. This script drives exactly that path with the production bundle:
 *
 *   mandate -> workflow delivers -> Deliverables -> View result -> the preview panel starts the
 *   delivered project -> the iframe's canvas really renders -> keyboard input reaches the game
 *   -> 停止 stops it -> 重新运行 brings it back -> the six delivered files are still listed
 *
 * Chrome is driven over the DevTools protocol (no extra dependency: Node ships a WebSocket
 * client), and the tetris mandate is the same command the console sends, so nothing here is a
 * simulation of a simulation.
 *
 * Run:  node tests/e2e/preview-panel.mjs
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
const API_PORT = 3201;
const CDP_PORT = 9446;
const ARTIFACTS = path.join(ROOT, 'tests', 'e2e', 'artifacts');
const MANDATE = '开发一个俄罗斯方块程序\n前端Web SPA 后端用python，后端用来记录每次排名和得分';

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
const CONSOLE_URL = `http://127.0.0.1:${String(WEB_PORT)}/`;

async function waitForHttp(url, label, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
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
  if (found === undefined) fail('Chrome not found — set CHROME_PATH to a Chrome binary');
  return found;
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
    /** Every execution context CDP has announced, so the preview frame's own one can be found. */
    this.contexts = [];
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) {
        if (message.method === 'Runtime.executionContextCreated') {
          this.contexts.push(message.params.context);
        } else if (message.method === 'Runtime.executionContextsCleared') {
          this.contexts = [];
        }
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

  /** Evaluate an expression in the top-level page. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails !== undefined) fail(`page evaluation threw: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
    return result.result.value;
  }

  /** Evaluate an expression in the page (or in the preview frame's own context). */
  async evaluateIn(expression, contextId) {
    const params = { expression, awaitPromise: true, returnByValue: true };
    if (contextId !== undefined) params.contextId = contextId;
    const result = await this.send('Runtime.evaluate', params);
    if (result.exceptionDetails !== undefined) return `THREW: ${String(result.exceptionDetails.text)}`;
    return result.result.value;
  }

  /**
   * The execution context of the preview iframe.
   *
   * The console and the preview are different origins (`127.0.0.1:4312` vs `127.0.0.1:<port>`),
   * which is correct and deliberate — a previewed project must not be able to script the console
   * that shows it. The consequence is that the page's own JavaScript cannot read into the frame,
   * exactly as the browser intends; the DevTools protocol sits outside that boundary, so the
   * frame's *own* context is how a test observes the game. Attaching requires no runtime flag
   * and no page cooperation.
   */
  previewContext(frameId) {
    for (const entry of this.contexts) {
      if (entry.auxData !== undefined && entry.auxData['frameId'] === frameId) return entry.id;
    }
    return undefined;
  }

  /** The iframe whose src is the preview URL, as CDP sees it. */
  async previewFrame() {
    const tree = await this.send('Page.getFrameTree');
    const walk = (node) => {
      const children = node.childFrames ?? [];
      for (const child of children) {
        if (String(child.frame.url).startsWith('http://127.0.0.1:')) return child.frame;
        const deep = walk(child);
        if (deep !== null) return deep;
      }
      return null;
    };
    return walk(tree.frameTree);
  }

  async waitFor(expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.evaluate(expression)) === true) return;
      if (Date.now() > deadline) {
        const diagnostics = await this.evaluate(
          `JSON.stringify({ h1: document.querySelector('h1')?.textContent ?? null, panel: document.querySelector('.result-preview')?.textContent?.slice(0, 300) ?? null })`,
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

  /**
   * Capture one element's own box in absolute page coordinates.
   *
   * Used for a panel that is taller than the viewport: a whole-page screenshot would cut off the
   * very controls the check is about. The height comes from `scrollHeight` because the panel's
   * frame scrolls internally, so `getBoundingClientRect` would report only the visible part.
   */
  async captureElement(selector, file) {
    // `captureBeyondViewport` clips against the whole document rather than the current scroll
    // position, so the rect has to be absolute (rect + scroll) for the clip to land correctly.
    const box = await this.evaluate(
      '(() => { const node = document.querySelector(' + JSON.stringify(selector) + ');'
      + ' if (node === null) return null; const rect = node.getBoundingClientRect();'
      + ' return JSON.stringify({ x: rect.x + window.scrollX, y: rect.y + window.scrollY,'
      + ' width: rect.width, height: Math.max(node.scrollHeight, rect.height) }); })()',
    );
    if (box === null) fail(`cannot capture ${selector}: not found`);
    const rect = JSON.parse(String(box));
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height, scale: 1 },
    });
    await writeFile(file, Buffer.from(shot.data, 'base64'));
  }
}

/**
 * Click an action button in the preview panel by its stable test id.
 *
 * The visible label is localized (中文 `停止` / English `Stop`) and the default locale is English,
 * so a check that matched on the label would silently depend on the console's language.
 */
const CLICK_PREVIEW_ACTION = (kind) => `(() => {
  const button = document.querySelector('[data-testid="preview-action-${kind}"]');
  if (button === null || button.disabled) return false;
  button.click();
  return true;
})()`;

const PREVIEW_STATE = `(() => {
  const panel = document.querySelector('.result-preview');
  if (panel === null) return null;
  const frame = panel.querySelector('iframe');
  return JSON.stringify({
    heading: panel.querySelector('.panel-head h2, h2, h3')?.textContent ?? null,
    text: panel.textContent,
    status: panel.querySelector('.pill')?.textContent ?? null,
    iframeSrc: frame?.getAttribute('src') ?? null,
  });
})()`;

/**
 * A fingerprint of the live board: the lit-pixel count plus a per-row profile.
 *
 * The count alone is too coarse — a board whose background grid dominates the pixel budget can
 * absorb a moving piece without the total changing — so the row profile goes with it. A loop that
 * is genuinely running moves the falling piece, which shifts the profile even when two frames
 * happen to light the same number of pixels.
 */
const BOARD_FINGERPRINT = `(() => {
  const canvas = document.querySelector('canvas#board');
  if (!canvas) return 'no-canvas';
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const rows = [];
  let lit = 0;
  for (let y = 0; y < canvas.height; y += 1) {
    let rowLit = 0;
    for (let x = 0; x < canvas.width; x += 1) {
      const index = (y * canvas.width + x) * 4;
      if (Math.abs(data[index] - 16) + Math.abs(data[index + 1] - 20) + Math.abs(data[index + 2] - 28) > 40) {
        rowLit += 1;
        lit += 1;
      }
    }
    rows.push(rowLit);
  }
  return JSON.stringify({ lit, rows });
})()`;

/** The delivered page's own HUD, read from inside the frame. */
const FRAME_HUD = `JSON.stringify({
  score: document.querySelector('#score')?.textContent ?? null,
  lines: document.querySelector('#lines')?.textContent ?? null,
  status: document.querySelector('#status')?.textContent ?? null,
  hasCanvas: document.querySelector('canvas#board') !== null,
  title: document.title,
})`;

async function main() {
  const chromePath = findChrome();
  const profile = path.join(tmpdir(), `maoeh-preview-e2e-${String(Date.now())}`);
  await mkdir(ARTIFACTS, { recursive: true });
  log(`[setup] chrome: ${chromePath}`);
  log(`[setup] console port ${String(WEB_PORT)}, preview panel e2e`);

  const api = spawn(process.execPath, ['apps/api/dist/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      MAOEH_EVENT_LOG: path.join(profile, 'events.jsonl'),
      MAOEH_OWNERSHIP: 'memory',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
      '--headless',
      `--remote-debugging-port=${String(CDP_PORT)}`,
      `--user-data-dir=${profile}`,
      '--remote-allow-origins=*',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--window-size=1440,16384',
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
      for (const line of lines) if (line.trim() !== '') log(`[${prefix}] ${line}`);
    });
  };
  capture('api', api.stdout);
  capture('api', api.stderr);
  capture('web', preview.stdout);
  capture('web', preview.stderr);

  try {
    log('[setup] waiting for the API and the console bundle');
    await waitForHttp(`http://127.0.0.1:${String(API_PORT)}/api/simulation`, 'the API server');
    await waitForHttp(CONSOLE_URL, 'the console preview');

    // 1. The mandate, sent exactly as the console sends it, so the organization really delivers.
    log('[1] handing the tetris mandate to the company');
    const command = {
      commandId: `panel-e2e-${String(Date.now())}`,
      commandType: 'Agent.Instruct',
      actor: { operatorId: 'ceo-alex', displayName: 'Alex', positionId: 'ceo', kind: 'human' },
      target: { targetType: 'agent', targetId: 'ceo-alex' },
      reason: 'delivery page preview e2e',
      correlationId: `panel-e2e-${String(Date.now())}`,
      causationId: null,
      createdAtSim: 0,
      instruction: MANDATE,
    };
    const instructed = await (
      await fetch(`http://127.0.0.1:${String(API_PORT)}/api/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command),
      })
    ).json();
    check(instructed.status === 'accepted', `the mandate must be accepted: ${JSON.stringify(instructed)}`);

    let deliveredTaskId = null;
    const deadline = Date.now() + 90_000;
    while (deliveredTaskId === null && Date.now() < deadline) {
      const tasks = await (await fetch(`http://127.0.0.1:${String(API_PORT)}/api/tasks`)).json();
      const finished = Array.isArray(tasks)
        ? tasks.filter((task) => ['completed', 'submitted'].includes(String(task.status)))
        : [];
      // The wiring step (`run.py`) is the one whose delivery names the runnable project; any
      // finished step works, because a preview composes the whole product from all of them.
      const anchor = finished.find((task) => String(task.title).toLowerCase() === 'implementation') ?? finished[0];
      if (anchor !== undefined) deliveredTaskId = String(anchor.taskId);
      if (deliveredTaskId === null) await sleep(500);
    }
    check(deliveredTaskId !== null, 'the workflow must deliver at least one step');
    log(`[1b] delivery page under test: /results/${deliveredTaskId}`);

    const version = await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/version`)).json();
    log(`[setup] chrome devtools: ${String(version['Browser'])}`);
    const target = await (
      await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/new?${encodeURIComponent(CONSOLE_URL)}`, { method: 'PUT' })
    ).json();
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // Headless Chrome throttles `requestAnimationFrame` for a page it does not consider
    // foreground, and a game that only advances inside rAF would then look frozen. Bringing the
    // target to the front makes the page the one the compositor actually animates — the same
    // condition a person looking at the console creates.
    await cdp.send('Page.bringToFront').catch(() => undefined);

    log('[2] entering the console and opening the finished delivery');
    await cdp.waitFor(`document.querySelector('[data-testid="foundry-signin"]') !== null`, 'the company gate');
    await enterConsole(cdp);
    await cdp.waitFor(`document.querySelectorAll('nav button').length === 9`, 'the console shell');

    // Deep-link the delivery page: this is the address a shared result opens.
    await cdp.send('Page.navigate', { url: `${CONSOLE_URL}results/${deliveredTaskId}` });
    await cdp.waitFor(`document.querySelector('.result-hero') !== null`, 'the delivery header');
    log('[2b] the delivery page is open');

    // 3. The preview panel sits ABOVE the technical files, as the product asked.
    log('[3] the Run Preview panel appears before the file list');
    await cdp.waitFor(`document.querySelector('.result-preview') !== null`, 'the Run Preview panel', 30_000);
    const order = await cdp.evaluate(`(() => {
      const panel = document.querySelector('.result-preview');
      const deliverable = document.querySelector('#final-deliverable');
      if (panel === null || deliverable === null) return null;
      return (panel.compareDocumentPosition(deliverable) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    })()`);
    check(order === true, 'the preview panel must be rendered above the delivered files');

    // 4. It auto-starts the delivered project and shows it in an iframe.
    log('[4] waiting for the delivered game to start inside the page');
    await cdp.waitFor(
      `(() => { const panel = document.querySelector('.result-preview'); const frame = panel?.querySelector('iframe'); return typeof frame?.getAttribute('src') === 'string' && frame.getAttribute('src').startsWith('http://127.0.0.1:'); })()`,
      'the preview iframe pointing at the running project',
      60_000,
    );
    const state = JSON.parse(await cdp.evaluate(PREVIEW_STATE));
    log(`[4b] panel: ${JSON.stringify({ heading: state.heading, status: state.status, src: state.iframeSrc })}`);
    check(state.iframeSrc !== null && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(state.iframeSrc), 'the iframe must point at the preview URL');

    // The iframe is the *live* delivered page: the same URL really serves it.
    const served = await fetch(state.iframeSrc);
    const html = await served.text();
    check(served.status === 200, `the preview URL must answer 200, got ${String(served.status)}`);
    check(html.includes('<canvas id="board"'), 'the served page must be the delivered tetris client');
    const liveHealth = await (await fetch(`${state.iframeSrc}api/health`)).json();
    check(liveHealth.ok === true, 'the delivered service must answer /api/health through the preview URL');
    log(`[4c] the preview URL serves the real product: ${String(html.length)} bytes, health ok`);

    // 5. The game inside the iframe renders, its loop runs, and keyboard input reaches it.
    log('[5] observing and driving the game inside the iframe');
    // The console and the preview are different origins, so the page cannot read into the frame
    // (by design). The frame's own execution context is where the game can be observed.
    let contextId = null;
    for (let attempt = 0; attempt < 60 && contextId === null; attempt += 1) {
      const frame = await cdp.previewFrame();
      if (frame !== null) contextId = cdp.previewContext(frame.id) ?? null;
      if (contextId === null) await sleep(250);
    }
    check(contextId !== null, 'the preview frame must expose its own execution context');

    const hud = JSON.parse(String(await cdp.evaluateIn(FRAME_HUD, contextId)));
    log(`[5a] the delivered page inside the frame: ${JSON.stringify(hud)}`);
    check(hud.hasCanvas === true, 'the frame must contain the delivered board canvas');

    // A live loop: the canvas keeps changing on its own, with no input at all.
    const sampleFrame = async () => JSON.parse(String(await cdp.evaluateIn(BOARD_FINGERPRINT, contextId)));
    const first = await sampleFrame();
    check(typeof first.lit === 'number' && first.lit > 0, `the delivered canvas must render pieces (lit cells: ${String(first.lit)})`);
    let advanced = null;
    for (let attempt = 0; attempt < 48; attempt += 1) {
      await sleep(250);
      const sample = await sampleFrame();
      if (JSON.stringify(sample.rows) !== JSON.stringify(first.rows)) {
        advanced = sample;
        break;
      }
    }
    check(
      advanced !== null,
      `the game loop must advance on its own (fingerprint unchanged over 12s at ${String(first.lit)} lit cells)`,
    );
    log(`[5b] the loop is alive: the board changed on its own (${String(first.lit)} -> ${String(advanced.lit)} lit cells)`);

    // Keyboard input reaches the game through the page's own listener. The iframe is focused
    // first so the events land in the frame's document, exactly as they would for a player.
    await cdp.evaluate(`(() => {
      const frame = document.querySelector('.result-preview iframe');
      if (frame === null) return false;
      // Clicking the frame transfers focus into it, which is what a player does before typing.
      frame.click();
      try { frame.contentWindow?.focus(); } catch (error) { /* cross-origin focus is best effort */ }
      return true;
    })()`);
    const KEYS = {
      ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
      ArrowRight: { code: 'ArrowRight', keyCode: 39 },
      ArrowUp: { code: 'ArrowUp', keyCode: 38 },
      Space: { code: 'Space', keyCode: 32 },
    };
    const before = await sampleFrame();
    // Hard drops are the unambiguous input effect: each one lands a piece and grows the stack.
    for (const name of ['ArrowLeft', 'ArrowUp', 'Space', 'Space', 'Space']) {
      const spec = KEYS[name];
      const key = name === 'Space' ? ' ' : name;
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode,
      });
      await sleep(450);
    }
    let after = before;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const sample = await sampleFrame();
      if (JSON.stringify(sample.rows) !== JSON.stringify(before.rows)) {
        after = sample;
        break;
      }
      await sleep(250);
    }
    check(
      JSON.stringify(after.rows) !== JSON.stringify(before.rows),
      `the board must change under keyboard input (${String(before.lit)} -> ${String(after.lit)} lit cells)`,
    );
    log(`[5c] keyboard input reached the game: ${String(before.lit)} -> ${String(after.lit)} lit cells`);

    const runningShot = path.join(ARTIFACTS, 'preview-panel-running.png');
    await cdp.evaluate(`(() => { document.querySelector('.result-preview')?.scrollIntoView({ block: 'start' }); return true; })()`);
    await sleep(300);
    await cdp.screenshot(runningShot);
    log(`[5c] screenshot: ${runningShot}`);
    // A second capture of the panel *element*: the page screenshot is taller than the fold, and
    // the panel's own box is what this check is about (heading, status, controls and the frame).
    const runningPanelShot = path.join(ARTIFACTS, 'preview-panel-running-panel.png');
    await cdp.captureElement('.result-preview', runningPanelShot);
    log(`[5d] panel screenshot: ${runningPanelShot}`);

    // 6. 停止 really stops it — the port stops answering, not just the label changing.
    log('[6] pressing 停止');
    check(await cdp.evaluate(CLICK_PREVIEW_ACTION('stop')), 'the 停止 button must be clickable');
    await cdp.waitFor(
      `(() => { const panel = document.querySelector('.result-preview'); return panel !== null && panel.querySelector('iframe') === null; })()`,
      'the iframe to be removed after stopping',
      30_000,
    );
    await expectPortSilent(state.iframeSrc);
    log('[6b] stopped: the preview URL no longer answers');

    const stoppedShot = path.join(ARTIFACTS, 'preview-panel-stopped.png');
    await cdp.screenshot(stoppedShot);

    // 7. Starting again brings the project back, on a fresh port and a fresh process.
    log('[7] starting it again from the stopped state');
    // The enablement is state-driven, so this is the truthful assertion for a stopped preview:
    // there is nothing to restart, and the button that starts is the one that is offered.
    check(
      (await cdp.evaluate(`document.querySelector('[data-testid="preview-action-rerun"]')?.disabled === true`)) === true,
      'a stopped preview must not offer 重新运行 (there is nothing running to restart)',
    );
    check(await cdp.evaluate(CLICK_PREVIEW_ACTION('start')), 'the start button must be clickable while stopped');
    await cdp.waitFor(
      `(() => { const frame = document.querySelector('.result-preview iframe'); return typeof frame?.getAttribute('src') === 'string' && frame.getAttribute('src').startsWith('http://'); })()`,
      'the preview to come back after a restart',
      60_000,
    );
    const rerun = JSON.parse(await cdp.evaluate(PREVIEW_STATE));
    check(rerun.iframeSrc !== state.iframeSrc, `the restart must use a fresh port (was ${String(state.iframeSrc)}, now ${String(rerun.iframeSrc)})`);
    check((await fetch(rerun.iframeSrc)).status === 200, 'the restarted URL must serve the game');
    // And while it runs, 重新运行 is offered instead — the panel mirrors the real state.
    check(
      (await cdp.evaluate(`document.querySelector('[data-testid="preview-action-rerun"]')?.disabled === false`)) === true,
      'a running preview must offer 重新运行',
    );
    check(
      (await cdp.evaluate(`document.querySelector('[data-testid="preview-action-stop"]')?.disabled === false`)) === true,
      'a running preview must offer 停止',
    );
    log(`[7b] restarted on a fresh port: ${String(rerun.iframeSrc)}`);

    // 8. The delivered files are still listed under the preview — the original download surface.
    const files = await cdp.evaluate(`(() => {
      const paths = [...document.querySelectorAll('.product-file-path')].map((node) => node.textContent.trim());
      const downloads = [...document.querySelectorAll('.product-files button')].length;
      const chips = [...document.querySelectorAll('.chip-file')].map((node) => node.textContent.trim());
      const hasDownloadAll = [...document.querySelectorAll('.result-deliverable button')].some((node) => /Download/.test(node.textContent));
      return JSON.stringify({ paths, downloads, chips, hasDownloadAll });
    })()`);
    const parsed = JSON.parse(files);
    log(`[8] delivered files still listed: ${JSON.stringify(parsed.paths)} (${String(parsed.downloads)} download buttons)`);
    check(parsed.paths.includes('run.py'), 'the wiring file must still be listed for download');
    check(parsed.paths.includes('client/index.html'), 'the front-end file must still be listed for download');
    check(parsed.paths.includes('server/app.py'), 'the service file must still be listed for download');
    check(parsed.downloads >= 3, 'every listed file must keep its download button');
    check(parsed.hasDownloadAll, 'the single-deliverable download button must survive');

    log('[done] the delivery page shows a real running project and keeps its downloads');
  } finally {
    cleanup();
  }
}

/** Poll until the preview URL stops answering (or fail loudly). */
async function expectPortSilent(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let alive;
    try {
      alive = (await fetch(url, { signal: AbortSignal.timeout(1_000) })).status < 400;
    } catch {
      alive = false;
    }
    if (!alive) return;
    if (Date.now() > deadline) fail(`the preview URL still answers after 停止: ${url}`);
    await sleep(300);
  }
}

await main();
