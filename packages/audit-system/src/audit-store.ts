import type { AuditQuery, AuditRecord, AuditStore } from './types.js';
import { deepFreeze } from './audit-record.js';

export interface InMemoryAuditStoreOptions {
  readonly maxRecords?: number;
}

const DEFAULT_MAX_RECORDS = 5000;

export function createInMemoryAuditStore(options?: InMemoryAuditStoreOptions): AuditStore {
  const maxRecords = options?.maxRecords ?? DEFAULT_MAX_RECORDS;
  const records: AuditRecord[] = [];

  const matches = (record: AuditRecord, q: AuditQuery): boolean => {
    if (q.actorId !== undefined && record.actorId !== q.actorId) return false;
    if (q.commandId !== undefined && record.commandId !== q.commandId) return false;
    if (q.targetId !== undefined && record.target.targetId !== q.targetId) return false;
    if (q.correlationId !== undefined && record.correlationId !== q.correlationId) return false;
    if (q.verdict !== undefined && record.verdict !== q.verdict) return false;
    return true;
  };

  const snapshot = (matched: readonly AuditRecord[]): readonly AuditRecord[] =>
    Object.freeze([...matched]);

  return {
    append(record) {
      records.push(deepFreeze(record));
      if (records.length > maxRecords) records.splice(0, records.length - maxRecords);
    },
    byCommandId(commandId) {
      for (const record of records) {
        if (record.commandId === commandId) return record;
      }
      return null;
    },
    byTarget(targetId) {
      return snapshot(records.filter((record) => record.target.targetId === targetId));
    },
    byCorrelationId(correlationId) {
      return snapshot(records.filter((record) => record.correlationId === correlationId));
    },
    all() {
      return snapshot(records);
    },
    query(q) {
      const matched = records.filter((record) => matches(record, q));
      if (q.limit === undefined) return snapshot(matched);
      return snapshot(matched.slice(0, Math.max(0, q.limit)));
    },
    size() {
      return records.length;
    },
  };
}
