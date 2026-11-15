import { describe, expect, it } from 'vitest';
import type { ControlCommand } from '@maoeh/organization-control';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M3.2 · the collaboration theater's live tail, over the real HTTP server.
 *
 * This is the acceptance chain the milestone asks for, and it is deliberately not a mock of
 * itself:
 *
 *   real API process (+ real kernel, event store, control plane, tick driver)
 *     → GET /api/theater/history          (the seed / replay read)
 *     → GET /api/theater/stream?cursor=…  (SSE over the company's own log)
 *     → POST /api/command                 (real pause/resume facts)
 *
 * It pins the four properties a theater cannot fake: a real event arrives live, the cursor
 * resumes without loss or duplication, pause/resume is the runtime's real state, and an event's
 * stage is proven (or explicitly absent) rather than invented.
 */

type Json = Readonly<Record<string, unknown>>;

const OPERATOR = {
  operatorId: 'ceo-alex',
  displayName: 'Alex',
  positionId: 'ceo',
  kind: 'human',
} as const;

let commandSeq = 0;

function command(
  commandType: ControlCommand['commandType'],
  overrides: Readonly<Record<string, unknown>> = {},
): ControlCommand {
  commandSeq += 1;
  const commandId = `cmd-m32-${String(commandSeq)}`;
  return {
    commandId,
    commandType,
    actor: OPERATOR,
    target: { targetType: 'organization', targetId: 'future-ai-lab' },
    reason: 'M3.2 theater verification',
    correlationId: commandId,
    causationId: null,
    createdAtSim: 0,
    ...overrides,
  } as ControlCommand;
}

function viewOf(value: unknown): Json {
  return (typeof value === 'object' && value !== null ? value : {}) as Json;
}

function rowsOf(value: unknown): readonly Json[] {
  return Array.isArray(value) ? (value as readonly Json[]) : [];
}

interface SseFrame {
  readonly event: string;
  readonly id: string | null;
  readonly data: Json;
}

/** A tiny SSE client: enough to prove framing, ids and ordered delivery. */
function openStream(url: string) {
  const controller = new AbortController();
  const frames: SseFrame[] = [];
  let buffer = '';
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let closed = false;

  const parse = (block: string): void => {
    if (block.trim() === '' || block.startsWith(':')) return;
    let event = 'message';
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      else if (line.startsWith('id:')) id = line.slice('id:'.length).trim();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trim());
    }
    let parsed: Json = {};
    if (data.length > 0) {
      try {
        parsed = viewOf(JSON.parse(data.join('\n')) as unknown);
      } catch {
        return;
      }
    }
    frames.push({ event, id, data: parsed });
  };

  const start = async (): Promise<Response> => {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    if (response.body !== null) {
      reader = response.body.getReader();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += new TextDecoder().decode(value);
            let index = buffer.indexOf('\n\n');
            while (index >= 0) {
              parse(buffer.slice(0, index));
              buffer = buffer.slice(index + 2);
              index = buffer.indexOf('\n\n');
            }
          }
        } catch {
          // aborted by the test
        } finally {
          closed = true;
        }
      })();
    }
    return response;
  };

  const waitFor = async (
    predicate: (frame: SseFrame) => boolean,
    timeoutMs = 6000,
  ): Promise<SseFrame> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = frames.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(`timed out; frames=${JSON.stringify(frames.map((frame) => frame.event))}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  const close = async (): Promise<void> => {
    controller.abort();
    if (reader !== null) {
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
    }
    // Give the server's close handling one turn to release the connection.
    await new Promise((resolve) => setTimeout(resolve, 30));
  };

  return {
    start,
    waitFor,
    close,
    frames,
    get closed() {
      return closed;
    },
  };
}

describe('M3.2 collaboration theater · real SSE over the real API', () => {
  it('streams a real pause fact, resumes by cursor without duplicates, and keeps stages honest', async () => {
    const server = await startApiServer(0, {
      eventLogPath: null,
      // The scenario is about the stream, not the scheduler: keep incidental ticks rare.
      tick: { activeIntervalMs: 60_000, idleIntervalMs: 60_000, pausedIntervalMs: 60_000 },
    });
    const base = `http://127.0.0.1:${String(server.port)}/api`;
    const get = async (path: string): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(`${base}${path}`, { headers: { connection: 'close' } });
      return { status: response.status, body: (await response.json()) as unknown };
    };
    const post = async (payload: ControlCommand): Promise<Json> => {
      const response = await fetch(`${base}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(200);
      return viewOf(await response.json());
    };
    const accept = async (payload: ControlCommand): Promise<void> => {
      const outcome = await post(payload);
      expect(String(outcome['status']), JSON.stringify(outcome['failure'])).toBe('accepted');
    };

    try {
      // 0. The seed read is the company's own log, with the cursor a client resumes from.
      const history = viewOf((await get('/theater/history?limit=20')).body);      const companyId = String(history['companyId']);
      expect(companyId).not.toBe('');
      const latestSeq = Number(history['latestSeq']);
      const historyEvents = rowsOf(history['events']);
      expect(latestSeq).toBeGreaterThan(0);
      expect(historyEvents.length).toBeGreaterThan(0);
      expect(historyEvents[0]).toHaveProperty('seq');
      expect(historyEvents[0]).toHaveProperty('type');
      // The theater is collaboration, not telemetry.
      expect(
        historyEvents.every((event) => {
          const type = String(event['type']);
          return !type.startsWith('System.') && !type.startsWith('Runtime.');
        }),
      ).toBe(true);

      // 1. Pause through the real command path, then connect from the seq after it.
      await accept(
        command('Simulation.Pause', {
          target: { targetType: 'simulation', targetId: companyId },
        }),
      );
      const paused = viewOf((await get('/simulation')).body);
      expect(paused['paused']).toBe(true);

      const afterPause = viewOf((await get('/theater/history?limit=1')).body);
      const cursor = Number(afterPause['latestSeq']);
      const first = openStream(`${base}/theater/stream?cursor=${String(cursor)}&company=${encodeURIComponent(companyId)}`);
      const firstResponse = await first.start();
      expect(firstResponse.status).toBe(200);
      expect(firstResponse.headers.get('content-type') ?? '').toContain('text/event-stream');
      const hello = await first.waitFor((frame) => frame.event === 'hello');
      expect(hello.data).toMatchObject({ companyId, cursor });

      // 2. A real control fact arrives live.
      await accept(
        command('Simulation.Resume', {
          target: { targetType: 'simulation', targetId: companyId },
        }),
      );
      const resumedFrame = await first.waitFor(
        (frame) => frame.event === 'theater' && frame.data['type'] === 'Control.SimulationResumed',
      );
      const resumedSeq = Number(resumedFrame.id);
      expect(resumedSeq).toBeGreaterThan(cursor);
      expect(viewOf((await get('/simulation')).body)['paused']).toBe(false);
      // A control event is operational, not a business phase: it must stay unclassified.
      expect(resumedFrame.data['stage']).toBeNull();

      // 3. Reconnect from the last delivered id; a later fact arrives exactly once.
      await first.close();
      const second = openStream(`${base}/theater/stream?cursor=${String(resumedSeq)}&company=${encodeURIComponent(companyId)}`);
      try {
        expect((await second.start()).status).toBe(200);
        const secondHello = await second.waitFor((frame) => frame.event === 'hello');
        expect(secondHello.data).toMatchObject({ cursor: resumedSeq });

        await accept(
          command('Simulation.Pause', {
            target: { targetType: 'simulation', targetId: companyId },
          }),
        );
        const pausedFrame = await second.waitFor(
          (frame) => frame.event === 'theater' && frame.data['type'] === 'Control.SimulationPaused',
        );
        expect(Number(pausedFrame.id)).toBeGreaterThan(resumedSeq);

        const delivered = second.frames.filter((frame) => frame.event === 'theater');
        const ids = delivered.map((frame) => Number(frame.id));
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.every((id) => id > resumedSeq)).toBe(true);
      } finally {
        await second.close();
      }

      // 4. A session replay reads the same events by `correlationId`, not a second script.
      const sessionId = String(resumedFrame.data['correlationId'] ?? '');
      const replay = viewOf(
        (await get(`/theater/history?correlationId=${encodeURIComponent(sessionId)}&limit=20`)).body,
      );
      const replayEvents = rowsOf(replay['events']);
      expect(replayEvents.some((event) => event['type'] === 'Control.SimulationResumed')).toBe(true);
      // Every replayed event is one of the original events (same seq/type/causation).
      const live = resumedFrame.data;
      const replayed = replayEvents.find((event) => event['seq'] === live['seq']);
      expect(replayed).toMatchObject({
        seq: live['seq'],
        eventId: live['eventId'],
        type: live['type'],
        stage: live['stage'],
      });

      // 5. A cursor from another company is refused before a stream opens.
      const mismatch = await fetch(`${base}/theater/stream?company=another-company`, {
        headers: { connection: 'close' },
      });
      expect(mismatch.status).toBe(409);
      // A malformed cursor is a client error, not a silent restart.
      const invalid = await fetch(`${base}/theater/stream?cursor=not-a-number`, {
        headers: { connection: 'close' },
      });
      expect(invalid.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});
