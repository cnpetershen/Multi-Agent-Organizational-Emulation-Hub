import type {
  EmploymentStatus,
  OrgEvent,
  Plan,
  PresenceState,
} from '@maoeh/shared-types';
import { PRESENCE_STATES } from '@maoeh/shared-types';
import type { AgentState } from '@maoeh/runtime-state';
import type { AgentInstance } from './agent-instance.js';

export const SUPPORTED_RUNTIME_EVENT_TYPES = ['Runtime.PresenceChanged'] as const;

export type RuntimeIgnoreReason =
  | 'duplicate'
  | 'unsupported_event_type'
  | 'unattributed_event'
  | 'event_for_other_agent';

export type RuntimeRejectReason =
  | 'event_payload_mismatch'
  | 'invalid_event_payload'
  | 'agent_not_runnable';

export type RuntimeDecisionReason = 'processed' | RuntimeIgnoreReason | RuntimeRejectReason;

export type RuntimeDecisionKind = 'process' | 'ignore' | 'reject';

export interface RuntimeProcessDecision {
  readonly kind: 'process';
  readonly reason: 'processed';
  readonly plan: Plan;
  readonly presence: PresenceState;
}

export interface RuntimeIgnoreDecision {
  readonly kind: 'ignore';
  readonly reason: RuntimeIgnoreReason;
  readonly plan: null;
}

export interface RuntimeRejectDecision {
  readonly kind: 'reject';
  readonly reason: RuntimeRejectReason;
  readonly plan: null;
}

export type RuntimeDecision =
  | RuntimeProcessDecision
  | RuntimeIgnoreDecision
  | RuntimeRejectDecision;

export interface RuntimeDecisionInput {
  readonly agent: AgentInstance;
  readonly state: AgentState;
  readonly event: OrgEvent;
  readonly alreadyProcessed: boolean;
}

const NON_RUNNABLE_EMPLOYMENT: readonly EmploymentStatus[] = [
  'suspended',
  'transferred',
  'offboarded',
];

interface RuntimePresencePayload {
  readonly employeeId: string | null;
  readonly presence: PresenceState | null;
}

function readPresencePayload(payload: unknown): RuntimePresencePayload {
  if (typeof payload !== 'object' || payload === null) {
    return { employeeId: null, presence: null };
  }
  const record = payload as { readonly employeeId?: unknown; readonly presence?: unknown };
  const employeeId =
    typeof record.employeeId === 'string' && record.employeeId !== '' ? record.employeeId : null;
  const presence =
    typeof record.presence === 'string' &&
    (PRESENCE_STATES as readonly string[]).includes(record.presence)
      ? (record.presence as PresenceState)
      : null;
  return { employeeId, presence };
}

function ignore(reason: RuntimeIgnoreReason): RuntimeIgnoreDecision {
  return { kind: 'ignore', reason, plan: null };
}

function reject(reason: RuntimeRejectReason): RuntimeRejectDecision {
  return { kind: 'reject', reason, plan: null };
}

function process(
  agent: AgentInstance,
  event: OrgEvent,
  presence: PresenceState,
): RuntimeProcessDecision {
  return {
    kind: 'process',
    reason: 'processed',
    presence,
    plan: {
      goal: `adopt presence "${presence}"`,
      steps: [
        {
          index: 0,
          action: 'UpdatePresence',
          args: {
            employeeId: agent.employeeId,
            presence,
            sourceEventId: event.eventId,
          },
          reasonRef: 0,
          idempotencyKey: `${agent.employeeId}:${event.eventId}`,
        },
      ],
      doneWhen: `AgentState.presence of ${agent.employeeId} equals "${presence}"`,
    },
  };
}

export function decideRuntimeTurn(input: RuntimeDecisionInput): RuntimeDecision {
  const { agent, state, event, alreadyProcessed } = input;

  if (alreadyProcessed) return ignore('duplicate');
  if (!(SUPPORTED_RUNTIME_EVENT_TYPES as readonly string[]).includes(event.type)) {
    return ignore('unsupported_event_type');
  }

  const subjectId = event.subjectId;
  if (subjectId === null) return ignore('unattributed_event');
  if (subjectId !== agent.employeeId) return ignore('event_for_other_agent');

  const payload = readPresencePayload(event.payload);
  if (payload.employeeId !== null && payload.employeeId !== subjectId) {
    return reject('event_payload_mismatch');
  }
  if (NON_RUNNABLE_EMPLOYMENT.includes(state.employment)) return reject('agent_not_runnable');
  if (payload.presence === null) return reject('invalid_event_payload');

  return process(agent, event, payload.presence);
}

export function shouldHandle(
  agent: AgentInstance,
  event: OrgEvent,
  state: AgentState,
): boolean {
  return decideRuntimeTurn({ agent, state, event, alreadyProcessed: false }).kind === 'process';
}
