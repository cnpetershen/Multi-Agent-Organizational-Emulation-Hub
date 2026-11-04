import type { EventType, Result } from '@maoeh/shared-types';
import type { ZodType } from 'zod';
import type { EventContractFailure, EventContractIssue } from './event-issue.js';
import { parseEventType } from './taxonomy.js';

export interface EventRegistry {
  register(type: string, schema: ZodType<unknown>): Result<void, EventContractFailure>;
  isRegistered(type: string): boolean;
  schemaFor(type: string): ZodType<unknown> | null;
  registeredTypes(): readonly EventType[];
}

export function createEventRegistry(): EventRegistry {
  const schemas = new Map<string, ZodType<unknown>>();

  return {
    register(type, schema) {
      const issues: EventContractIssue[] = [];
      if (parseEventType(type) === null) {
        issues.push({
          field: 'type',
          reason:
            'event type must follow <Aggregate>.<PastTenseVerb> with a documented aggregate (03-data-model 3.6.2)',
        });
      } else if (schemas.has(type)) {
        issues.push({ field: 'type', reason: `event type "${type}" is already registered` });
      }
      if (issues.length > 0) return { ok: false, error: { issues } };
      schemas.set(type, schema);
      return { ok: true, value: undefined };
    },
    isRegistered(type) {
      return schemas.has(type);
    },
    schemaFor(type) {
      return schemas.get(type) ?? null;
    },
    registeredTypes() {
      return [...schemas.keys()] as EventType[];
    },
  };
}
