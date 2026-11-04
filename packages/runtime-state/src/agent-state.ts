import type {
  AgendaItem,
  EmployeeId,
  EmploymentStatus,
  OrgEvent,
  PresenceState,
  SimTime,
} from '@maoeh/shared-types';
import { PRESENCE_STATES } from '@maoeh/shared-types';

export interface AgentState {
  readonly employeeId: EmployeeId;
  readonly version: number;
  readonly employment: EmploymentStatus;
  readonly presence: PresenceState;
  readonly currentCycleId: string | null;
  readonly suspendedAt: {
    readonly stepIndex: number;
    readonly awaitingEventType: string;
  } | null;
  readonly agenda: readonly AgendaItem[];
  readonly focus: {
    readonly refType: string;
    readonly refId: string;
  } | null;
  readonly budget: {
    readonly simDay: number;
    readonly tokensUsed: number;
    readonly usdUsed: number;
    readonly cyclesRun: number;
  };
  readonly reflection: {
    readonly accumulator: number;
    readonly lastReflectedAtSim: SimTime;
    readonly episodesSinceReflect: number;
  };
  readonly permissionSnapshot: {
    readonly computedAt: SimTime;
    readonly version: number;
  } | null;
  readonly branchId: string;
  readonly health: {
    readonly consecutiveFailures: number;
    readonly lastError?: string;
    readonly circuitOpenUntil?: SimTime;
  };
  readonly updatedAtSim: SimTime;
}

export type AgentStateTransition = (state: AgentState, event: OrgEvent) => AgentState;

export interface InitialAgentStateOptions {
  readonly employment?: EmploymentStatus;
}

export function createInitialAgentState(
  employeeId: EmployeeId,
  options?: InitialAgentStateOptions,
): AgentState {
  return {
    employeeId,
    version: 0,
    employment: options?.employment ?? 'defined',
    presence: 'idle',
    currentCycleId: null,
    suspendedAt: null,
    agenda: [],
    focus: null,
    budget: { simDay: 0, tokensUsed: 0, usdUsed: 0, cyclesRun: 0 },
    reflection: { accumulator: 0, lastReflectedAtSim: 0 as SimTime, episodesSinceReflect: 0 },
    permissionSnapshot: null,
    branchId: 'live',
    health: { consecutiveFailures: 0 },
    updatedAtSim: 0 as SimTime,
  };
}

function readPresence(payload: unknown): PresenceState | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = (payload as { readonly presence?: unknown }).presence;
  if (typeof candidate !== 'string') return null;
  if (!(PRESENCE_STATES as readonly string[]).includes(candidate)) return null;
  return candidate as PresenceState;
}

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = (payload as Readonly<Record<string, unknown>>)[key];
  return typeof candidate === 'string' && candidate !== '' ? candidate : null;
}

const RUNTIME_CYCLE_STARTED = 'Runtime.CycleStarted';
const RUNTIME_CYCLE_FINISHED = 'Runtime.CycleFinished';

function applyPresenceChanged(state: AgentState, event: OrgEvent): AgentState {
  const presence = readPresence(event.payload);
  if (presence === null) return state;
  return {
    ...state,
    presence,
    version: state.version + 1,
    updatedAtSim: event.occurredAtSim,
  };
}

function applyCycleStarted(state: AgentState, event: OrgEvent): AgentState {
  const cycleId = readString(event.payload, 'cycleId');
  if (cycleId === null) return state;
  return {
    ...state,
    currentCycleId: cycleId,
    version: state.version + 1,
    updatedAtSim: event.occurredAtSim,
  };
}

function applyCycleFinished(state: AgentState, event: OrgEvent): AgentState {
  const outcome = readString(event.payload, 'outcome');
  if (outcome === null) return state;
  const failureCode = readString(event.payload, 'failureCode');
  const health =
    outcome === 'failed'
      ? {
          ...state.health,
          consecutiveFailures: state.health.consecutiveFailures + 1,
          ...(failureCode === null ? {} : { lastError: failureCode }),
        }
      : { consecutiveFailures: 0 };
  return {
    ...state,
    currentCycleId: null,
    budget: { ...state.budget, cyclesRun: state.budget.cyclesRun + 1 },
    health,
    version: state.version + 1,
    updatedAtSim: event.occurredAtSim,
  };
}

export const agentStateTransition: AgentStateTransition = (state, event) => {
  if (event.subjectId !== state.employeeId) return state;
  switch (event.type) {
    case 'Runtime.PresenceChanged':
      return applyPresenceChanged(state, event);
    case RUNTIME_CYCLE_STARTED:
      return applyCycleStarted(state, event);
    case RUNTIME_CYCLE_FINISHED:
      return applyCycleFinished(state, event);
    default:
      return state;
  }
};

export function replayAgentState(
  initial: AgentState,
  events: readonly OrgEvent[],
  transition: AgentStateTransition = agentStateTransition,
): AgentState {
  let state = initial;
  for (const event of events) {
    state = transition(state, event);
  }
  return state;
}
