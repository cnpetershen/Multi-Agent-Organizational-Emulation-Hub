import { z } from 'zod';
import type { OrgEvent, Result } from '@maoeh/shared-types';
import {
  createOrgEvent,
  type EventContractFailure,
  type EventRegistry,
} from '@maoeh/event-system';

/**
 * M3.9 · observability events for the two stages that previously had no real event.
 *
 * These are additive facts about a business operation that already succeeded. They never carry
 * model prose as user speech: `analysisMode` / `provenanceMode` distinguishes AI derivation from
 * human confirmation, and there is no task/message claim for the capability matches in M3.7.
 */

export const REQUIREMENT_ANALYZED = 'Document.RequirementAnalyzed';
export const REQUIREMENT_CONFIRMED = 'Document.RequirementConfirmed';
export const PROMOTION_GENERATED = 'Document.PromotionGenerated';
export const PROMOTION_CONFIRMED = 'Document.PromotionConfirmed';

export const OBSERVABILITY_EVENT_TYPES = [
  REQUIREMENT_ANALYZED,
  REQUIREMENT_CONFIRMED,
  PROMOTION_GENERATED,
  PROMOTION_CONFIRMED,
] as const;

export type ObservabilityEventType = (typeof OBSERVABILITY_EVENT_TYPES)[number];

const requirementAnalyzedSchema = z.object({
  requirementId: z.string().min(1).max(64),
  version: z.number().int().min(1),
  title: z.string().min(1).max(200),
  sourceKind: z.enum(['goal', 'sandbox']),
  analysisMode: z.enum(['live', 'mock', 'sandbox', 'deterministic']),
  inferredFieldCount: z.number().int().min(0),
  analyzedAt: z.string().min(1),
});

const requirementConfirmedSchema = z.object({
  requirementId: z.string().min(1).max(64),
  version: z.number().int().min(1),
  title: z.string().min(1).max(200),
  confirmedBy: z.string().min(1).max(64),
  confirmedAt: z.string().min(1),
  inferredAcknowledged: z.boolean(),
});

const promotionGeneratedSchema = z.object({
  promotionId: z.string().min(1).max(64),
  version: z.number().int().min(1),
  title: z.string().min(1).max(200),
  executionId: z.string().min(1).max(64),
  planId: z.string().min(1).max(64),
  planVersion: z.number().int().min(1),
  approvalId: z.string().min(1).max(64),
  generatedAt: z.string().min(1),
  provenanceMode: z.string().min(1).max(32),
  materialCount: z.number().int().min(0),
  channelCount: z.number().int().min(0),
});

const promotionConfirmedSchema = z.object({
  promotionId: z.string().min(1).max(64),
  version: z.number().int().min(1),
  title: z.string().min(1).max(200),
  executionId: z.string().min(1).max(64),
  planId: z.string().min(1).max(64),
  planVersion: z.number().int().min(1),
  approvalId: z.string().min(1).max(64),
  confirmedBy: z.string().min(1).max(64),
  confirmedAt: z.string().min(1),
  humanEdits: z.array(z.string().max(80)).max(40),
});

export interface RequirementAnalyzedInput {
  readonly requirementId: string;
  readonly version: number;
  readonly title: string;
  readonly sourceKind: 'goal' | 'sandbox';
  readonly analysisMode: 'live' | 'mock' | 'sandbox' | 'deterministic';
  readonly inferredFieldCount: number;
  readonly analyzedAt: string;
}
export interface RequirementConfirmedInput {
  readonly requirementId: string;
  readonly version: number;
  readonly title: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly inferredAcknowledged: boolean;
}
export interface PromotionGeneratedInput {
  readonly promotionId: string;
  readonly version: number;
  readonly title: string;
  readonly executionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly approvalId: string;
  readonly generatedAt: string;
  readonly provenanceMode: string;
  readonly materialCount: number;
  readonly channelCount: number;
}
export interface PromotionConfirmedInput {
  readonly promotionId: string;
  readonly version: number;
  readonly title: string;
  readonly executionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly approvalId: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly humanEdits: readonly string[];
}

export function ensureObservabilityEvents(
  registry: EventRegistry,
): Result<void, EventContractFailure> {
  const registrations: readonly (readonly [string, z.ZodType<unknown>])[] = [
    [REQUIREMENT_ANALYZED, requirementAnalyzedSchema],
    [REQUIREMENT_CONFIRMED, requirementConfirmedSchema],
    [PROMOTION_GENERATED, promotionGeneratedSchema],
    [PROMOTION_CONFIRMED, promotionConfirmedSchema],
  ];
  for (const [type, schema] of registrations) {
    if (registry.isRegistered(type)) continue;
    const registered = registry.register(type, schema);
    if (!registered.ok) return registered;
  }
  return { ok: true, value: undefined };
}

export function requirementAnalyzedEvent(input: {
  readonly registry: EventRegistry;
  readonly companyId: string;
  readonly simTime: number;
  readonly actorId: string;
  readonly payload: RequirementAnalyzedInput;
}): OrgEvent {
  return makeEvent(input.registry, input.companyId, REQUIREMENT_ANALYZED, input.simTime, input.actorId, input.payload);
}

export function requirementConfirmedEvent(input: {
  readonly registry: EventRegistry;
  readonly companyId: string;
  readonly simTime: number;
  readonly actorId: string;
  readonly payload: RequirementConfirmedInput;
}): OrgEvent {
  return makeEvent(input.registry, input.companyId, REQUIREMENT_CONFIRMED, input.simTime, input.actorId, input.payload);
}

export function promotionGeneratedEvent(input: {
  readonly registry: EventRegistry;
  readonly companyId: string;
  readonly simTime: number;
  readonly actorId: string;
  readonly payload: PromotionGeneratedInput;
}): OrgEvent {
  return makeEvent(input.registry, input.companyId, PROMOTION_GENERATED, input.simTime, input.actorId, input.payload);
}

export function promotionConfirmedEvent(input: {
  readonly registry: EventRegistry;
  readonly companyId: string;
  readonly simTime: number;
  readonly actorId: string;
  readonly payload: PromotionConfirmedInput;
}): OrgEvent {
  return makeEvent(input.registry, input.companyId, PROMOTION_CONFIRMED, input.simTime, input.actorId, input.payload);
}

function makeEvent(
  registry: EventRegistry,
  companyId: string,
  type: ObservabilityEventType,
  simTime: number,
  actorId: string,
  payload: unknown,
): OrgEvent {
  const created = createOrgEvent(registry, {
    companyId: companyId as never,
    type,
    occurredAtSim: simTime as never,
    actorKind: 'human',
    actorId,
    subjectType: type.startsWith('Requirement') ? 'requirement' : 'promotion',
    subjectId:
      typeof payload === 'object' && payload !== null && 'requirementId' in payload
        ? String((payload as { requirementId: unknown }).requirementId)
        : typeof payload === 'object' && payload !== null && 'promotionId' in payload
          ? String((payload as { promotionId: unknown }).promotionId)
          : null,
    correlationId:
      typeof payload === 'object' && payload !== null && 'requirementId' in payload
        ? String((payload as { requirementId: unknown }).requirementId)
        : typeof payload === 'object' && payload !== null && 'promotionId' in payload
          ? String((payload as { promotionId: unknown }).promotionId)
          : type,
    payload,
  });
  if (!created.ok) {
    throw new Error(
      `${type} could not be created: ${created.error.issues
        .map((issue) => `${issue.field}: ${issue.reason}`)
        .join('; ')}`,
    );
  }
  return created.value;
}
