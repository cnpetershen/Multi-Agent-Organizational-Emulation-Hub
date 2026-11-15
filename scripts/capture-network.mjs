/**
 * Capture the Network canvas in a real browser, for visual review of a local change.
 *
 * This is a development utility, not part of the test suite: it launches the installed Chrome
 * headless, enters the Peter AI Lab company through the same gate a founder uses, switches the
 * console to 中文, opens the Network page, and writes a full-page PNG. It depends on the web dev
 * server already being up (default http://localhost:5174) and the API on :3001.
 *
 * Run:  node scripts/capture-network.mjs
 * Env:  CONSOLE_URL (default http://localhost:5174/), CHROME_PATH, OUT (default
 *       .screenshots/network-zh.png), VIEWPORT_WIDTH / VIEWPORT_HEIGHT (default 1440 × 1000;
 *       pass 390 × 844 to review the narrow layout)
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PAGE = process.env['PAGE'] ?? 'Network';
const RESULT_TASK = process.env['RESULT_TASK'] ?? 'task-4';
const CONSOLE_URL = process.env['CONSOLE_URL'] ?? 'http://localhost:5174/';
const VIEWPORT_WIDTH = Number(process.env['VIEWPORT_WIDTH'] ?? 1440);
const VIEWPORT_HEIGHT = Number(process.env['VIEWPORT_HEIGHT'] ?? 1000);
const OUT = path.resolve(
  ROOT,
  process.env['OUT'] ?? `.screenshots/${PAGE === 'Network' ? 'network' : PAGE === 'Canvas' ? 'canvas' : PAGE === 'Results' ? 'results' : PAGE === 'Tasks' ? 'tasks' : 'deliverables'}-zh.png`,
);
const CDP_PORT = 9333;
const NAV_ICON = PAGE === 'Canvas'
  ? '.nav-canvas'
  : PAGE === 'Deliverables'
    ? '.nav-deliverables'
    : PAGE === 'Tasks'
      ? '.nav-tasks'
      : '.nav-network';
const READY = PAGE === 'Canvas'
  ? '.assignment-studio'
  : PAGE === 'Results'
    ? '.delivery-package'
    : PAGE === 'Deliverables'
      ? '.project-card'
      : PAGE === 'Tasks'
        ? '.task-intake'
        : '.network-deck';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const candidates = [
    process.env['CHROME_PATH'],
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter((value) => typeof value === 'string' && value !== '');
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error('Chrome not found — set CHROME_PATH');
  return found;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.text ?? 'evaluation failed');
    }
    return result.result?.value;
  }
}

async function waitFor(cdp, expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cdp.evaluate(expression)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}

async function waitForCdp() {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const pages = await response.json();
      const page = pages.find((entry) => entry.type === 'page');
      if (page !== undefined) return page.webSocketDebuggerUrl;
    } catch {
      /* Chrome is still starting. */
    }
    if (Date.now() > deadline) throw new Error('Chrome did not expose a CDP page');
    await sleep(200);
  }
}

const profile = await mkdtemp(path.join(tmpdir(), 'maoeh-network-'));
const chrome = spawn(
  findChrome(),
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${String(VIEWPORT_WIDTH)},${String(VIEWPORT_HEIGHT + 100)}`,
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
);

try {
  const socketUrl = await waitForCdp();
  const socket = new WebSocket(socketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(socket);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await cdp.send('Page.navigate', { url: CONSOLE_URL });
  await waitFor(cdp, `document.readyState === 'complete'`, 'the console document');
  await cdp.evaluate(`(() => { localStorage.setItem('maoeh.locale', 'zh-CN'); return true; })()`);
  await cdp.send('Page.reload');
  await waitFor(cdp, `document.querySelector('[data-testid="foundry-signin"]') !== null`, 'the founder gate');
  await cdp.evaluate(`(() => { document.querySelector('[data-testid="foundry-signin"]').click(); return true; })()`);
  await waitFor(cdp, `document.querySelector('[data-testid="foundry-company"]') !== null`, 'the company list');
  await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('[data-testid="foundry-company"]')];
    const preferred = buttons.find((button) => button.textContent.includes('Peter AI Lab')) ?? buttons[0];
    preferred.click();
    return true;
  })()`);
  await waitFor(cdp, `document.querySelector('.shell') !== null`, 'the console shell');
  if (PAGE === 'Results') {
    await cdp.evaluate(`(() => {
      window.history.pushState(null, '', '/results/${RESULT_TASK}');
      window.dispatchEvent(new PopStateEvent('popstate'));
      return true;
    })()`);
  } else {
    await cdp.evaluate(`(() => {
      const icon = document.querySelector(${JSON.stringify(NAV_ICON)});
      const button = icon === null ? null : icon.closest('button');
      button.click();
      return true;
    })()`);
  }
  await waitFor(cdp, `document.querySelector(${JSON.stringify(READY)}) !== null`, `${PAGE} ready`);
  if (PAGE === 'Canvas') {
    await waitFor(cdp, `document.querySelectorAll('.assignment-node').length > 0`, 'assignment nodes');
    const wanted = process.env['CANVAS_INSTANCE'];
    if (wanted !== undefined && wanted !== '') {
      await cdp.evaluate(`(() => {
        const select = document.querySelector('.assignment-top-right select');
        if (select === null) return false;
        select.value = ${JSON.stringify(wanted)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await sleep(600);
      await waitFor(cdp, `document.querySelectorAll('.assignment-node').length > 0`, 'selected assignment nodes');
    }
  } else if (PAGE === 'Network') {
    await waitFor(cdp, `document.querySelectorAll('.net-node').length > 5`, 'network nodes');
  }
  await sleep(1500);

  const metrics = await cdp.send('Page.getLayoutMetrics');
  const content = metrics.cssContentSize ?? metrics.contentSize;
  const clip = { x: 0, y: 0, width: content.width, height: Math.min(content.height, 3200), scale: 1 };
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, Buffer.from(shot.data, 'base64'));

  const summary = await cdp.evaluate(`(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (element === null) return null;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height), display: style.display, columns: style.gridTemplateColumns, overflow: style.overflow };
    };
    return {
      title: document.title,
      lang: document.documentElement.lang,
      agents: document.querySelectorAll('.net-agent').length,
      workflows: document.querySelectorAll('.net-workflow').length,
      deliveries: document.querySelectorAll('.net-delivery').length,
      theatre: document.querySelectorAll('.theatre-card').length,
      inspector: document.querySelector('.network-inspector h3')?.textContent ?? '',
      deck: rect('.network-deck'),
      body: rect('.network-deck-body'),
      viewport: rect('.network-viewport'),
      inspectorRect: rect('.network-inspector'),
      top: rect('.network-deck-top'),
      canvasNodes: document.querySelectorAll('.assignment-node').length,
      canvasEdges: document.querySelectorAll('.assignment-edge').length,
      canvasStages: document.querySelectorAll('.assignment-stage').length,
      canvasInspector: document.querySelector('.assignment-inspector h3')?.textContent ?? '',
      studio: rect('.assignment-studio'),
      palette: rect('.assignment-palette'),
      graph: rect('.assignment-board'),
      packageCards: document.querySelectorAll('.package-card').length,
      packageFiles: document.querySelectorAll('.package-file').length,
      packageDoc: document.querySelectorAll('.package-card-doc').length,
      package3d: document.querySelectorAll('.package-card-3d').length,
      packageTitle: document.querySelector('.package-head h2')?.textContent ?? '',
      resultKind: document.querySelector('.result-hero-kind')?.textContent ?? '',
      docSheets: document.querySelectorAll('.doc-sheet').length,
      previewState: document.querySelector('.result-preview')?.textContent?.slice(0, 120) ?? '',
      previewFrame: (() => {
        const frame = document.querySelector('.result-preview iframe');
        if (frame === null) return null;
        const rect = frame.getBoundingClientRect();
        return { src: frame.getAttribute('src'), w: Math.round(rect.width), h: Math.round(rect.height) };
      })(),
      viewportWidth: window.innerWidth,
      packageGridColumns: document.querySelector('.package-grid') === null ? '' : getComputedStyle(document.querySelector('.package-grid')).gridTemplateColumns,
      packageH2Color: document.querySelector('.package-head h2') === null ? '' : getComputedStyle(document.querySelector('.package-head h2')).color,
      packageHead: rect('.package-head'),
      packageGrid: rect('.package-grid'),
      deliverablePackages: document.querySelectorAll('.project-card').length,
    };
  })()`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`wrote ${OUT}\n`);

  const action = process.env['ACTION'];
  if (PAGE === 'Deliverables' && action === 'project') {
    const opened = await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.project-card')];
      const card = cards.find((node) => node.textContent.includes('一鱼多吃') && node.textContent.includes('5/5'))
        ?? cards.find((node) => node.textContent.includes('一鱼多吃'));
      const button = card?.querySelector('button.primary');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!opened) throw new Error('could not open the 一鱼多吃 project');
    await waitFor(cdp, `location.pathname === '/results/task-32'`, 'the implementation delivery page');
    process.stdout.write(`project opens ${await cdp.evaluate('location.pathname')}\n`);
    await waitFor(cdp, `document.querySelector('.result-preview iframe') !== null`, 'the live preview iframe', 30_000);
    await sleep(2500);
    process.stdout.write(`preview iframe: ${JSON.stringify(await cdp.evaluate(`(() => {
      const frame = document.querySelector('.result-preview iframe');
      return { src: frame?.getAttribute('src') ?? null, pageHost: location.hostname };
    })()`))}\n`);
    const tree = await cdp.send('Page.getFrameTree');
    const child = (tree.frameTree.childFrames ?? []).find((entry) => entry.frame.url.includes('127.0.0.1'));
    if (child !== undefined) {
      const world = await cdp.send('Page.createIsolatedWorld', { frameId: child.frame.id, worldName: 'maoeh-inspect' });
      const content = await cdp.send('Runtime.evaluate', {
        expression: `({ title: document.title, text: (document.body?.innerText ?? '').slice(0, 240), cards: document.querySelectorAll('.card').length })`,
        returnByValue: true,
        contextId: world.executionContextId,
      });
      process.stdout.write(`preview frame: ${JSON.stringify({ url: child.frame.url, value: content.result?.value })}\n`);
    } else {
      process.stdout.write('preview frame: no child frame found\n');
    }
    const rect = await cdp.evaluate(`(() => {
      const frame = document.querySelector('.result-preview iframe');
      if (frame === null) return null;
      const box = frame.getBoundingClientRect();
      return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
    })()`);
    if (rect !== null) {
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
      });
      const out = path.resolve(ROOT, '.screenshots/fish-iframe.png');
      await writeFile(out, Buffer.from(shot.data, 'base64'));
      process.stdout.write(`wrote ${out}\n`);
    }
  }
  if (PAGE === 'Results' && action === 'translate') {
    const clicked = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.doc-lang button')].find((node) => !node.classList.contains('active'));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    if (!clicked) throw new Error('could not find the document translation button');
    await waitFor(
      cdp,
      `document.querySelector('.doc-sheet .doc-markdown')?.textContent.match(/[\\u4e00-\\u9fff]/) !== null`,
      'the translated document',
      90_000,
    );
    const translatedShot = await cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    const translatedOut = path.resolve(ROOT, '.screenshots/results-brief17-zh.png');
    await writeFile(translatedOut, Buffer.from(translatedShot.data, 'base64'));
    process.stdout.write(`wrote ${translatedOut}\n`);
  }
  if (PAGE === 'Canvas' && action === 'stage') {
    const picked = await cdp.evaluate(`(() => {
      const person = [...document.querySelectorAll('.assignment-agent')].find((node) => node.textContent.includes('QA Engineer'));
      if (!person) return false;
      person.click();
      return true;
    })()`);
    if (!picked) throw new Error('tap-to-stage could not find the QA card');
    // React commits the chosen employee on the next render; the second click is a human-paced
    // gesture, not a same-tick DOM query.
    await sleep(180);
    const clicked = await cdp.evaluate(`(() => {
      const node = [...document.querySelectorAll('.assignment-node')].find((item) => item.textContent.includes('Implementation'));
      if (!node) return false;
      node.click();
      return true;
    })()`);
    if (!clicked) throw new Error('tap-to-stage could not find the Implementation node');
    await sleep(220);
    const staged = await cdp.evaluate(`(() => {
      const badge = document.querySelector('.assignment-node .assignment-badge.staged');
      const count = document.querySelectorAll('.assignment-node .assignment-badge.staged').length;
      return {
        badge: badge?.textContent ?? null,
        count,
        composer: document.querySelector('.assignment-composer-state')?.textContent ?? '',
      };
    })()`);
    if (staged === null || staged.count === 0) throw new Error('tap-to-stage did not pin a node');
    process.stdout.write(`tap-to-stage: ${JSON.stringify(staged)}\n`);
  }
  if (PAGE === 'Network' && action === 'game') {
    const started = await cdp.evaluate(`(() => {
      const card = document.querySelector('.theatre-card.theatre-game');
      const button = card === null ? null : card.querySelector('.theatre-actions .primary');
      if (button === null) return false;
      button.click();
      return true;
    })()`);
    if (!started) throw new Error('no game showcase card on the Network page');
    await waitFor(cdp, `document.querySelector('.network-preview iframe') !== null`, 'the live game iframe', 45_000);
    await sleep(1200);
    await cdp.evaluate(`(() => { window.getSelection()?.removeAllRanges(); return true; })()`);
    const footer = await cdp.evaluate(`(() => ([...document.querySelectorAll('.network-preview footer button')].map((button) => {
      const style = getComputedStyle(button);
      return { text: button.textContent, disabled: button.disabled, background: style.backgroundColor, color: style.color, opacity: style.opacity, outline: style.outline, selection: window.getSelection()?.toString() ?? '' };
    })))()`);
    process.stdout.write(`${JSON.stringify(footer)}\n`);
    await sleep(300);
    const viewportShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = path.resolve(ROOT, '.screenshots/network-game-preview.png');
    await writeFile(out, Buffer.from(viewportShot.data, 'base64'));
    process.stdout.write(`wrote ${out}\n`);
  }
  if (PAGE === 'Network' && action === 'all') {
    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.network-toolbar button')].find((entry) => entry.textContent.includes('显示全部'));
      if (button === undefined) return false;
      button.click();
      return true;
    })()`);
    await sleep(800);
    const allShot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1440, height: 1200, scale: 1 },
    });
    const out = path.resolve(ROOT, '.screenshots/network-all.png');
    await writeFile(out, Buffer.from(allShot.data, 'base64'));
    const counts = await cdp.evaluate(`(() => ({ workflows: document.querySelectorAll('.net-workflow').length, deliveries: document.querySelectorAll('.net-delivery').length }))()`);
    process.stdout.write(`${JSON.stringify(counts)}\n`);
    process.stdout.write(`wrote ${out}\n`);
  }
  if (PAGE === 'Network' && action === 'hover') {
    const center = await cdp.evaluate(`(() => {
      const rect = document.querySelector('.holo-core').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y, button: 'none' });
    await sleep(600);
    const state = await cdp.evaluate(`(() => {
      const hover = document.querySelector('.holo-hover');
      const ring = hover === null ? null : getComputedStyle(hover, '::after');
      return {
        hovered: document.querySelector('.holo-core')?.classList.contains('hovered') ?? false,
        globePlay: getComputedStyle(document.querySelector('.holo-globe')).animationPlayState,
        matched: hover === null ? null : hover.matches('.holo-core.hovered .holo-hover'),
        coreClass: document.querySelector('.holo-core')?.className ?? '',
        hoverRect: hover === null ? null : (() => { const r = hover.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
        ring: ring === null ? null : { content: ring.content, border: ring.borderTopWidth + ' ' + ring.borderTopStyle + ' ' + ring.borderTopColor, opacity: ring.opacity, shadow: ring.boxShadow },
      };
    })()`);
    const frozenBefore = await cdp.evaluate(`(() => {
      const rect = document.querySelector('[data-testid="holo-beacon"]')?.getBoundingClientRect();
      return rect === undefined ? null : { x: rect.x, y: rect.y };
    })()`);
    await sleep(1000);
    const frozenAfter = await cdp.evaluate(`(() => {
      const rect = document.querySelector('[data-testid="holo-beacon"]')?.getBoundingClientRect();
      return rect === undefined ? null : { x: rect.x, y: rect.y };
    })()`);
    const frozen = frozenBefore !== null && frozenAfter !== null
      && Math.abs(frozenBefore.x - frozenAfter.x) < 0.5
      && Math.abs(frozenBefore.y - frozenAfter.y) < 0.5;
    process.stdout.write(`hover: ${JSON.stringify({ ...state, frozen })}\n`);
    const hoverShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = path.resolve(ROOT, '.screenshots/network-hover.png');
    await writeFile(out, Buffer.from(hoverShot.data, 'base64'));
    process.stdout.write(`wrote ${out}\n`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 20, button: 'none' });
    await sleep(300);
    const resumed = await cdp.evaluate(`(() => ({
      hovered: document.querySelector('.holo-core')?.classList.contains('hovered') ?? false,
      globePlay: getComputedStyle(document.querySelector('.holo-globe')).animationPlayState,
    }))()`);
    process.stdout.write(`resume: ${JSON.stringify(resumed)}\n`);
  }
  if (PAGE === 'Network' && action === 'beacon') {
    const center = await cdp.evaluate(`(() => {
      const rect = document.querySelector('.holo-core').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y, button: 'none' });
    await sleep(500);
    const beacon = await cdp.evaluate(`(() => {
      const button = document.querySelector('[data-testid="holo-beacon"]');
      if (button === null) return null;
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, id: button.dataset.agentId };
    })()`);
    if (beacon === null) throw new Error('no hover beacon hit target');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: beacon.x, y: beacon.y, button: 'none' });
    await sleep(200);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: beacon.x, y: beacon.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: beacon.x, y: beacon.y, button: 'left', clickCount: 1 });
    await sleep(500);
    const selected = await cdp.evaluate(`(() => ({
      agentId: ${JSON.stringify(beacon.id)},
      inspector: document.querySelector('.network-inspector h3')?.textContent ?? '',
      kicker: document.querySelector('.network-inspector .network-kicker')?.textContent ?? '',
    }))()`);
    process.stdout.write(`beacon: ${JSON.stringify(selected)}\n`);
    const beaconShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = path.resolve(ROOT, '.screenshots/network-beacon.png');
    await writeFile(out, Buffer.from(beaconShot.data, 'base64'));
    process.stdout.write(`wrote ${out}\n`);
  }
  if (PAGE === 'Network' && action === 'zoom') {
    await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.network-zoom button')];
      const zoomIn = buttons[buttons.length - 1];
      if (zoomIn === undefined) return false;
      for (let index = 0; index < 5; index += 1) zoomIn.click();
      return true;
    })()`);
    await sleep(800);
    const zoomShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = path.resolve(ROOT, '.screenshots/network-zoom.png');
    await writeFile(out, Buffer.from(zoomShot.data, 'base64'));
    process.stdout.write(`wrote ${out}\n`);
  }
  if (PAGE === 'Network' && action === 'still') {
    const toggled = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.network-toolbar > button')];
      const button = buttons[1];
      if (button === undefined) return false;
      button.click();
      return true;
    })()`);
    if (!toggled) throw new Error('no motion toggle on the Network page');
    await sleep(900);
    const stillShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = path.resolve(ROOT, '.screenshots/network-still.png');
    await writeFile(out, Buffer.from(stillShot.data, 'base64'));
    process.stdout.write(`wrote ${out}\n`);
  }
  if (PAGE === 'Network' && action === 'doc') {
    const opened = await cdp.evaluate(`(() => {
      const card = document.querySelector('.theatre-card.theatre-doc');
      const button = card === null ? null : card.querySelector('.theatre-actions .primary');
      if (button === null) return false;
      button.click();
      return true;
    })()`);
    if (!opened) throw new Error('no document showcase card on the Network page');
    await waitFor(cdp, `document.querySelector('.doc-sheet') !== null`, 'the document sheet');
    await sleep(800);
    const docMetrics = await cdp.send('Page.getLayoutMetrics');
    const docContent = docMetrics.cssContentSize ?? docMetrics.contentSize;
    const docShot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: docContent.width, height: Math.min(docContent.height, 2200), scale: 1 },
      captureBeyondViewport: true,
    });
    const out = path.resolve(ROOT, '.screenshots/network-doc-preview.png');
    await writeFile(out, Buffer.from(docShot.data, 'base64'));
    process.stdout.write(`wrote ${out}\n`);
  }
} finally {
  chrome.kill();
}
