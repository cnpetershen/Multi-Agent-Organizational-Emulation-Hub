import type {
  ActorKind,
  CompanyId,
  EventType,
  OrgEvent,
  Result,
  SimTime,
} from '@maoeh/shared-types';
import type { EventContractFailure, EventContractIssue } from './event-issue.js';
import { deepFreeze } from './event-issue.js';
import type { EventRegistry } from './event-registry.js';
import { parseEventType } from './taxonomy.js';

export interface OrgEventInput {
  readonly companyId: CompanyId;
  readonly type: string;
  readonly occurredAtSim: SimTime;
  readonly actorKind: ActorKind;
  readonly correlationId: string;
  readonly payload: unknown;
  readonly actorId?: string | null;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly causationId?: string | null;
  readonly traceId?: string | null;
  readonly version?: number;
  readonly eventId?: string;
}

export interface CreateEventOptions {
  readonly eventIdGenerator?: () => string;
}

const ACTOR_KINDS: readonly ActorKind[] = ['employee', 'human', 'system'];

function defaultEventIdGenerator(): string {
  return globalThis.crypto.randomUUID();
}

export function createOrgEvent(
  registry: EventRegistry,
  input: OrgEventInput,
  options?: CreateEventOptions,
): Result<OrgEvent, EventContractFailure> {
  const issues: EventContractIssue[] = [];
  const parsedType = parseEventType(input.type);
  if (parsedType === null) {
    issues.push({
      field: 'type',
      reason:
        'event type must follow <Aggregate>.<PastTenseVerb> with a documented aggregate (03-data-model 3.6.2)',
    });
  }
  if (input.companyId === undefined || input.companyId === '') {
    issues.push({ field: 'companyId', reason: 'companyId must not be empty' });
  }
  if (typeof input.correlationId !== 'string' || input.correlationId === '') {
    issues.push({ field: 'correlationId', reason: 'correlationId must not be empty' });
  }
  if (!ACTOR_KINDS.includes(input.actorKind)) {
    issues.push({ field: 'actorKind', reason: 'actorKind must be employee | human | system' });
  }
  if (
    typeof input.occurredAtSim !== 'number' ||
    !Number.isFinite(input.occurredAtSim) ||
    input.occurredAtSim < 0
  ) {
    issues.push({ field: 'occurredAtSim', reason: 'occurredAtSim must be a non-negative number (minutes)' });
  }
  if (
    input.version !== undefined &&
    (!Number.isInteger(input.version) || input.version < 1)
  ) {
    issues.push({ field: 'version', reason: 'version must be an integer >= 1' });
  }
  if (input.eventId !== undefined && (typeof input.eventId !== 'string' || input.eventId === '')) {
    issues.push({ field: 'eventId', reason: 'eventId must not be empty when provided' });
  }

  let payload: unknown = input.payload;
  if (parsedType !== null) {
    const schema = registry.schemaFor(input.type);
    if (schema === null) {
      issues.push({ field: 'type', reason: `event type "${input.type}" is not registered` });
    } else {
      const parsed = schema.safeParse(input.payload);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const path = issue.path.map((segment) => String(segment)).join('.');
          issues.push({
            field: path === '' ? 'payload' : `payload.${path}`,
            reason: issue.message,
          });
        }
      } else {
        payload = parsed.data;
      }
    }
  }

  if (issues.length > 0) return { ok: false, error: { issues } };

  const generateId = options?.eventIdGenerator ?? defaultEventIdGenerator;
  const event: OrgEvent = {
    seq: 0,
    eventId: input.eventId ?? generateId(),
    companyId: input.companyId,
    type: input.type as EventType,
    version: input.version ?? 1,
    occurredAtSim: input.occurredAtSim,
    occurredAtWall: '',
    actorKind: input.actorKind,
    actorId: input.actorId ?? null,
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    payload,
    causationId: input.causationId ?? null,
    correlationId: input.correlationId,
    traceId: input.traceId ?? null,
  };
  return { ok: true, value: deepFreeze(event) };
}
