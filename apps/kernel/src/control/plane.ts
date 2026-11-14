import type { EmployeeId, OrgEvent } from '@maoeh/shared-types';
import type { AuditRecord, AuditService } from '@maoeh/audit-system';
import { createAuditService } from '@maoeh/audit-system';
import type { AuthorityService } from '@maoeh/authority-engine';
import { createAuthorityService } from '@maoeh/authority-engine';
import type { EventRegistry } from '@maoeh/event-system';
import type { EventStore, Seq } from '@maoeh/event-store';
import type {
  AgentStateView,
  AuditPort,
  AuditPortRecord,
  AuditView,
  ControlPlane,
  ControlSimulationPort,
  SimulationSnapshot,
} from '@maoeh/organization-control';
import { createControlService } from '@maoeh/organization-control';
import type { AuthzService } from '@maoeh/permission-system';
import { isTerminalStatus } from '@maoeh/task-system';

import type { Simulation } from '../simulation/simulation.js';

export interface KernelControlPlaneOptions {
  readonly simulation: Simulation;
  readonly authz: AuthzService;
  readonly authority?: AuthorityService;
  readonly registry: EventRegistry;
  readonly eventStore: EventStore;
  readonly audit?: AuditPort;
  readonly auditService?: AuditService;
  readonly eventIdGenerator?: () => string;
}

export interface KernelControlPlane {
  readonly control: ControlPlane;
  readonly port: ControlSimulationPort;
  readonly audit: AuditPort;
}

/**
 * Adapts `@maoeh/audit-system`'s record shape to the control plane's read view.
 * Audit stays a log: this adapter adds no semantics of its own.
 */
export function createAuditPortAdapter(service: AuditService): AuditPort {
  const view = (record: AuditRecord): AuditView =>
    Object.freeze({
      auditId: record.auditId,
      actorKind: record.actorKind,
      actorId: record.actorId,
      actionType: record.action.type,
      actionResource: record.action.resource,
      reason: record.action.reason,
      verdict: record.verdict,
      commandId: record.commandId,
      correlationId: record.correlationId,
      causationId: record.causationId,
      resultCode: record.resultCode,
      eventIds: Object.freeze([...record.eventIds]),
      createdAtSim: record.createdAtSim,
      ...(record.details === undefined ? {} : { details: record.details }),
    });

  return {
    record(input: AuditPortRecord): AuditView {
      return view(
        service.record({
          actorKind: input.actorKind,
          actorId: input.actorId,
          action: {
            type: input.actionType,
            reason: input.actionReason,
            resource: input.actionResource,
          },
          target: { targetType: input.targetType, targetId: input.targetId },
          verdict: input.verdict,
          commandId: input.commandId,
          correlationId: input.correlationId,
          causationId: input.causationId,
          resultCode: input.resultCode,
          eventIds: input.eventIds,
          createdAtSim: input.createdAtSim,
          details: input.details,
        }),
      );
    },
    find(commandId) {
      const record = service.find(commandId);
      return record === null ? null : view(record);
    },
    trail(targetId) {
      return Object.freeze(service.trail(targetId).map(view));
    },
    recent(limit) {
      return Object.freeze(
        (limit === undefined ? service.recent() : service.recent(limit)).map(view),
      );
    },
    forCorrelation(correlationId) {
      return Object.freeze(service.forCorrelation(correlationId).map(view));
    },
  };
}

function agentStateView(
  simulation: Simulation,
  employeeId: EmployeeId,
  paused: boolean,
): AgentStateView | null {
  const bundle = simulation.agents.get(employeeId);
  if (bundle === undefined) return null;
  const state = simulation.stateStore.load(employeeId);
  return Object.freeze({
    employeeId,
    version: state.version,
    employment: state.employment,
    presence: state.presence,
    currentCycleId: state.currentCycleId,
    focus: state.focus,
    updatedAtSim: Number(state.updatedAtSim),
    paused,
  });
}

function currentTaskIds(simulation: Simulation): ReadonlyMap<EmployeeId, string> {  const map = new Map<EmployeeId, string>();
  for (const task of simulation.taskStore.all()) {
    if (isTerminalStatus(task.status)) continue;
    const assignee = task.assignment.assigneeEmployeeId;
    if (assignee === null || map.has(assignee)) continue;
    map.set(assignee, task.taskId);
  }
  return map;
}

/**
 * Composition root. The Control Plane never reaches into runtime state itself: this adapter
 * is the only bridge, and it exposes nothing beyond `ControlSimulationPort`.
 */
export function createKernelControlPlane(options: KernelControlPlaneOptions): KernelControlPlane {
  const { simulation, registry, eventStore } = options;
  const audit: AuditPort =
    options.audit ??
    createAuditPortAdapter(options.auditService ?? createAuditService());
  const companyId = String(simulation.config.companyId);
  const authority = options.authority ?? createAuthorityService(simulation.organization);

  /**
   * Operator pause overlay. Tracked explicitly (not derived from the AI agent roster) so a
   * human or agent-less employee can be paused too, and so the port never mutates `AgentState`.
   */
  const pausedAgents = new Set<EmployeeId>(simulation.pausedAgentIds());

  let lastTickStatus: string | null = null;
  let lastTickExceeded: readonly string[] = Object.freeze([]);

  const snapshot = (): SimulationSnapshot => {
    const versions = new Map<EmployeeId, number>();
    for (const employeeId of simulation.agents.keys()) {
      versions.set(employeeId, simulation.stateStore.load(employeeId).version);
    }
    return Object.freeze({
      companyId,
      tick: simulation.scheduler.clock.currentTick,
      simTime: Number(simulation.scheduler.clock.simTime),
      tickDuration: simulation.config.tickDuration,
      paused: simulation.scheduler.paused,
      budgets: {
        maxAgentTurns: simulation.config.budget.maxAgentTurns,
        maxEvents: simulation.config.budget.maxEvents,
        maxTasks: simulation.config.budget.maxTasks,
        maxWorkflowTransitions: simulation.config.budget.maxWorkflowTransitions,
        maxLlmCalls: simulation.config.budget.maxLlmCalls,
      },
      lastTickStatus: lastTickStatus ?? simulation.lastTickResult?.status ?? null,
      lastTickExceeded:
        lastTickExceeded.length > 0
          ? lastTickExceeded
          : (simulation.lastTickResult?.budget.exceeded ?? Object.freeze([])),
      /**
       * Actionable depth, not record count: `queue()` keeps completed/failed/cancelled
       * records forever (only `complete()`/`cancel()` flip their status), so a raw length
       * would pin the console's queue metric to the historical total and hide the idle
       * state the operator needs to see.
       */
      queueDepth: simulation.scheduler
        .queue()
        .filter((wakeup) => wakeup.status === 'pending' || wakeup.status === 'dispatched')
        .length,
      pendingWakeups: simulation.scheduler.pending().length,
      recovery: Object.freeze({ ...simulation.recovery }),
      agentStateVersions: versions,
      currentTaskIds: currentTaskIds(simulation),
    });
  };

  const port: ControlSimulationPort = {
    snapshot,
    async start() {
      // A paused simulation resumes on Start; a running one is simply ticked once, which is
      // what "start the simulation" means for an already-constructed M0.9 kernel.
      simulation.resume();
      const result = await simulation.tick();
      lastTickStatus = result.status;
      lastTickExceeded = result.budget.exceeded;
      return { status: result.status, tick: result.tickNumber };
    },
    pause() {
      simulation.pause();
    },
    resume() {
      simulation.resume();
    },
    async step() {
      const wasPaused = simulation.scheduler.paused;
      if (wasPaused) simulation.resume();
      const result = await simulation.tick();
      if (wasPaused) simulation.pause();
      lastTickStatus = result.status;
      lastTickExceeded = result.budget.exceeded;
      return {
        status: result.status,
        tick: result.tickNumber,
        paused: simulation.scheduler.paused,
      };
    },
    seek(tickNumber) {
      simulation.seek(tickNumber);
    },
    isAgentPaused(employeeId) {
      return pausedAgents.has(employeeId);
    },
    setAgentPaused(employeeId, paused) {
      if (paused) pausedAgents.add(employeeId);
      else pausedAgents.delete(employeeId);
      simulation.restorePausedAgents([...pausedAgents]);
    },
    // M1.3 agent lifecycle: the Control Plane asks, the Runtime places / retires the agent.
    // Nothing here writes domain state — the composition root is the only bridge.
    createAgent(request) {
      return simulation.createAgent(request);
    },
    archiveAgent(employeeId) {
      return simulation.archiveAgent(employeeId);
    },
    wakeAgent(employeeId, sourceEventId, refId) {
      // Reuse the existing scheduler rather than inventing a delivery path. `MANUAL` already
      // exists as a wakeup reason; `sourceEventId` makes the instruction the turn's input event,
      // so the existing idempotency marks and cycle machinery apply unchanged.
      simulation.scheduler.enqueue({
        companyId: simulation.config.companyId,
        agentId: employeeId,
        reason: 'MANUAL',
        trigger: { kind: 'manual', refId },
        sourceEventId,
        scheduledAtSim: simulation.scheduler.clock.simTime,
      });
    },    agentState(employeeId) {
      return agentStateView(simulation, employeeId, pausedAgents.has(employeeId));
    },
    organization() {
      return simulation.organization;
    },
    tasks() {
      return simulation.taskStore.all();
    },
    task(taskId) {
      return simulation.taskStore.get(taskId);
    },
    workflows() {
      return simulation.instanceStore.all();
    },
    workflow(instanceId) {
      return simulation.instanceStore.get(instanceId);
    },
    /** M1.8: the definition behind an instance, for the canvas projection. */
    workflowDefinition(workflowId) {
      return simulation.definitions.get(workflowId);
    },
    tickDuration: simulation.config.tickDuration,
  };

  const control = createControlService({
    companyId,
    identity: simulation.identity,
    authz: options.authz,
    authority,
    registry,
    eventStore,
    audit,
    simulation: port,
    tasks: simulation.tasks,
    workflow: simulation.workflow,
    eventIdGenerator:
      options.eventIdGenerator ?? (() => `ctrl-evt-${String(nextControlEventSeq())}`),
  });

  return { control, port, audit };
}

let controlEventSeq = 0;
function nextControlEventSeq(): number {
  controlEventSeq += 1;
  return controlEventSeq;
}

const CONTROL_EVENT_ID = /^ctrl-evt-(\d+)$/;

/**
 * Raise the control-event counter above every `ctrl-evt-N` already in the log.
 *
 * The counter is process-local, so on restart it starts at 0 again and the first commands would
 * reuse ids that already exist. The event store rejects duplicate event ids, so a restarted
 * kernel refused every command until it climbed past the recovered range — which is why "start
 * work" failed right after a restart. Recovery seeds the counter past the log so ids stay unique.
 */
function seedControlEventSeq(events: readonly OrgEvent[]): void {
  for (const event of events) {
    const match = CONTROL_EVENT_ID.exec(event.eventId);
    if (match === null) continue;
    const seq = Number(match[1]);
    if (seq > controlEventSeq) controlEventSeq = seq;
  }
}

/** Replay `Control.*` events into the control plane's projection (used after recovery). */
export async function hydrateControlPlane(
  control: ControlPlane,
  eventStore: EventStore,
): Promise<void> {
  const collected: OrgEvent[] = [];
  for await (const event of eventStore.replay(1 as Seq)) collected.push(event);
  seedControlEventSeq(collected);
  control.hydrate(collected);
}

/**
 * Accepted control events are named after their command; this is the inverse map that makes
 * the audit trail replayable from the event log alone (no second event source).
 */
const COMMAND_BY_ACCEPTED_EVENT: Readonly<Record<string, string>> = Object.freeze({
  'Control.SimulationStarted': 'Simulation.Start',
  'Control.SimulationPaused': 'Simulation.Pause',
  'Control.SimulationResumed': 'Simulation.Resume',
  'Control.SimulationStepped': 'Simulation.Step',
  'Control.SimulationSought': 'Simulation.Seek',
  'Control.AgentCreated': 'Agent.Create',
  'Control.AgentArchived': 'Agent.Archive',
  'Control.AgentPaused': 'Agent.Pause',
  'Control.AgentResumed': 'Agent.Resume',
  'Control.AgentInstructed': 'Agent.Instruct',
  'Control.AgentTaskCancelled': 'Agent.CancelTask',
  'Control.AgentReviewRequested': 'Agent.RequestReview',
  'Control.WorkflowCancelled': 'Workflow.Cancel',
  'Control.WorkflowDeleted': 'Workflow.Delete',
  'Control.WorkflowApprovalDecided': 'Workflow.Approve',
  'Control.WorkflowInstanceAssignmentOverridden': 'Workflow.InstanceAssignmentOverride',
  'Control.WorkflowInstanceConfirmed': 'Workflow.ConfirmStart',
  'Control.TaskCancelled': 'Task.Cancel',
  'Control.TaskDeleted': 'Task.Delete',
  'Control.TaskReassigned': 'Task.Reassign',
  'Control.TaskReviewRequested': 'Task.RequestReview',
  'Control.TaskInjected': 'Organization.InjectTask',
  'Control.WorkBriefed': 'Work.SubmitBrief',
  'Control.EventInjected': 'Organization.InjectEvent',
});

function payloadOf(event: OrgEvent): Readonly<Record<string, unknown>> {
  return typeof event.payload === 'object' && event.payload !== null
    ? (event.payload as Readonly<Record<string, unknown>>)
    : {};
}

function payloadString(event: OrgEvent, key: string): string {
  const value = payloadOf(event)[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Rebuild the audit trail from `Control.*` events. Used by the composition root on startup so
 * that command idempotency and the audit trail survive a restart, with the event log remaining
 * the single source of truth (BASELINE §14: audit is a log, not a second EventStore).
 */
export function rebuildAuditFromEvents(
  audit: AuditPort,
  events: readonly OrgEvent[],
): void {
  const seen = new Set<string>();

  for (const event of events) {
    const commandId = payloadString(event, 'commandId');
    if (commandId === '') continue;
    // One audit record per command; the first (acceptance) event wins, matching the
    // live-path contract where every command records exactly one row.
    if (seen.has(commandId)) continue;

    const isRejection = event.type === 'Control.CommandRejected';
    const commandType = isRejection
      ? payloadString(event, 'commandType')
      : (COMMAND_BY_ACCEPTED_EVENT[event.type] ?? '');
    if (commandType === '') continue;

    const targetId = payloadString(event, 'targetId') || String(event.subjectId ?? '');
    const targetType = payloadString(event, 'targetType') || String(event.subjectType ?? '');
    const resource = targetType === '' ? `resource:${targetId}` : `${targetType}:${targetId}`;
    const issues = isRejection ? payloadOf(event)['issues'] : null;

    audit.record({
      actorKind: event.actorKind,
      actorId: event.actorId,
      actionType: commandType,
      actionReason: payloadString(event, 'reason'),
      actionResource: resource,
      targetType,
      targetId,
      verdict: isRejection ? 'rejected' : 'accepted',
      commandId,
      correlationId: event.correlationId,
      causationId: event.causationId,
      resultCode: isRejection ? payloadString(event, 'resultCode') : null,
      eventIds: [event.eventId],
      createdAtSim: Number(event.occurredAtSim),
      details: {
        ...(event.type === 'Control.WorkflowApprovalDecided'
          ? { decision: payloadString(event, 'decision') }
          : {}),
        ...(isRejection && Array.isArray(issues) ? { issues } : {}),
        replayedFromEvent: true,
      },
    });
    seen.add(commandId);
  }
}

/**
 * The composition root's recovery step: rebuild the audit trail from the event log and let the
 * control plane restore its projection (paused simulation, paused agents).
 */
export async function recoverControlPlane(
  control: ControlPlane,
  audit: AuditPort,
  eventStore: EventStore,
): Promise<void> {
  const collected: OrgEvent[] = [];
  for await (const event of eventStore.replay(1 as Seq)) collected.push(event);
  seedControlEventSeq(collected);
  rebuildAuditFromEvents(audit, collected);
  control.hydrate(collected);
}
