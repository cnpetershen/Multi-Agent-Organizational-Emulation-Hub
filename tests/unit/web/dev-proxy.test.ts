import { afterEach, describe, expect, it } from 'vitest';
import { PROXY_FAILURE_STATUS, answerProxyFailure, proxyFailure, proxyTarget } from '../../../apps/web/dev-proxy';

/**
 * A stopped API must not reach the browser as an empty-body `500`.
 *
 * That is `http-proxy`'s default, and it is why the failure that started this work was reported as
 * `GET /api/ownership 返回 HTTP 500: 空响应体`: the console can only render a status it has no
 * detail for, so "the API process is not running" was indistinguishable from a broken response —
 * while the gate quietly showed no Sign in button. The proxy knows the address it failed to reach,
 * so it says it, in the `{ error, message }` shape the transport already parses.
 */

const savedPort = process.env['PORT'];

afterEach(() => {
  if (savedPort === undefined) delete process.env['PORT'];
  else process.env['PORT'] = savedPort;
});

describe('the console dev proxy explains an unreachable API', () => {
  it('forwards to the same port the API defaults to', () => {
    expect(proxyTarget('3100')).toBe('http://localhost:3100');
    // The API and the proxy must agree on `PORT`: a blank one falls back, it never builds `:`.
    expect(proxyTarget('')).toBe('http://localhost:3001');
    expect(proxyTarget('   ')).toBe('http://localhost:3001');
  });

  it('follows the PORT the dev command was started with', () => {
    process.env['PORT'] = '4321';
    expect(proxyTarget()).toBe('http://localhost:4321');
  });

  it('answers with a body that names the target and the reason', () => {
    const failure = proxyFailure('http://localhost:3001', new Error('connect ECONNREFUSED 127.0.0.1:3001'));
    expect(failure.status).toBe(PROXY_FAILURE_STATUS);
    expect(failure.contentType).toBe('application/json; charset=utf-8');
    expect(failure.body.length).toBeGreaterThan(0);
    const body = JSON.parse(failure.body) as { error?: unknown; message?: unknown; target?: unknown };
    expect(body.error).toBe('api_unreachable');
    expect(body.target).toBe('http://localhost:3001');
    expect(String(body.message)).toContain('http://localhost:3001');
    expect(String(body.message)).toContain('ECONNREFUSED');
    // The console's `requestJson` renders `body.error` as the detail, so it must never be blank.
    expect(String(body.message).trim()).not.toBe('');
  });

  it('describes a non-Error rejection instead of failing to build a response', () => {
    const failure = proxyFailure('http://localhost:3001', 'socket hang up');
    expect(failure.status).toBe(502);
    expect(String((JSON.parse(failure.body) as { message?: unknown }).message)).toContain('socket hang up');
  });

  it('writes the body through the response, keeping it as the receiver', () => {
    const written: { status: number; headers: Record<string, string>; body: string; receivers: unknown[] } = {
      status: 0,
      headers: {},
      body: '',
      receivers: [],
    };
    const reply = {
      headersSent: false,
      writeHead(this: unknown, status: number, headers: Record<string, string>): void {
        written.receivers.push(this);
        written.status = status;
        written.headers = headers;
      },
      end(this: unknown, body: string): void {
        written.receivers.push(this);
        written.body = body;
      },
    };
    const failure = proxyFailure('http://localhost:3001', new Error('connect ECONNREFUSED'));
    expect(answerProxyFailure(reply, failure)).toBe(true);
    expect(written.status).toBe(PROXY_FAILURE_STATUS);
    expect(written.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(written.body).toBe(failure.body);
    expect(written.receivers).toEqual([reply, reply]);
  });

  it('cuts the connection off rather than answering an empty response when headers are already out', () => {
    let destroyed = 0;
    const reply = { headersSent: true, writeHead: () => undefined, end: () => undefined, destroy: () => { destroyed += 1; } };
    expect(answerProxyFailure(reply, proxyFailure('http://localhost:3001', new Error('gone')))).toBe(false);
    expect(destroyed).toBe(1);
  });

  it('survives a response it cannot write through at all', () => {
    expect(answerProxyFailure(undefined, proxyFailure('http://localhost:3001', new Error('gone')))).toBe(false);
  });
});
