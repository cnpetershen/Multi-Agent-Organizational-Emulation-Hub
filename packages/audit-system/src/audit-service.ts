import type { AuditQuery, AuditRecord, AuditStore } from './types.js';
import { freezeAuditRecord } from './audit-record.js';
import { createInMemoryAuditStore } from './audit-store.js';

export interface AuditService {
  record(input: Omit<AuditRecord, 'auditId'>): AuditRecord;
  find(commandId: string): AuditRecord | null;
  trail(targetId: string): readonly AuditRecord[];
  recent(limit?: number): readonly AuditRecord[];
  forCorrelation(correlationId: string): readonly AuditRecord[];
  query(q: AuditQuery): readonly AuditRecord[];
}

export interface AuditServiceOptions {
  readonly store?: AuditStore;
  readonly auditIdGenerator?: () => string;
  readonly maxRecords?: number;
}

function createAuditIdGenerator(): () => string {
  let next = 1;
  return () => {
    const auditId = `audit-${next}`;
    next += 1;
    return auditId;
  };
}

export function createAuditService(options?: AuditServiceOptions): AuditService {
  const maxRecords = options?.maxRecords;
  // retention belongs to the store: an injected store keeps its own policy
  const store =
    options?.store ??
    createInMemoryAuditStore(maxRecords === undefined ? undefined : { maxRecords });
  const nextAuditId = options?.auditIdGenerator ?? createAuditIdGenerator();

  return {
    record(input) {
      const record = freezeAuditRecord(input, nextAuditId());
      store.append(record);
      return record;
    },
    find(commandId) {
      return store.byCommandId(commandId);
    },
    trail(targetId) {
      return store.byTarget(targetId);
    },
    recent(limit) {
      const all = store.all();
      const tail = limit === undefined ? all : all.slice(Math.max(0, all.length - limit));
      return Object.freeze([...tail].reverse());
    },
    forCorrelation(correlationId) {
      return store.byCorrelationId(correlationId);
    },
    query(q) {
      return store.query(q);
    },
  };
}
