import type { CorrelationId, EmployeeId, OrgEvent, SimTime } from '@maoeh/shared-types';
import type { AgentDefinition } from '@maoeh/agent-definition';
import type { CognitionExecutor, CognitionProfile } from '@maoeh/agent-cognition';
import type { PlanExecutor, RuntimeTurnContext } from '@maoeh/agent-runtime';
import { instantiateAgent, registerRuntimeEvents } from '@maoeh/agent-runtime';
import type {
  ChannelStore,
  CollaborationService,
  CommunicationIdentity,
  CommunicationService,
} from '@maoeh/agent-communication';
import {
  channelOpenedPayloadSchema,
  collaborationFromEvent,
  createChannel,
  createCommunicationService,
  createCollaborationService,
  createInMemoryChannelStore,
  createInMemoryCollaborationStore,
  createInMemoryDeliveryStore,
  createInMemoryMessageStore,
  isChannelOpenedEvent,
  isCollaborationRequestedEvent,
  isMessageProcessedEvent,
  isMessageSentEvent,
  registerCommunicationEvents,
} from '@maoeh/agent-communication';
import type { EventRegistry } from '@maoeh/event-system';
import { createEventRegistry, createOrgEvent } from '@maoeh/event-system';
import type { EventStore, Seq } from '@maoeh/event-store';
import { createInMemoryEventStore } from '@maoeh/event-store';
import type { Identity } from '@maoeh/identity-system';
import { createIdentity } from '@maoeh/identity-system';
import type { Employee, Organization } from '@maoeh/organization-model';
import { buildRuntimePosition } from '@maoeh/organization-model';
import type { AuthzService, PermissionPolicy } from '@maoeh/permission-system';
import { createAuthzService } from '@maoeh/permission-system';
import type {
  AgentLifecycleFailureCode,
  AgentLifecycleResult,
  CreateAgentRequest,
} from '@maoeh/organization-control';
import { ARCHIVED_EMPLOYMENT_STATUS, registerControlEvents } from '@maoeh/organization-control';
import type { BudgetTracker, ScheduleDefinition, Scheduler } from '@maoeh/runtime-scheduler';
import { createScheduler, createSimulationClock } from '@maoeh/runtime-scheduler';
import type { StateStore } from '@maoeh/runtime-state';
import {
  createInitialAgentState,
  createInMemoryStateStore,
  replayAgentState,
} from '@maoeh/runtime-state';
import type { TaskStore } from '@maoeh/task-system';
import {
  applyTaskEvent,
  createInMemoryTaskStore,
  createTaskService,
  registerTaskEvents,
} from '@maoeh/task-system';
import { createAuthorityService } from '@maoeh/authority-engine';
import type { WorkflowDefinition, WorkflowDefinitionStore, WorkflowInstanceStore } from '@maoeh/workflow-engine';
import {
  createInMemoryWorkflowDefinitionStore,
  createInMemoryWorkflowInstanceStore,
  createWorkflowEngine,
  HIRING_WORKFLOW_DEFINITION,
  regenerateWorkflowDefinition,
  registerWorkflowEvents,
  replayWorkflowInstance,
} from '@maoeh/workflow-engine';

import type { EligibilityDeps } from './eligibility.js';
import { registerSystemEvents, SYSTEM_SIM_CLOCK_TICKED } from './events.js';
import { createKernelPlanExecutor } from './plan-executor.js';
import type { AgentBundle, SimulationCore } from './run-tick.js';
import { runSimulationTick } from './run-tick.js';
import type {
  RecoveryReport,
  SimulationConfigOptions,
  SimulationTickResult,
} from './types.js';
import { resolveSimulationConfig } from './types.js';

export const DEFAULT_AGENT_POLICY: PermissionPolicy = {
  grants: [
    { subject: { kind: 'any' }, action: 'CreateProposal', resource: 'workflow:*' },
    { subject: { kind: 'any' }, action: 'ApproveStep', resource: 'workflow:*' },
    { subject: { kind: 'any' }, action: 'RejectStep', resource: 'workflow:*' },
    { subject: { kind: 'any' }, action: 'CastVote', resource: 'workflow:*' },
    { subject: { kind: 'any' }, action: 'FinalizeDecision', resource: 'workflow:*' },
    { subject: { kind: 'any' }, action: 'RequestDeviation', resource: 'workflow:*' },
    { subject: { kind: 'any' }, action: 'AcceptTask', resource: 'task:*' },
    { subject: { kind: 'any' }, action: 'StartTask', resource: 'task:*' },
    { subject: { kind: 'any' }, action: 'ProgressReport', resource: 'task:*' },
    { subject: { kind: 'any' }, action: 'SubmitReport', resource: 'task:*' },
    { subject: { kind: 'any' }, action: 'CompleteTask', resource: 'task:*' },
    { subject: { kind: 'any' }, action: 'RejectTask', resource: 'task:*' },
    { subject: { kind: 'any' }, action: 'BlockTask', resource: 'task:*' },
    { subject: { kind: 'any' }, action: 'ReviewProposal', resource: 'task:*' },
    // ADR-014: dispatching work needs org-domain authority ≥ 2, which in practice is the
    // manager seats — everyone else is refused by `DispatchWork`'s A1 gate inside
    // `TaskService.dispatch`, together with the reporting-subtree (A2) and no-upward (A3) rules.
    { subject: { kind: 'any' }, action: 'DispatchWork', resource: 'position:*', minAuthority: { domain: 'org', level: 2 } },
    // A2 (route A, role-agents-cannot-complete-tasks.md §9): hiring is an organizational act —
    // the seat must be inside the hirer's own reporting subtree, and a policy pattern can only
    // match `position:*`, so the subtree walk lives in the `agents.create` binding while the
    // org-domain threshold lives here (unmet ⇒ `NEEDS_APPROVAL`, escalating to the manager).
    { subject: { kind: 'any' }, action: 'ControlAgent', resource: 'position:*', minAuthority: { domain: 'org', level: 3 } },
    { subject: { kind: 'any' }, action: 'SendMessage', resource: 'channel:*' },
    // M3.1 collaboration handoff: asking a colleague to take work, and answering such a request.
    // The domain still decides who may ask (creator/executor) and which named employee may answer;
    // this grant is only the right to use the primitive at all, like every other task action.
    { subject: { kind: 'any' }, action: 'HandoffTask', resource: 'task:*' },
    { subject: { kind: 'any' }, action: 'UpdatePresence', resource: 'runtime:*' },
  ],
  denies: [],
};

export interface SimulationOptions {
  readonly organization: Organization;
  readonly agentDefinitions: readonly AgentDefinition[];
  readonly cognitionProfiles: readonly CognitionProfile[];
  readonly workflowDefinitions: readonly WorkflowDefinition[];
  readonly cognition: CognitionExecutor;
  readonly config: SimulationConfigOptions;
  readonly policy?: PermissionPolicy;
  /**
   * M1.9: capability-generated workflows start parked as drafts on the canvas — the human
   * confirms before the entry step is entered. The console sets this; headless kernels default
   * to immediate execution as before.
   */
  readonly requirePlanConfirmation?: boolean;
  readonly eventStore?: EventStore;
  readonly schedules?: readonly ScheduleDefinition[];
}

export interface Simulation {
  readonly config: ReturnType<typeof resolveSimulationConfig>;
  readonly scheduler: Scheduler;
  readonly registry: EventRegistry;
  readonly eventStore: EventStore;
  readonly stateStore: StateStore;
  readonly organization: Organization;
  readonly identity: Identity;
  readonly authz: AuthzService;
  readonly tasks: ReturnType<typeof createTaskService>;
  readonly workflow: ReturnType<typeof createWorkflowEngine>;
  readonly taskStore: TaskStore;
  readonly instanceStore: WorkflowInstanceStore;
  /** M1.8: the workflow definition store; the canvas projection reads definitions through it. */
  readonly definitions: WorkflowDefinitionStore;
  readonly communication: CommunicationService;
  readonly collaboration: CollaborationService;
  readonly agents: ReadonlyMap<EmployeeId, AgentBundle>;
  readonly lastTickMarker: OrgEvent | null;
  readonly lastTickResult: SimulationTickResult | null;
  readonly recovery: RecoveryReport;
  tick(): Promise<SimulationTickResult>;
  recover(): Promise<RecoveryReport>;
  inject(events: readonly OrgEvent[]): Promise<void>;
  /**
   * M1.3 · Agent Lifecycle Management — the Runtime's roster operations.
   *
   * `createAgent` is the same six-stage placement the company boots with (identity → placement →
   * 8-layer instantiation → schedulable agent), performed at runtime for one new employee.
   * `archiveAgent` closes an employment without deleting anything, and stops the scheduler from
   * waking the employee again. Both are called only through the Control Plane's port.
   */
  createAgent(request: CreateAgentRequest): AgentLifecycleResult;
  archiveAgent(employeeId: EmployeeId): AgentLifecycleResult;
  pause(): void;
  resume(): void;
  seek(tickNumber: number): void;
  /**
   * Control-plane overlay: apply operator pause/resume after a recovery replay.
   * Pausing one agent never pauses the simulation.
   */
  restorePausedAgents(employeeIds: readonly EmployeeId[]): void;
  isAgentPaused(employeeId: EmployeeId): boolean;
  pausedAgentIds(): readonly EmployeeId[];
}

function numericSuffix(id: string, prefix: string): number | null {
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  if (!/^\d+$/.test(rest)) return null;
  return Number(rest);
}

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Readonly<Record<string, unknown>>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readNumber(payload: unknown, key: string): number | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Readonly<Record<string, unknown>>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringArray(payload: unknown, key: string): readonly string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const value = (payload as Readonly<Record<string, unknown>>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/** Deterministic id of the company-wide channel every fresh simulation boots with. */
export function companyChannelId(companyId: string): string {
  return `company-${companyId}`;
}

/**
 * The employee who opens the company channel during company formation. The organization model
 * expresses "this role belongs to the whole company, not to a department" as a position without a
 * department, so that holder (the CEO in the seed) opens it; otherwise the roster's first member.
 * Returns `null` when the company has no employees at all.
 */
function companyChannelOpener(organization: Organization): EmployeeId | null {
  const companyLevel = organization.employees.find((employee) =>
    organization.positions.some(
      (position) => position.id === employee.positionId && position.departmentId === null,
    ),
  );
  const opener = companyLevel ?? organization.employees[0];
  return opener === undefined ? null : opener.id;
}

export async function createSimulation(
  options: SimulationOptions,
): Promise<Simulation> {
  const organization = options.organization;
  const config = resolveSimulationConfig({
    ...options.config,
    companyId: options.config.companyId ?? organization.company.id,
  });
  if (config.companyId !== organization.company.id) {
    throw new Error('config.companyId does not match the organization company id');
  }

  const registry: EventRegistry = createEventRegistry();
  for (const outcome of [
    registerTaskEvents(registry),
    registerWorkflowEvents(registry),
    registerCommunicationEvents(registry),
    registerRuntimeEvents(registry),
    registerSystemEvents(registry),
    registerControlEvents(registry),
  ]) {
    if (!outcome.ok) {
      throw new Error(
        `event registration failed: ${outcome.error.issues
          .map((issue) => `${issue.field}: ${issue.reason}`)
          .join(', ')}`,
      );
    }
  }

  const identity: Identity = createIdentity(organization);
  const authz = createAuthzService({
    organization,
    policy: options.policy ?? DEFAULT_AGENT_POLICY,
  });
  const eventStore: EventStore = options.eventStore ?? createInMemoryEventStore();

  let eventSeq = 0;
  let cycleSeq = 0;
  let requestSeq = 0;
  let turnSeq = 0;
  let taskSeq = 0;
  let instanceSeq = 0;
  let correlationSeq = 0;
  let collaborationSeq = 0;
  let handoffSeq = 0;
  let cursor = 0;
  let lastTickMarker: OrgEvent | null = null;
  let lastTickResult: SimulationTickResult | null = null;
  let lastRecovery: RecoveryReport | null = null;
  let ready = false;

  const nextEventId = (): string => `evt-${String((eventSeq += 1))}`;
  const nextCycleId = (): string => `cycle-${String((cycleSeq += 1))}`;
  const nextRequestId = (): string => `req-${String((requestSeq += 1))}`;
  const nextTaskId = (): string => `task-${String((taskSeq += 1))}`;
  const nextInstanceId = (): string => `instance-${String((instanceSeq += 1))}`;
  const nextCorrelationId = (): string => `corr-sim-${String((correlationSeq += 1))}`;
  const nextCollaborationId = (): string => `collab-${String((collaborationSeq += 1))}`;
  const nextHandoffId = (): string => `handoff-${String((handoffSeq += 1))}`;

  const taskStore: TaskStore = createInMemoryTaskStore();
  const tasks = createTaskService({
    organization,
    authz,
    registry,
    store: taskStore,
    eventIdGenerator: nextEventId,
    taskIdGenerator: nextTaskId,
    handoffIdGenerator: nextHandoffId,
  });

  const definitionStore = createInMemoryWorkflowDefinitionStore(options.workflowDefinitions);
  // A4: the hiring gate is a kernel-owned definition, always registered — a `RecommendHire`
  // opens it by id, so it must exist before recovery replays an instance that awaits it.
  definitionStore.save(HIRING_WORKFLOW_DEFINITION);
  const instanceStore: WorkflowInstanceStore = createInMemoryWorkflowInstanceStore();
  const workflow = createWorkflowEngine({
    organization,
    authz,
    registry,
    tasks,
    definitions: definitionStore,
    instances: instanceStore,
    eventIdGenerator: nextEventId,
    instanceIdGenerator: nextInstanceId,
    // M1.8: assignee-side authority checks for per-instance overrides.
    authority: createAuthorityService(organization),
  });

  const communicationIdentity: CommunicationIdentity = {
    resolve(employeeId) {
      const employee = organization.employees.find((entry) => entry.id === employeeId);
      if (employee === undefined) {
        return { ok: false, error: { code: 'unknown_employee', employeeId } };
      }
      const position = organization.positions.find((entry) => entry.id === employee.positionId);
      return {
        ok: true,
        value: {
          employeeId,
          positionId: employee.positionId,
          departmentId: position === undefined ? null : position.departmentId,
        },
      };
    },
  };

  const channelStore: ChannelStore = createInMemoryChannelStore();
  const communication: CommunicationService = createCommunicationService(
    {
      authz,
      identity: communicationIdentity,
      channels: channelStore,
      messages: createInMemoryMessageStore(),
      deliveries: createInMemoryDeliveryStore(),
      registry,
      companyId: config.companyId,
    },
    { eventIdGenerator: nextEventId },
  );

  /**
   * Collaboration records are log-derived read state, exactly like tasks and channels: the
   * service appends `Communication.CollaborationRequested`, recovery replays it into the store.
   */
  const collaborationStore = createInMemoryCollaborationStore();
  const collaboration: CollaborationService = createCollaborationService(
    {
      authz,
      identity: communicationIdentity,
      registry,
      store: collaborationStore,
      companyId: config.companyId,
    },
    { collaborationIdGenerator: nextCollaborationId, eventIdGenerator: nextEventId },
  );

  const stateStore: StateStore = createInMemoryStateStore();
  const pausedAgents = new Set<EmployeeId>();
  /**
   * Employees whose operator pause was lifted since the last tick. The runtime re-offers their
   * unconsumed work, so `Agent.Pause` defers work instead of dropping it.
   */
  const resumedAgents = new Set<EmployeeId>();
  const wakeupSource = new Map<string, OrgEvent>();

  /**
   * Replace the operator pause overlay. Any employee that was paused before and is not paused
   * now counts as resumed, which is the only signal the runtime needs: the control plane keeps
   * driving pause/resume purely as flags plus `Control.*` facts.
   */
  const setPausedAgents = (employeeIds: Iterable<EmployeeId>): void => {
    const next = new Set(employeeIds);
    for (const employeeId of pausedAgents) {
      if (!next.has(employeeId)) resumedAgents.add(employeeId);
    }
    pausedAgents.clear();
    for (const employeeId of next) pausedAgents.add(employeeId);
  };

  const pendingMarks = new Map<string, { eventId: string; employeeId: EmployeeId }>();
  const markKey = (employeeId: EmployeeId, eventId: string): string =>
    `${employeeId} ${eventId}`;

  const turnContext: RuntimeTurnContext = {
    isProcessed(employeeId, eventId) {
      return (
        pendingMarks.has(markKey(employeeId, eventId)) ||
        eventStore.isProcessed(config.consumerGroup, eventId, employeeId)
      );
    },
    markProcessed(employeeId, eventId) {
      pendingMarks.set(markKey(employeeId, eventId), { eventId, employeeId });
    },
    nextTurnId: () => `turn-${String((turnSeq += 1))}`,
    nextEventId,
  };

  const agents = new Map<EmployeeId, AgentBundle>();
  const profileById = new Map<string, CognitionProfile>(
    options.cognitionProfiles.map((profile) => [profile.id, profile]),
  );
  for (const definition of options.agentDefinitions) {
    const context = identity.actorContext(
      definition.employeeId,
      nextCorrelationId() as CorrelationId,
    );
    const instantiated = instantiateAgent(definition, context, 0 as SimTime);
    if (!instantiated.ok) {
      throw new Error(
        `agent ${definition.id} failed to instantiate: ${instantiated.error.issues
          .map((issue) => `${issue.field}: ${issue.reason}`)
          .join(', ')}`,
      );
    }
    const profile = profileById.get(definition.cognitionProfileId);
    if (profile === undefined) {
      throw new Error(
        `agent ${definition.id} references unknown cognition profile ${definition.cognitionProfileId}`,
      );
    }
    agents.set(definition.employeeId, { instance: instantiated.value, definition, profile });
  }

  const eligibilityDeps: EligibilityDeps = {
    companyId: config.companyId,
    organization,
    identity,
    authz,
    tasks,
    instances: instanceStore,
    definitions: definitionStore,
    controlState: {
      isAgentPaused: (employeeId) => pausedAgents.has(employeeId),
    },
  };

  const scheduler: Scheduler = createScheduler({
    companyId: config.companyId,
    clock: createSimulationClock({
      startTime: 0 as SimTime,
      tickDuration: config.tickDuration,
      startTick: config.startTick,
    }),
    schedules: options.schedules ?? config.schedules,
    wakeupIdGenerator: () => `wakeup-${String((requestSeq += 1))}`,
  });

  const retryCounts = new Map<string, number>();

  /**
   * M1.3 · Agent Lifecycle Management.
   *
   * `materializeAgent` is the runtime half of `Agent.Create`: it resolves the target position and
   * the 8-layer template, registers the identity, places the employee in the Organization and
   * instantiates the agent so the scheduler can wake it. Every failure is detected *before* the
   * roster changes, so a refused creation leaves the company exactly as it was.
   */
  const defaultCognitionProfileId = options.cognitionProfiles[0]?.id ?? '';

  /**
   * Where a new agent's capabilities / memory policy / tool policy (and any identity field the
   * operator did not state) come from: the position's current holder, otherwise the first agent
   * already placed in the position's department, otherwise the first deployed agent. An explicit
   * `templateEmployeeId` always wins. The rule is deterministic so a replay resolves the same
   * template the live path did.
   */
  const templateFor = (
    positionId: string,
    templateEmployeeId: string | null,
  ): AgentBundle | null => {
    if (templateEmployeeId !== null) return agents.get(templateEmployeeId as EmployeeId) ?? null;
    const bundles = [...agents.values()];
    const samePosition = bundles.find(
      (bundle) => String(bundle.definition.positionId) === positionId,
    );
    if (samePosition !== undefined) return samePosition;
    const departmentId = organization.positions.find(
      (entry) => String(entry.id) === positionId,
    )?.departmentId;
    if (departmentId !== null && departmentId !== undefined) {
      const sameDepartment = bundles.find(
        (bundle) => bundle.definition.departmentId === departmentId,
      );
      if (sameDepartment !== undefined) return sameDepartment;
    }
    return bundles[0] ?? null;
  };

  const materializeAgent = (request: CreateAgentRequest): AgentLifecycleResult => {
    const employeeId = request.employeeId as EmployeeId;
    let position = organization.positions.find(
      (entry) => String(entry.id) === request.positionId,
    );
    let createdPosition: (typeof organization.positions)[number] | null = null;
    if (position === undefined) {
      if (request.newPosition === undefined) {
        return {
          ok: false,
          code: 'unknown_position',
          reason: `position "${request.positionId}" does not exist in this organization`,
        };
      }
      // The console may ask for a seat the chart does not have yet ("Engineering" +
      // "Game Developer"): build it first (pure — the department must already exist, the id
      // must be free), push it only when every later step can succeed, and pop it on any
      // failure below so a refused creation leaves the chart exactly as it was.
      const built = buildRuntimePosition(organization, {
        positionId: request.positionId,
        title: request.newPosition.title,
        departmentId: request.newPosition.departmentId,
        ...(request.newPosition.capabilities === undefined
          ? {}
          : { capabilities: request.newPosition.capabilities }),
        ...(request.newPosition.reportsToPositionId === undefined
          ? {}
          : { reportsToPositionId: request.newPosition.reportsToPositionId }),
      });
      if (!built.ok) {
        return { ok: false, code: built.error.code, reason: built.error.reason };
      }
      position = built.value;
      createdPosition = position;
    } else if (request.newPosition !== undefined) {
      return {
        ok: false,
        code: 'duplicate_position',
        reason: `position "${request.positionId}" already exists in this organization`,
      };
    }
    if (createdPosition !== null) organization.positions.push(createdPosition);
    // Every refusal below undoes the seat this run added — a refused creation is invisible
    // on the chart, exactly like it is for the employee row.
    const refuse = (
      code: AgentLifecycleFailureCode,
      reason: string,
    ): AgentLifecycleResult => {
      if (createdPosition !== null) {
        const index = organization.positions.lastIndexOf(createdPosition);
        if (index >= 0) organization.positions.splice(index, 1);
      }
      return { ok: false, code, reason };
    };
    if (organization.employees.some((entry) => String(entry.id) === employeeId)) {
      return refuse(
        'duplicate_employee',
        `employee "${request.employeeId}" already exists in this organization`,
      );
    }
    if (
      request.employeeNo !== null &&
      organization.employees.some((entry) => entry.employeeNo === request.employeeNo)
    ) {
      return refuse(
        'duplicate_employee_no',
        `employee number "${request.employeeNo}" is already taken`,
      );
    }

    const template = templateFor(request.positionId, request.templateEmployeeId);
    if (request.templateEmployeeId !== null && template === null) {
      return refuse(
        'unknown_template',
        `template agent "${request.templateEmployeeId}" does not exist`,
      );
    }
    // Specializations are a fact about the *person*, and a definition carries none: the request's
    // list wins, otherwise we inherit from a template **only when that template is the current
    // holder of the requested seat** (hiring a second engineer from the engineer's seat).
    // `templateFor` also reaches a template through the department / first-agent fallback, and
    // those are *structural* stand-ins: borrowing their memory policy is right, borrowing their
    // person's specializations is not — the CEO's strategy skills must never become a frontend
    // engineer's. Normalized the same way the loader normalizes a seed employee, so the two paths
    // agree.
    const templateEmployeeIdOfTemplate =
      template === null ? null : String(template.definition.employeeId);
    const templateHoldsSeat =
      template !== null && String(template.definition.positionId) === String(position.id);
    const inheritedExpertise =
      templateEmployeeIdOfTemplate === null || !templateHoldsSeat
        ? []
        : (organization.employees.find(
            (entry) => String(entry.id) === templateEmployeeIdOfTemplate,
          )?.expertise ?? []);
    const expertise = Object.freeze(
      [
        ...new Set(
          (request.expertise.length > 0 ? request.expertise : inheritedExpertise).map((entry) =>
            entry.trim().toLowerCase(),
          ),
        ),
      ].filter((entry) => entry !== ''),
    );
    const cognitionProfileId =
      request.cognitionProfileId ?? template?.definition.cognitionProfileId ?? defaultCognitionProfileId;
    const profile = profileById.get(cognitionProfileId);
    if (profile === undefined) {
      return refuse(
        'unknown_cognition_profile',
        `cognition profile "${cognitionProfileId}" is not loaded`,
      );
    }

    const departmentId = position.departmentId ?? null;
    const definition: AgentDefinition = {
      id: `agent-${request.employeeId}`,
      employeeId,
      positionId: position.id,
      ...(departmentId === null ? {} : { departmentId }),
      identity: {
        name: request.name,
        ...(template?.definition.identity.description === undefined
          ? {}
          : { description: template.definition.identity.description }),
        traits:
          request.traits.length > 0
            ? request.traits
            : (template?.definition.identity.traits ?? []),
      },
      responsibilities:
        request.responsibilities.length > 0
          ? request.responsibilities
          : (template?.definition.responsibilities ?? []),
      // Capabilities, memory strategy and tool policy have no place in a create command: they are
      // the template's (a position's SOP), while permissions are never in a definition at all.
      capabilities: template?.definition.capabilities ?? {},
      cognitionProfileId,
      memoryPolicy: template?.definition.memoryPolicy ?? { retain: ['agent_lifecycle'] },
      toolPolicy: template?.definition.toolPolicy ?? { allowed: [] },
    };

    const employee: Employee = {
      id: employeeId,
      companyId: organization.company.id,
      positionId: position.id,
      ...(request.employeeNo === null ? {} : { employeeNo: request.employeeNo }),
      name: request.name,
      kind: 'agent',
      status: 'active',
      ...(expertise.length === 0 ? {} : { expertise }),
    };

    try {
      identity.register(employee);
    } catch (error) {
      return refuse(
        'duplicate_employee',
        error instanceof Error ? error.message : String(error),
      );
    }
    organization.employees.push(employee);

    const context = identity.actorContext(employeeId, nextCorrelationId() as CorrelationId);
    const instantiated = instantiateAgent(definition, context, request.simTime);
    if (!instantiated.ok) {
      // Unreachable while the definition is derived from the same position/department the
      // identity reports; the roster is restored so a refused creation is invisible.
      organization.employees.pop();
      return refuse(
        'instantiation_failed',
        instantiated.error.issues
          .map((issue) => `${issue.field}: ${issue.reason}`)
          .join('; '),
      );
    }
    agents.set(employeeId, { instance: instantiated.value, definition, profile });

    return {
      ok: true,
      value: {
        employeeId: String(employeeId),
        name: request.name,
        positionId: String(position.id),
        employeeNo: request.employeeNo,
        cognitionProfileId,
        // What the person actually carries (the request, else the seat holder's) — the fact the
        // event and a replay need to rebuild their matchable skill shape.
        expertise: [...expertise],
        definitionSource:
          template === null ? 'request' : String(template.definition.employeeId),
        lifecycle: 'active',
        createdPosition:
          createdPosition === null
            ? null
            : {
                positionId: String(createdPosition.id),
                departmentId: String(createdPosition.departmentId),
                title: createdPosition.title,
                capabilities: [...(createdPosition.capabilities ?? [])],
                reportsToPositionId:
                  createdPosition.reportsToPositionId === null
                    ? null
                    : String(createdPosition.reportsToPositionId),
              },
      },
    };
  };

  /**
   * `archiveAgent`: close the employment, cancel the wakeups that were already queued, keep
   * everything else. The eligibility filter (`NON_RUNNABLE_EMPLOYMENT`) keeps an `offboarded`
   * employee out of every future wakeup, so cancelling the queue is the only scheduling work.
   */
  const archiveAgent = (employeeId: EmployeeId): AgentLifecycleResult => {
    const employee = organization.employees.find((entry) => entry.id === employeeId);
    if (employee === undefined) {
      return {
        ok: false,
        code: 'unknown_agent',
        reason: `agent "${String(employeeId)}" does not exist in this organization`,
      };
    }
    if (employee.status === ARCHIVED_EMPLOYMENT_STATUS) {
      return {
        ok: false,
        code: 'already_archived',
        reason: `agent "${String(employeeId)}" is already archived`,
      };
    }
    for (const wakeup of scheduler.queue()) {
      if (wakeup.agentId === employeeId && wakeup.status === 'pending') {
        scheduler.cancel(wakeup.wakeupId);
      }
    }
    pausedAgents.delete(employeeId);
    employee.status = ARCHIVED_EMPLOYMENT_STATUS;
    return {
      ok: true,
      value: {
        employeeId: String(employeeId),
        name: employee.name,
        positionId: String(employee.positionId),
        employeeNo: employee.employeeNo ?? null,
        cognitionProfileId: agents.get(employeeId)?.definition.cognitionProfileId ?? '',
        expertise: [...(employee.expertise ?? [])],
        definitionSource: 'archive',
        lifecycle: 'archived',
        createdPosition: null,
      },
    };
  };

  /**
   * Roster projection for `recover()`. `Control.AgentCreated` carries everything the Runtime
   * needs to place the same agent again and `Control.AgentArchived` records the closure, so a
   * replay of the log rebuilds `organization.employees` exactly as the live path left it (A3:
   * every organization state change is an event).
   */
  const projectAgentRoster = (events: readonly OrgEvent[]): void => {
    for (const event of events) {
      if (event.type !== 'Control.AgentCreated' && event.type !== 'Control.AgentArchived') {
        continue;
      }
      const agentId = readString(event.payload, 'agentId');
      if (agentId === null) continue;
      if (event.type === 'Control.AgentCreated') {
        if (organization.employees.some((entry) => String(entry.id) === agentId)) continue;
        const name = readString(event.payload, 'name');
        const positionId = readString(event.payload, 'positionId');
        if (name === null || positionId === null) continue;
        // A seat created together with this agent rides on the event (A3), so the replay
        // rebuilds the chart row before the employee lands in it.
        const rawPosition = (event.payload as Record<string, unknown>)['position'];
        const newPosition =
          typeof rawPosition === 'object' && rawPosition !== null && !Array.isArray(rawPosition)
            ? {
                departmentId: readString(rawPosition as Record<string, unknown>, 'departmentId'),
                title: readString(rawPosition as Record<string, unknown>, 'title'),
                capabilities: readStringArray(
                  rawPosition as Record<string, unknown>,
                  'capabilities',
                ),
                reportsToPositionId: readString(
                  rawPosition as Record<string, unknown>,
                  'reportsToPositionId',
                ),
              }
            : null;
        materializeAgent({
          employeeId: agentId,
          name,
          positionId,
          employeeNo: readString(event.payload, 'employeeNo'),
          responsibilities: readStringArray(event.payload, 'responsibilities'),
          traits: readStringArray(event.payload, 'traits'),
          expertise: readStringArray(event.payload, 'expertise'),
          cognitionProfileId: readString(event.payload, 'cognitionProfileId'),
          templateEmployeeId: readString(event.payload, 'templateEmployeeId'),
          simTime: event.occurredAtSim,
          ...(newPosition === null ||
          newPosition.departmentId === null ||
          newPosition.title === null
            ? {}
            : {
                newPosition: {
                  departmentId: newPosition.departmentId,
                  title: newPosition.title,
                  capabilities: newPosition.capabilities,
                  reportsToPositionId: newPosition.reportsToPositionId,
                },
              }),
        });
        continue;
      }
      const employee = organization.employees.find((entry) => String(entry.id) === agentId);
      if (employee !== undefined) employee.status = ARCHIVED_EMPLOYMENT_STATUS;
    }
  };

  const core: SimulationCore = {
    config,
    scheduler,
    registry,
    eventStore,
    stateStore,
    identity,
    organization,
    authz,
    tasks,
    instances: instanceStore,
    definitions: definitionStore,
    workflow,
    communication,
    collaboration,
    cognition: options.cognition,
    planExecutorFactory: (budget: BudgetTracker): PlanExecutor =>
      createKernelPlanExecutor({
        tasks,
        workflow,
        communication,
        collaboration,
        budget,
        authz,
        organization,
        instances: instanceStore,
        ...(options.requirePlanConfirmation === undefined
          ? {}
          : { requirePlanConfirmation: options.requirePlanConfirmation }),
      }),
    turnContext,
    agents,
    eligibilityDeps,
    wakeupSource,
    stallHeartbeats: new Map(),
    stallBootstrapped: false,
    taskContinuations: new Map(),
    createAgent: materializeAgent,
    cursor: () => cursor,
    nextEventId,
    nextCycleId,
    nextRequestId,
    resetRetry(employeeId, eventId) {
      retryCounts.delete(`${employeeId} ${eventId}`);
    },
    bumpRetry(employeeId, eventId) {
      const key = `${employeeId} ${eventId}`;
      const attempt = (retryCounts.get(key) ?? 0) + 1;
      retryCounts.set(key, attempt);
      return attempt;
    },
    flushProcessedMarks() {
      for (const entry of pendingMarks.values()) {
        eventStore.markProcessed(config.consumerGroup, entry.eventId, entry.employeeId);
      }
      pendingMarks.clear();
    },
    drainResumedAgents() {
      const resumed = Object.freeze([...resumedAgents]);
      resumedAgents.clear();
      return resumed;
    },
  };

  const allStoredEvents = async (): Promise<readonly OrgEvent[]> => {
    const collected: OrgEvent[] = [];
    for await (const event of eventStore.replay(1 as Seq)) {
      collected.push(event);
    }
    return collected;
  };

  /**
   * Channels are in-memory state whose source of truth is the log: like tasks, workflow
   * instances and agent state, they are rebuilt from their own events during recovery.
   */
  const projectChannels = (events: readonly OrgEvent[]): void => {
    for (const event of events) {
      if (!isChannelOpenedEvent(event.type)) continue;
      const parsed = channelOpenedPayloadSchema.safeParse(event.payload);
      if (!parsed.success) continue;
      channelStore.save(
        createChannel({
          channelId: parsed.data.channelId,
          channelType: parsed.data.channelType,
          memberAgentIds: parsed.data.memberIds as readonly string[] as readonly EmployeeId[],
          createdBy: parsed.data.createdBy as EmployeeId,
          createdAtSim: event.occurredAtSim,
        }),
      );
    }
  };

  /**
   * Collaboration records are in-memory state whose source of truth is the log: a restart
   * rebuilds "who asked whom, and for what" from `Communication.CollaborationRequested`.
   */
  const projectCollaborations = (events: readonly OrgEvent[]): void => {
    for (const event of events) {
      if (!isCollaborationRequestedEvent(event.type)) continue;
      const rebuilt = collaborationFromEvent(event);
      if (!rebuilt.ok) continue;
      collaborationStore.save(rebuilt.value);
    }
  };

  /**
   * M3.1: messages, their delivery ledger and their processing state are derived state too. A
   * restarted kernel that forgot them could neither trace an in-flight message nor honour a
   * sender's dedupe key, and the delivery ledger would report "nothing was ever delivered". The
   * projection is idempotent and writes no events; channels are projected before this so a
   * delivery can resolve its channel.
   */
  const projectMessages = (events: readonly OrgEvent[]): void => {
    for (const event of events) {
      if (!isMessageSentEvent(event.type)) continue;
      communication.restoreMessage(event);
    }
  };

  const projectDeliveries = (events: readonly OrgEvent[]): void => {
    for (const event of events) {
      if (!isMessageSentEvent(event.type)) continue;
      communication.deliverFromEvent(event);
    }
  };

  const projectMessageProcessing = (events: readonly OrgEvent[]): void => {
    for (const event of events) {
      if (!isMessageProcessedEvent(event.type)) continue;
      communication.restoreProcessing(event);
    }
  };

  /**
   * Company formation. A fresh company is not a mute company: it boots with one company-wide
   * channel, opened through the existing `Comm.openChannel` primitive and recorded as
   * `Communication.ChannelOpened`, so agents can `SendMessage` without an out-of-band setup step
   * (M1.0.1 K1). Idempotent: it opens nothing when the log already records the channel, which
   * keeps a restarted kernel (and recovery parity) byte-identical to a continuous run.
   *
   * Runs **after** `recover()`, and that order is load bearing: a starter company is founded with
   * one employee (the CEO), and every colleague is a `Control.AgentCreated` fact replayed during
   * recovery. Opening the channel before the replay found a one-member roster — below the
   * channel contract's minimum of two — and silently returned, so the live company ran with no
   * channel at all and every agent `SendMessage` would have failed with `unknown_channel`.
   */
  const bootstrapCompanyChannel = async (): Promise<void> => {
    const channelId = companyChannelId(String(config.companyId));
    const stored = await allStoredEvents();
    const alreadyOpened = stored.some(
      (event) =>
        isChannelOpenedEvent(event.type) && readString(event.payload, 'channelId') === channelId,
    );
    if (alreadyOpened) return;

    const memberIds = organization.employees.map((employee) => employee.id);
    const opener = companyChannelOpener(organization);
    // The channel contract itself requires at least two unique members.
    if (opener === null || memberIds.length < 2) return;

    const opened = communication.createChannel({
      channelId,
      channelType: 'group',
      memberIds,
      actor: identity.actorContext(
        opener,
        `corr-company-formation-${String(config.companyId)}` as CorrelationId,
      ),
      simTime: scheduler.clock.simTime,
    });
    if (!opened.ok) return;
    await eventStore.append([opened.value.event]);
  };

  const seedCounters = (events: readonly OrgEvent[]): void => {
    for (const event of events) {
      const eventId = numericSuffix(event.eventId, 'evt-');
      if (eventId !== null && eventId > eventSeq) eventSeq = eventId;
      const taskId = readString(event.payload, 'taskId');
      if (taskId !== null) {
        const value = numericSuffix(taskId, 'task-');
        if (value !== null && value > taskSeq) taskSeq = value;
      }
      const instanceId = readString(event.payload, 'instanceId');
      if (instanceId !== null) {
        const value = numericSuffix(instanceId, 'instance-');
        if (value !== null && value > instanceSeq) instanceSeq = value;
      }
      const collaborationId = readString(event.payload, 'collaborationId');
      if (collaborationId !== null) {
        const value = numericSuffix(collaborationId, 'collab-');
        if (value !== null && value > collaborationSeq) collaborationSeq = value;
      }
      const handoffId = readString(event.payload, 'handoffId');
      if (handoffId !== null) {
        const value = numericSuffix(handoffId, 'handoff-');
        if (value !== null && value > handoffSeq) handoffSeq = value;
      }
      const cycleId = readString(event.payload, 'cycleId');
      if (cycleId !== null) {
        const value = numericSuffix(cycleId, 'cycle-');
        if (value !== null && value > cycleSeq) cycleSeq = value;
      }
    }
  };

  const recover = async (): Promise<RecoveryReport> => {
    const events = await allStoredEvents();
    seedCounters(events);

    const taskGroups = new Map<string, readonly OrgEvent[]>();
    const instanceGroups = new Map<string, readonly OrgEvent[]>();
    const agentGroups = new Map<EmployeeId, readonly OrgEvent[]>();
    const append = <K>(map: Map<K, readonly OrgEvent[]>, key: K, event: OrgEvent): void => {
      map.set(key, [...(map.get(key) ?? []), event]);
    };

    for (const event of events) {
      if (event.type.startsWith('Task.')) {
        const taskId = readString(event.payload, 'taskId');
        if (taskId !== null) append(taskGroups, taskId, event);
        continue;
      }
      if (event.type.startsWith('Workflow.')) {
        const instanceId = readString(event.payload, 'instanceId');
        if (instanceId !== null) append(instanceGroups, instanceId, event);
        continue;
      }
      if (
        event.type.startsWith('Runtime.') &&
        event.subjectType === 'employee' &&
        event.subjectId !== null &&
        agents.has(event.subjectId as EmployeeId)
      ) {
        append(agentGroups, event.subjectId as EmployeeId, event);
      }
    }

    for (const [taskId, group] of taskGroups) {
      let task = null;
      for (const event of group) task = applyTaskEvent(task, event);
      if (task !== null && task.taskId === taskId) taskStore.save(task);
    }
    for (const [, group] of instanceGroups) {
      const instance = replayWorkflowInstance(group);
      if (instance === null) continue;
      instanceStore.save(instance);
      // A generated definition is derived state: the capability plan the started-instance
      // event carried rebuilds it, so a restart does not strand a running instance.
      if (definitionStore.get(instance.workflowId) === null) {
        const regenerated = regenerateWorkflowDefinition(
          instance,
          organization.positions
            .filter((position) => position.reportsToPositionId === null)
            .map((position) => String(position.id)),
        );
        if (regenerated !== null) definitionStore.save(regenerated);
      }
    }
    for (const [employeeId, group] of agentGroups) {
      if (stateStore.load(employeeId).version !== 0) continue;
      const replayed = replayAgentState(createInitialAgentState(employeeId), group);
      stateStore.commit(replayed, 0);
    }
    projectChannels(events);
    projectMessages(events);
    projectDeliveries(events);
    projectMessageProcessing(events);
    projectCollaborations(events);
    // M1.3: agents born / archived at runtime are facts on the log, so a replay restores them
    // before the tick markers decide the cursor.
    projectAgentRoster(events);

    const markers = events.filter((event) => event.type === SYSTEM_SIM_CLOCK_TICKED);
    const lastMarker = markers.length === 0 ? null : (markers[markers.length - 1] ?? null);

    if (lastMarker === null) {
      const bootSimTime = scheduler.clock.at(config.startTick);
      const created = createOrgEvent(
        registry,
        {
          companyId: config.companyId,
          type: SYSTEM_SIM_CLOCK_TICKED,
          occurredAtSim: bootSimTime,
          actorKind: 'system',
          actorId: 'kernel-scheduler',
          subjectType: 'system',
          subjectId: String(config.companyId),
          correlationId: nextCorrelationId() as CorrelationId,
          payload: {
            tickNumber: config.startTick,
            simTime: Number(bootSimTime),
            windowStartSim: Number(bootSimTime),
            deltaSim: config.tickDuration,
            status: 'ok',
            cursorSeq: 0,
            inputEventCount: 0,
            wakeupCount: 0,
            turnCount: 0,
            emittedCount: 0,
          },
        },
        { eventIdGenerator: nextEventId },
      );
      if (!created.ok) {
        throw new Error(
          `boot marker contract violation: ${created.error.issues
            .map((issue) => `${issue.field}: ${issue.reason}`)
            .join(', ')}`,
        );
      }
      cursor = 0;
      lastTickMarker = created.value;
      ready = true;
      lastRecovery = {
        cursor,
        tickNumber: config.startTick,
        taskCount: taskStore.all().length,
        workflowInstanceCount: instanceStore.all().length,
        agentStateCount: agentGroups.size,
        eventCount: events.length,
      };
      return lastRecovery;
    }

    const tickNumber = readNumber(lastMarker.payload, 'tickNumber') ?? config.startTick;
    cursor = readNumber(lastMarker.payload, 'cursorSeq') ?? Number(lastMarker.seq);
    lastTickMarker = lastMarker;
    scheduler.seek(scheduler.clock.at(tickNumber));
    ready = true;
    lastRecovery = {
      cursor,
      tickNumber,
      taskCount: taskStore.all().length,
      workflowInstanceCount: instanceStore.all().length,
      agentStateCount: agentGroups.size,
      eventCount: events.length,
    };
    return lastRecovery;
  };

  /**
   * Rebuild the operator pause overlay from `Control.AgentPaused` / `Control.AgentResumed`
   * so that a pause survives recovery. Only the control plane's own events are read.
   */
  const restoreControlOverlay = (events: readonly OrgEvent[]): void => {
    const restored = new Set<EmployeeId>();
    for (const event of events) {
      const payload = event.payload;
      if (typeof payload !== 'object' || payload === null) continue;
      const agentId = (payload as Readonly<Record<string, unknown>>)['agentId'];
      if (typeof agentId !== 'string' || agentId === '') continue;
      if (event.type === 'Control.AgentPaused') restored.add(agentId as EmployeeId);
      else if (event.type === 'Control.AgentResumed') restored.delete(agentId as EmployeeId);
    }
    setPausedAgents(restored);
  };

  /**
   * Ticks are serialised. The background tick driver, `POST /api/tick` and the control
   * plane's `Step`/`Start` all reach `Simulation.tick()`, and `runSimulationTick` yields
   * at every await (event replay, cognition, plan execution), so two concurrent ticks
   * would read the same cursor, double-dispatch the same wakeups and append two markers
   * for one tick number. Queueing callers behind the tick in flight keeps the cursor,
   * the wakeup queue and the marker sequence strictly ordered.
   */
  let tickChain: Promise<unknown> = Promise.resolve();
  const runTickOnce = async (): Promise<SimulationTickResult> => {
    if (!ready) await recover();
    const outcome = await runSimulationTick(core, lastTickMarker);
    if (outcome.tickMarker !== null) lastTickMarker = outcome.tickMarker;
    cursor = outcome.result.cursor;
    lastTickResult = outcome.result;
    return outcome.result;
  };

  const simulation: Simulation = {
    config,
    scheduler,
    registry,
    eventStore,
    stateStore,
    organization,
    identity,
    authz,
    tasks,
    workflow,
    taskStore,
    instanceStore,
    // M1.8: the canvas projection reads the definitions of running instances through this.
    definitions: definitionStore,
    communication,
    collaboration,
    agents,
    get lastTickMarker() {
      return lastTickMarker;
    },
    get lastTickResult() {
      return lastTickResult;
    },
    get recovery() {
      if (lastRecovery === null) throw new Error('simulation has not been recovered');
      return lastRecovery;
    },
    tick(): Promise<SimulationTickResult> {
      const queued = tickChain.then(runTickOnce, runTickOnce);
      tickChain = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    recover,
    async inject(events) {
      if (events.length === 0) return;
      await eventStore.append(events);
    },
    createAgent(request) {
      return materializeAgent(request);
    },
    archiveAgent(employeeId) {
      return archiveAgent(employeeId);
    },
    pause() {
      scheduler.pause();
    },
    resume() {
      scheduler.resume();
    },
    seek(tickNumber) {
      scheduler.seek(scheduler.clock.at(tickNumber));
    },
    restorePausedAgents(employeeIds) {
      setPausedAgents(employeeIds);
    },
    isAgentPaused(employeeId) {
      return pausedAgents.has(employeeId);
    },
    pausedAgentIds() {
      return Object.freeze([...pausedAgents]);
    },
  };

  // Recovery precedes company formation: replaying the log is what restores a starter company's
  // roster, and the channel's member list is read from that roster. A restarted kernel rebuilds
  // the channel from its own record instead, so the sequence stays idempotent.
  await recover();
  await bootstrapCompanyChannel();
  await restoreControlOverlay(await allStoredEvents());
  return simulation;
}
