import type {
  ActorContext,
  CompanyId,
  CorrelationId,
  EmployeeId,
  OrgEvent,
  Result,
  SimTime,
} from '@maoeh/shared-types';
import type { EventRegistry } from '@maoeh/event-system';
import { createEventRegistry } from '@maoeh/event-system';
import type { Identity } from '@maoeh/identity-system';
import { createIdentity } from '@maoeh/identity-system';
import type { Organization } from '@maoeh/organization-model';
import { loadOrganization } from '@maoeh/organization-model';
import type { AuthzService, CommandActor, PermissionPolicy } from '@maoeh/permission-system';
import type { AuthorityService } from '@maoeh/authority-engine';
import { createAuthzService, employeeActor } from '@maoeh/permission-system';
import type { Task, TaskService, TaskStore } from '@maoeh/task-system';
import { createInMemoryTaskStore, createTaskService, registerTaskEvents } from '@maoeh/task-system';
import type {
  WorkflowDefinition,
  WorkflowDefinitionStore,
  WorkflowEngine,
  WorkflowInstance,
  WorkflowInstanceStore,
} from '@maoeh/workflow-engine';
import {
  createInMemoryWorkflowDefinitionStore,
  createInMemoryWorkflowInstanceStore,
  createWorkflowEngine,
  loadWorkflowDefinitions,
  registerWorkflowEvents,
} from '@maoeh/workflow-engine';
import { seedRoot } from './communication-fixtures';
import { createNodeFsOrganizationReader } from './organization-readers';
import { createNodeFsWorkflowReader } from './workflow-readers';

export const sim = (minutes: number): SimTime => minutes as SimTime;

const eid = (value: string): EmployeeId => value as EmployeeId;

export function must<T>(result: Result<T, unknown>, label: string): T {
  if (result.ok) return result.value;
  const error = result.error as {
    readonly code?: string;
    readonly issues?: readonly { readonly field: string; readonly reason: string }[];
  };
  const issues =
    error.issues === undefined
      ? JSON.stringify(result.error)
      : error.issues.map((issue) => `${issue.field}: ${issue.reason}`).join(', ');
  throw new Error(`${label} failed${error.code === undefined ? '' : ` [${error.code}]`}: ${issues}`);
}

export const workflowTestPolicy: PermissionPolicy = {
  grants: [
    { subject: { kind: 'any' }, action: 'CreateProposal', resource: 'workflow:*' },
    { subject: { kind: 'any' }, action: 'ApproveStep', resource: 'workflow:*' },
    { subject: { kind: 'any' }, action: 'RejectStep', resource: 'workflow:*' },
    { subject: { kind: 'any' }, action: 'FinalizeDecision', resource: 'workflow:*' },
    { subject: { kind: 'any' }, action: 'RequestDeviation', resource: 'workflow:*' },
    { subject: { kind: 'any' }, action: 'AcceptTask', resource: 'task:*' },
    { subject: { kind: 'any' }, action: 'StartTask', resource: 'task:*' },
    { subject: { kind: 'any' }, action: 'ProgressReport', resource: 'task:*' },
    { subject: { kind: 'any' }, action: 'CompleteTask', resource: 'task:*' },
    { subject: { kind: 'any' }, action: 'RejectTask', resource: 'task:*' },
    { subject: { kind: 'any' }, action: 'BlockTask', resource: 'task:*' },
    { subject: { kind: 'any' }, action: 'ReviewProposal', resource: 'task:*' },
  ],
  denies: [],
};

export function loadSeedOrganization(): Organization {
  const result = loadOrganization(createNodeFsOrganizationReader(seedRoot));
  if (!result.ok) {
    throw new Error(
      `seed organization failed: ${result.error.issues
        .map((issue) => `${issue.source}:${issue.reason}`)
        .join(', ')}`,
    );
  }
  return result.value;
}

function loadSeedWorkflowDefinitions(): readonly WorkflowDefinition[] {
  const result = loadWorkflowDefinitions(createNodeFsWorkflowReader(), '');
  if (!result.ok) {
    throw new Error(
      `seed workflows failed: ${result.error.issues
        .map((issue) => `${issue.field}: ${issue.reason}`)
        .join(', ')}`,
    );
  }
  return result.value;
}

export interface WorkflowFixtureOptions {
  readonly policy?: PermissionPolicy;
  readonly organization?: Organization;
  readonly definitions?: readonly WorkflowDefinition[];
  /** M1.8: pass-through for the assignee-side authority check in overrideAssignments. */
  readonly authority?: AuthorityService;
}

export interface WorkflowFixture {
  readonly organization: Organization;
  readonly identity: Identity;
  readonly registry: EventRegistry;
  readonly authz: AuthzService;
  readonly tasks: TaskService;
  readonly engine: WorkflowEngine;
  readonly taskStore: TaskStore;
  readonly definitionStore: WorkflowDefinitionStore;
  readonly instanceStore: WorkflowInstanceStore;
  readonly sink: readonly OrgEvent[];
  readonly companyId: CompanyId;
  readonly ceo: ActorContext;
  readonly cto: ActorContext;
  readonly engineer: ActorContext;
  readonly ceoActor: CommandActor;
  readonly ctoActor: CommandActor;
  readonly engineerActor: CommandActor;
  actor(employeeId: EmployeeId): CommandActor;
  /**
   * The actor that owns a task right now. Workflow mechanics tests drive a *task*, not a seat:
   * which seat a step resolves to is routing's business (and `Position.capabilities`' decision),
   * so a helper that hardcodes an employee breaks the moment routing picks someone else.
   */
  executorActor(taskId: string): CommandActor;
  record<T extends { readonly events: readonly OrgEvent[] }>(operation: T): T;
  instance(instanceId: string): WorkflowInstance | null;
  currentTask(instanceId: string): Task | null;
}

export function createWorkflowFixture(options?: WorkflowFixtureOptions): WorkflowFixture {
  const organization = options?.organization ?? loadSeedOrganization();
  const identity = createIdentity(organization);
  const registry = createEventRegistry();

  const taskRegistration = registerTaskEvents(registry);
  if (!taskRegistration.ok) {
    throw new Error(
      `task event registration failed: ${taskRegistration.error.issues
        .map((issue) => `${issue.field}: ${issue.reason}`)
        .join(', ')}`,
    );
  }
  const workflowRegistration = registerWorkflowEvents(registry);
  if (!workflowRegistration.ok) {
    throw new Error(
      `workflow event registration failed: ${workflowRegistration.error.issues
        .map((issue) => `${issue.field}: ${issue.reason}`)
        .join(', ')}`,
    );
  }

  const authz = createAuthzService({
    organization,
    policy: options?.policy ?? workflowTestPolicy,
  });

  let eventSeq = 0;
  let taskSeq = 0;
  let instanceSeq = 0;
  let correlationSeq = 0;
  const nextEventId = (): string => `wf-evt-${++eventSeq}`;
  const nextTaskId = (): string => `task-${++taskSeq}`;
  const nextInstanceId = (): string => `instance-${++instanceSeq}`;
  const nextCorrelationId = (): CorrelationId => `corr-wf-${++correlationSeq}` as CorrelationId;

  const taskStore = createInMemoryTaskStore();
  const tasks = createTaskService({
    organization,
    authz,
    registry,
    store: taskStore,
    eventIdGenerator: nextEventId,
    taskIdGenerator: nextTaskId,
  });
  const definitionStore = createInMemoryWorkflowDefinitionStore(
    options?.definitions ?? loadSeedWorkflowDefinitions(),
  );
  const instanceStore = createInMemoryWorkflowInstanceStore();
  const engine = createWorkflowEngine({
    organization,
    authz,
    registry,
    tasks,
    definitions: definitionStore,
    instances: instanceStore,
    eventIdGenerator: nextEventId,
    instanceIdGenerator: nextInstanceId,
    // M1.8: assignee-side authority for override validation (absent → those checks fail closed).
    ...(options?.authority === undefined ? {} : { authority: options.authority }),
  });

  const sink: OrgEvent[] = [];
  const actor = (employeeId: EmployeeId): CommandActor =>
    employeeActor(identity.actorContext(employeeId, nextCorrelationId()));

  const contextOf = (employeeId: EmployeeId): ActorContext =>
    identity.actorContext(employeeId, nextCorrelationId());

  const instance = (instanceId: string): WorkflowInstance | null => instanceStore.get(instanceId);

  const currentTask = (instanceId: string): Task | null => {
    const state = instanceStore.get(instanceId);
    if (state === null) return null;
    for (const stepId of state.activeStepIds) {
      const stepState = state.stepStates[stepId];
      if (stepState === undefined || stepState.taskId === null) continue;
      const task = taskStore.get(stepState.taskId);
      if (task !== null) return task;
    }
    return null;
  };

  return {
    organization,
    identity,
    registry,
    authz,
    tasks,
    engine,
    taskStore,
    definitionStore,
    instanceStore,
    sink,
    companyId: organization.company.id,
    // Seat handles are resolved on access: a fixture may be handed a trimmed roster (one
    // employee, to prove routing falls back to the only seat), and building every seat eagerly
    // would fail on the employees the test deliberately removed.
    get ceo(): ActorContext {
      return contextOf(eid('ceo-alex'));
    },
    get cto(): ActorContext {
      return contextOf(eid('cto-john'));
    },
    get engineer(): ActorContext {
      return contextOf(eid('engineer-mike'));
    },
    get ceoActor(): CommandActor {
      return actor(eid('ceo-alex'));
    },
    get ctoActor(): CommandActor {
      return actor(eid('cto-john'));
    },
    get engineerActor(): CommandActor {
      return actor(eid('engineer-mike'));
    },
    actor,
    executorActor(taskId) {
      const assignee = taskStore.get(taskId)?.assignment.assigneeEmployeeId ?? null;
      if (assignee === null) throw new Error(`task ${taskId} has no assignee`);
      return actor(assignee);
    },
    record(operation) {
      sink.push(...operation.events);
      return operation;
    },
    instance,
    currentTask,
  };
}
