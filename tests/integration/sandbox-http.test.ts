import { describe, expect, it } from 'vitest';
import type { ApiRuntime } from '../../apps/api/src/api-adapter';
import { handleApiRequest } from '../../apps/api/src/api-adapter';
import { SandboxError, type SandboxSession } from '../../apps/api/src/sandbox-session';
import { sandboxPage } from '../../apps/api/src/sandbox-page';

/**
 * The 赛博沙盘 HTTP surface.
 *
 * A session is minutes of real model calls, so the contract matters as much as the engine: a page
 * that can be opened, a start that returns 201 with the finished session, reads that answer 404
 * for an unknown id, and failures that say *which* failure happened (bad input / no seats /
 * provider down) instead of a generic 500.
 */

const SESSION: SandboxSession = {
  sessionId: 'sandbox-session-1',
  channelId: 'sandbox-chan-1',
  topic: 'a topic',
  rounds: 1,
  roles: [{ role: 'proposer', employeeId: 'cto-john' as never, name: 'John', title: 'CTO' }],
  turns: [
    {
      seq: 1,
      messageId: 'msg-1',
      eventId: 'evt-1',
      channelId: 'sandbox-chan-1',
      atSim: 0,
      role: 'proposer',
      employeeId: 'cto-john' as never,
      name: 'John',
      title: 'CTO',
      body: 'the proposal',
    },
  ],
  scores: null,
  scoringRaw: null,
  provenance: 'live',
  provider: 'deepseek',
  model: 'deepseek-flash',
  startedAt: '2026-11-14T00:00:00.000Z',
  finishedAt: '2026-11-14T00:00:01.000Z',
  durationMs: 1000,
};

function runtimeWith(sandbox: ApiRuntime['sandbox']): ApiRuntime {
  return { control: null as never, query: null as never, ...(sandbox === undefined ? {} : { sandbox }) };
}

const get = (path: string): Request => new Request(`http://localhost${path}`);
const post = (path: string, body: unknown): Request =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('赛博沙盘 over HTTP', () => {
  it('serves the workbench page, which starts sessions through this API', async () => {
    const response = await handleApiRequest(
      get('/api/sandbox'),
      runtimeWith({ page: sandboxPage, start: async () => SESSION, list: async () => [], get: async () => null }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const page = await response.text();
    expect(page).toContain('/api/sandbox/session');
    expect(page).toContain('/api/sandbox/sessions');
    // M2: the session can be converted into a brief, but only behind an explicit confirm.
    expect(page).toContain('/brief');
    expect(page).toContain('briefConfirm');
    expect(page).toContain('confirm');
    // No hardcoded transcript: the old manual shell had fixed role copy, this page has none.
    expect(page).not.toContain('人工逐条');
  });

  it('starts a session and returns it with 201', async () => {
    const response = await handleApiRequest(
      post('/api/sandbox/session', { topic: 'a topic', rounds: 1 }),
      runtimeWith({ page: sandboxPage, start: async () => SESSION, list: async () => [], get: async () => null }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sessionId: SESSION.sessionId, turns: SESSION.turns });
  });

  it('answers 400 / 409 / 502 for the three failure kinds', async () => {
    const invalid = await handleApiRequest(
      post('/api/sandbox/session', { topic: '' }),
      runtimeWith({
        page: sandboxPage,
        start: async () => {
          throw new SandboxError('invalid', 'topic must not be empty');
        },
        list: async () => [],
        get: async () => null,
      }),
    );
    expect(invalid.status).toBe(400);

    const noRoles = await handleApiRequest(
      post('/api/sandbox/session', { topic: 'x' }),
      runtimeWith({
        page: sandboxPage,
        start: async () => {
          throw new SandboxError('no_roles', 'the runtime has fewer than two employees');
        },
        list: async () => [],
        get: async () => null,
      }),
    );
    expect(noRoles.status).toBe(409);

    const provider = await handleApiRequest(
      post('/api/sandbox/session', { topic: 'x' }),
      runtimeWith({
        page: sandboxPage,
        start: async () => {
          throw new SandboxError('provider', 'challenger generation failed: provider_error');
        },
        list: async () => [],
        get: async () => null,
      }),
    );
    expect(provider.status).toBe(502);
  });

  it('lists sessions and answers 404 for an unknown one', async () => {
    const api = (): ApiRuntime =>
      runtimeWith({ page: sandboxPage, start: async () => SESSION, list: async () => [SESSION], get: async () => null });

    const list = await handleApiRequest(get('/api/sandbox/sessions'), api());
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ sessions: [{ sessionId: SESSION.sessionId }] });

    const missing = await handleApiRequest(get('/api/sandbox/sessions/nope'), api());
    expect(missing.status).toBe(404);
  });

  it('is honestly unavailable when the runtime has no sandbox service', async () => {
    const page = await handleApiRequest(get('/api/sandbox'), runtimeWith(undefined));
    expect(page.status).toBe(503);

    const start = await handleApiRequest(post('/api/sandbox/session', { topic: 'x' }), runtimeWith(undefined));
    expect(start.status).toBe(501);
  });
});
