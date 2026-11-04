import type { AuditRecord } from './types.js';

export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  const seen = new WeakSet<object>();
  const walk = (node: object): void => {
    if (seen.has(node)) return;
    seen.add(node);
    Object.freeze(node);
    for (const key of Object.keys(node)) {
      const child = Reflect.get(node, key);
      if (typeof child === 'object' && child !== null) walk(child);
    }
  };
  walk(value);
  return value;
}

export function freezeAuditRecord(input: Omit<AuditRecord, 'auditId'>, auditId: string): AuditRecord {
  const record: AuditRecord = {
    ...input,
    auditId,
    action: { ...input.action },
    target: { ...input.target },
    eventIds: [...input.eventIds],
    details: { ...input.details },
  };
  return deepFreeze(record);
}
