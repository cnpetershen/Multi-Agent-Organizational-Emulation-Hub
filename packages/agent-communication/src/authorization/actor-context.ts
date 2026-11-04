import { z } from 'zod';
import type { ActorContext } from '@maoeh/shared-types';
import type { CommunicationFailure } from '../communication-errors.js';
import { communicationFailure, issue } from '../communication-errors.js';
import { zodIssues } from '../validation/zod-issues.js';

export const actorContextSchema = z.object({
  employeeId: z.string().min(1).max(64),
  positionId: z.string().min(1).max(64),
  correlationId: z.string().min(1),
});

export function validateActorContext(actor: ActorContext): CommunicationFailure | null {
  const parsed = actorContextSchema.safeParse(actor);
  if (parsed.success) return null;
  return communicationFailure('invalid_actor', zodIssues(parsed.error));
}

export function unknownActor(employeeId: string): CommunicationFailure {
  return communicationFailure('invalid_actor', [
    issue('actor.employeeId', `identity system cannot resolve employee "${employeeId}"`),
  ]);
}
