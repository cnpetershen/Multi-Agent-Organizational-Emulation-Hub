import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  EventView,
  TheaterEventView,
  TheaterStageSeed,
} from '@maoeh/organization-control';
import {
  TheaterStageTracker,
  theaterEventOf,
} from '@maoeh/organization-control';

/**
 * M3.2 · the collaboration theater's live tail.
 *
 * One SSE connection is a **cursor over the company's own event log**, not a second bus:
 *
 *   - the cursor is the last `seq` the client rendered; reconnecting with it resumes after that
 *     event, so a dropped connection neither loses a fact nor replays one;
 *   - every frame carries the real `OrgEvent` (id, type, sim time, actor, payload) plus the stage
 *     association the server proved; nothing is generated here;
 *   - `System.SimClockTicked` is the only type filtered out — it is a clock marker appended
 *     every tick, not collaboration — and the cursor still advances over it;
 *   - the stream is read-only and company-scoped: a request naming another company is refused
 *     before the stream opens.
 *
 * The handler writes to the Node response directly because SSE cannot go through the buffered
 * `Request → Response` adapter (a never-ending body would never resolve `arrayBuffer()`).
 */

export interface TheaterStreamSource {
  /** The company this API is currently serving. A stream never crosses a company switch. */
  readonly companyId: () => string;
  /** The newest event seq — where a client without a cursor starts. */
  readonly latestSeq: () => Promise<number>;
  /** Events with `seq > afterSeq`, oldest first (includes the clock marker the handler filters). */
  readonly page: (afterSeq: number, limit: number) => Promise<readonly EventView[]>;
  /** Recent activity used to prime the stage tracker when the stream starts mid-history. */
  readonly prime: () => Promise<readonly EventView[]>;
  /** Folded tasks, so a task assigned before this connection still keeps its stage. */
  readonly stageSeeds?: () => readonly TheaterStageSeed[];
}

export interface TheaterStreamOptions {
  readonly pollIntervalMs?: number;
  readonly heartbeatMs?: number;
  readonly batchSize?: number;
  readonly now?: () => number;
}

const DEFAULT_POLL_MS = 1000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_BATCH = 200;

export type CursorRead =
  | { readonly ok: true; readonly cursor: number | null }
  | { readonly ok: false };

/**
 * Resolve the resume cursor from `?cursor=` or the `Last-Event-ID` header.
 *
 * An absent cursor is legitimate (start at the newest event); a present but malformed one is a
 * client error rather than "start over", because silently restarting would replay history the
 * caller did not ask for.
 */
export function readTheaterCursor(
  searchParams: URLSearchParams,
  lastEventId: string | undefined,
): CursorRead {
  const queryCursor = searchParams.get('cursor');
  const raw = queryCursor ?? lastEventId ?? null;
  if (raw === null) return { ok: true, cursor: null };
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { ok: false };
  return { ok: true, cursor: value };
}

function sseJson(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatTheaterFrame(event: TheaterEventView): string {
  return `id: ${String(event.seq)}\nevent: theater\ndata: ${JSON.stringify(event)}\n\n`;
}

export function formatTheaterControl(event: string, data: unknown): string {
  return sseJson(event, data);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serve one SSE connection until the client leaves, the server switches company, or an error
 * ends it. Resolves when the response is finished; never throws at the caller.
 */
export async function serveTheaterStream(
  request: IncomingMessage,
  response: ServerResponse,
  source: TheaterStreamSource,
  options: TheaterStreamOptions = {},
): Promise<void> {
  if ((request.method ?? 'GET').toUpperCase() !== 'GET') {
    writeJson(response, 405, { error: 'method_not_allowed' });
    return;
  }
  const url = new URL(`http://localhost${request.url ?? '/'}`);
  const companyId = source.companyId();
  const requestedCompany = url.searchParams.get('company');
  if (requestedCompany !== null && requestedCompany !== companyId) {
    writeJson(response, 409, { error: 'company_mismatch', companyId });
    return;
  }
  const lastEventIdHeader = request.headers['last-event-id'];
  const lastEventId = Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader;
  const cursorRead = readTheaterCursor(url.searchParams, lastEventId);
  if (!cursorRead.ok) {
    writeJson(response, 400, { error: 'invalid_cursor' });
    return;
  }

  let latestSeq: number;
  let prime: readonly EventView[];
  try {
    latestSeq = await source.latestSeq();
    prime = await source.prime();
  } catch (error) {
    writeJson(response, 503, { error: 'stream_unavailable', message: messageOf(error) });
    return;
  }

  // A cursor ahead of the log means the log was reset (an in-memory run restarted) or the
  // client kept a cursor from another company. Resynchronise at the head instead of hanging.
  const resync = cursorRead.cursor !== null && cursorRead.cursor > latestSeq;
  let cursor = resync ? latestSeq : (cursorRead.cursor ?? latestSeq);

  const batchSize = Math.min(Math.max(options.batchSize ?? DEFAULT_BATCH, 1), 500);
  const pollMs = Math.max(options.pollIntervalMs ?? DEFAULT_POLL_MS, 100);
  const heartbeatMs = Math.max(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, pollMs);
  const now = options.now ?? Date.now;

  const tracker = new TheaterStageTracker(source.stageSeeds?.() ?? []);
  // Prime only with the past: a task's stage must not be learned from an event the client has
  // not reached yet (the prime window can extend past the resume cursor).
  for (const event of prime) {
    if (event.seq <= cursor) tracker.observe(event);
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  response.write('retry: 3000\n\n');
  response.write(
    formatTheaterControl('hello', {
      companyId,
      cursor,
      latestSeq,
      resync,
    }),
  );

  let closed = false;
  let polling = false;
  let draining = false;
  let lastWriteAt = now();
  let timer: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const finish = (): void => {
    if (closed) return;
    closed = true;
    if (timer !== null) clearInterval(timer);
    if (heartbeat !== null) clearInterval(heartbeat);
    if (!response.writableEnded) response.end();
  };

  const poll = async (): Promise<void> => {
    if (closed || polling || draining) return;
    polling = true;
    try {
      if (source.companyId() !== companyId) {
        response.write(formatTheaterControl('reset', { reason: 'company_changed' }));
        finish();
        return;
      }
      const events = await source.page(cursor, batchSize);
      for (const event of events) {
        if (closed) return;
        if (event.seq <= cursor) continue;
        const view = theaterEventOf(event, tracker);
        cursor = Math.max(cursor, event.seq);
        // The theater shows collaboration, not telemetry: the tick marker and the per-cycle
        // Runtime.* facts are skipped (the cursor still advances over them, so no fact is lost
        // from the log — only held out of this view).
        if (event.type.startsWith('System.') || event.type.startsWith('Runtime.')) continue;
        const writable = response.write(formatTheaterFrame(view));
        lastWriteAt = now();
        if (!writable) {
          draining = true;
          response.once('drain', () => {
            draining = false;
          });
          break;
        }
      }
    } catch (error) {
      if (!closed) {
        response.write(formatTheaterControl('error', { message: messageOf(error) }));
        finish();
      }
    } finally {
      polling = false;
    }
  };

  const onClose = (): void => finish();
  // `response` close is the connection ending. Deliberately not `request`'s `close`: on a
  // body-less GET that event can mean "request complete", which would end every stream at once.
  response.on('close', onClose);
  response.on('error', onClose);

  timer = setInterval(() => {
    void poll();
  }, pollMs);
  heartbeat = setInterval(() => {
    if (closed || response.writableEnded) return;
    if (now() - lastWriteAt < heartbeatMs) return;
    response.write(': keep-alive\n\n');
    lastWriteAt = now();
  }, Math.min(heartbeatMs, 5000));

  // Do not leave an empty connection waiting for the first poll: a client that connects to a
  // quiet company still sees whatever arrived since the cursor immediately.
  await poll();

  await new Promise<void>((resolve) => {
    if (closed) {
      resolve();
      return;
    }
    response.once('finish', resolve);
    response.once('close', resolve);
  });
}
