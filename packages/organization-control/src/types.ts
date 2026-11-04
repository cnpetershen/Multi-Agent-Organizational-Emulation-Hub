import type { AuthorityLevel, DecisionDomain, EmployeeId, SimTime } from '@maoeh/shared-types';
import type { CommandActor } from '@maoeh/permission-system';
import type { Task, TaskFailure } from '@maoeh/task-system';
import type { WorkflowFailure, WorkflowInstance } from '@maoeh/workflow-engine';
import type { StateVersionConflict } from '@maoeh/runtime-state';

import type { AgentLifecycleStatus } from './agent-lifecycle.js';

/**
 * The operator behind a control command.
 *
 * Humankind is a first-class organization member (BASELINE §5): an operator is an
 * `Employee` with `kind: 'human'` occupying a real `Position`. That is what makes the
 * existing `AuthzService.can()` path (`employee.positionId === actor.positionId`) apply
 * unchanged — no parallel permission system is introduced.
 */
export interface ControlActor {
  readonly operatorId: EmployeeId;
  readonly displayName: string;
  readonly positionId: string;
  readonly kind: 'human' | 'employee';
}

/** The person/agent a command acts upon. */
export interface ControlTarget {
  readonly targetType: ControlTargetType;
  readonly targetId: string;
}

export const CONTROL_TARGET_TYPES = [
  'simulation',
  'organization',
  'agent',
  'workflow',
  'task',
] as const;

export type ControlTargetType = (typeof CONTROL_TARGET_TYPES)[number];

export const CONTROL_COMMAND_TYPES = [
  'Simulation.Start',
  'Simulation.Pause',
  'Simulation.Resume',
  'Simulation.Step',
  'Simulation.Seek',
  'Agent.Create',
  'Agent.Archive',
  'Agent.Pause',
  'Agent.Resume',
  'Agent.Instruct',
  'Agent.CancelTask',
  'Agent.RequestReview',
  'Workflow.Pause',
  'Workflow.Resume',
  'Workflow.Cancel',
  'Workflow.Approve',
  'Workflow.Reject',
  'Workflow.Delete',
  'Task.Cancel',
  'Task.Reassign',
  'Task.AssignToAgent',
  'Task.RequestReview',
  'Task.Delete',
  'Organization.InjectTask',
  'Organization.InjectEvent',
  'Work.SubmitBrief',
] as const;

export type ControlCommandType = (typeof CONTROL_COMMAND_TYPES)[number];

/** `Command` = "what I want the system to do". Never an event. */
export interface ControlCommandBase {
  /** Idempotency key. A repeated `commandId` never applies twice. */
  readonly commandId: string;
  readonly commandType: ControlCommandType;
  readonly actor: ControlActor;
  readonly target: ControlTarget;
  /** Mandatory: written to the audit trail and to every emitted control event. */
  readonly reason: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  /** Optimistic concurrency. Omitted = no version precondition. */
  readonly expectedVersion?: number;
  readonly createdAtSim: SimTime;
}

export interface SimulationTargetCommand extends ControlCommandBase {
  readonly commandType: 'Simulation.Start';
}

export interface SimulationPauseCommand extends ControlCommandBase {
  readonly commandType: 'Simulation.Pause';
}

export interface SimulationResumeCommand extends ControlCommandBase {
  readonly commandType: 'Simulation.Resume';
}

export interface SimulationStepCommand extends ControlCommandBase {
  readonly commandType: 'Simulation.Step';
}

export interface SimulationSeekCommand extends ControlCommandBase {
  readonly commandType: 'Simulation.Seek';
  readonly tickNumber: number;
}

export interface AgentCreateCommand extends ControlCommandBase {
  readonly commandType: 'Agent.Create';
  /**
   * The identity of the new agent. The operator states it explicitly (the console derives a
   * slug from the name) so the event can name its subject before the roster changes.
   */
  readonly employeeId: string;
  readonly name: string;
  readonly positionId: string;
  readonly employeeNo?: string | null;
  /** Responsibilities are mandatory: an agent without a mandate is not an agent (AGENTS.md). */
  readonly responsibilities: readonly string[];
  readonly traits?: readonly string[];
  /**
   * Fine-grained specializations of the new person (M1.6 capability matching reads them, on top
   * of the seat's declared capabilities). Optional; when omitted the template employee's
   * expertise is inherited, so hiring into an existing seat keeps the seat's skill shape.
   */
  readonly expertise?: readonly string[];
  readonly cognitionProfileId?: string | null;
  /**
   * Where the rest of the 8-layer structure comes from (capabilities, memory policy, tool
   * policy and, unless overridden, responsibilities/traits/cognition profile). Defaults to the
   * target position's current holder, then to the first deployed agent.
   */
  readonly templateEmployeeId?: string | null;
  /**
   * Create `positionId` as a new position under this department when the chart does not have
   * it yet ("Engineering" + "Game Developer"). Absent means `positionId` must already exist.
   * Departments are never created here — the command adds a *seat*, not a box on the chart.
   */
  readonly newPosition?: NewPositionSpec;
}

/** A seat the chart does not have yet, created together with the agent that fills it. */
export interface NewPositionSpec {
  readonly departmentId: string;
  readonly title: string;
  /** Capability tags for capability → position routing (trimmed/lowercased by the Runtime). */
  readonly capabilities?: readonly string[];
  /** Manager seat; defaults to the department head position. */
  readonly reportsToPositionId?: string | null;
}

export interface AgentArchiveCommand extends ControlCommandBase {
  readonly commandType: 'Agent.Archive';
}

export interface AgentPauseCommand extends ControlCommandBase {
  readonly commandType: 'Agent.Pause';
}

export interface AgentResumeCommand extends ControlCommandBase {
  readonly commandType: 'Agent.Resume';
}

export interface AgentInstructCommand extends ControlCommandBase {
  readonly commandType: 'Agent.Instruct';
  readonly instruction: string;
}

export interface AgentCancelTaskCommand extends ControlCommandBase {
  readonly commandType: 'Agent.CancelTask';
  readonly taskId: string;
}

export interface AgentRequestReviewCommand extends ControlCommandBase {
  readonly commandType: 'Agent.RequestReview';
  readonly taskId: string;
}

export interface WorkflowPauseCommand extends ControlCommandBase {
  readonly commandType: 'Workflow.Pause';
}

export interface WorkflowResumeCommand extends ControlCommandBase {
  readonly commandType: 'Workflow.Resume';
}

export interface WorkflowCancelCommand extends ControlCommandBase {
  readonly commandType: 'Workflow.Cancel';
}

export interface WorkflowApproveCommand extends ControlCommandBase {
  readonly commandType: 'Workflow.Approve';
}

export interface WorkflowRejectCommand extends ControlCommandBase {
  readonly commandType: 'Workflow.Reject';
}

/**
 * Remove a workflow instance.
 *
 * Deletion, not cancellation: the instance and every task it owns leave the organization. The
 * command targets the instance; the cascade to its tasks is the Control Plane's job, so the
 * operator states one intent instead of a list.
 */
export interface WorkflowDeleteCommand extends ControlCommandBase {
  readonly commandType: 'Workflow.Delete';
}

export interface TaskCancelCommand extends ControlCommandBase {
  readonly commandType: 'Task.Cancel';
}

/**
 * Remove a task. When the task is filed under a workflow instance the whole instance goes with
 * it — one deliverable and the work stream that produced it are a single unit of cleanup.
 */
export interface TaskDeleteCommand extends ControlCommandBase {
  readonly commandType: 'Task.Delete';
}

export interface TaskReassignCommand extends ControlCommandBase {
  readonly commandType: 'Task.Reassign';
  readonly positionId: string;
}

/**
 * M1.6 — assign a task to a *person*, chosen by capability.
 *
 * With `agentId` the operator names the employee. Without it the Control Plane runs the
 * deterministic capability matcher over the organization and assigns the task to the best
 * available candidate — the decision is then a fact on the log (`Control.TaskAssigned` +
 * `Control.DelegationDecided`), never a hidden heuristic.
 */
export interface TaskAssignToAgentCommand extends ControlCommandBase {
  readonly commandType: 'Task.AssignToAgent';
  readonly agentId?: string;
}

export interface TaskRequestReviewCommand extends ControlCommandBase {
  readonly commandType: 'Task.RequestReview';
}

export interface InjectTaskCommand extends ControlCommandBase {
  readonly commandType: 'Organization.InjectTask';
  readonly title: string;
  readonly goal: string;
  readonly detail?: string | null;
  /**
   * Dispatch target. Required unless `requiredSkills` is given: with a seat the task is
   * routed exactly as before, without one it is routed by capability matching (M1.6).
   */
  readonly positionId?: string;
  /**
   * Capabilities this work needs. Present (and `positionId` absent) means "delegate to
   * whoever can do it" — the Control Plane picks the candidate and records why.
   */
  readonly requiredSkills?: readonly string[];
  readonly workflowInstanceId?: string | null;
  readonly workflowStepId?: string | null;
}

export interface InjectEventCommand extends ControlCommandBase {
  readonly commandType: 'Organization.InjectEvent';
  readonly eventType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * A work brief (任务书) — the M1.4 single human entry point for organizational work
 * (§5.7). Structured, never a free-text string: the briefed agent turns it into a plan,
 * and every work item it dispatches must be verifiable.
 */
export interface WorkBriefSpec {
  readonly title: string;
  readonly goal: string;
  /** Standing context around the ask. Absent / `null` = none supplied. */
  readonly context?: string | null;
  /** Q3: verification is mandatory — an unverifiable brief cannot be met. */
  readonly verificationKeys: readonly string[];
  /** Urgency 1 (highest) … 9 (lowest); absent = the org's default priority. */
  readonly priority?: number | null;
  /** Deadline in simulation time; absent = no deadline stated. */
  readonly dueAtSim?: number | null;
}

export interface WorkSubmitBriefCommand extends ControlCommandBase {
  readonly commandType: 'Work.SubmitBrief';
  readonly workBrief: WorkBriefSpec;
}

export type ControlCommand =
  | SimulationTargetCommand
  | SimulationPauseCommand
  | SimulationResumeCommand
  | SimulationStepCommand
  | SimulationSeekCommand
  | AgentCreateCommand
  | AgentArchiveCommand
  | AgentPauseCommand
  | AgentResumeCommand
  | AgentInstructCommand
  | AgentCancelTaskCommand
  | AgentRequestReviewCommand
  | WorkflowPauseCommand
  | WorkflowResumeCommand
  | WorkflowCancelCommand
  | WorkflowApproveCommand
  | WorkflowRejectCommand
  | WorkflowDeleteCommand
  | TaskCancelCommand
  | TaskReassignCommand
  | TaskAssignToAgentCommand
  | TaskRequestReviewCommand
  | TaskDeleteCommand
  | InjectTaskCommand
  | InjectEventCommand
  | WorkSubmitBriefCommand;

export const CONTROL_ACTION_BY_COMMAND: Readonly<Record<ControlCommandType, string>> =
  Object.freeze({
    'Simulation.Start': 'ControlSimulation',
    'Simulation.Pause': 'ControlSimulation',
    'Simulation.Resume': 'ControlSimulation',
    'Simulation.Step': 'ControlSimulation',
    'Simulation.Seek': 'ControlSimulation',
    'Agent.Create': 'ControlAgent',
    'Agent.Archive': 'ControlAgent',
    'Agent.Pause': 'ControlAgent',
    'Agent.Resume': 'ControlAgent',
    'Agent.Instruct': 'ControlAgent',
    'Agent.CancelTask': 'ControlTask',
    'Agent.RequestReview': 'ControlTask',
    'Workflow.Pause': 'ControlWorkflow',
    'Workflow.Resume': 'ControlWorkflow',
    'Workflow.Cancel': 'ControlWorkflow',
    'Workflow.Approve': 'ControlWorkflow',
    'Workflow.Reject': 'ControlWorkflow',
    'Workflow.Delete': 'ControlWorkflow',
    'Task.Cancel': 'ControlTask',
    'Task.Reassign': 'ControlTask',
    'Task.AssignToAgent': 'ControlTask',
    'Task.RequestReview': 'ControlTask',
    'Task.Delete': 'ControlTask',
    'Organization.InjectTask': 'InjectOrganizationInput',
    'Organization.InjectEvent': 'InjectOrganizationInput',
    'Work.SubmitBrief': 'ControlAgent',
  });

/** Decision domain whose authority threshold gates each command family. */
export const CONTROL_DOMAIN_BY_COMMAND: Readonly<Record<ControlCommandType, DecisionDomain>> =
  Object.freeze({
    'Simulation.Start': 'org',
    'Simulation.Pause': 'org',
    'Simulation.Resume': 'org',
    'Simulation.Step': 'org',
    'Simulation.Seek': 'org',
    // Hiring and archiving are organizational acts, not operational ones: they change who the
    // company is (04-agent-lifecycle §4.6), so they are gated in the `org` decision domain.
    'Agent.Create': 'org',
    'Agent.Archive': 'org',
    'Agent.Pause': 'org',
    'Agent.Resume': 'org',
    'Agent.Instruct': 'org',
    'Agent.CancelTask': 'ops',
    'Agent.RequestReview': 'ops',
    'Workflow.Pause': 'ops',
    'Workflow.Resume': 'ops',
    'Workflow.Cancel': 'ops',
    'Workflow.Approve': 'ops',
    'Workflow.Reject': 'ops',
    // Removal is an operational act on running work, exactly like the cancel beside it.
    'Workflow.Delete': 'ops',
    'Task.Cancel': 'ops',
    'Task.Reassign': 'ops',
    'Task.AssignToAgent': 'ops',
    'Task.RequestReview': 'ops',
    'Task.Delete': 'ops',
    'Organization.InjectTask': 'product',
    'Organization.InjectEvent': 'product',
    // A brief is an organizational commitment: who the company works for next.
    'Work.SubmitBrief': 'org',
  });

export function controlResourceOf(command: ControlCommand, companyId: string): string {
  switch (command.target.targetType) {
    case 'simulation':
      return `simulation:${companyId}`;
    case 'organization':
      return `organization:${companyId}`;
    case 'agent':
      return `agent:${command.target.targetId}`;
    case 'workflow':
      return `workflow:${command.target.targetId}`;
    case 'task':
      return `task:${command.target.targetId}`;
    default:
      return `unknown:${command.target.targetId}`;
  }
}

export type ControlErrorCode =
  | 'UNAUTHENTICATED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'OUT_OF_SCOPE'
  | 'NEEDS_APPROVAL'
  | 'INVALID_COMMAND'
  | 'INVALID_TARGET'
  | 'STALE_VERSION'
  | 'ALREADY_PROCESSED'
  | 'INVALID_STATE'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BUDGET_EXCEEDED'
  | 'SIMULATION_PAUSED'
  | 'AGENT_PAUSED'
  | 'WORKFLOW_BLOCKED'
  | 'UNSUPPORTED';

export interface ControlIssue {
  readonly field: string;
  readonly reason: string;
}

export interface ControlFailure {
  readonly code: ControlErrorCode;
  readonly issues: readonly ControlIssue[];
  readonly actualVersion?: number;
  readonly escalateTo?: EmployeeId;
  readonly requiredAuthority?: AuthorityLevel;
  readonly taskFailure?: TaskFailure;
  readonly workflowFailure?: WorkflowFailure;
  readonly versionConflict?: StateVersionConflict;
}

export interface ControlAuthorizationRequest {
  readonly command: ControlCommand;
  readonly actor: ControlActor;
  readonly action: string;
  readonly domain: DecisionDomain;
  readonly resource: string;
}

export type ControlAuthorizationDecision =
  | { readonly allow: true; readonly actor: CommandActor; readonly requiredAuthority: AuthorityLevel }
  | { readonly allow: false; readonly code: ControlErrorCode };

export interface ControlOutcome {
  readonly status: 'accepted' | 'rejected' | 'failed';
  readonly commandId: string;
  readonly commandType: ControlCommandType;
  /** `true` when the result was replayed from the audit trail (idempotent hit). */
  readonly replayed: boolean;
  readonly events: readonly string[];
  readonly auditId: string;
  readonly failure: ControlFailure | null;
}

/** Read-only view of the control plane's own projected state. */
export interface ControlState {
  readonly simulationPaused: boolean;
  readonly pausedAgentIds: readonly EmployeeId[];
  readonly pausedWorkflowIds: readonly string[];
  readonly issuedInstructionIds: readonly string[];
  readonly tick: number;
  readonly simTime: number;
  readonly processedCommandIds: readonly string[];
}

export interface AgentStateView {
  readonly employeeId: EmployeeId;
  readonly version: number;
  readonly employment: string;
  readonly presence: string;
  readonly currentCycleId: string | null;
  readonly focus: { readonly refType: string; readonly refId: string } | null;
  readonly updatedAtSim: number;
  readonly paused: boolean;
}

export interface AgentSummary {
  readonly employeeId: EmployeeId;
  /** The company this agent is employed by — M1.5 User owns Organization employs Agents; the same id as the event/record companyId. */
  readonly organizationId: string;
  readonly name: string;
  readonly positionId: string;
  readonly departmentId: string | null;
  readonly managerEmployeeId: EmployeeId | null;
  readonly status: string;
  /**
   * M1.3 agent lifecycle: `active` or `archived`. `status` above stays the raw employment
   * status (`active`, `on_leave`, `offboarded`, …); this is the two-state view the Agent
   * Management page and the API speak.
   */
  readonly lifecycle: AgentLifecycleStatus;
  readonly kind: 'agent' | 'human' | null;
  /**
   * The person's fine-grained specializations (`Employee.expertise`) — what capability matching
   * can route on beyond their seat's declared capabilities.
   */
  readonly expertise: readonly string[];
  readonly runtime: AgentStateView | null;
  readonly currentTaskId: string | null;
  readonly currentWorkflowInstanceId: string | null;
  readonly presence: string;
  readonly paused: boolean;
}

export interface DepartmentSummary {
  readonly departmentId: string;
  readonly name: string;
  readonly parentDepartmentId: string | null;
  readonly headPositionId: string | null;
  readonly positionCount: number;
  readonly employeeCount: number;
}

export interface EmployeeSummary {
  readonly employeeId: EmployeeId;
  readonly name: string;
  readonly employeeNo: string | null;
  readonly positionId: string;
  readonly positionTitle: string;
  readonly departmentId: string | null;
  readonly managerEmployeeId: EmployeeId | null;
  readonly status: string;
  readonly kind: 'agent' | 'human' | null;
}

/**
 * A position of the organization chart, with the employees who staff it. Unstaffed
 * positions are what `Organization.InjectTask` produces an unassigned task for, so the
 * console needs them in the same read as the employees.
 */
export interface PositionSummary {
  readonly positionId: string;
  readonly title: string;
  readonly departmentId: string | null;
  readonly employeeIds: readonly EmployeeId[];
  /** Capability tags this seat provides — the routing keys a generated workflow matches on. */
  readonly capabilities: readonly string[];
}

export interface SimulationStateView {
  readonly status: 'running' | 'paused';
  readonly paused: boolean;
  readonly tick: number;
  readonly simTime: number;
  readonly tickDuration: number;
  readonly budgets: {
    readonly maxAgentTurns: number;
    readonly maxEvents: number;
    readonly maxTasks: number;
    readonly maxWorkflowTransitions: number;
    readonly maxLlmCalls: number;
  };
  readonly lastTickStatus: string | null;
  readonly lastTickExceeded: readonly string[];
  readonly queueDepth: number;
  readonly pendingWakeups: number;
  readonly pausedAgentIds: readonly EmployeeId[];
  readonly recovery: {
    readonly cursor: number;
    readonly tickNumber: number;
    readonly taskCount: number;
    readonly workflowInstanceCount: number;
    readonly agentStateCount: number;
    readonly eventCount: number;
  } | null;
}

export interface OrganizationSnapshot {
  /** The AI company this snapshot belongs to, including the founder who owns it (M1.5). */
  readonly company: { readonly id: string; readonly name: string; readonly ownerId: string | null };
  readonly simulation: SimulationStateView;
  readonly departments: readonly DepartmentSummary[];
  readonly positions: readonly PositionSummary[];
  readonly employees: readonly EmployeeSummary[];
  readonly agents: readonly AgentSummary[];
  readonly workflows: readonly WorkflowSummary[];
  readonly tasks: readonly TaskSummary[];
  readonly recentEvents: readonly EventView[];
  readonly recentAudits: readonly AuditView[];
}

export interface WorkflowSummary {
  readonly instanceId: string;
  readonly workflowId: string;
  readonly title: string;
  readonly status: string;
  readonly stageId: string | null;
  readonly activeStepIds: readonly string[];
  readonly blockedReason: { readonly kind: string; readonly detail: string } | null;
  readonly paused: boolean;
  readonly startedAtSim: number;
  readonly completedAtSim: number | null;
  readonly eventCount: number;
  readonly approval: {
    readonly stepId: string;
    readonly status: string;
    readonly requiredCount: number;
    readonly grantedBy: readonly string[];
  } | null;
}

export interface WorkflowView extends WorkflowSummary {
  readonly goal: string;
  readonly correlationId: string;
  readonly initiatedBy: string;
  readonly stepStates: readonly {
    readonly stepId: string;
    readonly status: string;
    readonly taskId: string | null;
  }[];
}

export interface TaskSummary {
  readonly taskId: string;
  /** The company this task belongs to — M1.5 ownership scoping; identical to the record's `companyId`. */
  readonly organizationId: string;
  readonly title: string;
  readonly status: string;
  readonly assigneeEmployeeId: EmployeeId | null;
  readonly positionId: string | null;
  readonly workflowInstanceId: string | null;
  readonly workflowStepId: string | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly createdAtSim: number;
  readonly completedAtSim: number | null;
  readonly eventCount: number;
  /** Capability tags the work declares — what capability matching routes on (M1.6). */
  readonly requiredSkills: readonly string[];
  /** Why the current assignee was chosen; `null` until the task has been assigned. */
  readonly assignmentReason: string | null;
  /** The required capabilities the current assignee covers. */
  readonly matchedCapabilities: readonly string[];
}

/**
 * The work product an executor submitted for a task (`TASK_PROGRESS_REPORTED` / `TASK_SUBMITTED`).
 *
 * `summary` is the executor's own account of the work, `data` is the structured deliverable
 * content (report sections, analysis findings, …) and `artifacts` are the document references
 * the task's `outputs` are folded from. The M1.4 Deliverables page renders this and nothing
 * else: a delivery the console did not receive is never invented.
 */
export interface TaskResultView {
  readonly taskId: string;
  readonly producedBy: EmployeeId;
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly string[];
}

export interface TaskView extends TaskSummary {
  readonly goal: string;
  readonly detail: string | null;
  readonly priority: number;
  readonly correlationId: string;
  readonly blockedReason: string | null;
  readonly rejectReason: string | null;
  readonly outputs: readonly string[];
  readonly result: TaskResultView | null;
  readonly reviews: readonly {
    readonly reviewerId: string;
    readonly verdict: string;
    readonly reason: string | null;
  }[];
  readonly verification: { readonly kind: string; readonly requiredOutputKeys: readonly string[] } | null;
}

/** One work item the briefed agent's plan dispatched for a brief (a `Task.*` on the log). */
export interface WorkBriefItemView {
  readonly taskId: string;
  readonly title: string;
  readonly goal: string;
  readonly status: string;
  readonly positionId: string | null;
  readonly assigneeEmployeeId: EmployeeId | null;
  readonly priority: number;
  readonly dueAtSim: number | null;
  /** The outputs this item must produce to count as done (A5 keeps them non-empty). */
  readonly verificationKeys: readonly string[];
}

/**
 * The work-brief read model (M1.4 §5.4): the brief as submitted (`Control.WorkBriefed`)
 * plus the decomposition produced from it — every task sharing the brief's `correlationId`,
 * in creation order. Derived from the log alone: no new events, no new tables.
 */
export interface WorkBriefView {
  readonly briefId: string;
  readonly commandId: string;
  readonly agentId: EmployeeId;
  readonly operatorId: EmployeeId;
  readonly reason: string;
  /** The grouping key §5.4 propagates: brief → dispatched items. */
  readonly correlationId: string;
  readonly title: string;
  readonly goal: string;
  readonly context: string | null;
  readonly verificationKeys: readonly string[];
  readonly priority: number | null;
  readonly dueAtSim: number | null;
  readonly submittedAtSim: number;
  readonly items: readonly WorkBriefItemView[];
  readonly counts: {
    readonly total: number;
    readonly assigned: number;
    readonly completed: number;
    readonly blocked: number;
    readonly rejected: number;
  };
}

export interface EventView {
  readonly seq: number;
  readonly eventId: string;
  readonly type: string;
  readonly occurredAtSim: number;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload: unknown;
}

export interface EventStreamFilter {
  readonly limit?: number;
  /** Exclusive lower bound on `seq` (cursor pagination). */
  readonly cursor?: number;
  readonly eventTypes?: readonly string[];
  readonly eventTypePrefix?: string;
  /**
   * Aggregate prefixes held out of this read. Read-side only: the event is still in the
   * `EventStore`, still returned by `replay`, and still reachable through `getEventStream`
   * — it is merely not part of the requested slice.
   */
  readonly excludeEventTypePrefixes?: readonly string[];
  readonly subjectId?: string;
  readonly subjectType?: string;
  readonly correlationId?: string;
  readonly fromSim?: number;
  readonly toSim?: number;
  /**
   * Whether work the log records as removed still shows up.
   *
   * Read-side only, and the two streams read it differently: `getRecentEvents` (the activity
   * panels) hides it unless this is `true`, while `getEventStream` stays raw unless a caller
   * states `false`. Either way the `EventStore` keeps every event — a deletion is masked out
   * of a view, never out of history.
   */
  readonly includeDeleted?: boolean;
}

export interface AuditTargetClaim {
  readonly targetType: string;
  readonly targetId: string;
}

export interface AuditView {
  readonly auditId: string;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly actionType: string;
  readonly actionResource: string;
  readonly reason: string;
  readonly verdict: string;
  readonly commandId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly resultCode: string | null;
  readonly eventIds: readonly string[];
  readonly createdAtSim: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AuditTrailEntry {
  readonly audit: AuditView;
  readonly events: readonly EventView[];
}

/**
 * A control command that the existing `AuthzService` answered with `NEEDS_APPROVAL`:
 * the operator holds the grant but not enough decision power, so the request must be
 * escalated to the named approver instead of being silently dropped.
 */
export interface PendingApprovalView {
  readonly commandId: string;
  readonly commandType: string;
  readonly operatorId: string | null;
  readonly reason: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly requiredAuthority: number | null;
  readonly escalateTo: string | null;
  readonly createdAtSim: number;
  readonly eventId: string | null;
}

export interface ApprovalInbox {
  readonly pending: readonly PendingApprovalView[];
}

export interface AgentActivityEntry {
  readonly event: EventView;
  readonly role: 'input' | 'runtime' | 'decision' | 'plan' | 'action' | 'task' | 'workflow' | 'communication';
}

export interface AgentActivity {
  readonly agentId: EmployeeId;
  readonly entries: readonly AgentActivityEntry[];
  readonly cycles: readonly {
    readonly cycleId: string;
    readonly startedAtSim: number | null;
    readonly finishedAtSim: number | null;
    readonly presence: string | null;
  }[];
}

/**
 * Audit egress port. Shaped to be structurally satisfied by
 * `@maoeh/audit-system`'s `AuditService` (via a thin adapter in the composition root).
 * Audit is a log, never a second EventStore (BASELINE §14).
 */
export interface AuditPortRecord {
  readonly actorKind: 'employee' | 'human' | 'system';
  readonly actorId: string | null;
  readonly actionType: string;
  readonly actionReason: string;
  readonly actionResource: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly verdict: 'accepted' | 'rejected' | 'failed';
  readonly commandId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly resultCode: string | null;
  readonly eventIds: readonly string[];
  readonly createdAtSim: number;
  readonly details: Readonly<Record<string, unknown>>;
}

/** Read view of one audit record (structurally equal to the audit-system record view). */
export type AuditRecordLike = AuditView;

export interface AuditPort {
  /** Append one audit record and return its read view. */
  record(input: AuditPortRecord): AuditView;
  find(commandId: string): AuditView | null;
  trail(targetId: string): readonly AuditView[];
  recent(limit?: number): readonly AuditView[];
  forCorrelation(correlationId: string): readonly AuditView[];
}

/** Raw material a control plane needs from the running simulation. */
export interface SimulationSnapshot {
  readonly companyId: string;
  readonly tick: number;
  readonly simTime: number;
  readonly tickDuration: number;
  readonly paused: boolean;
  readonly budgets: SimulationStateView['budgets'];
  readonly lastTickStatus: string | null;
  readonly lastTickExceeded: readonly string[];
  readonly queueDepth: number;
  readonly pendingWakeups: number;
  readonly recovery: SimulationStateView['recovery'];
  readonly agentStateVersions: ReadonlyMap<EmployeeId, number>;
  readonly currentTaskIds: ReadonlyMap<EmployeeId, string>;
}

/**
 * M1.3 `Agent.Create` materialization request. The Control Plane states identity, position and
 * mandate; the Runtime resolves the profile/template defaults it owns.
 */
export interface CreateAgentRequest {
  readonly employeeId: string;
  readonly name: string;
  readonly positionId: string;
  readonly employeeNo: string | null;
  readonly responsibilities: readonly string[];
  readonly traits: readonly string[];
  /** Specializations stated by the operator; empty means "inherit the template". */
  readonly expertise: readonly string[];
  readonly cognitionProfileId: string | null;
  readonly templateEmployeeId: string | null;
  readonly simTime: SimTime;
  /** Present when the command also creates `positionId` (see `AgentCreateCommand.newPosition`). */
  readonly newPosition?: NewPositionSpec;
}

/** What the Runtime actually materialized (echoed into `Control.AgentCreated`). */
export interface AgentMaterialization {
  readonly employeeId: string;
  readonly name: string;
  readonly positionId: string;
  readonly employeeNo: string | null;
  readonly cognitionProfileId: string;
  /** The specializations the new employee actually carries (request, else template). */
  readonly expertise: readonly string[];
  /** Where the 8-layer structure came from: a template employee, or the request itself. */
  readonly definitionSource: string;
  readonly lifecycle: AgentLifecycleStatus;
  /** The seat this run added to the chart (`null` when the position already existed). */
  readonly createdPosition: {
    readonly positionId: string;
    readonly departmentId: string;
    readonly title: string;
    readonly capabilities: readonly string[];
    readonly reportsToPositionId: string | null;
  } | null;
}

export type AgentLifecycleFailureCode =
  | 'duplicate_employee'
  | 'duplicate_employee_no'
  | 'unknown_position'
  | 'unknown_department'
  | 'duplicate_position'
  | 'unknown_cognition_profile'
  | 'unknown_template'
  | 'unknown_agent'
  | 'already_archived'
  | 'instantiation_failed';

export type AgentLifecycleResult =
  | { readonly ok: true; readonly value: AgentMaterialization }
  | {
      readonly ok: false;
      readonly code: AgentLifecycleFailureCode;
      readonly reason: string;
    };

/**
 * The only way the control plane may affect the running simulation.
 * Implemented by the composition root (apps/kernel); the control plane never
 * reaches into runtime state directly (M1.0 first principle).
 */
export interface ControlSimulationPort {
  snapshot(): SimulationSnapshot;
  start(): Promise<{ readonly status: string; readonly tick: number }>;
  pause(): void;
  resume(): void;
  step(): Promise<{ readonly status: string; readonly tick: number; readonly paused: boolean }>;
  seek(tickNumber: number): void;
  isAgentPaused(employeeId: EmployeeId): boolean;
  setAgentPaused(employeeId: EmployeeId, paused: boolean): void;
  /**
   * Materialize a new agent (M1.3): the Runtime instantiates the 8-layer structure and places
   * the employee in the Organization. Mutating the roster is a Runtime act — the Control Plane
   * only asks for it, exactly as it does for `Agent.Pause`.
   */
  createAgent(request: CreateAgentRequest): AgentLifecycleResult;
  /** Archive an agent (M1.3): close its employment, cancel its pending wakeups, delete nothing. */
  archiveAgent(employeeId: EmployeeId): AgentLifecycleResult;
  /**
   * Ask the existing scheduler to wake this agent with a `MANUAL` wakeup whose source event is
   * `sourceEventId`. Used to deliver operator instructions: control events are deliberately not
   * wakeup-eligible, so the Control Plane cannot rely on ordinary event subscription.
   */
  wakeAgent(employeeId: EmployeeId, sourceEventId: string, refId: string): void;
  agentState(employeeId: EmployeeId): AgentStateView | null;
  organization(): import('@maoeh/organization-model').Organization;
  tasks(): readonly Task[];
  task(taskId: string): Task | null;
  workflows(): readonly WorkflowInstance[];
  workflow(instanceId: string): WorkflowInstance | null;
  tickDuration: number;
}
