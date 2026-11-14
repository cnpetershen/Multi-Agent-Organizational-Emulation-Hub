import { describe, expect, it } from 'vitest';
import type { ControlCommand } from '@maoeh/organization-control';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * The Preview Runtime, end to end, over HTTP: a real workflow delivers the product, and the
 * delivery page's own endpoints start it and answer with a URL that really serves it.
 *
 * This is the test the feature exists for. It walks the whole chain with nothing simulated in the
 * middle: the deterministic cognition runs the organization, the delivered React-free SPA and the
 * delivered Python service are copied out of the task records into a private directory, the real
 * service is started as a child process on a dynamically chosen port, and then the delivered API
 * is driven through the preview URL �?proving the thing on screen is a running program and not a
 * screenshot, a fixture, or a static copy of the expected page.
 *
 * It is deliberately patient: the workflow has to finish before there is a product to run, and the
 * service has to bind before the URL answers. Everything is bounded, so a hang fails the test
 * rather than the suite.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Json = Readonly<Record<string, unknown>>;

async function waitFor<T>(read: () => Promise<T | null>, label: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

function viewOf(value: unknown): Json {
  return (typeof value === 'object' && value !== null ? value : {}) as Json;
}

const MANDATE = '开发一个俄罗斯方块程序\n前端Web SPA 后端用python，后端用来记录每次排名和得分';

describe('preview runtime over HTTP', () => {
  it('starts the delivered product of a finished workflow and serves it on a real URL', async () => {
    const server = await startApiServer(0, { requirePlanConfirmation: false, 
      tick: { activeIntervalMs: 5, idleIntervalMs: 25 },
      eventLogPath: null,
    });
    const base = `http://127.0.0.1:${String(server.port)}/api`;
    const get = async (path: string): Promise<Response> =>
      fetch(`${base}${path}`, { headers: { connection: 'close' } });
    const post = async (path: string): Promise<Response> =>
      fetch(`${base}${path}`, { method: 'POST', headers: { connection: 'close' } });

    try {
      // 1. A real mandate, handed to the CEO exactly as the console does.
      const command: ControlCommand = {
        commandId: `preview-instruct-${String(Date.now())}`,
        commandType: 'Agent.Instruct',
        actor: { operatorId: 'ceo-alex', displayName: 'Alex', positionId: 'ceo', kind: 'human' },
        target: { targetType: 'agent', targetId: 'ceo-alex' },
        reason: 'preview verification mandate',
        correlationId: `preview-${String(Date.now())}`,
        causationId: null,
        createdAtSim: 0,
        instruction: MANDATE,
      } as ControlCommand;
      const instructed = viewOf(
        await (await fetch(`${base}/command`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', connection: 'close' },
          body: JSON.stringify(command),
        })).json(),
      );
      expect(String(instructed['status']), JSON.stringify(instructed['failure'])).toBe('accepted');

      // 2. The workflow delivers the product: every step of the split plan finishes.
      const delivered = await waitFor(async () => {
        const tasks = (await (await get('/tasks')).json()) as readonly Json[];
        if (tasks.length < 2) return null;
        const finished = tasks.every((task) => ['completed', 'rejected', 'cancelled'].includes(String(task['status'])));
        return finished ? tasks : null;
      }, 'the workflow to deliver every step');

      // The delivery really is split across steps, which is why a preview composes the product.
      const anchor = delivered.find((task) => String(task['title']).toLowerCase() === 'frontend') ?? delivered[0];
      const anchorTaskId = String(viewOf(anchor)['taskId']);
      const record = viewOf(await (await get(`/tasks/${encodeURIComponent(anchorTaskId)}`)).json());
      expect(viewOf(record['result'])['data']).toBeDefined();

      // 3. The delivery page's read: is there anything to run, and where does it stand?
      const before = viewOf(await (await get(`/preview/${encodeURIComponent(anchorTaskId)}`)).json());
      expect(before['available']).toBe(true);
      expect(before['state']).toBe('stopped');
      expect(before['previewUrl']).toBeNull();
      // The preview runs the whole product, so every delivered step is named as a source.
      const sources = before['sources'] as readonly Json[];
      expect(sources.length).toBeGreaterThanOrEqual(2);
      expect((before['skipped'] as readonly Json[]).length).toBe(0);
      expect(String(before['projectName'])).not.toBe('');

      // 4. Start it, and wait for the URL to answer �?`running` means the service answered.
      const started = viewOf(await (await post(`/preview/${encodeURIComponent(anchorTaskId)}/start`)).json());
      const running = started['state'] === 'running'
        ? started
        : await waitFor(async () => {
          const status = viewOf(await (await get(`/preview/${encodeURIComponent(anchorTaskId)}`)).json());
          if (status['state'] === 'failed') throw new Error(`preview failed: ${String(status['error'])}`);
          return status['state'] === 'running' ? status : null;
        }, 'the preview to start');

      const previewUrl = String(running['previewUrl']);
      expect(previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      // The port is chosen by the runtime, not baked into the artifact or this test.
      expect(new URL(previewUrl).port).not.toBe('');
      expect(String(running['runCommand'])).toContain('server/app.py');

      // 5. The delivered SPA is served �?the real one, with its canvas and its leaderboard client.
      const page = await fetch(previewUrl, { headers: { connection: 'close' } });
      expect(page.status).toBe(200);
      expect(String(page.headers.get('content-type'))).toContain('text/html');
      const html = await page.text();
      expect(html).toContain('<canvas id="board"');
      expect(html).toContain('maoehScore');

      // 6. The delivered service is genuinely running: its own API answers, records a play and
      //    ranks it. A static copy of index.html could never do this.
      const health = viewOf(await (await fetch(`${previewUrl}api/health`, { headers: { connection: 'close' } })).json());
      expect(health['ok']).toBe(true);
      const posted = await fetch(`${previewUrl}api/scores`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ player: 'preview-verifier', score: 420, lines: 7 }),
      });
      expect(posted.status).toBe(201);
      const scored = viewOf(await posted.json());
      expect(scored['ok']).toBe(true);
      expect(Number(scored['rank'])).toBeGreaterThan(0);
      const board = viewOf(await (await fetch(`${previewUrl}api/scores?limit=10`, { headers: { connection: 'close' } })).json());
      expect(JSON.stringify(board['scores'])).toContain('preview-verifier');

      // 7. The preview is isolated: the artifact it copied from was never written to.
      const afterRecord = viewOf(await (await get(`/tasks/${encodeURIComponent(anchorTaskId)}`)).json());
      expect(afterRecord['result']).toEqual(record['result']);

      // 8. Meanwhile the platform's own API is unaffected �?the preview must never block it.
      const during = await Promise.all(['/snapshot', '/tasks', '/workflows'].map(async (path) => (await get(path)).status));
      expect(during).toEqual([200, 200, 200]);

      // 9. Stop frees the port, and the next read says so.
      const stopped = viewOf(await (await post(`/preview/${encodeURIComponent(anchorTaskId)}/stop`)).json());
      expect(stopped['state']).toBe('stopped');
      expect(stopped['previewUrl']).toBeNull();
      await expect(fetch(`${previewUrl}api/health`, { headers: { connection: 'close' } })).rejects.toThrow();
    } finally {
      await server.close();
    }
  }, 120_000);

  it('answers 404 for a task the organization does not know', async () => {
    const server = await startApiServer(0, { requirePlanConfirmation: false,  tick: { activeIntervalMs: 5, idleIntervalMs: 25 }, eventLogPath: null });
    try {
      const base = `http://127.0.0.1:${String(server.port)}/api`;
      const missing = await fetch(`${base}/preview/task-unknown`, { headers: { connection: 'close' } });
      expect(missing.status).toBe(404);
      const started = await fetch(`${base}/preview/task-unknown/start`, { method: 'POST', headers: { connection: 'close' } });
      expect(started.status).toBe(404);
      // A path that is not an endpoint this API has must not be mistaken for a task id.
      const malformed = await fetch(`${base}/preview/task-unknown/restart`, { method: 'POST', headers: { connection: 'close' } });
      expect(malformed.status).toBe(404);
    } finally {
      await server.close();
    }
  }, 60_000);
});

