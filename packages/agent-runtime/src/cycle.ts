import type {
  Action,
  ActorContext,
  CompanyId,
  EmployeeId,
  OrgEvent,
  Plan,
  Result,
  SimTime,
  Step,
} from '@maoeh/shared-types';
import type { AgentDefinition } from '@maoeh/agent-definition';
import type {
  AssignedTaskView,
  CognitionExecutor,
  CognitionProfile,
  CommunicationView,
  OrganizationSnapshotView,
  WorkCatalogView,
} from '@maoeh/agent-cognition';
import type { EventContractFailure, EventRegistry } from '@maoeh/event-system';
import { createOrgEvent } from '@maoeh/event-system';
import type { AgentState } from '@maoeh/runtime-state';
import { replayAgentState } from '@maoeh/runtime-state';
import type { AgentInstance } from './agent-instance.js';
import { runAgentCognition } from './cognition-adapter.js';
import type { RuntimeError } from './runtime-errors.js';
import { RUNTIME_CYCLE_FINISHED, RUNTIME_CYCLE_STARTED } from './runtime-events.js';
import type { RuntimeTurnContext } from './runtime-turn.js';
import { validateTurnInput } from './turn-validation.js';

export const AGENT_CYCLE_STATUSES = [
  'acted',
  'noop',
  'ignored',
  'rejected',
  'failed',
  'budget_exceeded',
] as const;

export type AgentCycleStatus = (typeof AGENT_CYCLE_STATUSES)[number];

const NON_RUNNABLE_EMPLOYMENT = ['suspended', 'transferred', 'offboarded'] as const;

/**
 * Cognition failures worth waking the agent up for again. Transport problems and throttling pass;
 * a rejected credential (`llm_auth_failed`) or an unfunded account (`llm_account_unfunded`) does
 * not — retrying those burns the whole run budget on a loop only a human can end.
 */
const RETRYABLE_COGNITION_ERRORS = new Set<string>([
  'llm_gateway_unavailable',
  'llm_timeout',
  'provider_error',
  'llm_rate_limited',
  'budget_exceeded',
  // A live planner occasionally emits an action shape the executor rejects (an outline
  // instead of content, a missing transition, a stale task status). The next cycle asks the
  // model again; without this the task sits at `accepted`/`started` forever. The scheduler
  // caps these retries, so a genuinely broken plan still stops.
  'invalid_args',
  'invalid_transition',
  // A worker can mis-read an assigned step as a manager's dispatch and be refused by the A1/A2
  // scope gate. The next cycle is a fresh plan with the executor convention in the prompt; the
  // retry cap still stops a worker that genuinely lacks authority.
  'permission_denied',
]);

export interface PlanExecutionFailure {
  readonly code: string;
  readonly issues: readonly { readonly field: string; readonly reason: string }[];
}

export interface PlanExecutionContext {
  readonly companyId: CompanyId;
  readonly actorContext: ActorContext;
  readonly simTime: SimTime;
  readonly registry: EventRegistry;
  readonly correlationId: string;
  readonly causationId: string;
  readonly traceId: string | null;
  nextEventId(): string;
}

export interface PlanExecutor {
  execute(
    step: Step,
    context: PlanExecutionContext,
  ): Promise<Result<readonly OrgEvent[], PlanExecutionFailure>>;
}

export interface PlanStepResult {
  readonly stepIndex: number;
  readonly action: Action;
  readonly ok: boolean;
  readonly events: readonly OrgEvent[];
  readonly failure: PlanExecutionFailure | null;
}

export interface AgentCycleFailure {
  readonly code: string;
  readonly issues: readonly { readonly field: string; readonly reason: string }[];
}

export interface AgentCycleResult {
  readonly cycleId: string;
  readonly turnId: string;
  readonly employeeId: EmployeeId;
  readonly status: AgentCycleStatus;
  readonly reason: string;
  readonly inputEvent: OrgEvent;
  readonly plan: Plan | null;
  readonly stepResults: readonly PlanStepResult[];
  readonly emittedEvents: readonly OrgEvent[];
  readonly stateBefore: AgentState;
  readonly stateAfter: AgentState;
  readonly llmCalls: number;
  readonly failure: AgentCycleFailure | null;
  readonly retryable: boolean;
}

export interface RunAgentCycleInput {
  readonly agent: AgentInstance;
  readonly state: AgentState;
  readonly actorContext: ActorContext;
  readonly event: OrgEvent;
  readonly simTime: SimTime;
  readonly registry: EventRegistry;
  readonly turnContext: RuntimeTurnContext;
  readonly cycleId: string;
  readonly requestId: string;
  readonly wakeReason: string;
  readonly executor: CognitionExecutor;
  readonly definition: AgentDefinition;
  readonly profile: CognitionProfile;
  readonly organization: OrganizationSnapshotView;
  readonly workCatalog?: WorkCatalogView;
  /** Channels/messages this agent may act on — the surface `SendMessage` is executed against. */
  readonly communication?: CommunicationView;
  /** When set, the agent sees its own open tasks in the cognition prompt. */
  readonly assignedTasks?: readonly AssignedTaskView[];
  readonly planExecutor: PlanExecutor;
  readonly maxLlmCalls: number;
  readonly maxEmittedEvents?: number;
}

function emitRuntimeEvent(
  input: RunAgentCycleInput,
  type: string,
  payload: unknown,
): Result<OrgEvent, EventContractFailure> {
  return createOrgEvent(
    input.registry,
    {
      companyId: input.event.companyId,
      type,
      occurredAtSim: input.simTime,
      actorKind: 'employee',
      actorId: input.actorContext.employeeId,
      subjectType: 'employee',
      subjectId: input.agent.employeeId,
      correlationId: input.event.correlationId,
      causationId: input.event.eventId,
      traceId: input.event.traceId,
      payload,
    },
    { eventIdGenerator: () => input.turnContext.nextEventId() },
  );
}

function toCycleFailure(
  code: string,
  issues: readonly { readonly field: string; readonly reason: string }[],
): AgentCycleFailure {
  return { code, issues };
}

export async function runAgentCycle(
  input: RunAgentCycleInput,
): Promise<Result<AgentCycleResult, RuntimeError>> {
  const validation = validateTurnInput(input);
  if (validation !== null) return { ok: false, error: validation };

  const { agent, state, actorContext, event, simTime, registry, turnContext } = input;
  const turnId = turnContext.nextTurnId();

  const base = {
    cycleId: input.cycleId,
    turnId,
    employeeId: agent.employeeId,
    inputEvent: event,
    stateBefore: state,
    plan: null,
    stepResults: Object.freeze([]) as readonly PlanStepResult[],
    emittedEvents: Object.freeze([]) as readonly OrgEvent[],
    stateAfter: state,
    llmCalls: 0,
    failure: null,
    retryable: false,
  };

  if (turnContext.isProcessed(agent.employeeId, event.eventId)) {
    return {
      ok: true,
      value: { ...base, status: 'ignored', reason: 'duplicate' },
    };
  }

  if ((NON_RUNNABLE_EMPLOYMENT as readonly string[]).includes(state.employment)) {
    return {
      ok: true,
      value: { ...base, status: 'rejected', reason: 'agent_not_runnable' },
    };
  }

  if (!Number.isInteger(input.maxLlmCalls) || input.maxLlmCalls <= 0) {
    return {
      ok: true,
      value: { ...base, status: 'budget_exceeded', reason: 'max_llm_calls' },
    };
  }

  const started = emitRuntimeEvent(input, RUNTIME_CYCLE_STARTED, {
    cycleId: input.cycleId,
    employeeId: agent.employeeId,
    sourceEventId: event.eventId,
    reason: input.wakeReason,
  });
  if (!started.ok) {
    return {
      ok: false,
      error: { code: 'EVENT_CONTRACT_VIOLATION', issues: started.error.issues },
    };
  }

  const planContext: PlanExecutionContext = {
    companyId: event.companyId,
    actorContext,
    simTime,
    registry,
    correlationId: event.correlationId,
    causationId: event.eventId,
    traceId: event.traceId ?? null,
    nextEventId: () => turnContext.nextEventId(),
  };

  const cognition = await runAgentCognition({
    executor: input.executor,
    requestId: input.requestId,
    instance: agent,
    definition: input.definition,
    actorContext,
    profile: input.profile,
    organization: input.organization,
    ...(input.workCatalog === undefined ? {} : { workCatalog: input.workCatalog }),
    ...(input.communication === undefined ? {} : { communication: input.communication }),
    ...(input.assignedTasks === undefined ? {} : { assignedTasks: input.assignedTasks }),
    inputEvent: event,
    simTime,
    maxLlmCalls: input.maxLlmCalls,
    ...(event.traceId === undefined || event.traceId === null
      ? {}
      : { traceId: event.traceId }),
  });

  if (!cognition.ok) {
    const failure: AgentCycleFailure = {
      code: cognition.error.code,
      issues: cognition.error.issues,
    };
    const retryable = RETRYABLE_COGNITION_ERRORS.has(cognition.error.code);
    const finished = emitRuntimeEvent(input, RUNTIME_CYCLE_FINISHED, {
      cycleId: input.cycleId,
      employeeId: agent.employeeId,
      sourceEventId: event.eventId,
      outcome: 'failed',
      actionCount: 0,
      goal: null,
      failureCode: cognition.error.code,
    });
    if (!finished.ok) {
      return {
        ok: false,
        error: { code: 'EVENT_CONTRACT_VIOLATION', issues: finished.error.issues },
      };
    }
    const emitted = Object.freeze([started.value, finished.value]);
    if (!retryable) turnContext.markProcessed(agent.employeeId, event.eventId);
    return {
      ok: true,
      value: {
        ...base,
        status: 'failed',
        reason: `cognition_${cognition.error.code}`,
        emittedEvents: emitted,
        stateAfter: replayAgentState(state, emitted),
        failure,
        retryable,
      },
    };
  }

  const plan = cognition.value.cognition.plan;
  const llmCalls = cognition.value.cognition.llmMetadata.callCount;
  const eventBudget =
    input.maxEmittedEvents === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, input.maxEmittedEvents - 2);

  const stepResults: PlanStepResult[] = [];
  const planEvents: OrgEvent[] = [];
  let failure: AgentCycleFailure | null = null;
  let stopReason = '';

  for (const step of plan.steps) {
    if (planEvents.length >= eventBudget) {
      failure = toCycleFailure('budget_exceeded', [
        { field: 'maxEmittedEvents', reason: 'cycle event budget exhausted' },
      ]);
      stopReason = 'budget_exceeded';
      break;
    }
    const outcome = await input.planExecutor.execute(step, planContext);
    if (!outcome.ok) {
      failure = toCycleFailure(outcome.error.code, outcome.error.issues);
      stopReason = `step_${step.action.toLowerCase()}_failed`;
      stepResults.push({
        stepIndex: step.index,
        action: step.action,
        ok: false,
        events: Object.freeze([]),
        failure,
      });
      break;
    }
    stepResults.push({
      stepIndex: step.index,
      action: step.action,
      ok: true,
      events: Object.freeze([...outcome.value]),
      failure: null,
    });
    planEvents.push(...outcome.value);
  }

  const status: AgentCycleStatus =
    failure !== null ? 'failed' : planEvents.length === 0 ? 'noop' : 'acted';

  const finished = emitRuntimeEvent(input, RUNTIME_CYCLE_FINISHED, {
    cycleId: input.cycleId,
    employeeId: agent.employeeId,
    sourceEventId: event.eventId,
    outcome: status === 'failed' ? 'failed' : 'acted',
    actionCount: planEvents.length,
    goal: plan.goal,
    failureCode: failure === null ? null : failure.code,
  });
  if (!finished.ok) {
    return {
      ok: false,
      error: { code: 'EVENT_CONTRACT_VIOLATION', issues: finished.error.issues },
    };
  }

  const emitted = Object.freeze([started.value, ...planEvents, finished.value]);
  const retryable =
    failure !== null && RETRYABLE_COGNITION_ERRORS.has(failure.code);
  if (!retryable) turnContext.markProcessed(agent.employeeId, event.eventId);

  return {
    ok: true,
    value: {
      cycleId: input.cycleId,
      turnId,
      employeeId: agent.employeeId,
      status,
      reason: stopReason === '' ? 'plan_executed' : stopReason,
      inputEvent: event,
      plan,
      stepResults: Object.freeze(stepResults),
      emittedEvents: emitted,
      stateBefore: state,
      stateAfter: replayAgentState(state, emitted),
      llmCalls,
      failure,
      retryable,
    },
  };
}
