import type { Result } from '@maoeh/shared-types';
import { createOrgEvent } from '@maoeh/event-system';
import { replayAgentState } from '@maoeh/runtime-state';
import { decideRuntimeTurn } from './runtime-decision.js';
import type { RuntimeError } from './runtime-errors.js';
import type { RunAgentTurnInput, RuntimeTurnResult } from './runtime-turn.js';
import { validateTurnInput } from './turn-validation.js';

export function runAgentTurn(input: RunAgentTurnInput): Result<RuntimeTurnResult, RuntimeError> {
  const failure = validateTurnInput(input);
  if (failure !== null) return { ok: false, error: failure };

  const { agent, state, actorContext, event, simTime, registry, turnContext } = input;
  const decision = decideRuntimeTurn({
    agent,
    state,
    event,
    alreadyProcessed: turnContext.isProcessed(agent.employeeId, event.eventId),
  });
  const turnId = turnContext.nextTurnId();

  const base = {
    turnId,
    agentId: agent.id,
    employeeId: agent.employeeId,
    actorContext,
    inputEvent: event,
    stateBefore: state,
    decision,
  };

  if (decision.kind !== 'process') {
    return {
      ok: true,
      value: {
        ...base,
        emittedEvents: [],
        stateAfter: state,
        status: decision.kind === 'ignore' ? 'ignored' : 'rejected',
      },
    };
  }

  const emitted = createOrgEvent(
    registry,
    {
      companyId: event.companyId,
      type: 'Runtime.PresenceChanged',
      occurredAtSim: simTime,
      actorKind: 'employee',
      actorId: actorContext.employeeId,
      subjectType: 'employee',
      subjectId: agent.employeeId,
      correlationId: event.correlationId,
      causationId: event.eventId,
      traceId: event.traceId,
      payload: { employeeId: agent.employeeId, presence: decision.presence },
    },
    { eventIdGenerator: () => turnContext.nextEventId() },
  );
  if (!emitted.ok) {
    return {
      ok: false,
      error: { code: 'EVENT_CONTRACT_VIOLATION', issues: emitted.error.issues },
    };
  }

  turnContext.markProcessed(agent.employeeId, event.eventId);
  const stateAfter = replayAgentState(state, [emitted.value]);

  return {
    ok: true,
    value: {
      ...base,
      emittedEvents: [emitted.value],
      stateAfter,
      status: 'completed',
    },
  };
}
