import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ControlCommand } from '@maoeh/organization-control';
import { startApiServer } from '../../apps/api/src/composition';
import {
  PreviewRuntime,
  PreviewUnavailableError,
  UnknownPreviewTaskError,
  type PreviewRecipe,
  type PreviewTaskReader,
} from '../../apps/api/src/preview-runtime';

/**
 * M1.6 Preview Runtime: the delivered artifact really runs.
 *
 * The delivery page can show and download the files a task handed over, but "does it run?" is a
 * different claim. This test walks the real chain — hand the CEO the mandate the platform's own
 * acceptance uses, let the organization deliver it, then ask the API to *run* what was delivered —
 * and asserts on the served bytes, the live service and the state machine, using the same
 * `startApiServer` in-process route as `deliverables-http.test.ts`.
 *
 * The delivered product is split across the workflow's steps (wiring, front end, service), so the
 * preview must compose the whole workflow: three sources, nothing skipped.
 *
 * A real browser cannot be launched from a confined session (Chrome needs named pipes and
 * crashpad, both denied), so the pixel-level gameplay proof lives in `scripts/verify-preview.mjs`,
 * which drives the delivered page's own module in a browser when one is available.
 */

const MANDATE = '开发一个俄罗斯方块程序\n前端Web SPA 后端用python，后端用来记录每次排名和得分';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => Promise<T | null>, label: string, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

type Json = Readonly<Record<string, unknown>>;
const viewOf = (value: unknown): Json => (typeof value === 'object' && value !== null ? (value as Json) : {});
const filesOf = (record: Json): readonly { path: string; content: string }[] => {
  const data = viewOf(record['result'])?.['data'];
  const files = viewOf(data)['files'];
  return Array.isArray(files) ? (files as readonly { path: string; content: string }[]) : [];
};

/** Does this host let `killTree` actually kill? (A confined session denies taskkill.) */
function taskkillWorks(): boolean {
  const sleeper: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const result = spawnSync('taskkill', ['/pid', String(sleeper.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 3_000 });
  let alive = true;
  try {
    process.kill(Number(sleeper.pid), 0);
  } catch {
    alive = false;
  }
  if (alive) {
    try {
      process.kill(Number(sleeper.pid), 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return !alive && result.status === 0;
}

const killPrimitiveWorks = process.platform === 'win32' ? taskkillWorks() : true;

/* --- The failure-path fixtures (a stub reader, so no product surface is added for a test) --- */

/** Looks like an HTTP service to the planner, and exits immediately when started. */
const BROKEN_SERVER = [
  '#!/usr/bin/env python3',
  '"""An entry point that looks like a service and cannot start."""',
  'import os',
  'from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer',
  '',
  'PORT = int(os.environ.get("PORT", "8000"))',
  'raise SystemExit(1)',
  '',
  'ThreadingHTTPServer(("127.0.0.1", PORT), SimpleHTTPRequestHandler).serve_forever()',
].join('\n');

const REPORT_ONLY = ['# Churn driver brief', '', 'A written analysis with sources; nothing runnable.', ''].join('\n');

function recipeFor(taskId: string, files: readonly { path: string; language: string; content: string }[], title: string): PreviewRecipe {
  return {
    files,
    title,
    taskId,
    sources: files.length === 0 ? [] : [{ taskId, title, files: files.length }],
    skipped: [],
  };
}

function stubReader(recipes: Readonly<Record<string, PreviewRecipe>>): PreviewTaskReader {
  return { getPreviewRecipe: async (taskId: string) => recipes[taskId] ?? null };
}

describe('M1.6 Preview Runtime over HTTP: the delivered tetris artifact really runs', () => {
  const previewRoot = mkdtempSync(join(tmpdir(), 'maoeh-preview-http-'));
  let server: Awaited<ReturnType<typeof startApiServer>>;
  let base = '';
  let taskId = '';
  let deliveredTasks: readonly Json[] = [];
  let previewUrl: string | null = null;

  const get = async (pathname: string): Promise<Response> => fetch(`${base}${pathname}`, { headers: { connection: 'close' } });
  const post = async (pathname: string, body?: unknown): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      method: 'POST',
      headers: { connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** `GET /api/preview/:taskId`, unwrapped from either a `{status}` envelope or a bare object. */
  const previewOf = async (id: string): Promise<Json> => {
    const body = viewOf(await (await get(`/preview/${encodeURIComponent(id)}`)).json());
    return viewOf(body['status'] ?? body);
  };

  beforeAll(async () => {
    // Tests own their preview directory instead of writing into the checkout.
    process.env['MAOEH_PREVIEW_ROOT'] = previewRoot;
    server = await startApiServer(0, { tick: { activeIntervalMs: 5, idleIntervalMs: 50 }, eventLogPath: null });
    base = `http://127.0.0.1:${String(server.port)}/api`;
    const stamp = String(Date.now());
    const instructed = await post('/command', {
      commandId: `preview-http-instruct-${stamp}`,
      commandType: 'Agent.Instruct',
      actor: { operatorId: 'ceo-alex', displayName: 'Alex', positionId: 'ceo', kind: 'human' },
      target: { targetType: 'agent', targetId: 'ceo-alex' },
      reason: 'M1.6 preview verification',
      correlationId: `preview-http-${stamp}`,
      causationId: null,
      createdAtSim: 0,
      instruction: MANDATE,
    } satisfies ControlCommand);
    expect(String(viewOf(await instructed.json())['status'])).toBe('accepted');

    deliveredTasks = await waitFor(async () => {
      const tasks = (await (await get('/tasks')).json()) as readonly Json[];
      const settled = tasks.filter((task) => ['completed', 'rejected', 'cancelled'].includes(String(task['status'])));
      if (tasks.length < 3 || settled.length !== tasks.length) return null;
      const records: Json[] = [];
      for (const task of tasks) records.push(viewOf(await (await get(`/tasks/${encodeURIComponent(String(task['taskId']))}`)).json()));
      return records.every((record) => record['result'] !== null) ? records : null;
    }, 'the delivered workflow');
    const tetris = deliveredTasks.find((record) => filesOf(record).some((file) => file.content.includes('俄罗斯方块')));
    expect(tetris, 'a delivered task must carry the tetris page').toBeDefined();
    taskId = String(viewOf(tetris)['taskId']);
    expect(taskId).not.toBe('undefined');
  }, 240_000);

  afterAll(async () => {
    await server?.close();
    delete process.env['MAOEH_PREVIEW_ROOT'];
    rmSync(previewRoot, { recursive: true, force: true });
  });

  it('composes the whole workflow product: three sources, none skipped', async () => {
    const status = await previewOf(taskId);
    expect(status['available']).toBe(true);
    expect(status['state']).toBe('stopped');
    expect(status['plan']).toBe('python-server');
    expect(status['runCommand']).toBe('python server/app.py');
    const sources = status['sources'] as readonly Json[];
    // The product is split across the workflow's steps; the preview composes all three of them.
    expect(sources.map((source) => String(source['title'])).sort()).toEqual(['Backend', 'Frontend', 'Implementation']);
    expect(sources.map((source) => Number(source['files'])).sort()).toEqual([2, 2, 2]);
    expect(status['skipped']).toEqual([]);
    expect(String(status['projectName'])).toContain('俄罗斯方块');
  });

  it('serves the delivered SPA and the delivered python service on a real port', async () => {
    const started = viewOf(await (await post(`/preview/${encodeURIComponent(taskId)}/start`)).json());
    expect(started['state'], JSON.stringify(started)).toBe('running');
    previewUrl = String(started['previewUrl']);
    expect(previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const page = await fetch(previewUrl, { headers: { connection: 'close' } });
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(String(page.headers.get('content-type'))).toContain('text/html');
    // The *delivered* page, not a screenshot, a mock or a placeholder: its own canvas, its own
    // game loop and the mandate it answers.
    expect(html).toContain('<canvas id="board"');
    expect(html).toContain('requestAnimationFrame');
    expect(html).toContain('ArrowLeft');
    expect(html).toContain('开发一个俄罗斯方块程序');
    expect(html.length).toBeGreaterThan(5_000);

    const health = viewOf(await (await fetch(new URL('/api/health', previewUrl).href)).json());
    expect(health['ok']).toBe(true);

    const recorded = await fetch(new URL('/api/scores', previewUrl).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ player: 'vitest-ada', score: 310, lines: 9 }),
    });
    expect(recorded.status).toBe(201);
    const rank = viewOf(await recorded.json());
    expect(typeof rank['rank']).toBe('number');

    const board = viewOf(await (await fetch(new URL('/api/scores?limit=10', previewUrl).href)).json());
    const scores = board['scores'] as readonly Json[];
    expect(scores.some((row) => row['player'] === 'vitest-ada' && Number(row['score']) === 310)).toBe(true);
  }, 60_000);

  it('keeps the normal API answering while a preview runs', async () => {
    const results = await Promise.all(['/snapshot', '/tasks', '/workflows'].map(async (pathname) => (await get(pathname)).status));
    expect(results).toEqual([200, 200, 200]);
  });

  it('does not pretend to preview a delivery with no web entry point', async () => {
    const stamp = String(Date.now());
    const injected = await post('/command', {
      commandId: `preview-http-inject-${stamp}`,
      commandType: 'Organization.InjectTask',
      actor: { operatorId: 'ceo-alex', displayName: 'Alex', positionId: 'ceo', kind: 'human' },
      target: { targetType: 'organization', targetId: 'future-ai-lab' },
      positionId: 'ceo',
      title: 'Churn driver brief',
      goal: 'Publish a written churn driver analysis with sources',
      reason: 'M1.6 preview verification: a report-only delivery',
      correlationId: `preview-http-inject-${stamp}`,
      causationId: null,
      createdAtSim: 0,
    } as never);
    expect(String(viewOf(await injected.json())['status'])).toBe('accepted');
    const docTaskId = await waitFor(async () => {
      const tasks = (await (await get('/tasks')).json()) as readonly Json[];
      const found = tasks.find((task) => task['title'] === 'Churn driver brief' && task['status'] === 'completed');
      return found === undefined ? null : String(found['taskId']);
    }, 'the report-only delivery');
    const record = viewOf(await (await get(`/tasks/${docTaskId}`)).json());
    // The delivery is a real result (a report artifact) that simply has no runnable files.
    const result = viewOf(record['result']);
    expect(Array.isArray(result['artifacts']) && (result['artifacts'] as readonly string[]).length > 0).toBe(true);
    expect(Array.isArray(viewOf(result['data'])['files'])).toBe(false);

    const status = await previewOf(docTaskId);
    expect(status['available']).toBe(false);
    expect(status['plan']).toBe('none');
    expect(status['previewUrl']).toBeNull();
    expect(String(status['error']).length).toBeGreaterThan(0);
    // Starting it is refused with the reason, and nothing is spawned.
    const refused = await post(`/preview/${encodeURIComponent(docTaskId)}/start`);
    expect(refused.status).toBe(422);
    expect(String(viewOf(await refused.json())['error']).length).toBeGreaterThan(0);
  }, 120_000);

  it('stops the preview and reports it stopped', async () => {
    const stopped = viewOf(await (await post(`/preview/${encodeURIComponent(taskId)}/stop`)).json());
    expect(stopped['state']).toBe('stopped');
    expect(stopped['previewUrl']).toBeNull();
    expect((await previewOf(taskId))['state']).toBe('stopped');
    // NOTE: whether the port really stops answering depends on the host's kill primitive
    // (`taskkill` on Windows). This session denies taskkill, so the port-free observation is
    // reported by scripts/verify-preview.mjs (item 5) rather than asserted here.
  }, 60_000);

  it('leaves the delivery readable, byte for byte, with its artifacts', async () => {
    const artifacts = deliveredTasks.flatMap((record) => (viewOf(record['result'])['artifacts'] as readonly string[]) ?? []);
    const files = deliveredTasks.flatMap((record) => filesOf(record));
    expect(files.map((file) => file.path).sort()).toEqual([
      'README.md',
      'client/README.md',
      'client/index.html',
      'run.py',
      'server/README.md',
      'server/app.py',
    ]);
    expect(artifacts.sort()).toEqual(files.map((file) => file.path).sort());
    for (const file of files) {
      // The delivered bytes are the pre-existing artifact on disk — the same project, not a copy.
      const onDisk = readFileSync(join(process.cwd(), 'deliverables', 'ss-tetris', ...file.path.split('/')), 'utf8');
      expect(onDisk, file.path).toBe(file.content);
    }
  });

  it('answers an unknown task id with 404', async () => {
    const response = await get('/preview/task-does-not-exist');
    expect(response.status).toBe(404);
    expect(String(viewOf(await response.json())['error'])).toContain('unknown task');
  });
});

describe('M1.6 Preview Runtime failure paths (stub reader, no product surface added)', () => {
  const rootFor = (name: string): string => {
    const dir = mkdtempSync(join(tmpdir(), `maoeh-preview-${name}-`));
    return dir;
  };

  it('reports a failing start as failed with a reason, and leaves no working directory', async () => {
    const workspaceRoot = rootFor('broken');
    const runtime = new PreviewRuntime(
      stubReader({ 'task-broken': recipeFor('task-broken', [{ path: 'server/app.py', language: 'python', content: BROKEN_SERVER }], 'Broken service') }),
      { workspaceRoot, readyTimeoutMs: 10_000, reapIntervalMs: 0 },
    );
    await expect(runtime.start('task-broken')).resolves.toMatchObject({ available: true, state: 'failed', previewUrl: null });
    const status = await runtime.status('task-broken');
    // A failed run is not sticky: the next read re-plans the delivery, so a retry is a real retry.
    expect(status['state']).toBe('stopped');
    expect(existsSync(join(workspaceRoot, '.maoeh', 'preview', 'task-broken'))).toBe(false);
    await runtime.dispose();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }, 60_000);

  it('captures the failure reason from the process that died', async () => {
    const workspaceRoot = rootFor('reason');
    const runtime = new PreviewRuntime(
      stubReader({ 'task-broken': recipeFor('task-broken', [{ path: 'server/app.py', language: 'python', content: BROKEN_SERVER }], 'Broken service') }),
      { workspaceRoot, readyTimeoutMs: 10_000, reapIntervalMs: 0 },
    );
    const status = await runtime.start('task-broken');
    expect(status['state']).toBe('failed');
    expect(String(status['error'])).toMatch(/exited on its own/);
    expect(status['plan']).toBe('python-server');
    expect(status['runCommand']).toBe('python server/app.py');
    await runtime.dispose();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }, 60_000);

  it('refuses a delivery with no web entry point', async () => {
    const workspaceRoot = rootFor('report');
    const runtime = new PreviewRuntime(
      stubReader({ 'task-report': recipeFor('task-report', [{ path: 'churn-brief.md', language: 'markdown', content: REPORT_ONLY }], 'Churn brief') }),
      { workspaceRoot, readyTimeoutMs: 5_000, reapIntervalMs: 0 },
    );
    const status = await runtime.status('task-report');
    expect(status['available']).toBe(false);
    expect(status['state']).toBe('stopped');
    expect(status['plan']).toBe('none');
    await expect(runtime.start('task-report')).rejects.toBeInstanceOf(PreviewUnavailableError);
    await runtime.dispose();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }, 30_000);

  it('throws UnknownPreviewTaskError for a task the organization does not know', async () => {
    const workspaceRoot = rootFor('unknown');
    const runtime = new PreviewRuntime(stubReader({}), { workspaceRoot, reapIntervalMs: 0 });
    await expect(runtime.status('task-nope')).rejects.toBeInstanceOf(UnknownPreviewTaskError);
    await runtime.dispose();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }, 30_000);

  it('reaps a stale preview: the marked pid is killed where the kill primitive works, and the directory always goes', async () => {
    const workspaceRoot = rootFor('orphan');
    const staleDir = join(workspaceRoot, '.maoeh', 'preview', 'stale-task');
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, 'preview.pid'), String(sleeper.pid), 'utf8');

    // A new runtime must reclaim what a crashed previous API process left behind.
    const runtime = new PreviewRuntime(stubReader({}), { workspaceRoot, reapIntervalMs: 0 });
    expect(existsSync(staleDir)).toBe(false);
    let alive = true;
    try {
      process.kill(Number(sleeper.pid), 0);
    } catch {
      alive = false;
    }
    if (killPrimitiveWorks) expect(alive).toBe(false);
    else console.warn('[preview test] this host denies taskkill (see scripts/verify-preview.mjs item 9b): the marked pid survived the reap');
    if (alive) {
      try {
        process.kill(Number(sleeper.pid), 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
    await runtime.dispose();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }, 30_000);
});
