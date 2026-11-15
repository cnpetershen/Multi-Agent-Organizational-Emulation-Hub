import { z } from 'zod';
import type { OrgEvent, Result } from '@maoeh/shared-types';
import {
  createOrgEvent,
  type EventContractFailure,
  type EventRegistry,
} from '@maoeh/event-system';

/**
 * M3.8 · real publication lifecycle events.
 *
 * These are facts about a local publication artifact that was actually written (or a real failed
 * attempt). They are not campaign-performance telemetry and they never claim an external platform
 * accepted anything. Theater classifies them as the release stage.
 */

export const PUBLICATION_DRAFTED = 'Document.PublicationDrafted';
export const PUBLICATION_CONFIRMED = 'Document.PublicationConfirmed';
export const PUBLICATION_PUBLISHED = 'Document.PublicationPublished';
export const PUBLICATION_PARTIALLY_PUBLISHED = 'Document.PublicationPartiallyPublished';
export const PUBLICATION_FAILED = 'Document.PublicationFailed';

export const PUBLICATION_EVENT_TYPES = [
  PUBLICATION_DRAFTED,
  PUBLICATION_CONFIRMED,
  PUBLICATION_PUBLISHED,
  PUBLICATION_PARTIALLY_PUBLISHED,
  PUBLICATION_FAILED,
] as const;

const payloadSchema = z.object({
  publicationId: z.string().min(1).max(64),
  version: z.number().int().min(1),
  promotionId: z.string().min(1).max(64),
  promotionVersion: z.number().int().min(1),
  executionId: z.string().min(1).max(64),
  planId: z.string().min(1).max(64),
  planVersion: z.number().int().min(1),
  approvalId: z.string().min(1).max(64),
  status: z.string().min(1).max(40),
  publicPath: z.string().max(500).nullable(),
});

export type PublicationEventPayload = z.infer<typeof payloadSchema>;

export function ensurePublicationEvents(
  registry: EventRegistry,
): Result<void, EventContractFailure> {
  for (const type of PUBLICATION_EVENT_TYPES) {
    if (registry.isRegistered(type)) continue;
    const registered = registry.register(type, payloadSchema);
    if (!registered.ok) return registered;
  }
  return { ok: true, value: undefined };
}

export function publicationEvent(input: {
  readonly registry: EventRegistry;
  readonly companyId: string;
  readonly type: (typeof PUBLICATION_EVENT_TYPES)[number];
  readonly simTime: number;
  readonly actorId: string;
  readonly payload: PublicationEventPayload;
}): OrgEvent {
  const created = createOrgEvent(input.registry, {
    companyId: input.companyId as never,
    type: input.type,
    occurredAtSim: input.simTime as never,
    actorKind: 'human',
    actorId: input.actorId,
    subjectType: 'publication',
    subjectId: input.payload.publicationId,
    correlationId: input.payload.publicationId,
    payload: input.payload,
  });
  if (!created.ok) {
    throw new Error(
      `publication event ${input.type} could not be created: ${created.error.issues
        .map((issue) => `${issue.field}: ${issue.reason}`)
        .join('; ')}`,
    );
  }
  return created.value;
}
