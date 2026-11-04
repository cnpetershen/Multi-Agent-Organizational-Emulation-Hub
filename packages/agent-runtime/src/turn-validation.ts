import type { ActorContext, OrgEvent } from '@maoeh/shared-types';
import { EMPLOYMENT_STATUSES, PRESENCE_STATES } from '@maoeh/shared-types';
import type { AgentState } from '@maoeh/runtime-state';
import type { AgentInstance } from './agent-instance.js';
import type { RuntimeError, RuntimeIssue } from './runtime-errors.js';

export interface TurnInputShape {
  readonly agent: Pick<AgentInstance, 'id' | 'definitionId' | 'employeeId'>;
  readonly state: AgentState;
  readonly actorContext: ActorContext;
  readonly event: OrgEvent;
}

export function validateTurnInput(input: TurnInputShape): RuntimeError | null {
  const { agent, state, actorContext, event } = input;

  const agentIssues: RuntimeIssue[] = [];
  if (agent.id === '') {
    agentIssues.push({ field: 'agent.id', reason: 'agent id must not be empty' });
  }
  if (agent.definitionId === '') {
    agentIssues.push({
      field: 'agent.definitionId',
      reason: 'agent definitionId must not be empty',
    });
  }
  if (agent.employeeId === '') {
    agentIssues.push({
      field: 'agent.employeeId',
      reason: 'agent employeeId must not be empty',
    });
  }
  if (agentIssues.length > 0) {
    return { code: 'INVALID_AGENT_INSTANCE', issues: agentIssues };
  }

  const stateIssues: RuntimeIssue[] = [];
  if (state.employeeId !== agent.employeeId) {
    stateIssues.push({
      field: 'state.employeeId',
      reason: `state belongs to "${state.employeeId}" but agent is "${agent.employeeId}"`,
    });
  }
  if (!Number.isInteger(state.version) || state.version < 0) {
    stateIssues.push({ field: 'state.version', reason: 'version must be an integer >= 0' });
  }
  if (!(EMPLOYMENT_STATUSES as readonly string[]).includes(state.employment)) {
    stateIssues.push({ field: 'state.employment', reason: 'employment is not a known status' });
  }
  if (!(PRESENCE_STATES as readonly string[]).includes(state.presence)) {
    stateIssues.push({ field: 'state.presence', reason: 'presence is not a known state' });
  }
  if (stateIssues.length > 0) {
    return { code: 'INVALID_STATE', issues: stateIssues };
  }

  const turnIssues: RuntimeIssue[] = [];
  if (actorContext.employeeId !== agent.employeeId) {
    turnIssues.push({
      field: 'actorContext.employeeId',
      reason: `turn actor is "${actorContext.employeeId}" but agent is "${agent.employeeId}"`,
    });
  }
  if (event.eventId === '') {
    turnIssues.push({ field: 'event.eventId', reason: 'event id must not be empty' });
  }
  if (event.type === '') {
    turnIssues.push({ field: 'event.type', reason: 'event type must not be empty' });
  }
  if (event.companyId === '') {
    turnIssues.push({ field: 'event.companyId', reason: 'companyId must not be empty' });
  }
  if (event.correlationId === '') {
    turnIssues.push({ field: 'event.correlationId', reason: 'correlationId must not be empty' });
  }
  if (turnIssues.length > 0) {
    return { code: 'INVALID_TURN_INPUT', issues: turnIssues };
  }

  return null;
}
