// Browser-level verification of the two workbenches, against the running stack.
//
// This is the "operate it like a person" check: a real headless Edge, a real page load, a real
// click on 开始/生成, real typing into the result cards, a real download. It does not import any
// product module and it writes nothing to the demo company: the sandbox session goes to the
// sandbox runtime's own log, the content studio writes no event at all.
//
// Usage: node scripts/verify-browser.mjs [--base http://127.0.0.1:5173] [--cdp 9461]
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = join(root, '.maoeh', 'audit', 'browser', `run-${stamp}`);
const shotsDir = join(runDir, 'screenshots');
const downloadsDir = join(runDir, 'downloads');
mkdirSync(shotsDir, { recursive: true });
mkdirSync(downloadsDir, { recursive: true });

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const BASE = String(argOf('--base', 'http://127.0.0.1:5173')).replace(/\/+$/, '');
const CDP = Number(argOf('--cdp', '9461'));
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((candidate) => existsSync(candidate));
if (EDGE === undefined) throw new Error('no Edge/Chrome executable found');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (message) => process.stdout.write(`${message}\n`);

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
        await new Promise((done, fail) => {
          const timer = setTimeout(() => fail(new Error('connect timeout')), 1000);
          socket.addEventListener('open', () => { clearTimeout(timer); done(); });
          socket.addEventListener('error', () => { clearTimeout(timer); fail(new Error('connect failed')); });
        });
        return new Cdp(socket);
      } catch { await sleep(100); }
    }
    throw new Error('timed out connecting to CDP');
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((done, fail) => {
      this.pending.set(id, { resolve: done, reject: fail });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 500));
    return result.result.value;
  }
  async waitFor(expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.evaluate(expression) === true) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await sleep(250);
    }
  }
  async goto(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', `load ${url}`, 60_000);
  }
  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = join(shotsDir, `${name}.png`);
    writeFileSync(file, Buffer.from(result.data, 'base64'));
    return file;
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

const edgeLogFd = openSync(join(runDir, 'edge.log'), 'a');
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${String(CDP)}`,
    `--user-data-dir=${join(tmpdir(), `maoeh-browser-${String(Date.now())}`)}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=1500,1200',
    'about:blank',
  ],
  { stdio: ['ignore', edgeLogFd, edgeLogFd] },
);

let cdp;
const report = { at: new Date().toISOString(), base: BASE, checks: {}, screenshots: [], downloads: [] };
try {
  await waitHttp(`${BASE}/api/snapshot`);
  const ownership = await (await fetch(`${BASE}/api/ownership`)).json();
  const active = ownership.organizations.find((organization) => organization.id === ownership.activeOrganizationId);
  if (active === undefined) throw new Error('the API reports no active company');
  report.company = { id: active.id, name: active.name };
  await waitHttp(`http://127.0.0.1:${String(CDP)}/json/version`);
  const target = await (await fetch(`http://127.0.0.1:${String(CDP)}/json/new?${encodeURIComponent(`${BASE}/`)}`, { method: 'PUT' })).json();
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadsDir }).catch(() => undefined);
  await cdp.waitFor('document.readyState === "complete"', 'initial load', 60_000);

  // ── 0. Enter the console (the Foundry gate is the real entry, not a test bypass) ───────────
  await cdp.goto(`${BASE}/`);
  await cdp.waitFor(`document.querySelector('[data-testid="foundry-signin"]') !== null`, 'the Foundry sign-in', 60_000);
  await cdp.evaluate(`(() => document.querySelector('[data-testid="foundry-signin"]').click())()`);
  await cdp.waitFor(`document.querySelector('[data-testid="foundry-company"]') !== null`, 'the company list', 30_000);
  // Click the ACTIVE company, not merely the first one: the lab seed and the founder's company
  // are both listed, and picking the wrong one silently switches the runtime's company.
  const picked = await cdp.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('[data-testid="foundry-company"]')];
    const target = buttons.find((button) => button.textContent.includes(${JSON.stringify(active.name)}));
    if (target === undefined) return null;
    target.click();
    return target.textContent.slice(0, 60);
  })()`);
  if (picked === null) throw new Error(`company "${active.name}" is not on the Foundry gate`);
  await cdp.waitFor(`document.querySelector('.shell') !== null`, 'the console shell', 60_000);
  const enteredAs = await cdp.evaluate(`document.querySelector('.company-block strong') ? document.querySelector('.company-block strong').textContent : ''`);
  if (enteredAs !== active.name) throw new Error(`entered "${enteredAs}" instead of "${active.name}"`);
  report.checks.consoleEntered = { company: enteredAs };

  // ── 1. Results page: does it link to the NEW workbench? ───────────────────────────────────
  await cdp.goto(`${BASE}/results/task-44`);
  await cdp.waitFor(`document.querySelector('.shell') !== null`, 'the console shell on the results route', 60_000);
  // The task and workflow reads land after the shell; give them a bounded window instead of
  // throwing on the first poll, so a failure still produces evidence.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await cdp.evaluate(`document.querySelector('iframe.sandbox-frame') !== null || document.body.innerText.includes('Unknown task') || document.body.innerText.includes('加载失败')`);
    if (ready === true) break;
    await sleep(250);
  }
  const resultsCheck = await cdp.evaluate(`(() => {
    const frame = document.querySelector('iframe.sandbox-frame');
    const link = document.querySelector('a[href="/api/sandbox"]');
    return {
      src: frame ? frame.getAttribute('src') : null,
      link: link ? link.getAttribute('href') : null,
      legacyLinks: [...document.querySelectorAll('a[href*="sandbox.html"], iframe[src*="sandbox.html"]')].length,
      frameText: frame && frame.contentDocument ? frame.contentDocument.title : null,
      frameHasStart: frame && frame.contentDocument ? frame.contentDocument.getElementById('start') !== null : false,
      h1: document.querySelector('h1') ? document.querySelector('h1').textContent : null,
      bodyText: document.body.innerText.slice(0, 600),
    };
  })()`);
  report.checks.results = resultsCheck;
  report.screenshots.push(await cdp.shot('01-results-sandbox-panel'));

  // ── 2. The new sandbox workbench, operated like a person ──────────────────────────────────
  await cdp.goto(`${BASE}/api/sandbox`);
  await cdp.waitFor(`document.documentElement.dataset.maoehReady === '1'`, 'the sandbox workbench to be operable', 30_000);
  const topic = '该不该把这套多 Agent 组织仿真平台做成面向高校课程实验的产品？';
  await cdp.evaluate(`(() => {
    const topic = document.getElementById('topic');
    topic.value = ${JSON.stringify(topic)};
    topic.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('rounds').value = '1';
    document.getElementById('start').click();
    return true;
  })()`);
  let sessionState = { done: false, failed: false, status: '' };
  for (let attempt = 0; attempt < 600; attempt += 1) {
    sessionState = await cdp.evaluate(`(() => ({
      done: document.querySelectorAll('#turns .turn').length >= 4 && document.getElementById('status').textContent.includes('会话完成'),
      failed: document.getElementById('status').textContent.includes('会话失败'),
      status: document.getElementById('status').textContent,
    }))()`);
    if (sessionState.done || sessionState.failed) break;
    await sleep(500);
  }
  if (!sessionState.done) throw new Error(`the sandbox session did not complete: ${sessionState.status}`);
  const sandbox = await cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#scores table tr')].slice(1).map((tr) => [...tr.children].map((cell) => cell.textContent.trim()));
    return {
      provenance: document.getElementById('prov').textContent,
      status: document.getElementById('status').textContent,
      roles: [...document.querySelectorAll('#roles .role')].map((role) => role.textContent.trim()),
      turns: [...document.querySelectorAll('#turns .turn')].map((turn) => ({
        role: turn.className.replace('turn ', ''),
        head: turn.querySelector('header') ? turn.querySelector('header').textContent.trim() : '',
        body: turn.querySelector('p') ? turn.querySelector('p').textContent.trim().slice(0, 140) : '',
      })),
      total: document.querySelector('.total') ? document.querySelector('.total').textContent.trim() : null,
      dimensions: rows,
      cited: rows.filter((row) => /msg-\\d+/.test(row[3] ?? '')).length,
      uncited: rows.filter((row) => (row[3] ?? '').includes('未引用')).length,
    };
  })()`);
  report.checks.sandbox = sandbox;
  report.screenshots.push(await cdp.shot('02-sandbox-session'));

  // ── 3. Reopen a finished session from the history list ───────────────────────────────────
  await cdp.evaluate(`(() => { const row = document.querySelector('#sessions .session'); if (row) row.click(); return row !== null; })()`);
  await cdp.waitFor(`document.querySelectorAll('#turns .turn').length >= 4`, 'the history session to reopen', 30_000);
  report.checks.sandboxHistory = await cdp.evaluate(`(() => ({
    turns: document.querySelectorAll('#turns .turn').length,
    total: document.querySelector('.total') ? document.querySelector('.total').textContent.trim() : null,
  }))()`);
  report.screenshots.push(await cdp.shot('03-sandbox-history'));

  // ── 4. The content studio: generate, edit, approve, export ───────────────────────────────
  await cdp.goto(`${BASE}/api/studio`);
  await cdp.waitFor(`document.documentElement.dataset.maoehReady === '1'`, 'the content workbench to be operable', 30_000);
  await cdp.evaluate(`(() => {
    const source = document.getElementById('source');
    source.value = ${JSON.stringify('我们用一个 AI 剪辑工具，把一期播客的剪辑时间从 3 小时降到 10 分钟：自动去停顿和口误，保留气口，一键生成 shownotes。')};
    source.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('generate').click();
    return true;
  })()`);
  await cdp.waitFor(`document.querySelectorAll('#grid .card').length === 4`, 'four platform cards', 180_000);
  const beforeEdit = await cdp.evaluate(`(() => ({
    provenance: document.getElementById('provenance').textContent,
    cards: [...document.querySelectorAll('#grid .card')].map((card) => ({
      title: card.querySelector('b').textContent,
      text: card.querySelector('textarea').value.slice(0, 80),
    })),
    exportEnabled: document.getElementById('exportJson').disabled === false,
  }))()`);
  await cdp.evaluate(`(() => {
    const card = document.querySelector('#grid .card');
    const textarea = card.querySelector('textarea');
    textarea.value = textarea.value + '\\n\\n（人工补充：已按运营要求加上合规提示。）';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await cdp.evaluate(`(() => { document.querySelector('#grid .card button').click(); return true; })()`);
  const afterApprove = await cdp.evaluate(`(() => ({
    approvedCount: document.getElementById('approved').textContent,
    approvedBadges: document.querySelectorAll('#grid .card .badge.ok').length,
    firstCardTail: document.querySelector('#grid .card textarea').value.slice(-40),
  }))()`);
  const beforeFiles = new Set(readdirSync(downloadsDir));
  // Native download is the honest path; the blob hook is a fallback so a headless download
  // policy can never turn "the export button works" into a false negative.
  await cdp.evaluate(`(() => {
    window.__maoehExport = null;
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob && typeof blob.text === 'function') blob.text().then((text) => { window.__maoehExport = text; });
      return original(blob);
    };
    return true;
  })()`);
  await cdp.evaluate(`(() => { document.getElementById('exportJson').click(); return true; })()`);
  let exported = null;
  let exportedVia = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const file = join(downloadsDir, 'content-assets.json');
    if (existsSync(file)) {
      exported = JSON.parse(readFileSync(file, 'utf8'));
      exportedVia = 'download';
      break;
    }
    const captured = await cdp.evaluate('window.__maoehExport');
    if (typeof captured === 'string' && captured.trim() !== '') {
      exported = JSON.parse(captured);
      exportedVia = 'blob';
      break;
    }
    await sleep(250);
  }
  const afterFiles = readdirSync(downloadsDir).filter((name) => !beforeFiles.has(name));
  report.checks.studio = {
    beforeEdit,
    afterApprove,
    exportedVia,
    exported: exported === null ? null : {
      assets: exported.assets.length,
      approved: exported.assets.filter((asset) => asset.approved).length,
      editedTail: String(exported.assets[0]?.text ?? '').slice(-40),
      provenance: exported.provenance,
    },
    newDownloads: afterFiles,
  };
  report.downloads.push(...afterFiles.map((name) => join(downloadsDir, name)));
  report.screenshots.push(await cdp.shot('04-content-studio'));
  if (exported !== null) writeFileSync(join(runDir, 'content-assets.json'), JSON.stringify(exported, null, 2), 'utf8');

  // ── 5. Legacy entry: still served, still linked? ─────────────────────────────────────────
  const legacy = await fetch(`${BASE}/sandbox.html`);
  report.checks.legacySandbox = {
    httpStatus: legacy.status,
    contentType: legacy.headers.get('content-type'),
    stillLinkedFromResults: resultsCheck.legacyLinks !== 0,
  };

  const verdict = {
    resultsPointsToNewWorkbench: resultsCheck.src === '/api/sandbox' && resultsCheck.legacyLinks === 0 && resultsCheck.frameHasStart,
    sandboxHasFourRoles: sandbox.roles.length === 4 && new Set(sandbox.turns.map((turn) => turn.head.split('·')[0])).size >= 4,
    sandboxHasFourTurns: sandbox.turns.length >= 4,
    sandboxScoredWithCitations: sandbox.total !== null && sandbox.cited >= 2 && sandbox.uncited === 0,
    sandboxHistoryReopens: report.checks.sandboxHistory.turns >= 4,
    studioGeneratedFour: beforeEdit.cards.length === 4,
    studioIsLiveLlm: beforeEdit.provenance.includes('LLM'),
    studioEditAndApprove: afterApprove.approvedBadges === 1 && afterApprove.approvedCount.includes('1 / 4'),
    studioExportContainsEdit: exported !== null && String(exported.assets[0]?.text ?? '').includes('合规提示') && exported.assets[0]?.approved === true,
    legacyNotLinked: resultsCheck.legacyLinks === 0,
  };
  report.verdict = verdict;
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  log(`results page: ${JSON.stringify(resultsCheck)}`);
  log(`sandbox: roles=${String(sandbox.roles.length)} turns=${String(sandbox.turns.length)} total=${String(sandbox.total)} cited=${String(sandbox.cited)}/${String(sandbox.dimensions.length)} provenance=${sandbox.provenance}`);
  log(`sandbox turns: ${sandbox.turns.map((turn) => `${turn.role}:${turn.head}`).join(' | ')}`);
  log(`history reopen: ${JSON.stringify(report.checks.sandboxHistory)}`);
  log(`studio: ${JSON.stringify(report.checks.studio)}`);
  log(`legacy /sandbox.html: ${JSON.stringify(report.checks.legacySandbox)}`);
  log(`verdict: ${JSON.stringify(verdict)}`);
  log(`evidence: ${runDir}`);
  process.exitCode = Object.values(verdict).every((value) => value === true) ? 0 : 2;
} catch (error) {
  report.error = String(error?.stack ?? error);
  // A failed run still has to say what was on screen; a stack trace alone is not evidence.
  try {
    if (cdp !== undefined) {
      report.failure = {
        url: await cdp.evaluate('location.href'),
        text: await cdp.evaluate('document.body.innerText.slice(0, 1200)'),
      };
      report.screenshots.push(await cdp.shot('99-failure'));
    }
  } catch { /* the browser may already be gone */ }
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (cdp !== undefined) cdp.close();
  spawn('taskkill', ['/pid', String(edge.pid), '/T', '/F'], { stdio: 'ignore' });
  closeSync(edgeLogFd);
  await sleep(500);
}
