import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deepFreeze } from '@maoeh/event-system';
import type { OrgEvent } from '@maoeh/shared-types';
import type {
  EventFilter,
  EventStore,
  OutboxDispatchReport,
  OutboxEntry,
  Seq,
} from './types.js';
import { DuplicateEventError } from './types.js';

export interface FileEventStoreOptions {
  /**
   * Append-only JSONL log. The file (and its parent directory) is created when missing, so a
   * first boot and a restart take the same code path.
   */
  readonly path: string;
  readonly now?: () => string;
}

export interface FileEventStoreRecovery {
  /** Events replayed from the log on construction. */
  readonly events: number;
  /** Lines dropped because they were unreadable (a crash can truncate the last append). */
  readonly skipped: number;
}

export interface FileEventStore extends EventStore {
  readonly path: string;
  readonly recovered: FileEventStoreRecovery;
}

const join = (...parts: readonly string[]): string => parts.join('\u0000');

function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function readSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * A durable `EventStore`: the same append/replay contract as `createInMemoryEventStore`, with the
 * log written to an append-only JSONL file so it survives a process restart.
 *
 * Why the log is the unit of durability (A3: "every organization state change is an event"): the
 * kernel already knows how to rebuild everything from it. On boot `createSimulation` replays the
 * log — tasks, workflow instances, agent state, channels and runtime-created agents
 * (`Control.AgentCreated`) all come back — and company formation is idempotent, so a restarted
 * process is byte-identical to one that never stopped. Persisting the *roster* instead would put
 * organization state outside the event stream and break that replay guarantee.
 *
 * Scope of the durability, stated plainly:
 * - **durable** — the event log itself (`append` writes before it resolves; `replay` serves the
 *   in-memory mirror, which is loaded from the file once at construction).
 * - **not yet durable** — the outbox, consumer offsets and processed marks. They are
 *   process-local bookkeeping: the kernel never reads offsets back (it re-commits them every tick)
 *   and the recovered cursor, not the processed marks, is what bounds re-dispatch after a restart.
 *   `persistence` (Postgres) replaces this adapter behind the same port when it lands
 *   (BASELINE §15 / SCHEMA GAP), at which point those tables become real.
 *
 * A truncated or unreadable tail line is skipped instead of failing the boot: a hard kill can
 * interrupt the last append, and refusing to start would turn that into a permanent outage.
 */
export function createFileEventStore(options: FileEventStoreOptions): FileEventStore {
  const now = options?.now ?? ((): string => new Date().toISOString());
  const path = options.path;

  mkdirSync(dirname(path), { recursive: true });

  const events: OrgEvent[] = [];
  const storedKeys = new Set<string>();
  const outbox: OutboxEntry[] = [];
  const offsets = new Map<string, Seq>();
  const processed = new Map<
    string,
    { consumerGroup: string; eventId: string; consumerKey: string; processedAt: string }
  >();
  let skipped = 0;
  let nextSeq = 1;
  let nextOutboxId = 1;

  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        skipped += 1;
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        skipped += 1;
        continue;
      }
      const record = parsed as Record<string, unknown>;
      const eventId = readString(record['eventId']);
      const companyId = readString(record['companyId']);
      const seq = readSeq(record['seq']);
      const type = readString(record['type']);
      if (eventId === null || companyId === null || seq === null || type === null) {
        skipped += 1;
        continue;
      }
      // The four load-critical fields are validated above; everything else is carried through
      // verbatim, so a recovered event is identical to the one that was appended.
      const event = deepFreeze({ ...(record as unknown as OrgEvent), seq }) as OrgEvent;
      events.push(event);
      storedKeys.add(join(companyId, eventId));
      if (seq >= nextSeq) nextSeq = seq + 1;
    }
  }

  return {
    path,
    recovered: Object.freeze({ events: events.length, skipped }),
    async append(batch) {
      const batchKeys = new Set<string>();
      for (const event of batch) {
        const key = join(event.companyId, event.eventId);
        if (storedKeys.has(key) || batchKeys.has(key)) {
          throw new DuplicateEventError(event.eventId, event.companyId);
        }
        batchKeys.add(key);
      }
      const lines: string[] = [];
      let watermark = nextSeq - 1;
      for (const event of batch) {
        storedKeys.add(join(event.companyId, event.eventId));
        const seq = nextSeq;
        nextSeq += 1;
        const stored = deepFreeze({ ...event, seq, occurredAtWall: now() }) as OrgEvent;
        events.push(stored);
        outbox.push(
          deepFreeze({
            id: nextOutboxId,
            eventId: stored.eventId,
            topic: stored.type,
            payload: stored,
            availableAt: now(),
            dispatchedAt: null,
            attempts: 0,
            lastError: null,
          }),
        );
        nextOutboxId += 1;
        lines.push(JSON.stringify(stored));
        watermark = seq;
      }
      // Written before the promise resolves: once `append` has been awaited the event is on disk,
      // which is the guarantee a restart replays.
      if (lines.length > 0) appendFileSync(path, `${lines.join('\n')}\n`, 'utf8');
      return watermark as Seq;
    },
    async *replay(from, to, filter) {
      for (const event of events) {
        if (event.seq < from) continue;
        if (to !== undefined && event.seq > to) continue;
        if (filter !== undefined && !matchesFilter(event, filter)) continue;
        yield event;
      }
    },
    async dispatchOutbox(handler): Promise<OutboxDispatchReport> {
      let dispatched = 0;
      let failed = 0;
      const current = now();
      for (let index = 0; index < outbox.length; index += 1) {
        const entry = outbox[index];
        if (entry === undefined) continue;
        if (entry.dispatchedAt !== null) continue;
        if (entry.availableAt > current) continue;
        const pending: OutboxEntry = deepFreeze({ ...entry, attempts: entry.attempts + 1 });
        try {
          await handler(pending);
          outbox[index] = deepFreeze({ ...pending, dispatchedAt: now() });
          dispatched += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          outbox[index] = deepFreeze({ ...pending, lastError: message });
          failed += 1;
        }
      }
      return { dispatched, failed };
    },
    commitOffset(consumerGroup, companyId, lastSeq) {
      offsets.set(join(consumerGroup, companyId), lastSeq);
    },
    loadOffset(consumerGroup, companyId) {
      return offsets.get(join(consumerGroup, companyId)) ?? (0 as Seq);
    },
    markProcessed(consumerGroup, eventId, consumerKey) {
      processed.set(join(consumerGroup, eventId, consumerKey), {
        consumerGroup,
        eventId,
        consumerKey,
        processedAt: now(),
      });
    },
    isProcessed(consumerGroup, eventId, consumerKey) {
      return processed.has(join(consumerGroup, eventId, consumerKey));
    },
  };
}

function matchesFilter(event: OrgEvent, filter: EventFilter): boolean {
  if (filter.companyId !== undefined && event.companyId !== filter.companyId) return false;
  if (filter.type !== undefined && event.type !== filter.type) return false;
  if (filter.correlationId !== undefined && event.correlationId !== filter.correlationId) {
    return false;
  }
  if (filter.subjectId !== undefined && event.subjectId !== filter.subjectId) return false;
  return true;
}
