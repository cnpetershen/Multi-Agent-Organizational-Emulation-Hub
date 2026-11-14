import type {
  ActorContext,
  AgendaItem,
  CompanyId,
  DepartmentId,
  EmployeeId,
  EmploymentStatus,
  OrgEvent,
  PositionId,
  PresenceState,
  SimTime,
} from '@maoeh/shared-types';
import type { AgentDefinition } from '@maoeh/agent-definition';

export interface CognitionAgentRef {
  readonly id: string;
  readonly definitionId: string;
  readonly employeeId: EmployeeId;
}

export interface CognitionStateView {
  readonly employeeId: EmployeeId;
  readonly version: number;
  readonly employment: EmploymentStatus;
  readonly presence: PresenceState;
  readonly currentCycleId: string | null;
  readonly agenda: readonly AgendaItem[];
  readonly updatedAtSim: SimTime;
  /**
   * This agent's own open tasks, resolved live at cycle start.
   *
   * Without this, a woken agent has no idea which of its tasks are still open — it guesses, and
   * in live mode the guess is almost always wrong ("still needs accept" on an accepted task).
   * The status travels with the task so the model can choose the legal next transition.
   */
  readonly assignedTasks?: readonly AssignedTaskView[];
}

export interface OrgMemberView {
  readonly id: EmployeeId;
  readonly name: string;
}

/** One assigned open task visible to the agent — title, goal, current status, and what proves done. */
export interface AssignedTaskView {
  readonly taskId: string;
  readonly title: string;
  readonly goal: string;
  readonly status: string;
  /** When present, the literal `requiredOutputKeys.data` the deterministic verifier expects. */
  readonly verificationKeys?: readonly string[];
  /**
   * The task commands this status accepts right now, from the task state machine itself.
   *
   * A live planner that could not see that `submit` requires `started` planned
   * `AcceptTask` + `SubmitReport` and spent four retries on `invalid_transition`. The runtime
   * passes the legal set in; the prompt renders it; cognition never has to encode the machine.
   */
  readonly allowedCommands?: readonly string[];
}

/** One seat that provides a capability — enough for a planner to see who can do the work. */
export interface CapabilitySeatView {
  readonly id: PositionId;
  readonly title: string;
  /** `true` when someone can currently carry this seat's work. */
  readonly staffed: boolean;
  /**
   * The staffed seat this one's work escalates to for *this* viewer — the "seat is vacant, the
   * boss covers it" walk the capability router performs (`resolveCapabilityAssignments`), with
   * the viewer's own seat excluded exactly as a dispatcher's seat is excluded. A staffed seat
   * reports itself. `null` means nobody outside the viewer's seat can carry it, and only that
   * combination — not mere vacancy — leaves a capability with no executor and makes a
   * `RecommendHire` the honest next step.
   */
  readonly coveredBy?: PositionId | null;
}

/** A capability this organization provides, and the seats that declare it. */
export interface CapabilityOfferView {
  readonly capability: string;
  readonly seats: readonly CapabilitySeatView[];
}

export interface OrganizationSnapshotView {
  readonly company: {
    readonly id: CompanyId;
    readonly name: string;
  };
  readonly department: {
    readonly id: DepartmentId;
    readonly name: string;
  } | null;
  readonly position: {
    readonly id: PositionId;
    readonly title: string;
    /** Capability tags this seat provides — the basis for capability → position routing. */
    readonly capabilities?: readonly string[];
  };
  /**
   * Every capability the *organization* provides, with the seats that provide it (the seats
   * that declare it in `Position.capabilities`).
   *
   * `position.capabilities` above answers "what can *I* do". This answers "what can *we* do",
   * which is what a planner needs: without it an agent — including the CEO decomposing a task
   * book — sees only its own seat's tags and cannot stack the capabilities the organization
   * actually holds. Derived from the live chart, so an `Agent.Create` seat shows up here too.
   */
  readonly capabilityMap?: readonly CapabilityOfferView[];
  readonly employee: OrgMemberView;
  readonly manager: OrgMemberView | null;
  readonly reports: readonly OrgMemberView[];
  readonly peers: readonly OrgMemberView[];
  readonly colleagues: readonly OrgMemberView[];
}

/**
 * Pure-data view of the work this organization can start and is already running (M1.4 §5.6).
 *
 * Assembled by the composition root from live kernel state and injected here, so `agent-cognition`
 * stays free of `workflow-engine`/`permission-system` dependencies and prompts never hardcode
 * permission rules.
 */
export interface WorkCatalogView {
  readonly workflows: readonly {
    readonly workflowId: string;
    readonly title: string;
    readonly goal: string;
    readonly stepCount: number;
    readonly approvalGateCount: number;
  }[];
  readonly positions: readonly {
    readonly positionId: PositionId;
    readonly title: string;
    readonly departmentId: DepartmentId | null;
    readonly authorityLevel: number;
    readonly openTaskCount: number;
  }[];
  readonly inFlightWorkflows: number;
  /** Whether *this* agent's seat may dispatch work — computed by the composition root from the real policy, so prompts never hardcode permission rules. */
  readonly canDispatchWork: boolean;
}

/**
 * One channel this agent belongs to — the id it must name in `SendMessage`, and who else is on it.
 *
 * The channel is the whole reason a live planner could not communicate before: the executor
 * required a `channelId`, the prompt never carried one, and a model cannot invent an id that the
 * `CommunicationService` will accept. Only channels the agent is actually a member of are listed,
 * so the prompt never suggests a send that authorization would refuse.
 */
export interface CommunicationChannelView {
  readonly channelId: string;
  readonly channelType: string;
  readonly memberIds: readonly EmployeeId[];
}

/** One message already on a channel — enough to answer a colleague without guessing sender or channel. */
export interface CommunicationMessageView {
  readonly messageId: string;
  readonly channelId: string;
  readonly senderId: EmployeeId;
  readonly recipientIds: readonly EmployeeId[];
  readonly subject: string;
  readonly body: string;
  readonly messageType: string;
  readonly createdAtSim: SimTime;
}

/**
 * The conversation surface this agent may act on, assembled by the composition root from the live
 * `CommunicationService` (M-COMMUNICATION: make the existing service reachable from cognition).
 *
 * Absent means "this agent has no channel" and renders nothing — a fresh company before its
 * company channel exists, or any runtime composed without communication.
 */
export interface CommunicationView {
  readonly channels: readonly CommunicationChannelView[];
  readonly recentMessages: readonly CommunicationMessageView[];
}

export interface CognitionContext {
  readonly agent: CognitionAgentRef;
  readonly definition: AgentDefinition;
  readonly actorContext: ActorContext;
  readonly state: CognitionStateView;
  readonly inputEvent: OrgEvent;
  readonly organization: OrganizationSnapshotView;
  readonly workCatalog?: WorkCatalogView;
  readonly communication?: CommunicationView;
  readonly simTime: SimTime;
  readonly memoryContext?: Readonly<Record<string, unknown>>;
  readonly knowledgeContext?: Readonly<Record<string, unknown>>;
}
