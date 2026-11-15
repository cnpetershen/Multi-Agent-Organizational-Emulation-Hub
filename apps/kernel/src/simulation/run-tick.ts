import type {
  ActorContext,
  CorrelationId,
  EmployeeId,
  OrgEvent,
  SimTime,
} from '@maoeh/shared-types';
import type { AgentDefinition } from '@maoeh/agent-definition';
import type { CognitionExecutor, CognitionProfile, AssignedTaskView } from '@maoeh/agent-cognition';
import type { AgentInstance, PlanExecutor, RuntimeTurnContext } from '@maoeh/agent-runtime';
import { runAgentCycle } from '@maoeh/agent-runtime';
import type { CollaborationService, CommunicationService } from '@maoeh/agent-communication';
import type { EventRegistry } from '@maoeh/event-system';
import { createOrgEvent } from '@maoeh/event-system';
import type { EventStore, Seq } from '@maoeh/event-store';
import type { Identity } from '@maoeh/identity-system';
import type { Organization } from '@maoeh/organization-model';
import type { AgentLifecycleResult, CreateAgentRequest } from '@maoeh/organization-control';
import { CONTROL_AGENT_CREATED } from '@maoeh/organization-control';
import type { AuthzService, CommandActor } from '@maoeh/permission-system';
import { employeeActor, systemActor } from '@maoeh/permission-system';
import type {
  AgentWakeup,
  BudgetTracker,
  Scheduler,
  WakeupTriggerKind,
} from '@maoeh/runtime-scheduler';
import { createBudgetTracker } from '@maoeh/runtime-scheduler';
import type { StateStore } from '@maoeh/runtime-state';
import type { Task, TaskService } from '@maoeh/task-system';
import { allowedTaskCommands, executorIdOf, isTerminalStatus } from '@maoeh/task-system';
import type {
  WorkflowDefinitionStore,
  WorkflowEngine,
  WorkflowInstanceStore,
} from '@maoeh/workflow-engine';
import { HIRING_WORKFLOW_ID, evaluateVerification } from '@maoeh/workflow-engine';

import { SYSTEM_SIM_CLOCK_TICKED } from './events.js';
import {
  MAX_TASK_CONTINUATIONS,
  noteTaskActivity,
  noteTaskHeartbeat,
  stalledTasks,
  tasksAwaitingContinuation,
  STALL_THRESHOLD_TICKS,
  type TaskHeartbeat,
} from './stall.js';
import { communicationViewOf } from './communication-view.js';
import type { EligibilityDeps } from './eligibility.js';
import { eligibleAgentsFor, refersToDeletedWork } from './eligibility.js';
import { organizationSnapshotView } from './snapshot.js';
import { workCatalogView } from './work-catalog.js';
import type {
  AgentTurnRecord,
  SimulationConfig,
  SimulationTickResult,
  SimulationTickStatus,
} from './types.js';

export interface AgentBundle {
  readonly instance: AgentInstance;
  readonly definition: AgentDefinition;
  readonly profile: CognitionProfile;
}

export interface SimulationCore {
  readonly config: SimulationConfig;
  readonly scheduler: Scheduler;
  readonly registry: EventRegistry;
  readonly eventStore: EventStore;
  readonly stateStore: StateStore;
  readonly identity: Identity;
  readonly organization: Organization;
  readonly authz: AuthzService;
  readonly tasks: TaskService;
  readonly instances: WorkflowInstanceStore;
  readonly definitions: WorkflowDefinitionStore;
  readonly workflow: WorkflowEngine;
  readonly communication: CommunicationService;
  readonly collaboration: CollaborationService;
  readonly cognition: CognitionExecutor;
  readonly planExecutorFactory: (budget: BudgetTracker) => PlanExecutor;
  /**
   * A4 (`role-agents-cannot-complete-tasks.md` §9): the Runtime's own roster operation, used by
   * the post-decision hiring pass to materialize an approved hire. Mutating the roster stays a
   * Runtime act — the pass only supplies the request a grant authorizes.
   */
  readonly createAgent: (request: CreateAgentRequest) => AgentLifecycleResult;
  readonly turnContext: RuntimeTurnContext;
  readonly agents: ReadonlyMap<EmployeeId, AgentBundle>;
  readonly eligibilityDeps: EligibilityDeps;
  /**
   * Stall watchdog bookkeeping: taskId -> last observed activity, including the phase that
   * produced it. Kept in memory like `retryCounts`; rebuilt empty at boot and seeded from the
   * event log on the first tick, which is what makes a pre-existing stall detectable without
   * treating an old-but-recently-active task as stale.
   */
  readonly stallHeartbeats: Map<string, TaskHeartbeat>;
  /** True once the first tick has seeded `stallHeartbeats` from the durable event log. */
  stallBootstrapped: boolean;
  /** Per-task count of scheduling continuations; capped so a model loop cannot spin forever. */
  readonly taskContinuations: Map<string, number>;
  /**
   * Wakeup id -> the event that caused it. The scheduler only stores a `sourceEventId`, and a
   * wakeup may be dispatched on a later tick than the event that produced it (deferred work for
   * a paused agent), so the event object is remembered here until the wakeup settles.
   */
  readonly wakeupSource: Map<string, OrgEvent>;
  cursor(): number;
  nextEventId(): string;
  nextCycleId(): string;
  nextRequestId(): string;
  resetRetry(employeeId: EmployeeId, eventId: string): void;
  bumpRetry(employeeId: EmployeeId, eventId: string): number;
  flushProcessedMarks(): void;
  /**
   * Employees whose operator pause was lifted since the previous tick. Their unconsumed,
   * still-actionable events are re-offered so that pausing an agent defers work instead of
   * dropping it (M1.0 §17: resume must restore the agent, not leave it idle forever).
   */
  drainResumedAgents(): readonly EmployeeId[];
}

export interface TickOutcome {
  readonly result: SimulationTickResult;
  readonly tickMarker: OrgEvent | null;
}

interface ReactorOutcome {
  readonly events: readonly OrgEvent[];
  readonly failures: number;
}

const REACTOR_TASK_EVENTS: ReadonlySet<string> = new Set([
  'Task.ProgressReported',
  'Task.Completed',
  'Task.Rejected',
  'Task.Failed',
  'Task.Cancelled',
]);

const REACTOR_MESSAGE_EVENT = 'Communication.MessageSent';

const SUBMIT_PHASES: ReadonlySet<string> = new Set(['submitted', 'reviewed']);

function assignedTasksOf(
  core: SimulationCore,
  employeeId: EmployeeId,
): readonly AssignedTaskView[] {
  return core
    .tasks.all()
    .filter((task) => executorIdOf(task) === employeeId && !isTerminalStatus(task.status))
    .map((task) => {
      const verificationKeys = task.verification?.requiredOutputKeys;
      const keys =
        verificationKeys === undefined || verificationKeys === null
          ? []
          : [...verificationKeys];
      const workflowContext = workflowContextOf(core, task);
      const base: AssignedTaskView = {
        taskId: task.taskId,
        title: task.title,
        goal: task.goal,
        status: task.status,
        // The task state machine's own answer to "what may I do next" — see the view's comment.
        allowedCommands: [...allowedTaskCommands(task.status)],
        ...(keys.length === 0 ? {} : { verificationKeys: keys }),
        ...(workflowContext === undefined ? {} : { workflowContext }),
      };
      return base;
    });
}

/**
 * A workflow step only exists after the canvas confirmed the draft; downstream agents otherwise
 * cannot tell that from a bare Task.Assigned event and may block waiting for a confirmation that
 * already happened. Include the confirmed status plus prior completed steps and evidence keys.
 */
function workflowContextOf(core: SimulationCore, task: Task): string | undefined {
  const instanceId = task.workflowInstanceId;
  if (instanceId === null) return undefined;
  const instance = core.instances.get(instanceId);
  if (instance === null) return undefined;
  const completed = core.tasks
    .all()
    .filter(
      (sibling) =>
        sibling.workflowInstanceId === instanceId &&
        sibling.taskId !== task.taskId &&
        sibling.status === 'completed',
    );
  const evidenceKeys = [
    ...new Set(
      completed.flatMap((sibling) =>
        sibling.result === null ? [] : Object.keys(sibling.result.data),
      ),
    ),
  ].slice(0, 8);
  const steps = completed.map((sibling) => sibling.title).slice(0, 6);
  return `instance ${instanceId} is confirmed (${String(instance.status)}); completed steps: ${
    steps.length === 0 ? '(none yet)' : steps.join(', ')
  }; evidence keys: ${evidenceKeys.length === 0 ? '(none yet)' : evidenceKeys.join(', ')}`;
}

function openTaskIdsOf(assigned: readonly AssignedTaskView[]): readonly string[] {
  return assigned
    .filter((task) => task.status === 'accepted' || task.status === 'started')
    .map((task) => task.taskId);
}

function pausedWorkflowIdsOf(core: SimulationCore): ReadonlySet<string> {
  return new Set(
    core.instances
      .all()
      .filter(
        (instance) =>
          String(instance.status) === 'paused' ||
          (String(instance.status) === 'blocked' &&
            instance.blockedReason !== null &&
            instance.blockedReason.kind === 'manual'),
      )
      .map((instance) => instance.instanceId),
  );
}

/** A task that starts, finishes or fails has no need for a continuation count any more. */
function clearContinuationCounts(core: SimulationCore, events: readonly OrgEvent[]): void {
  for (const event of events) {
    if (event.subjectType !== 'task' || event.subjectId === null) continue;
    if (
      event.type === 'Task.Assigned' ||
      event.type === 'Task.Started' ||
      event.type === 'Task.ProgressReported' ||
      event.type === 'Task.Completed' ||
      event.type === 'Task.Rejected' ||
      event.type === 'Task.Failed' ||
      event.type === 'Task.Cancelled'
    ) {
      core.taskContinuations.delete(event.subjectId);
    }
  }
}

/**
 * Wake an assignee after an AcceptTask-only cycle. This is a scheduler fact, not an auto-start:
 * the next turn is a real model turn whose prompt shows `status=accepted | next=StartTask`.
 * The cap prevents a model that keeps doing nothing from spinning forever; after it the
 * watchdog still fails/rejects the step, so nothing is marked complete by this path.
 */
function scheduleTaskContinuation(
  core: SimulationCore,
  employeeId: EmployeeId,
  simTime: SimTime,
  cycleEvents: readonly OrgEvent[],
  wakeupReason: string,
): void {
  const acceptedEvent = cycleEvents.some(
    (event) => event.type === 'Task.Accepted' || event.type === 'Task.Started',
  );
  if (!acceptedEvent && wakeupReason !== 'TURN') return;
  const paused = pausedWorkflowIdsOf(core);
  const waiting = tasksAwaitingContinuation(
    core.tasks.all(),
    employeeId,
    core.config.companyId,
    paused,
  );
  for (const task of waiting) {
    const count = core.taskContinuations.get(task.taskId) ?? 0;
    if (count >= MAX_TASK_CONTINUATIONS) continue;
    core.taskContinuations.set(task.taskId, count + 1);
    core.scheduler.enqueue({
      companyId: core.config.companyId,
      agentId: employeeId,
      reason: 'TURN',
      trigger: {
        kind: 'task',
        eventTypeId: 'Task.Accepted',
        refId: `${task.taskId}:continuation:${String(count + 1)}`,
      },
      sourceEventId: null,
      scheduledAtSim: (Number(simTime) + 1) as SimTime,
    });
  }
}

function payloadOf(event: OrgEvent): Readonly<Record<string, unknown>> {  return typeof event.payload === 'object' && event.payload !== null
    ? (event.payload as Readonly<Record<string, unknown>>)
    : {};
}

function readString(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

async function readEventsAfter(store: EventStore, cursor: number): Promise<readonly OrgEvent[]> {
  const collected: OrgEvent[] = [];
  for await (const event of store.replay((cursor + 1) as Seq)) {
    collected.push(event);
  }
  return collected;
}

async function readAllEvents(store: EventStore): Promise<readonly OrgEvent[]> {
  const collected: OrgEvent[] = [];
  for await (const event of store.replay(1 as Seq)) {
    collected.push(event);
  }
  return collected;
}

/**
 * `true` when the event still points at live work. While an agent is paused the cursor moves on,
 * so a deferred event may describe a task that has since been completed or an approval that has
 * since been decided; re-offering those would burn a turn on work that no longer exists.
 */
function isStillActionable(core: SimulationCore, event: OrgEvent): boolean {
  const payload = payloadOf(event);
  const taskId = readString(payload, 'taskId');
  if (taskId !== null) {
    const task = core.tasks.get(taskId);
    return task !== null && !isTerminalStatus(task.status);
  }
  if (event.type === 'Workflow.ApprovalRequested') {
    const instanceId = readString(payload, 'instanceId');
    if (instanceId === null) return false;
    const instance = core.instances.get(instanceId);
    return (
      instance !== null && instance.status === 'blocked' && instance.approval?.status === 'open'
    );
  }
  return true;
}

/**
 * Work that arrived while an employee was paused. The wakeup queue is a cache and the event log
 * is the source of truth (M1.0 §11.1), so the deferred work is re-derived from the unconsumed
 * events rather than kept in a second queue.
 */
async function deferredWorkFor(
  core: SimulationCore,
  employeeId: EmployeeId,
): Promise<
  readonly {
    readonly event: OrgEvent;
    readonly triggerKind: WakeupTriggerKind;
    readonly refId: string | null;
  }[]
> {
  const candidates: {
    event: OrgEvent;
    triggerKind: WakeupTriggerKind;
    refId: string | null;
  }[] = [];
  for (const event of await readAllEvents(core.eventStore)) {
    if (core.turnContext.isProcessed(employeeId, event.eventId)) continue;
    if (refersToDeletedWork(event, core.eligibilityDeps)) continue;
    if (!isStillActionable(core, event)) continue;
    const eligible = eligibleAgentsFor(event, core.eligibilityDeps).find(
      (entry) => entry.employeeId === employeeId,
    );
    if (eligible === undefined) continue;
    candidates.push({
      event,
      triggerKind: eligible.triggerKind,
      refId: eligible.refId ?? event.eventId,
    });
  }
  return candidates;
}

function budgetSnapshot(budget: BudgetTracker): SimulationTickResult['budget'] {
  return Object.freeze({
    ...budget.usage,
    exceeded: budget.exceeded,
    limits: budget.limits,
  });
}

function emptyPausedResult(
  config: SimulationConfig,
  scheduler: Scheduler,
  cursor: number,
): SimulationTickResult {
  return Object.freeze({
    tickNumber: scheduler.clock.currentTick,
    simTime: scheduler.clock.simTime,
    windowStartSim: scheduler.clock.simTime,
    deltaSim: config.tickDuration,
    status: 'paused' as const,
    cursorBefore: cursor,
    cursor,
    inputEventCount: 0,
    scheduledWakeupCount: 0,
    wakeupCount: 0,
    dispatchLimit: 0,
    turns: Object.freeze([]) as readonly AgentTurnRecord[],
    reactorEventCount: 0,
    emittedEvents: Object.freeze([]) as readonly OrgEvent[],
    budget: budgetSnapshot(createBudgetTracker(config.budget)),
  });
}

function reactorActor(core: SimulationCore, task: Task, event: OrgEvent): CommandActor {
  const assignee = task.assignment.assigneeEmployeeId;
  if (assignee !== null) {
    try {
      return employeeActor(
        core.identity.actorContext(assignee, event.correlationId as CorrelationId),
      );
    } catch {
      // fall through to the system actor below
    }
  }
  return systemActor('kernel-reactor', event.correlationId);
}

type StandaloneSettlement =
  | { readonly kind: 'skip' }
  | { readonly kind: 'settled'; readonly events: readonly OrgEvent[] }
  | { readonly kind: 'failed' }
  | { readonly kind: 'budget' };

/**
 * Settles a task that belongs to **no** workflow instance.
 *
 * The existing semantics for turning a submitted result into a completed task live in the
 * workflow engine: a step declares a verification rule, `evaluateVerification` judges the
 * submitted result, and on `pass` the engine's own system actor calls `TaskService.complete()`.
 * A standalone task carries that same rule on the task itself (`Task.verification`), but has no
 * workflow to settle it, so the reactor — the kernel's deterministic task-event consumer — applies
 * the identical rule. Nothing is bypassed: completion still goes through `TaskService.complete()`,
 * which enforces the task state machine, the "no self-verification" rule and the result
 * precondition; a task whose rule does not pass is simply left untouched.
 */
function settleStandaloneTask(
  core: SimulationCore,
  budget: BudgetTracker,
  simTime: SimTime,
  task: Task,
  event: OrgEvent,
): StandaloneSettlement {
  // `submitted` is the only status in which `complete` is allowed by the task state machine.
  if (task.status !== 'submitted') return { kind: 'skip' };
  const verdict = evaluateVerification(task, task.verification);
  if (verdict.kind !== 'pass') return { kind: 'skip' };
  if (!budget.tryTask()) return { kind: 'budget' };

  const completed = core.tasks.complete({
    taskId: task.taskId,
    actor: systemActor('kernel-reactor', event.correlationId),
    simTime,
    verification: task.verification,
    // M3.1: the completion is caused by the submission it judges, so a handoff's settlement
    // (`Task.HandoffCompleted`) can be walked back to the delivered result.
    causationId: event.eventId,
    traceId: event.traceId,
  });
  if (!completed.ok) return { kind: 'failed' };
  return { kind: 'settled', events: completed.value.events };
}

function runReactor(
  core: SimulationCore,
  budget: BudgetTracker,
  simTime: SimTime,
  cycleEvents: readonly OrgEvent[],
): ReactorOutcome {
  const produced: OrgEvent[] = [];
  const advancedTaskIds = new Set<string>();
  let failures = 0;

  for (const event of cycleEvents) {
    if (!REACTOR_TASK_EVENTS.has(event.type)) continue;
    const payload = payloadOf(event);
    if (event.type === 'Task.ProgressReported') {
      const phase = readString(payload, 'phase');
      if (phase === null || !SUBMIT_PHASES.has(phase)) continue;
    }
    const taskId = readString(payload, 'taskId');
    if (taskId === null || advancedTaskIds.has(taskId)) continue;

    const task = core.tasks.get(taskId);
    if (task === null) continue;

    if (task.workflowInstanceId === null) {
      // No workflow owns this task, so the kernel settles it on the task's own verification rule.
      const settlement = settleStandaloneTask(core, budget, simTime, task, event);
      if (settlement.kind === 'budget') {
        budget.markExceeded('max_tasks');
        break;
      }
      if (settlement.kind === 'skip') continue;
      advancedTaskIds.add(taskId);
      if (settlement.kind === 'failed') {
        failures += 1;
        continue;
      }
      produced.push(...settlement.events);
      continue;
    }

    const instance = core.instances.get(task.workflowInstanceId);
    if (instance === null) continue;
    if (instance.status === 'completed' || instance.status === 'aborted') continue;
    const active = instance.activeStepIds.some(
      (stepId) => instance.stepStates[stepId]?.taskId === taskId,
    );
    if (!active) continue;
    if (!budget.tryWorkflowTransition()) {
      budget.markExceeded('max_workflow_transitions');
      break;
    }
    advancedTaskIds.add(taskId);

    const operation = core.workflow.advance({
      instanceId: task.workflowInstanceId,
      actor: reactorActor(core, task, event),
      event,
      simTime,
    });
    if (!operation.ok) {
      failures += 1;
      continue;
    }
    produced.push(...operation.value.events);
  }

  return { events: produced, failures };
}

/** `waiting_for_approval: …` — the reason a hiring gate parks the original task under. */
const HIRING_WAIT_PREFIX = 'waiting_for_approval';
/** `needs_human_decision: …` — the reason a rejected hire leaves on the original task. */
const HIRING_REJECT_PREFIX = 'needs_human_decision';

function subRecord(
  record: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> {
  const value = record[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function readStringList(
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

function requesterActor(
  core: SimulationCore,
  employeeId: string,
  correlationId: string,
): CommandActor {
  try {
    return employeeActor(
      core.identity.actorContext(employeeId as EmployeeId, correlationId as CorrelationId),
    );
  } catch {
    return systemActor('kernel-hiring', correlationId);
  }
}

/**
 * A4 (`role-agents-cannot-complete-tasks.md` §9): the deterministic half of the hiring gate.
 *
 * The plan that recommends a hire only opens the gate (`hire-gate`) and parks the original
 * objectives in a blocked task; nothing about the roster moves while the root decides. This pass
 * reads the decision off the log and applies it exactly once:
 *
 * - **granted** — materialize the employee (`Control.AgentCreated`, the same fact
 *   `Agent.Create` writes, so recovery rebuilds the roster), start the deferred proposal against
 *   the roster that now holds the seat (assignment to the new employee follows from the ordinary
 *   capability router), and *retire* the held placeholder task once the resume owns its
 *   objectives — the placeholder shares the brief's `correlationId`, so leaving it open would pin
 *   the brief's progress below 100% forever.
 * - **denied** — reopen the original task with a `needs_human_decision` reason, so the board
 *   sees *why* the work stopped instead of a request that silently vanished.
 *
 * Every step is guarded by live state (employee exists, task status, resume instance exists),
 * so a replay, a re-read batch or a duplicate decision can never create a second employee, a
 * second resume or a second roster event.
 */
function runHiringGatePhase(
  core: SimulationCore,
  budget: BudgetTracker,
  simTime: SimTime,
  events: readonly OrgEvent[],
): ReactorOutcome {
  const produced: OrgEvent[] = [];
  const seen = new Set<string>();
  let failures = 0;

  for (const event of events) {
    if (event.type !== 'Workflow.ApprovalGranted' && event.type !== 'Workflow.ApprovalDenied') {
      continue;
    }
    const instanceId = readString(payloadOf(event), 'instanceId');
    if (instanceId === null || seen.has(instanceId)) continue;
    const instance = core.instances.get(instanceId);
    if (instance === null || instance.workflowId !== HIRING_WORKFLOW_ID) continue;
    seen.add(instanceId);

    const status = instance.approval?.status;
    if (status !== 'granted' && status !== 'denied') continue;

    const context = instance.context;
    const hire = subRecord(context, 'hire');
    const proposal = subRecord(context, 'proposal');
    const employeeId = readString(hire, 'employeeId');
    const positionId = readString(hire, 'positionId');
    const originalTaskId = readString(context, 'originalTaskId');
    const actor = requesterActor(core, instance.initiatedBy, event.correlationId);

    if (status === 'denied') {
      if (originalTaskId === null) continue;
      const task = core.tasks.get(originalTaskId);
      if (
        task === null ||
        task.status !== 'blocked' ||
        !(task.blockedReason ?? '').startsWith(HIRING_WAIT_PREFIX)
      ) {
        continue;
      }
      if (!budget.tryTask()) {
        budget.markExceeded('max_tasks');
        failures += 1;
        continue;
      }
      const unblocked = core.tasks.unblock({ taskId: originalTaskId, actor, simTime });
      if (!unblocked.ok) {
        failures += 1;
        continue;
      }
      produced.push(...unblocked.value.events);
      const reblocked = core.tasks.block({
        taskId: originalTaskId,
        actor,
        simTime,
        reason: `${HIRING_REJECT_PREFIX}: the root rejected the hire for ${
          positionId ?? 'the requested seat'
        }${employeeId === null ? '' : ` (${employeeId})`} — the objectives need a human decision`,
      });
      if (!reblocked.ok) {
        failures += 1;
        continue;
      }
      produced.push(...reblocked.value.events);
      continue;
    }

    if (employeeId === null || positionId === null) continue;

    const alreadyHired = core.organization.employees.some(
      (entry) => String(entry.id) === employeeId,
    );
    if (!alreadyHired) {
      const created = core.createAgent({
        employeeId,
        name: readString(hire, 'name') ?? employeeId,
        positionId,
        employeeNo: readString(hire, 'employeeNo'),
        responsibilities: readStringList(hire, 'responsibilities'),
        traits: readStringList(hire, 'traits'),
        expertise: readStringList(hire, 'expertise'),
        cognitionProfileId: readString(hire, 'cognitionProfileId'),
        templateEmployeeId: readString(hire, 'templateEmployeeId'),
        simTime,
      });
      if (!created.ok) {
        failures += 1;
      } else {
        // The roster change is a Runtime act; this event is its trace — the same split the
        // control plane's `Agent.Create` uses, so a replay rebuilds the employee instead of
        // merely remembering that a hire happened (R10).
        const agent = created.value;
        const createdEvent = createOrgEvent(
          core.registry,
          {
            companyId: core.config.companyId,
            type: CONTROL_AGENT_CREATED,
            occurredAtSim: simTime,
            actorKind: event.actorKind,
            actorId: event.actorId,
            subjectType: 'employee',
            subjectId: agent.employeeId,
            correlationId: event.correlationId,
            causationId: event.eventId,
            ...(event.traceId === undefined || event.traceId === null
              ? {}
              : { traceId: event.traceId }),
            payload: {
              commandId: `hire-${employeeId}`,
              operatorId: String(event.actorId),
              reason: readString(hire, 'reason') ?? `Root approved the hire of ${employeeId}`,
              agentId: agent.employeeId,
              name: agent.name,
              positionId: agent.positionId,
              employeeNo: agent.employeeNo,
              responsibilities: readStringList(hire, 'responsibilities'),
              traits: readStringList(hire, 'traits'),
              expertise: [...agent.expertise],
              cognitionProfileId: agent.cognitionProfileId,
              templateEmployeeId: readString(hire, 'templateEmployeeId'),
              definitionSource: agent.definitionSource,
              status: 'active',
            },
          },
          { eventIdGenerator: () => core.nextEventId() },
        );
        if (!createdEvent.ok) failures += 1;
        else produced.push(createdEvent.value);
      }
    }

    // Run the deferred proposal against the roster that now holds the seat. The id is derived
    // from the brief, so re-reading the grant finds the running resume instead of opening a
    // second one.
    const capabilities = readStringList(proposal, 'capabilities');
    if (capabilities.length === 0) continue;
    const briefRef =
      (readString(context, 'briefRef') ?? '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+/, '')
        .slice(0, 48) || 'hire';
    const resumeId = `res-${briefRef}`;
    if (core.instances.get(resumeId) === null) {
      if (!budget.tryWorkflowTransition()) {
        budget.markExceeded('max_workflow_transitions');
        failures += 1;
        continue;
      }
      const title = readString(proposal, 'title') ?? `Hire ${employeeId} for ${positionId}`;
      const goal = readString(proposal, 'goal') ?? readString(hire, 'reason') ?? title;
      const started = core.workflow.start({
        capabilities,
        actor,
        simTime,
        title: title.slice(0, 200),
        goal: goal.slice(0, 2000),
        instanceId: resumeId,
        context: { resumedFor: instanceId },
      });
      // A resume that did not start leaves the objectives where they were: the placeholder is
      // only retired below once the deferred proposal actually owns them.
      if (!started.ok) {
        failures += 1;
        continue;
      }
      produced.push(...started.value.events);
    }

    // Retire the held placeholder now that the resume owns the objectives. It shares the brief's
    // `correlationId`, so leaving it open — even unblocked, which is what this pass used to do —
    // pins the brief's progress below 100% forever while the real work runs in `resumeId`:
    // `briefProgress` counts every task under the brief's correlationId, and `briefState` only
    // reads `completion === total`. It is deleted rather than completed because the requester is
    // the task's own executor and the state machine forbids self-completion; the deletion is
    // what lets the brief reach `完成`.
    if (originalTaskId !== null) {
      const held = core.tasks.get(originalTaskId);
      if (
        held !== null &&
        ((held.blockedReason ?? '').startsWith(HIRING_WAIT_PREFIX) || held.status === 'started')
      ) {
        if (!budget.tryTask()) {
          budget.markExceeded('max_tasks');
          failures += 1;
        } else {
          const retired = core.tasks.delete({
            taskId: originalTaskId,
            actor,
            simTime,
            reason: `hiring granted: the objectives resume in "${resumeId}"; the held task is closed`,
          });
          if (retired.ok) produced.push(...retired.value.events);
          else failures += 1;
        }
      }
    }
  }

  return { events: produced, failures };
}

/**
 * Deliverability is a read model derived from `Communication.MessageSent`: recipients are only
 * woken (by `eligibleAgentsFor`) if the event is actually appended, and the same event must also
 * advance the delivery projection, otherwise the message exists in the log while the delivery
 * ledger stays empty. Delivery is idempotent and emits no events, so it cannot disturb the log.
 */
function runCommunicationDelivery(
  core: SimulationCore,
  events: readonly OrgEvent[],
): number {
  let failures = 0;
  for (const event of events) {
    if (event.type !== REACTOR_MESSAGE_EVENT) continue;
    const outcome = core.communication.deliverFromEvent(event);
    if (!outcome.ok) failures += 1;
  }
  return failures;
}

export async function runSimulationTick(
  core: SimulationCore,
  lastTickMarker: OrgEvent | null,
): Promise<TickOutcome> {
  const { config, scheduler } = core;
  const cursorBefore = core.cursor();

  if (scheduler.paused) {
    return { result: emptyPausedResult(config, scheduler, cursorBefore), tickMarker: null };
  }

  const windowStart = scheduler.clock.simTime;
  const simTime: SimTime = scheduler.tick();
  const tickNumber = scheduler.clock.currentTick;

  // On boot the heartbeat map is empty. Seed it from the durable log before the first watchdog
  // decision: an old task with a recent Task.* event must not be treated as stale merely because
  // the process was restarted, while a task whose last event is genuinely old remains actionable.
  if (!core.stallBootstrapped) {
    noteTaskActivity(core.stallHeartbeats, await readAllEvents(core.eventStore));
    core.stallBootstrapped = true;
  }

  const inputEvents = await readEventsAfter(core.eventStore, cursorBefore);
  const inputById = new Map<string, OrgEvent>(inputEvents.map((event) => [event.eventId, event]));

  const budget = createBudgetTracker(config.budget);

  const scheduledWakeups = scheduler.resolveDueScheduled(windowStart);

  const rememberSource = (wakeup: AgentWakeup, event: OrgEvent): void => {
    core.wakeupSource.set(wakeup.wakeupId, event);
  };
  const settleWakeup = (wakeupId: string, status: 'completed' | 'failed'): void => {
    scheduler.complete(wakeupId, status);
    core.wakeupSource.delete(wakeupId);
  };

  let enqueuedCount = scheduledWakeups.length;
  for (const event of inputEvents) {
    for (const eligible of eligibleAgentsFor(event, core.eligibilityDeps)) {
      const wakeup = scheduler.enqueue({
        companyId: config.companyId,
        agentId: eligible.employeeId,
        reason: 'EVENT',
        trigger: {
          kind: eligible.triggerKind,
          eventTypeId: event.type,
          refId: eligible.refId ?? event.eventId,
        },
        sourceEventId: event.eventId,
        scheduledAtSim: simTime,
      });
      rememberSource(wakeup, event);
      enqueuedCount += 1;
    }
  }

  // An operator pause defers an employee's work instead of destroying it: the cursor has moved
  // past the events that arrived while it was paused, so on resume they are re-offered here.
  for (const employeeId of core.drainResumedAgents()) {
    for (const deferred of await deferredWorkFor(core, employeeId)) {
      const wakeup = scheduler.enqueue({
        companyId: config.companyId,
        agentId: employeeId,
        reason: 'EVENT',
        trigger: {
          kind: deferred.triggerKind,
          eventTypeId: deferred.event.type,
          refId: deferred.refId,
        },
        sourceEventId: deferred.event.eventId,
        scheduledAtSim: simTime,
      });
      rememberSource(wakeup, deferred.event);
      enqueuedCount += 1;
    }
  }

  const turns: AgentTurnRecord[] = [];
  const cycleEvents: OrgEvent[] = [];
  /**
   * M3.1 message lifecycle: a recipient that ran a turn on a `Communication.MessageSent` has
   * processed it — unless the turn is going to be retried, in which case the message is still
   * pending. Emitted once per (message, recipient) by the communication service itself.
   */
  const messageProcessingEvents: OrgEvent[] = [];
  let dispatchLimit = 0;

  /**
   * The event that caused a wakeup, resolved from the log instead of guessed.
   *
   * A wakeup may be enqueued while this tick is already running: the control plane
   * appends `Control.AgentInstructed` and hands it to the scheduler from an HTTP request
   * while a background tick is in flight, so the source event is not necessarily inside
   * the input range read above. Falling back to the tick marker there would run the turn
   * against a clock event and silently swallow the instruction; reading the event by id
   * keeps the turn's input true to its cause. The marker remains the input for scheduled
   * wakeups, which have no source event by definition. The log index is built lazily, so
   * the common path (source event in the input range) still costs one map lookup.
   */
  let eventIndex: Map<string, OrgEvent> | null = null;
  const eventById = async (eventId: string): Promise<OrgEvent | undefined> => {
    if (eventIndex === null) {
      eventIndex = new Map<string, OrgEvent>();
      for (const event of await readAllEvents(core.eventStore)) {
        eventIndex.set(event.eventId, event);
      }
    }
    return eventIndex.get(eventId);
  };

  const resolveSourceEvent = async (
    wakeup: AgentWakeup,
  ): Promise<OrgEvent | undefined> => {
    const remembered = core.wakeupSource.get(wakeup.wakeupId);
    if (remembered !== undefined) return remembered;
    if (wakeup.sourceEventId !== null) {
      return inputById.get(wakeup.sourceEventId) ?? (await eventById(wakeup.sourceEventId));
    }
    return lastTickMarker ?? undefined;
  };

  for (;;) {
    if (scheduler.pending().length === 0) break;
    const available = config.budget.maxAgentTurns - budget.usage.agentTurns;
    if (available <= 0) {
      budget.markExceeded('max_agent_turns');
      break;
    }
    if (budget.remainingLlmCalls <= 0) {
      budget.markExceeded('max_llm_calls');
      break;
    }
    if (config.budget.maxEvents - budget.usage.events < 2) {
      budget.markExceeded('max_events');
      break;
    }
    if (dispatchLimit === 0) dispatchLimit = available;

    const batch = scheduler.dispatch(available);
    if (batch.length === 0) break;

    for (const wakeup of batch) {
      const bundle = core.agents.get(wakeup.agentId);
      const sourceEvent = await resolveSourceEvent(wakeup);
      if (bundle === undefined || sourceEvent === undefined) {
        settleWakeup(wakeup.wakeupId, 'failed');
        continue;
      }
      const employeeId = wakeup.agentId;
      const eventId = sourceEvent.eventId;
      // A TURN continuation exists precisely because the prior turn already consumed the task
      // event; it is a synthetic follow-up, not a replay, so the processed-event guard must not
      // suppress it (otherwise two continuations scheduled in the same tick would collapse).
      if (wakeup.reason !== 'TURN' && core.turnContext.isProcessed(employeeId, eventId)) {
        settleWakeup(wakeup.wakeupId, 'completed');
        continue;
      }
      // The work this wakeup was queued for may have been deleted since. Nothing to act on:
      // settle the wakeup rather than run a turn that would report against a missing task.
      if (refersToDeletedWork(sourceEvent, core.eligibilityDeps)) {
        core.turnContext.markProcessed(employeeId, eventId);
        turns.push({
          wakeupId: wakeup.wakeupId,
          cycleId: '-',
          employeeId,
          sourceEventId: eventId,
          reason: wakeup.reason,
          status: 'ignored',
          retryable: false,
          llmCalls: 0,
          emittedEventCount: 0,
          failureCode: 'work_deleted',
        });
        settleWakeup(wakeup.wakeupId, 'completed');
        continue;
      }
      if (!budget.tryAgentTurn()) {
        budget.markExceeded('max_agent_turns');
        settleWakeup(wakeup.wakeupId, 'failed');
        continue;
      }

      let actorContext: ActorContext;
      try {
        actorContext = core.identity.actorContext(
          employeeId,
          sourceEvent.correlationId as CorrelationId,
        );
      } catch {
        turns.push({
          wakeupId: wakeup.wakeupId,
          cycleId: '-',
          employeeId,
          sourceEventId: eventId,
          reason: wakeup.reason,
          status: 'failed',
          retryable: false,
          llmCalls: 0,
          emittedEventCount: 0,
          failureCode: 'UNKNOWN_EMPLOYEE',
        });
        settleWakeup(wakeup.wakeupId, 'failed');
        continue;
      }

      const stateBefore = core.stateStore.load(employeeId);
      const assignedTasks = assignedTasksOf(core, employeeId);
      const openTaskIds = openTaskIdsOf(assignedTasks);
      // Explicit heartbeat: a live model can spend a long turn reasoning before it emits its
      // first Task.* event. That turn is real work, not a stall.
      noteTaskHeartbeat(core.stallHeartbeats, openTaskIds, simTime, 'inference');
      const basePlanExecutor = core.planExecutorFactory(budget);
      const planExecutor: PlanExecutor = {
        async execute(step, context) {
          noteTaskHeartbeat(core.stallHeartbeats, openTaskIds, simTime, 'tool');
          const result = await basePlanExecutor.execute(step, context);
          noteTaskHeartbeat(core.stallHeartbeats, openTaskIds, simTime, 'tool');
          return result;
        },
      };
      // Read once per cycle: the prompt must describe the conversation the agent can act on, and
      // an agent in no channel gets no `communication` at all (the prompt then renders nothing).
      const communicationView = communicationViewOf(core.communication, employeeId);
      const outcome = await runAgentCycle({
        agent: { ...bundle.instance, state: stateBefore },
        state: stateBefore,
        actorContext,
        event: sourceEvent,
        simTime,
        registry: core.registry,
        turnContext: core.turnContext,
        cycleId: core.nextCycleId(),
        requestId: core.nextRequestId(),
        wakeReason: wakeup.reason,
        executor: core.cognition,
        definition: bundle.definition,
        profile: bundle.profile,
        organization: organizationSnapshotView(core.organization, employeeId),
        assignedTasks,
        ...(communicationView === undefined ? {} : { communication: communicationView }),
        workCatalog: workCatalogView(
          {
            organization: core.organization,
            tasks: core.tasks,
            definitions: core.definitions,
            instances: core.instances,
            authz: core.authz,
          },
          actorContext,
        ),
        planExecutor,
        maxLlmCalls: budget.remainingLlmCalls,
        maxEmittedEvents: Math.max(2, config.budget.maxEvents - budget.usage.events),
      });

      if (!outcome.ok) {
        core.turnContext.markProcessed(employeeId, eventId);
        turns.push({
          wakeupId: wakeup.wakeupId,
          cycleId: '-',
          employeeId,
          sourceEventId: eventId,
          reason: wakeup.reason,
          status: 'failed',
          retryable: false,
          llmCalls: 0,
          emittedEventCount: 0,
          failureCode: outcome.error.code,
        });
        settleWakeup(wakeup.wakeupId, 'failed');
        continue;
      }

      const cycle = outcome.value;
      budget.tryLlmCalls(cycle.llmCalls);
      budget.tryEvents(cycle.emittedEvents.length);
      cycleEvents.push(...cycle.emittedEvents);

      const committed = core.stateStore.commit(cycle.stateAfter, cycle.stateBefore.version);
      if (!committed.ok) {
        core.turnContext.markProcessed(employeeId, eventId);
        turns.push({
          wakeupId: wakeup.wakeupId,
          cycleId: cycle.cycleId,
          employeeId,
          sourceEventId: eventId,
          reason: wakeup.reason,
          status: 'failed',
          retryable: false,
          llmCalls: cycle.llmCalls,
          emittedEventCount: cycle.emittedEvents.length,
          failureCode: committed.error.code,
        });
        settleWakeup(wakeup.wakeupId, 'failed');
        continue;
      }

      noteTaskActivity(core.stallHeartbeats, cycle.emittedEvents);
      noteTaskHeartbeat(core.stallHeartbeats, openTaskIds, simTime, 'idle');
      clearContinuationCounts(core, cycle.emittedEvents);
      scheduleTaskContinuation(core, employeeId, simTime, cycle.emittedEvents, wakeup.reason);

      const retryableFailure =
        cycle.retryable &&
        cycle.failure !== null &&
        cycle.failure.code !== 'budget_exceeded';
      let attempt = 0;
      let willRetry = false;
      if (retryableFailure) {
        attempt = core.bumpRetry(employeeId, eventId);
        willRetry = attempt <= config.maxRetries;
      }

      if (willRetry) {
        scheduler.enqueue({
          companyId: config.companyId,
          agentId: employeeId,
          reason: 'RETRY',
          trigger: {
            kind: 'event',
            eventTypeId: sourceEvent.type,
            refId: `${eventId}:${String(attempt)}`,
          },
          sourceEventId: eventId,
          scheduledAtSim: simTime,
        });
      } else {
        core.turnContext.markProcessed(employeeId, eventId);
        core.resetRetry(employeeId, eventId);
      }

      // A message is "processed" once the recipient's turn on it has settled (no retry pending).
      // The outcome is the turn's own: a failed non-retryable turn is a real processing failure
      // and is recorded as one, rather than silently leaving the message at "delivered".
      if (sourceEvent.type === REACTOR_MESSAGE_EVENT && !willRetry) {
        const messagePayload = payloadOf(sourceEvent);
        const messageId = readString(messagePayload, 'messageId');
        const recipients = messagePayload['recipientIds'];
        const isRecipient =
          Array.isArray(recipients) && recipients.includes(String(employeeId));
        if (messageId !== null && isRecipient) {
          const processed = core.communication.markProcessed({
            messageId,
            recipientId: employeeId,
            outcome: cycle.status === 'failed' ? 'failed' : 'handled',
            simTime,
            correlationId: sourceEvent.correlationId as CorrelationId,
            causationId: sourceEvent.eventId,
            traceId: sourceEvent.traceId,
          });
          if (processed.ok && processed.value !== null) {
            messageProcessingEvents.push(processed.value.event);
          }
        }
      }

      turns.push({
        wakeupId: wakeup.wakeupId,
        cycleId: cycle.cycleId,
        employeeId,
        sourceEventId: eventId,
        reason: cycle.reason,
        status: cycle.status,
        retryable: willRetry,
        llmCalls: cycle.llmCalls,
        emittedEventCount: cycle.emittedEvents.length,
        failureCode: cycle.failure === null ? null : cycle.failure.code,
      });
      settleWakeup(wakeup.wakeupId, 'completed');
    }
  }

  // --- stall watchdog -------------------------------------------------------
  // An open task that saw no activity for STALL_THRESHOLD_TICKS is acted on here: started
  // tasks are failed (legal transition, the executor's own terminal act), accepted-but-never
  // started tasks are rejected (the closest transition the state machine permits). The task
  // events produced are consumed by the reactor in this tick, so the workflow settles the
  // step instead of leaving it active forever.
  noteTaskActivity(core.stallHeartbeats, [...inputEvents, ...cycleEvents]);
  const pausedWorkflowIds = pausedWorkflowIdsOf(core);
  const stallActions = stalledTasks(
    core.tasks.all(),
    core.stallHeartbeats,
    String(config.companyId),
    simTime,
    STALL_THRESHOLD_TICKS,
    { pausedWorkflowIds },
  );
  const stallEvents: OrgEvent[] = [];
  let stallFailures = 0;
  for (const action of stallActions) {
    if (!budget.tryTask()) {
      stallFailures += 1;
      break;
    }
    const actor = systemActor('kernel-watchdog', `corr-stall-${String(simTime)}-${action.taskId}`);
    const outcome =
      action.action === 'reject'
        ? core.tasks.reject({ taskId: action.taskId, actor, simTime, reason: action.reason })
        : core.tasks.fail({ taskId: action.taskId, actor, simTime, reason: action.reason });
    if (!outcome.ok) {
      stallFailures += 1;
      continue;
    }
    noteTaskActivity(core.stallHeartbeats, outcome.value.events);
    stallEvents.push(...outcome.value.events);
  }

  for (const wakeup of scheduler.queue()) {
    if (wakeup.status !== 'pending' || wakeup.reason !== 'RETRY') continue;
    scheduler.cancel(wakeup.wakeupId);
    core.wakeupSource.delete(wakeup.wakeupId);
    if (wakeup.sourceEventId !== null) {
      core.turnContext.markProcessed(wakeup.agentId, wakeup.sourceEventId);
    }
    core.resetRetry(wakeup.agentId, wakeup.sourceEventId ?? '');
  }

  const reactor = runReactor(core, budget, simTime, [...cycleEvents, ...stallEvents]);
  // A4: a hiring decision arrives as an event — appended by the console (seen as an input event
  // on a later tick) or voted by an agent in this tick's cycle events. The pass applies it
  // deterministically; it is idempotent, so re-read batches and replays never double-apply.
  const hiring = runHiringGatePhase(core, budget, simTime, [...inputEvents, ...cycleEvents]);
  // Delivery follows the message wherever it entered the log: an agent turn (this tick's cycle
  // events) or anything else that appended `Communication.MessageSent` (an injected or recovered
  // event). It is idempotent, so re-seeing a message never duplicates a delivery record.
  const deliveryFailures = runCommunicationDelivery(core, [...inputEvents, ...cycleEvents]);

  const batch: OrgEvent[] = [
    ...cycleEvents,
    ...stallEvents,
    ...reactor.events,
    ...hiring.events,
    ...messageProcessingEvents,
  ];
  const cursor = cursorBefore + inputEvents.length;

  const budgetExceeded = budget.exceeded.length > 0;
  const turnFailures = turns.filter((turn) => turn.status === 'failed').length;
  const status: SimulationTickStatus = budgetExceeded
    ? 'budget_exceeded'
    : turnFailures > 0 || stallFailures > 0 || reactor.failures > 0 || hiring.failures > 0 || deliveryFailures > 0
      ? 'partial_failure'
      : enqueuedCount === 0 && turns.length === 0 && reactor.events.length === 0 && hiring.events.length === 0 && messageProcessingEvents.length === 0
        ? 'idle'
        : 'ok';

  const marker = createOrgEvent(
    core.registry,
    {
      companyId: config.companyId,
      type: SYSTEM_SIM_CLOCK_TICKED,
      occurredAtSim: simTime,
      actorKind: 'system',
      actorId: 'kernel-scheduler',
      subjectType: 'system',
      subjectId: String(config.companyId),
      correlationId: `corr-tick-${String(tickNumber)}`,
      payload: {
        tickNumber,
        simTime: Number(simTime),
        windowStartSim: Number(windowStart),
        deltaSim: config.tickDuration,
        status,
        cursorSeq: cursor,
        inputEventCount: inputEvents.length,
        wakeupCount: enqueuedCount,
        turnCount: turns.length,
        emittedCount: batch.length + 1,
      },
    },
    { eventIdGenerator: () => core.nextEventId() },
  );
  if (!marker.ok) {
    throw new Error(
      `tick marker contract violation: ${marker.error.issues
        .map((issue) => `${issue.field}: ${issue.reason}`)
        .join(', ')}`,
    );
  }

  const fullBatch: readonly OrgEvent[] = Object.freeze([...batch, marker.value]);
  const watermark = await core.eventStore.append(fullBatch);
  core.flushProcessedMarks();
  core.eventStore.commitOffset(config.consumerGroup, config.companyId, watermark);

  const result: SimulationTickResult = Object.freeze({
    tickNumber,
    simTime,
    windowStartSim: windowStart,
    deltaSim: config.tickDuration,
    status,
    cursorBefore,
    cursor,
    inputEventCount: inputEvents.length,
    scheduledWakeupCount: scheduledWakeups.length,
    wakeupCount: enqueuedCount,
    dispatchLimit,
    turns: Object.freeze(turns),
    reactorEventCount: reactor.events.length,
    emittedEvents: fullBatch,
    budget: budgetSnapshot(budget),
  });

  return { result, tickMarker: marker.value };
}
