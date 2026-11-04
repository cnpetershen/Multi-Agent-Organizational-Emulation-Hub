import type { ActorContext, CorrelationId, SimTime } from '@maoeh/shared-types';
import type { CognitionContext } from './context/cognition-context.js';
import type { CognitionProfile } from './profile.js';

export interface CognitionRequest {
  readonly requestId: string;
  readonly actorContext: ActorContext | undefined;
  readonly cognitionContext: CognitionContext;
  readonly profile: CognitionProfile;
  readonly maxLlmCalls: number;
  readonly simTime: SimTime;
  readonly traceId?: string | null;
  readonly correlationId?: CorrelationId;
}
