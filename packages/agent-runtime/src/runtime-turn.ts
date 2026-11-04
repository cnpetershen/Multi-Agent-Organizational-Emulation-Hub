import type {
  ActorContext,
  EmployeeId,
  OrgEvent,
  SimTime,
} from '@maoeh/shared-types';
import type { EventRegistry } from '@maoeh/event-system';
import type { AgentState } from '@maoeh/runtime-state';
import type { AgentInstance } from './agent-instance.js';
import type { RuntimeDecision } from './runtime-decision.js';

export type RuntimeTurnStatus = 'completed' | 'ignored' | 'rejected';

export interface RuntimeTurnResult {
  readonly turnId: string;
  readonly agentId: string;
  readonly employeeId: EmployeeId;
  readonly actorContext: ActorContext;
  readonly inputEvent: OrgEvent;
  readonly stateBefore: AgentState;
  readonly decision: RuntimeDecision;
  readonly emittedEvents: readonly OrgEvent[];
  readonly stateAfter: AgentState;
  readonly status: RuntimeTurnStatus;
}

export interface RuntimeTurnContext {
  isProcessed(agentId: EmployeeId, eventId: string): boolean;
  markProcessed(agentId: EmployeeId, eventId: string): void;
  nextTurnId(): string;
  nextEventId(): string;
}

export interface RuntimeTurnContextOptions {
  readonly turnIdPrefix?: string;
  readonly eventIdPrefix?: string;
}

export interface RunAgentTurnInput {
  readonly agent: AgentInstance;
  readonly state: AgentState;
  readonly actorContext: ActorContext;
  readonly event: OrgEvent;
  readonly simTime: SimTime;
  readonly registry: EventRegistry;
  readonly turnContext: RuntimeTurnContext;
}

function turnKey(agentId: EmployeeId, eventId: string): string {
  return JSON.stringify([agentId, eventId]);
}

export function createRuntimeTurnContext(
  options?: RuntimeTurnContextOptions,
): RuntimeTurnContext {
  const turnIdPrefix = options?.turnIdPrefix ?? 'turn-';
  const eventIdPrefix = options?.eventIdPrefix ?? 'evt-';
  const processed = new Set<string>();
  let turnSeq = 0;
  let eventSeq = 0;

  return {
    isProcessed(agentId, eventId) {
      return processed.has(turnKey(agentId, eventId));
    },
    markProcessed(agentId, eventId) {
      processed.add(turnKey(agentId, eventId));
    },
    nextTurnId() {
      turnSeq += 1;
      return `${turnIdPrefix}${turnSeq}`;
    },
    nextEventId() {
      eventSeq += 1;
      return `${eventIdPrefix}${eventSeq}`;
    },
  };
}
