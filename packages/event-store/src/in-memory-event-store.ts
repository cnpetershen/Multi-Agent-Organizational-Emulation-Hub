import type { OrgEvent } from '@maoeh/shared-types';
import { deepFreeze } from '@maoeh/event-system';
import type { EventFilter, EventStore, OutboxDispatchReport, OutboxEntry, Seq } from './types.js';
import { DuplicateEventError } from './types.js';

export interface InMemoryEventStoreOptions {
  readonly now?: () => string;
}

const join = (...parts: readonly string[]): string => parts.join('\u0000');

export function createInMemoryEventStore(options?: InMemoryEventStoreOptions): EventStore {
  const now = options?.now ?? ((): string => new Date().toISOString());
  const events: OrgEvent[] = [];
  const storedKeys = new Set<string>();
  const outbox: OutboxEntry[] = [];
  const offsets = new Map<string, Seq>();
  const processed = new Map<string, { consumerGroup: string; eventId: string; consumerKey: string; processedAt: string }>();
  let nextSeq = 1;
  let nextOutboxId = 1;

  return {
    async append(batch) {
      const batchKeys = new Set<string>();
      for (const event of batch) {
        const key = join(event.companyId, event.eventId);
        if (storedKeys.has(key) || batchKeys.has(key)) {
          throw new DuplicateEventError(event.eventId, event.companyId);
        }
        batchKeys.add(key);
      }
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
        watermark = seq;
      }
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
