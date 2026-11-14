import type { EmployeeId, OrgEvent, PositionId } from '@maoeh/shared-types';
import type { EventStore, Seq } from '@maoeh/event-store';
import type { EventAggregate } from '@maoeh/event-system';
import type { Organization } from '@maoeh/organization-model';
import { createOrgGraph, resolveCapabilityAssignments } from '@maoeh/organization-model';
import type { Task } from '@maoeh/task-system';
import { TASK_CREATED, TASK_DELETED } from '@maoeh/task-system';
import { DRAFT_CONTEXT_KEY, WORKFLOW_INSTANCE_DELETED, assignmentOverridesOf } from '@maoeh/workflow-engine';
import type { WorkflowInstance } from '@maoeh/workflow-engine';
import type { WorkflowCanvasStepView } from './types.js';

import { agentLifecycleOf } from './agent-lifecycle.js';
import {
  CONTROL_TASK_DELETED,
  CONTROL_WORK_BRIEFED,
  CONTROL_WORKFLOW_DELETED,
} from './events.js';
import type {
  AgentActivity,
  AgentActivityEntry,
  AgentStateView,
  AgentSummary,
  AuditRecordLike,
  AuditTargetClaim,
  AuditTrailEntry,
  AuditView,
  ControlSimulationPort,
  ControlState,
  DepartmentSummary,
  EmployeeSummary,
  EventStreamFilter,
  EventView,
  OrganizationSnapshot,
  PendingApprovalView,
  PositionSummary,
  SimulationStateView,
  TaskSummary,
  TaskView,
  WorkBriefItemView,
  WorkBriefView,
  WorkflowSummary,
  WorkflowView,
} from './types.js';

export interface AuditReader {
  recent(limit?: number): readonly AuditView[];
  find(commandId: string): AuditView | null;
  trail(targetId: string): readonly AuditView[];
  forCorrelation(correlationId: string): readonly AuditView[];
}

/**
 * Read model / projection / query. Never writes, never calls an LLM
 * (BASELINE §14; 01-overview §1.4 rule 1: the read side never writes).
 */
export interface ControlQuery {
  getOrganizationSnapshot(): Promise<OrganizationSnapshot>;
  getSimulationState(): SimulationStateView;
  getDepartments(): readonly DepartmentSummary[];
  getEmployees(): readonly EmployeeSummary[];
  getAgents(): readonly AgentSummary[];
  getAgent(agentId: EmployeeId): AgentSummary | null;
  getAgentRuntimeState(agentId: EmployeeId): AgentStateView | null;
  getAgentActivity(agentId: EmployeeId, limit?: number): Promise<AgentActivity>;
  getWorkflows(): readonly WorkflowSummary[];
  getWorkflow(instanceId: string): WorkflowView | null;
  getTasks(): readonly TaskSummary[];
  getTask(taskId: string): TaskView | null;
  /**
   * M1.4 work briefs (任务书): every `Control.WorkBriefed`, oldest-first, each carrying the
   * tasks that share its `correlationId` — the decomposition the briefed agent produced
   * (§5.4: grouped from the log, no new events and no new tables).
   *
   * Asynchronous because `EventStore.replay` is an async stream — the one deliberate
   * deviation from this otherwise-synchronous read side.
   */
  listWorkBriefs(): Promise<readonly WorkBriefView[]>;
  /** One brief by its `briefId`, or `null`. */
  getWorkBrief(briefId: string): Promise<WorkBriefView | null>;
  /**
   * The operator-facing activity view: newest-first "what just happened".
   *
   * `BACKGROUND_EVENT_TYPE_PREFIXES` is held back by default, because one
   * `System.SimClockTicked` marker per tick otherwise drowns the company's own events in
   * the same `limit` window. A caller that narrows the query itself (`eventTypes` /
   * `eventTypePrefix`) or states `excludeEventTypePrefixes` explicitly — `[]` means "show
   * everything" — keeps full control; the events are never removed from the store.
   *
   * Work the log records as removed is held back the same way: `includeDeleted: true` is the
   * escape hatch that brings a deleted task's or instance's history — tombstones included —
   * back into the feed.
   */
  getRecentEvents(filter?: EventStreamFilter): Promise<readonly EventView[]>;
  /**
   * The complete append-only log, oldest-first. Nothing is held back here: this is the
   * raw read side used for audits, pagination and recovery-style inspection. It only masks
   * removed work when a caller says so with `includeDeleted: false`.
   */
  getEventStream(filter: EventStreamFilter): Promise<readonly EventView[]>;
  getAuditTrail(resourceId: string): AuditTrailEntry[];
  getRecentAudits(limit?: number): readonly AuditView[];
  /**
   * Commands the existing permission/authority machinery answered with `NEEDS_APPROVAL`.
   * This is the human approval entry point (M1.0 §7) — derived from the audit trail, which
   * itself is replayable from `Control.CommandRejected` events.
   */
  getPendingApprovals(): readonly PendingApprovalView[];
  getControlState(): ControlState;
}

export interface ControlQueryOptions {
  readonly companyId: string;
  readonly organization: Organization;
  readonly simulation: ControlSimulationPort;
  readonly eventStore: EventStore;
  readonly audit: AuditReader;
  readonly controlState: () => ControlState;
}

const RUNTIME_PREFIX = 'Runtime.';
const COMMUNICATION_PREFIX = 'Communication.';
const TASK_PREFIX = 'Task.';
const WORKFLOW_PREFIX = 'Workflow.';
const CONTROL_PREFIX = 'Control.';

/**
 * Aggregates that carry simulation telemetry instead of company activity: one
 * `System.SimClockTicked` marker is appended per tick, so inside any fixed `limit` window
 * they drown out everything the organization actually did.
 *
 * Read-side default only. Nothing is deleted or suppressed at the source — the marker is
 * still appended, `EventStore.replay` still returns it, and `getEventStream` still serves
 * the complete log.
 */
const BACKGROUND_AGGREGATES: readonly EventAggregate[] = Object.freeze(['System']);

export const BACKGROUND_EVENT_TYPE_PREFIXES: readonly string[] = Object.freeze(
  BACKGROUND_AGGREGATES.map((aggregate) => `${aggregate}.`),
);

/**
 * Default of `getRecentEvents`. A caller that narrows the query themselves, or states an
 * exclusion explicitly (`[]` = raw view), already said what they want and is obeyed
 * verbatim — that is how `/api/events?prefix=System.` still reaches the tick markers.
 */
function activityFilter(filter: EventStreamFilter): EventStreamFilter {
  const callerDecides =
    filter.excludeEventTypePrefixes !== undefined ||
    filter.eventTypes !== undefined ||
    filter.eventTypePrefix !== undefined;
  return callerDecides
    ? filter
    : { ...filter, excludeEventTypePrefixes: BACKGROUND_EVENT_TYPE_PREFIXES };
}

/**
 * The four events that take work out of the organization: the domain facts, and the control
 * events recording who asked for them. Together they are the whole record of "this no longer
 * exists" — a `Task.Cancelled` or a `Workflow.InstanceAborted` leaves the record in place and
 * is therefore never masked.
 */
export const DELETION_EVENT_TYPES: readonly string[] = Object.freeze([
  TASK_DELETED,
  WORKFLOW_INSTANCE_DELETED,
  CONTROL_TASK_DELETED,
  CONTROL_WORKFLOW_DELETED,
]);

/** Payload keys that name the work an event belongs to: a task or a workflow instance. */
const OWNED_ID_KEYS: readonly string[] = Object.freeze(['taskId', 'instanceId', 'targetId']);
/** Payload keys holding a list of tasks — `Workflow.InstanceDeleted.taskIds`. */
const OWNED_ID_LIST_KEYS: readonly string[] = Object.freeze(['taskIds']);

/** Collects the ids a deletion removed, from its payload and from the subject it names. */
function noteDeletedIds(event: OrgEvent, into: Set<string>): void {
  if (event.subjectId !== null) into.add(event.subjectId);
  for (const key of OWNED_ID_KEYS) {
    const value = payloadString(event, key);
    if (value !== null) into.add(value);
  }
  for (const key of OWNED_ID_LIST_KEYS) {
    for (const value of payloadStringArray(event, key)) into.add(value);
  }
}

async function deletedIdsInStore(eventStore: EventStore, companyId: string): Promise<ReadonlySet<string>> {
  const deleted = new Set<string>();
  for await (const event of eventStore.replay(1 as Seq, undefined, {
    companyId: companyId as never,
  })) {
    if (DELETION_EVENT_TYPES.includes(event.type)) noteDeletedIds(event, deleted);
  }
  return deleted;
}

/**
 * `true` when the event belongs to work the log removed — it names the id itself, or carries
 * it in a payload field that owns work (`taskId` / `instanceId` / `targetId` / `taskIds`).
 * Ids are unique, so naming a removed id means the event is about that thing.
 */
function belongsToDeletedWork(event: OrgEvent, deleted: ReadonlySet<string>): boolean {
  if (deleted.size === 0) return false;
  if (event.subjectId !== null && deleted.has(event.subjectId)) return true;
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return false;
  for (const key of OWNED_ID_KEYS) {
    const value = payloadString(event, key);
    if (value !== null && deleted.has(value)) return true;
  }
  for (const key of OWNED_ID_LIST_KEYS) {
    if (payloadStringArray(event, key).some((value) => deleted.has(value))) return true;
  }
  return false;
}

export function toEventView(event: OrgEvent): EventView {
  return Object.freeze({
    seq: event.seq,
    eventId: event.eventId,
    type: event.type,
    occurredAtSim: Number(event.occurredAtSim),
    actorKind: event.actorKind,
    actorId: event.actorId,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    payload: event.payload,
  });
}

export function toAuditView(record: AuditRecordLike): AuditView {
  return Object.freeze({ ...record, eventIds: Object.freeze([...record.eventIds]) });
}

function activityRoleOf(type: string): AgentActivityEntry['role'] {
  if (type.startsWith(CONTROL_PREFIX)) return 'input';
  if (type.startsWith(RUNTIME_PREFIX)) return 'runtime';
  if (type.startsWith(TASK_PREFIX)) return 'task';
  if (type.startsWith(WORKFLOW_PREFIX)) return 'workflow';
  if (type.startsWith(COMMUNICATION_PREFIX)) return 'communication';
  return 'action';
}

export function createControlQuery(options: ControlQueryOptions): ControlQuery {
  const { companyId, organization, simulation, eventStore, audit } = options;
  const graph = createOrgGraph(organization);
  const company = {
    id: String(organization.company.id),
    name: organization.company.name,
    // M1.5 `User owns Organization`: whose company the console is showing. `null` only for a
    // company composed from a source that never named an owner (none ships).
    ownerId: organization.company.ownerId === undefined ? null : String(organization.company.ownerId),
  };

  const simulationState = (): SimulationStateView => {
    const snapshot = simulation.snapshot();
    return Object.freeze({
      status: snapshot.paused ? 'paused' : 'running',
      paused: snapshot.paused,
      tick: snapshot.tick,
      simTime: snapshot.simTime,
      tickDuration: snapshot.tickDuration,
      budgets: snapshot.budgets,
      lastTickStatus: snapshot.lastTickStatus,
      lastTickExceeded: Object.freeze([...snapshot.lastTickExceeded]),
      queueDepth: snapshot.queueDepth,
      pendingWakeups: snapshot.pendingWakeups,
      pausedAgentIds: Object.freeze([...options.controlState().pausedAgentIds]),
      recovery: snapshot.recovery,
    });
  };

  const agentSummary = (employeeId: EmployeeId): AgentSummary | null => {
    // Read the roster from the live `Organization`, not from a boot-time index: M1.3 materializes
    // agents at runtime (`Agent.Create`), and they must be visible to the console immediately.
    const employee = organization.employees.find((entry) => entry.id === employeeId);
    if (employee === undefined) return null;
    const position = graph.getPosition(employee.positionId);
    const manager = graph.getManagerOf(employeeId);
    const runtime = simulation.agentState(employeeId);
    const paused = simulation.isAgentPaused(employeeId);
    const currentTaskId = simulation.snapshot().currentTaskIds.get(employeeId) ?? null;
    const currentTask =
      currentTaskId === null ? null : simulation.task(currentTaskId);
    return Object.freeze({
      employeeId,
      organizationId: String(employee.companyId),
      name: employee.name,
      positionId: String(employee.positionId),
      departmentId: position?.departmentId === undefined ? null : String(position.departmentId),
      managerEmployeeId: manager === null ? null : manager.id,
      status: employee.status,
      lifecycle: agentLifecycleOf(employee.status),
      kind: employee.kind ?? null,
      expertise: Object.freeze([...(employee.expertise ?? [])]),
      runtime,
      currentTaskId,
      currentWorkflowInstanceId:
        currentTask === null ? null : currentTask.workflowInstanceId,
      presence: runtime === null ? 'unknown' : runtime.presence,
      paused,
    });
  };

  const departmentSummary = (): readonly DepartmentSummary[] =>
    Object.freeze(
      organization.departments.map((department) => {
        const positions = organization.positions.filter(
          (position) => position.departmentId === department.id,
        );
        const positionIds = new Set(positions.map((position) => position.id));
        const employees = organization.employees.filter((employee) =>
          positionIds.has(employee.positionId),
        );
        return Object.freeze({
          departmentId: String(department.id),
          name: department.name,
          parentDepartmentId:
            department.parent === null || department.parent === undefined
              ? null
              : String(department.parent),
          headPositionId:
            department.headPositionId === null || department.headPositionId === undefined
              ? null
              : String(department.headPositionId),
          positionCount: positions.length,
          employeeCount: employees.length,
        });
      }),
    );

  const employeeSummary = (): readonly EmployeeSummary[] =>
    Object.freeze(
      organization.employees.map((employee) => {
        const position = graph.getPosition(employee.positionId);
        const manager = graph.getManagerOf(employee.id);
        return Object.freeze({
          employeeId: employee.id,
          name: employee.name,
          employeeNo: employee.employeeNo ?? null,
          positionId: String(employee.positionId),
          positionTitle: position === null ? '' : position.title,
          departmentId:
            position === null || position.departmentId === null
              ? null
              : String(position.departmentId),
          managerEmployeeId: manager === null ? null : manager.id,
          status: employee.status,
          kind: employee.kind ?? null,
          expertise: Object.freeze([...(employee.expertise ?? [])]),
        });
      }),
    );

  const positionSummary = (): readonly PositionSummary[] =>
    Object.freeze(
      organization.positions.map((position) => {
        const staff = organization.employees.filter(
          (employee) => employee.positionId === position.id,
        );
        return Object.freeze({
          positionId: String(position.id),
          title: position.title,
          departmentId:
            position.departmentId === null || position.departmentId === undefined
              ? null
              : String(position.departmentId),
          employeeIds: Object.freeze(staff.map((employee) => employee.id)),
          capabilities: Object.freeze([...(position.capabilities ?? [])]),
        });
      }),
    );

  const taskEventCounts = async (): Promise<ReadonlyMap<string, number>> => {
    const counts = new Map<string, number>();
    for await (const event of eventStore.replay(1 as Seq, undefined, {
      companyId: companyId as never,
    })) {
      if (!event.type.startsWith(TASK_PREFIX)) continue;
      const taskId = payloadTaskId(event);
      if (taskId === null) continue;
      counts.set(taskId, (counts.get(taskId) ?? 0) + 1);
    }
    return counts;
  };

  /**
   * M1.8: project the definition's steps for the canvas. An absent definition service makes
   * the whole projection absent (clients tolerate it); an instance step already entered shows
   * the task's real executor; a not-yet-entered step shows the folded override, the definition
   * pin, or the live capability/position resolution — whichever the engine would use at entry.
   */
  const workflowStepsView = (
    instance: WorkflowInstance,
  ): readonly WorkflowCanvasStepView[] | undefined => {
    const definition = simulation.workflowDefinition?.(instance.workflowId);
    if (definition === undefined || definition === null) return undefined;
    const overrides = assignmentOverridesOf(instance);
    const graph = createOrgGraph(organization);
    const steps: WorkflowCanvasStepView[] = [];
    for (const stage of definition.stages) {
      for (const step of stage.steps) {
        const state = instance.stepStates[step.stepId];
        const taskId = state?.taskId ?? null;
        const task = taskId === null ? null : simulation.task(taskId);
        const overrideEmployeeId = overrides[step.stepId] ?? null;
        let assigneeEmployeeId: string | null = task?.assignment.assigneeEmployeeId ?? null;
        let assigneePositionId: string | null = task?.assignment.positionId ?? null;
        let overridden = false;
        if (assigneeEmployeeId === null) {
          if (overrideEmployeeId !== null) {
            assigneeEmployeeId = overrideEmployeeId;
            assigneePositionId = graph.getEmployee(overrideEmployeeId as EmployeeId)?.positionId ?? null;
            overridden = true;
          } else if (step.assignment?.kind === 'employee' && step.assignment.employeeId !== undefined) {
            assigneeEmployeeId = step.assignment.employeeId;
            assigneePositionId = graph.getEmployee(step.assignment.employeeId)?.positionId ?? null;
          } else if (step.assignment?.kind === 'position' && step.assignment.positionId !== undefined) {
            assigneePositionId = step.assignment.positionId;
            assigneeEmployeeId = graph.resolveByPosition(step.assignment.positionId)?.id ?? null;
          } else if (step.assignment?.kind === 'capability' && step.assignment.capability !== undefined) {
            const resolved = resolveCapabilityAssignments(organization, [step.assignment.capability]);
            const seat = resolved[0];
            if (seat !== undefined) {
              assigneePositionId = String(seat.positionId);
              assigneeEmployeeId =
                graph.resolveByPosition(seat.positionId as PositionId)?.id ?? null;
            }
          }
          // Role-based steps (approvals): show who holds the seat, not "unresolved".
          if (assigneeEmployeeId === null && taskId === null && step.requiredRoles.length > 0) {
            for (const role of step.requiredRoles) {
              const position = organization.positions.find(
                (entry) => entry.id === role || entry.key === role || entry.roleCode === role,
              );
              if (position === undefined) continue;
              const holder = graph.resolveByPosition(position.id);
              if (holder !== null) {
                assigneePositionId = String(position.id);
                assigneeEmployeeId = holder.id;
                break;
              }
            }
          }
        }
        steps.push(
          Object.freeze({
            stepId: step.stepId,
            stageId: stage.stageId,
            stageName: stage.name,
            name: step.name,
            description: step.description ?? null,
            kind: step.kind,
            status: state?.status ?? 'pending',
            taskId,
            assigneeEmployeeId,
            assigneePositionId,
            capability: step.capability ?? null,
            assignment: step.assignment ?? null,
            requiredRoles: Object.freeze([...step.requiredRoles]),
            requiredAuthority:
              step.requiredAuthority === null || step.requiredAuthority === undefined
                ? null
                : Object.freeze({
                    domain: String(step.requiredAuthority.domain),
                    level: step.requiredAuthority.level,
                  }),
            overridden,
          }),
        );
      }
    }
    return Object.freeze(steps);
  };

  const workflowSummary = (
    instance: WorkflowInstance,
    eventCount: number,
    pausedWorkflows: readonly string[],
  ): WorkflowSummary =>
    Object.freeze({
      instanceId: instance.instanceId,
      workflowId: instance.workflowId,
      title: instance.title,
      status: instance.status,
      stageId: instance.currentStageId,
      activeStepIds: Object.freeze([...instance.activeStepIds]),
      blockedReason:
        instance.blockedReason === null
          ? null
          : Object.freeze({
              kind: instance.blockedReason.kind,
              detail: instance.blockedReason.detail,
            }),
      paused: pausedWorkflows.includes(instance.instanceId),
      startedAtSim: Number(instance.startedAtSim),
      completedAtSim:
        instance.completedAtSim === null ? null : Number(instance.completedAtSim),
      eventCount,
      approval:
        instance.approval === null
          ? null
          : Object.freeze({
              stepId: instance.approval.stepId,
              status: instance.approval.status,
              requiredCount: instance.approval.requiredCount,
              grantedBy: Object.freeze([...instance.approval.grantedBy]),
            }),
    });

  const taskSummary = (task: Task, eventCount: number): TaskSummary =>
    Object.freeze({
      taskId: task.taskId,
      organizationId: String(task.companyId),
      title: task.title,
      status: task.status,
      assigneeEmployeeId: task.assignment.assigneeEmployeeId,
      positionId:
        task.assignment.positionId === null ? null : String(task.assignment.positionId),
      workflowInstanceId: task.workflowInstanceId,
      workflowStepId: task.workflowStepId,
      attempt: task.attempt,
      maxAttempts: task.maxAttempts,
      createdAtSim: Number(task.createdAtSim),
      completedAtSim: task.completedAtSim === null ? null : Number(task.completedAtSim),
      eventCount,
      requiredSkills: Object.freeze([...task.requiredSkills]),
      assignmentReason: task.assignmentReason,
      matchedCapabilities: Object.freeze([...task.matchedCapabilities]),
    });

  const taskView = (task: Task, eventCount: number): TaskView =>
    Object.freeze({
      ...taskSummary(task, eventCount),
      goal: task.goal,
      detail: task.detail,
      priority: task.priority,
      correlationId: task.correlationId,
      blockedReason: task.blockedReason,
      rejectReason: task.rejectReason,
      outputs: Object.freeze([...task.outputs]),
      result:
        task.result === null
          ? null
          : Object.freeze({
              taskId: task.result.taskId,
              producedBy: task.result.producedBy,
              summary: task.result.summary,
              data: Object.freeze({ ...task.result.data }),
              artifacts: Object.freeze([...task.result.artifacts]),
            }),
      reviews: Object.freeze(
        task.reviews.map((review) =>
          Object.freeze({
            reviewerId: String(review.reviewerId),
            verdict: review.verdict,
            reason: review.reason,
          }),
        ),
      ),
      verification:
        task.verification === null
          ? null
          : Object.freeze({
              kind: task.verification.kind,
              requiredOutputKeys: Object.freeze([...task.verification.requiredOutputKeys]),
            }),
    });

  const matchesFilter = (event: OrgEvent, filter: EventStreamFilter): boolean => {
    if (filter.cursor !== undefined && event.seq <= filter.cursor) return false;
    if (filter.eventTypes !== undefined && !filter.eventTypes.includes(event.type)) {
      return false;
    }
    if (filter.eventTypePrefix !== undefined && !event.type.startsWith(filter.eventTypePrefix)) {
      return false;
    }
    if (
      filter.excludeEventTypePrefixes !== undefined &&
      filter.excludeEventTypePrefixes.some((prefix) => event.type.startsWith(prefix))
    ) {
      return false;
    }
    if (filter.subjectId !== undefined && event.subjectId !== filter.subjectId) return false;
    if (filter.subjectType !== undefined && event.subjectType !== filter.subjectType) return false;
    if (filter.correlationId !== undefined && event.correlationId !== filter.correlationId) {
      return false;
    }
    const sim = Number(event.occurredAtSim);
    if (filter.fromSim !== undefined && sim < filter.fromSim) return false;
    if (filter.toSim !== undefined && sim > filter.toSim) return false;
    return true;
  };

  /**
   * One pass over the log. `hideDeleted` also gathers every id a deletion removed, so the
   * mask can be applied after the scan — the tombstones may sit anywhere in history, and the
   * activity window must be refilled with visible events rather than shrinking around them.
   */
  const collectEvents = async (
    filter: EventStreamFilter,
    hideDeleted: boolean,
  ): Promise<readonly EventView[]> => {
    const collected: OrgEvent[] = [];
    const deleted = new Set<string>();
    for await (const event of eventStore.replay(1 as Seq, undefined, {
      companyId: companyId as never,
    })) {
      if (hideDeleted && DELETION_EVENT_TYPES.includes(event.type)) noteDeletedIds(event, deleted);
      if (matchesFilter(event, filter)) collected.push(event);
    }
    const visible = hideDeleted
      ? collected.filter((event) => !belongsToDeletedWork(event, deleted))
      : collected;
    const limit = filter.limit ?? 100;
    return Object.freeze(visible.slice(-limit).map(toEventView));
  };

  /**
   * Briefs plus a taskId → creation-index map, from one replay: the read model needs both
   * (the brief itself and the order its items were created in), and replaying twice would
   * only double the cost of the same scan.
   */
  const workBriefViews = async (): Promise<readonly WorkBriefView[]> => {
    const briefEvents: OrgEvent[] = [];
    const createdAt = new Map<string, number>();
    let index = 0;
    for await (const event of eventStore.replay(1 as Seq, undefined, {
      companyId: companyId as never,
    })) {
      if (event.type === CONTROL_WORK_BRIEFED) briefEvents.push(event);
      if (event.type === TASK_CREATED) {
        const taskId = payloadString(event, 'taskId');
        if (taskId !== null && !createdAt.has(taskId)) createdAt.set(taskId, index);
      }
      index += 1;
    }
    const tasks = simulation.tasks();
    return Object.freeze(briefEvents.map((event) => workBriefView(event, tasks, createdAt)));
  };

  const query: ControlQuery = {
    getSimulationState: simulationState,
    getDepartments: departmentSummary,
    getEmployees: employeeSummary,

    getAgents() {
      return Object.freeze(
        simulation
          .organization()
          .employees.map((employee) => agentSummary(employee.id))
          .filter((summary): summary is AgentSummary => summary !== null),
      );
    },

    getAgent(agentId) {
      return agentSummary(agentId);
    },

    getAgentRuntimeState(agentId) {
      return simulation.agentState(agentId);
    },

    async getAgentActivity(agentId, limit = 50) {
      const entries: AgentActivityEntry[] = [];
      // This stream is filtered by subject, so the tombstones naming removed work never reach
      // it: they need their own pass, otherwise the agent's feed keeps naming tasks that are
      // gone. Cycles are telemetry rather than a narrative — they stay paired even when the
      // entry that reported them is masked.
      const deleted = await deletedIdsInStore(eventStore, companyId);
      let cycles: readonly {
        readonly cycleId: string;
        readonly startedAtSim: number | null;
        readonly finishedAtSim: number | null;
        readonly presence: string | null;
      }[] = Object.freeze([]);
      for await (const event of eventStore.replay(1 as Seq, undefined, {
        companyId: companyId as never,
        subjectId: String(agentId),
      })) {
        if (!belongsToDeletedWork(event, deleted)) {
          entries.push(
            Object.freeze({
              event: toEventView(event),
              role: activityRoleOf(event.type),
            }),
          );
        }
        if (event.type === 'Runtime.CycleStarted') {
          const cycleId = payloadString(event, 'cycleId') ?? '-';
          cycles = Object.freeze([
            ...cycles,
            Object.freeze({
              cycleId,
              startedAtSim: Number(event.occurredAtSim),
              finishedAtSim: null,
              presence: null,
            }),
          ]);
        } else if (event.type === 'Runtime.CycleFinished') {
          const cycleId = payloadString(event, 'cycleId') ?? '-';
          const presence = payloadString(event, 'presence');
          const index = cycles.findIndex((entry) => entry.cycleId === cycleId);
          if (index < 0) {
            cycles = Object.freeze([
              ...cycles,
              Object.freeze({
                cycleId,
                startedAtSim: null,
                finishedAtSim: Number(event.occurredAtSim),
                presence,
              }),
            ]);
          } else {
            cycles = Object.freeze(
              cycles.map((entry, position) =>
                position === index
                  ? Object.freeze({
                      ...entry,
                      finishedAtSim: Number(event.occurredAtSim),
                      presence,
                    })
                  : entry,
              ),
            );
          }
        }
      }
      return Object.freeze({
        agentId,
        entries: Object.freeze(entries.slice(-limit)),
        cycles,
      });
    },

    getWorkflows() {
      const state = options.controlState();
      return Object.freeze(
        simulation
          .workflows()
          .map((instance) => workflowSummary(instance, instance.processedEventIds.length, state.pausedWorkflowIds)),
      );
    },

    getWorkflow(instanceId) {
      const instance = simulation.workflow(instanceId);
      if (instance === null) return null;
      const summary = workflowSummary(
        instance,
        instance.processedEventIds.length,
        options.controlState().pausedWorkflowIds,
      );
      const steps = workflowStepsView(instance);
      return Object.freeze({
        ...summary,
        goal: instance.goal,
        correlationId: instance.correlationId,
        initiatedBy: instance.initiatedBy,
        stepStates: Object.freeze(
          Object.values(instance.stepStates).map((step) =>
            Object.freeze({
              stepId: step.stepId,
              status: step.status,
              taskId: step.taskId,
            }),
          ),
        ),
        // M1.8: canvas projection; absent when the port cannot resolve the definition.
        ...(steps === undefined ? {} : { steps }),
        assignmentOverrides: Object.freeze({ ...assignmentOverridesOf(instance) }),
        // M1.9: the console renders drafts (plan not yet executing) with a confirm action.
        draft: instance.context[DRAFT_CONTEXT_KEY] === true,
      });
    },

    getTasks() {
      return Object.freeze(
        simulation.tasks().map((task) => taskSummary(task, 0)),
      );
    },

    getTask(taskId) {
      const task = simulation.task(taskId);
      if (task === null) return null;
      return taskView(task, 0);
    },

    listWorkBriefs() {
      return workBriefViews();
    },

    getWorkBrief(briefId) {
      return workBriefViews().then(
        (briefs) => briefs.find((brief) => brief.briefId === briefId) ?? null,
      );
    },

    async getRecentEvents(filter = {}) {
      // The activity view is "what the organization is doing now": work that was removed is
      // not part of it, tombstones included, unless the caller asked for the full history.
      const events = await collectEvents(activityFilter(filter), filter.includeDeleted !== true);
      return Object.freeze([...events].reverse());
    },

    async getEventStream(filter = {}) {
      // The raw log defaults to complete; hiding is an explicit request only.
      return collectEvents(filter, filter.includeDeleted === false);
    },

    getAuditTrail(resourceId) {
      const target: AuditTargetClaim = { targetType: 'resource', targetId: resourceId };
      const records = audit.trail(target.targetId);
      return records.map((record) =>
        Object.freeze({
          audit: toAuditView(record),
          events: Object.freeze([]),
        }),
      );
    },

    getRecentAudits(limit = 50) {
      return Object.freeze(audit.recent(limit).map(toAuditView));
    },

    getPendingApprovals() {
      const recent = audit.recent(1000);
      const pending: PendingApprovalView[] = [];
      for (const record of recent) {
        if (record.resultCode !== 'NEEDS_APPROVAL') continue;
        const details = record.details ?? {};
        const resource = String(record.actionResource ?? '');
        const separator = resource.indexOf(':');
        const targetType = separator < 0 ? 'resource' : resource.slice(0, separator);
        const targetId = separator < 0 ? resource : resource.slice(separator + 1);
        const required = details['requiredAuthority'];
        const escalate = details['escalateTo'];
        pending.push(
          Object.freeze({
            commandId: record.commandId,
            commandType: record.actionType,
            operatorId: record.actorId,
            reason: record.reason,
            targetType,
            targetId,
            requiredAuthority: typeof required === 'number' ? required : null,
            escalateTo: typeof escalate === 'string' ? escalate : null,
            createdAtSim: record.createdAtSim,
            eventId: record.eventIds[0] ?? null,
          }),
        );
      }
      return Object.freeze(pending);
    },

    getControlState() {
      return options.controlState();
    },

    async getOrganizationSnapshot() {
      const taskCounts = await taskEventCounts();
      const state = options.controlState();
      const tasks = simulation
        .tasks()
        .map((task) => taskSummary(task, taskCounts.get(task.taskId) ?? 0));
      const workflows = simulation
        .workflows()
        .map((instance) =>
          workflowSummary(
            instance,
            instance.processedEventIds.length,
            state.pausedWorkflowIds,
          ),
        );
      const agents = simulation
        .organization()
        .employees.map((employee) => agentSummary(employee.id))
        .filter((summary): summary is AgentSummary => summary !== null);
      const recentEvents = await query.getRecentEvents({ limit: 25 });
      return Object.freeze({
        company,
        simulation: simulationState(),
        departments: departmentSummary(),
        positions: positionSummary(),
        employees: employeeSummary(),
        agents: Object.freeze(agents),
        workflows: Object.freeze(workflows),
        tasks: Object.freeze(tasks),
        recentEvents,
        recentAudits: query.getRecentAudits(25),
      });
    },
  };

  return query;
}

function payloadTaskId(event: OrgEvent): string | null {
  return payloadString(event, 'taskId');
}

function payloadString(event: OrgEvent, key: string): string | null {
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Readonly<Record<string, unknown>>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function payloadValue(event: OrgEvent, key: string): unknown {
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  return (payload as Readonly<Record<string, unknown>>)[key];
}

function payloadNumberOrNull(event: OrgEvent, key: string): number | null {
  const value = payloadValue(event, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function payloadStringArray(event: OrgEvent, key: string): readonly string[] {
  const value = payloadValue(event, key);
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.filter((entry): entry is string => typeof entry === 'string'),
  );
}

/** One brief: its submitted fields verbatim, plus the tasks its `correlationId` groups. */
function workBriefView(
  event: OrgEvent,
  tasks: readonly Task[],
  createdAt: ReadonlyMap<string, number>,
): WorkBriefView {
  const context = payloadValue(event, 'context');
  const items = Object.freeze(
    tasks
      .filter((task) => task.correlationId === event.correlationId)
      .sort((left, right) => {
        const leftOrder = createdAt.get(left.taskId) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = createdAt.get(right.taskId) ?? Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0;
      })
      .map((task) => workBriefItemView(task)),
  );
  const countOf = (status: string): number =>
    items.filter((item) => item.status === status).length;
  return Object.freeze({
    briefId: payloadString(event, 'briefId') ?? '',
    commandId: payloadString(event, 'commandId') ?? '',
    agentId: (payloadString(event, 'agentId') ?? '') as EmployeeId,
    operatorId: (payloadString(event, 'operatorId') ?? '') as EmployeeId,
    reason: payloadString(event, 'reason') ?? '',
    correlationId: event.correlationId,
    title: payloadString(event, 'title') ?? '',
    goal: payloadString(event, 'goal') ?? '',
    context: typeof context === 'string' ? context : null,
    verificationKeys: payloadStringArray(event, 'verificationKeys'),
    priority: payloadNumberOrNull(event, 'priority'),
    dueAtSim: payloadNumberOrNull(event, 'dueAtSim'),
    submittedAtSim: Number(event.occurredAtSim),
    items,
    counts: Object.freeze({
      total: items.length,
      assigned: countOf('assigned'),
      completed: countOf('completed'),
      blocked: countOf('blocked'),
      rejected: countOf('rejected'),
    }),
  });
}

function workBriefItemView(task: Task): WorkBriefItemView {
  return Object.freeze({
    taskId: task.taskId,
    title: task.title,
    goal: task.goal,
    status: task.status,
    positionId: task.assignment.positionId === null ? null : String(task.assignment.positionId),
    assigneeEmployeeId: task.assignment.assigneeEmployeeId,
    priority: task.priority,
    dueAtSim: task.dueAtSim === null ? null : Number(task.dueAtSim),
    verificationKeys: Object.freeze([...(task.verification?.requiredOutputKeys ?? [])]),
  });
}
