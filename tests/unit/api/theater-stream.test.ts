import { describe, expect, it } from 'vitest';
import type { TheaterEventView } from '@maoeh/organization-control';
import {
  formatTheaterControl,
  formatTheaterFrame,
  readTheaterCursor,
} from '../../../apps/api/src/theater-stream';

/**
 * M3.2 · SSE contract at the edge.
 *
 * The cursor is the whole reconnect story: it must parse strictly (a malformed cursor is a
 * client error, not a silent restart) and the frame must carry the real event id so the browser
 * and our own reconnect logic can resume after exactly the last displayed fact.
 */

const EVENT: TheaterEventView = {
  seq: 42,
  eventId: 'evt-42',
  type: 'Communication.MessageSent',
  occurredAtSim: 7,
  actorKind: 'employee',
  actorId: 'engineer-mike',
  subjectType: 'message',
  subjectId: 'msg-1',
  correlationId: 'session-1',
  causationId: null,
  payload: { messageId: 'msg-1', body: 'please take this' },
  stage: null,
  stageBasis: null,
};

describe('M3.2 theater SSE · cursor', () => {
  it('accepts an absent cursor as "start at the newest event"', () => {
    expect(readTheaterCursor(new URLSearchParams(), undefined)).toEqual({ ok: true, cursor: null });
  });

  it('reads the query cursor, then the Last-Event-ID header', () => {
    expect(readTheaterCursor(new URLSearchParams('cursor=42'), undefined)).toEqual({
      ok: true,
      cursor: 42,
    });
    expect(readTheaterCursor(new URLSearchParams(), '17')).toEqual({ ok: true, cursor: 17 });
    expect(readTheaterCursor(new URLSearchParams('cursor=5'), '17')).toEqual({
      ok: true,
      cursor: 5,
    });
    expect(readTheaterCursor(new URLSearchParams('cursor=%2042%20'), undefined)).toEqual({
      ok: true,
      cursor: 42,
    });
  });

  it('rejects malformed, negative and unsafe cursors instead of restarting silently', () => {
    for (const raw of ['abc', '-1', '1.5', '', '42abc', '9007199254740993']) {
      expect(readTheaterCursor(new URLSearchParams(`cursor=${raw}`), undefined), raw).toEqual({
        ok: false,
      });
    }
  });
});

describe('M3.2 theater SSE · frames', () => {
  it('carries the event id and the real event payload', () => {
    const frame = formatTheaterFrame(EVENT);
    expect(frame.startsWith('id: 42\nevent: theater\ndata: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    const data = JSON.parse(frame.slice(frame.indexOf('data: ') + 'data: '.length)) as Record<
      string,
      unknown
    >;
    expect(data).toMatchObject({
      seq: 42,
      eventId: 'evt-42',
      type: 'Communication.MessageSent',
      payload: { messageId: 'msg-1', body: 'please take this' },
      stage: null,
    });
  });

  it('formats control frames as named events', () => {
    expect(formatTheaterControl('hello', { cursor: 3 })).toBe(
      'event: hello\ndata: {"cursor":3}\n\n',
    );
  });
});
