import type { EmployeeId, OrgEvent } from '@maoeh/shared-types';
import type { WorkflowInstance } from '@maoeh/workflow-engine';

import {
  CONTROL_AGENT_INSTRUCTED,
  CONTROL_AGENT_PAUSED,
  CONTROL_AGENT_RESUMED,
  CONTROL_EVENT_INJECTED,
  CONTROL_SIMULATION_PAUSED,
  CONTROL_SIMULATION_RESUMED,
  CONTROL_SIMULATION_SOUGHT,
  CONTROL_SIMULATION_STARTED,
  CONTROL_SIMULATION_STEPPED,
  CONTROL_TASK_INJECTED,
  isControlEvent,
} from './events.js';

/**
 * Control-plane projection of `Control.*` events.
 *
 * This is a **read model**, not a source of truth (BASELINE §14 / 01-overview §1.4 rule 1).
 * It exists so that "pause" survives `recover()` without writing pause into an event-free
 * in-memory flag, and so that `Simulation.Pause` is auditable and observable.
 */
export interface ControlProjection {
  readonly simulationPaused: boolean;
  readonly pausedAgentIds: ReadonlySet<EmployeeId>;
  readonly issuedInstructionIds: readonly string[];
  readonly injectedTaskIds: readonly string[];
  readonly lastControlTick: number;
  readonly appliedEventIds: readonly string[];
}

export function createInitialControlProjection(): ControlProjection {
  return Object.freeze({
    simulationPaused: false,
    pausedAgentIds: new Set<EmployeeId>(),
    issuedInstructionIds: Object.freeze([]),
    injectedTaskIds: Object.freeze([]),
    lastControlTick: 0,
    appliedEventIds: Object.freeze([]),
  });
}

function payloadOf(event: OrgEvent): Readonly<Record<string, unknown>> {
  return typeof event.payload === 'object' && event.payload !== null
    ? (event.payload as Readonly<Record<string, unknown>>)
    : {};
}

function readString(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readNumber(payload: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function appendUnique(values: readonly string[], next: string): readonly string[] {
  return values.includes(next) ? values : Object.freeze([...values, next]);
}

export function applyControlEvent(
  state: ControlProjection,
  event: OrgEvent,
): ControlProjection {
  if (!isControlEvent(event.type)) return state;
  if (state.appliedEventIds.includes(event.eventId)) return state;

  const payload = payloadOf(event);
  const appliedEventIds = appendUnique(state.appliedEventIds, event.eventId);
  const base = { ...state, appliedEventIds };
  const tick = readNumber(payload, 'tickNumber');

  const withTick = (): ControlProjection =>
    tick === null ? base : { ...base, lastControlTick: tick };

  switch (event.type) {
    case CONTROL_SIMULATION_STARTED:
    case CONTROL_SIMULATION_RESUMED:
      return { ...withTick(), simulationPaused: false };
    case CONTROL_SIMULATION_PAUSED:
      return { ...withTick(), simulationPaused: true };
    case CONTROL_SIMULATION_STEPPED:
    case CONTROL_SIMULATION_SOUGHT:
      return withTick();
    case CONTROL_AGENT_PAUSED: {
      const agentId = readString(payload, 'agentId');
      if (agentId === null) return base;
      const paused = new Set(state.pausedAgentIds);
      paused.add(agentId as EmployeeId);
      return { ...base, pausedAgentIds: paused };
    }
    case CONTROL_AGENT_RESUMED: {
      const agentId = readString(payload, 'agentId');
      if (agentId === null) return base;
      const paused = new Set(state.pausedAgentIds);
      paused.delete(agentId as EmployeeId);
      return { ...base, pausedAgentIds: paused };
    }
    case CONTROL_AGENT_INSTRUCTED: {
      const instructionId = readString(payload, 'instructionId');
      if (instructionId === null) return base;
      return { ...base, issuedInstructionIds: appendUnique(state.issuedInstructionIds, instructionId) };
    }
    case CONTROL_TASK_INJECTED: {
      const taskId = readString(payload, 'taskId');
      if (taskId === null) return base;
      return { ...base, injectedTaskIds: appendUnique(state.injectedTaskIds, taskId) };
    }
    case CONTROL_EVENT_INJECTED:
      return base;
    default:
      return base;
  }
}

export function applyControlEvents(
  events: Iterable<OrgEvent>,
  initial: ControlProjection = createInitialControlProjection(),
): ControlProjection {
  let state = initial;
  for (const event of events) state = applyControlEvent(state, event);
  return state;
}

/**
 * Aggregate version proxies.
 *
 * `WorkflowInstance.version` is the *workflow definition* version and `Task` carries no
 * revision at all (verified against M0.9 source), so optimistic concurrency for these two
 * aggregates is expressed as the number of domain events folded into them.
 */
export function taskVersionOf(eventCount: number): number {
  return eventCount;
}

export function workflowVersionOf(instance: WorkflowInstance): number {
  return instance.processedEventIds.length;
}

export function agentVersionOf(version: number): number {
  return version;
}
