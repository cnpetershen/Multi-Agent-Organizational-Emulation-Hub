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
}

export interface OrgMemberView {
  readonly id: EmployeeId;
  readonly name: string;
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

export interface CognitionContext {
  readonly agent: CognitionAgentRef;
  readonly definition: AgentDefinition;
  readonly actorContext: ActorContext;
  readonly state: CognitionStateView;
  readonly inputEvent: OrgEvent;
  readonly organization: OrganizationSnapshotView;
  readonly workCatalog?: WorkCatalogView;
  readonly simTime: SimTime;
  readonly memoryContext?: Readonly<Record<string, unknown>>;
  readonly knowledgeContext?: Readonly<Record<string, unknown>>;
}
