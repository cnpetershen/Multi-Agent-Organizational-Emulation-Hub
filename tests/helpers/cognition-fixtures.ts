import type {
  ActorContext,
  AgendaItem,
  AuthorityLevel,
  CompanyId,
  CorrelationId,
  DepartmentId,
  EmployeeId,
  EventType,
  OrgEvent,
  PositionId,
  SimTime,
} from '@maoeh/shared-types';
import { DECISION_DOMAINS } from '@maoeh/shared-types';
import type { AgentDefinition } from '@maoeh/agent-definition';
import type {
  CognitionContext,
  CognitionProfile,
  CognitionStateView,
  OrganizationSnapshotView,
} from '@maoeh/agent-cognition';
import type { LlmGatewayOptions, LlmGateway } from '@maoeh/llm-gateway';
import { createLlmGateway, createMockLlmProvider } from '@maoeh/llm-gateway';
import type { AgentState } from '@maoeh/runtime-state';
import { createInitialAgentState } from '@maoeh/runtime-state';

export const sim = (minutes: number): SimTime => minutes as SimTime;

const authority: Readonly<Record<string, AuthorityLevel>> = Object.fromEntries(
  DECISION_DOMAINS.map((domain) => [domain, 5 as AuthorityLevel]),
) as Readonly<Record<string, AuthorityLevel>>;

export const TEST_AUTHORITY = authority as Readonly<Record<(typeof DECISION_DOMAINS)[number], AuthorityLevel>>;

export function testActorContext(employeeId = 'alice'): ActorContext {
  return {
    employeeId: employeeId as EmployeeId,
    positionId: 'ceo' as PositionId,
    departmentId: 'engineering' as DepartmentId,
    authorityByDomain: TEST_AUTHORITY,
    correlationId: 'corr-cognition-1' as CorrelationId,
  };
}

export const TEST_PROFILE: CognitionProfile = {
  id: 'tech-task',
  reasoningStyle: 'step by step, evidence first',
  planningStyle: 'small reversible steps',
  decisionFramework: 'weigh options against stated responsibility',
  reflectionPolicy: 'reflect after every completed cycle',
};

export function testDefinition(): AgentDefinition {
  return {
    id: 'agent-alice',
    employeeId: 'alice' as EmployeeId,
    positionId: 'ceo' as PositionId,
    departmentId: 'engineering' as DepartmentId,
    identity: {
      name: 'Alice',
      description: 'Runs the company.',
      traits: ['diligent', 'calm'],
    },
    responsibilities: ['keep_the_lights_on', 'unblock_the_team'],
    capabilities: { decision: ['operate', 'approve'], writing: ['summarize'] },
    cognitionProfileId: TEST_PROFILE.id,
    memoryPolicy: { retain: ['decisions'] },
    toolPolicy: { allowed: ['meeting'] },
  };
}

export function testOrganizationView(): OrganizationSnapshotView {
  return {
    company: { id: 'acme' as CompanyId, name: 'Acme Corp' },
    department: { id: 'engineering' as DepartmentId, name: 'Engineering' },
    position: { id: 'ceo' as PositionId, title: 'Chief Executive Officer' },
    employee: { id: 'alice' as EmployeeId, name: 'Alice' },
    manager: null,
    reports: [{ id: 'bob' as EmployeeId, name: 'Bob' }],
    peers: [],
    colleagues: [{ id: 'carol' as EmployeeId, name: 'Carol' }],
  };
}

export const TEST_AGENDA: readonly AgendaItem[] = [
  { kind: 'task', ref: 'task-1', title: 'Ship the release' },
];

export function testState(overrides: Partial<AgentState> = {}): AgentState {
  const base = createInitialAgentState('alice' as EmployeeId, { employment: 'active' });
  return {
    ...base,
    presence: 'thinking',
    currentCycleId: 'cycle-42',
    agenda: TEST_AGENDA,
    version: 3,
    updatedAtSim: sim(60),
    ...overrides,
  };
}

export function testStateView(overrides: Partial<CognitionStateView> = {}): CognitionStateView {
  return {
    employeeId: 'alice' as EmployeeId,
    version: 3,
    employment: 'active',
    presence: 'thinking',
    currentCycleId: 'cycle-42',
    agenda: TEST_AGENDA,
    updatedAtSim: sim(60),
    ...overrides,
  };
}

export function testEvent(overrides: Partial<OrgEvent> = {}): OrgEvent {
  return {
    seq: 7,
    eventId: 'evt-cognition-1',
    companyId: 'acme' as CompanyId,
    type: 'Task.Assigned' as EventType,
    version: 1,
    occurredAtSim: sim(30),
    occurredAtWall: '2026-10-01T00:00:00.000Z',
    actorKind: 'system',
    actorId: 'scheduler',
    subjectType: 'employee',
    subjectId: 'alice',
    payload: { taskId: 'task-1', title: 'Ship the release' },
    causationId: null,
    correlationId: 'corr-cognition-1',
    traceId: null,
    ...overrides,
  };
}

export interface CognitionContextOverrides {
  readonly actorContext?: ActorContext;
  readonly state?: CognitionStateView;
  readonly inputEvent?: OrgEvent;
  readonly organization?: OrganizationSnapshotView;
  readonly profile?: CognitionProfile;
  readonly definition?: AgentDefinition;
  readonly simTime?: SimTime;
  readonly memoryContext?: Readonly<Record<string, unknown>>;
  readonly knowledgeContext?: Readonly<Record<string, unknown>>;
}

export function testContext(overrides: CognitionContextOverrides = {}): CognitionContext {
  const definition = overrides.definition ?? testDefinition();
  const context: CognitionContext = {
    agent: {
      id: 'agent:agent-alice',
      definitionId: definition.id,
      employeeId: definition.employeeId,
    },
    definition,
    actorContext: overrides.actorContext ?? testActorContext(),
    state: overrides.state ?? testStateView(),
    inputEvent: overrides.inputEvent ?? testEvent(),
    organization: overrides.organization ?? testOrganizationView(),
    simTime: overrides.simTime ?? sim(60),
    ...(overrides.memoryContext === undefined
      ? {}
      : { memoryContext: overrides.memoryContext }),
    ...(overrides.knowledgeContext === undefined
      ? {}
      : { knowledgeContext: overrides.knowledgeContext }),
  };
  return Object.freeze(context);
}

export interface OutputOverrides {
  readonly interpretation?: string;
  readonly considerations?: readonly string[];
  readonly conclusion?: string;
  readonly confidence?: number;
  readonly goal?: string;
  readonly doneWhen?: string;
  readonly steps?: readonly {
    readonly action: string;
    readonly args?: Readonly<Record<string, unknown>>;
    readonly reasonRef?: number;
  }[];
}

export function validOutput(overrides: OutputOverrides = {}): string {
  const steps = overrides.steps ?? [
    { action: 'AcceptTask', args: { taskId: 'task-1' }, reasonRef: 0 },
    { action: 'StartTask', args: { taskId: 'task-1' }, reasonRef: 0 },
  ];
  return JSON.stringify({
    interpretation: overrides.interpretation ?? 'The task is assigned to me and unstarted.',
    considerations: overrides.considerations ?? [
      'The task is mine.',
      'Starting it unblocks the team.',
    ],
    conclusion: overrides.conclusion ?? 'Accept the task and start immediately.',
    confidence: overrides.confidence ?? 0.86,
    plan: {
      goal: overrides.goal ?? 'task-1 is started',
      doneWhen: overrides.doneWhen ?? 'the task shows in_progress',
      steps,
    },
  });
}

export function createTestGateway(options?: {
  readonly text?: string | ((request: { readonly prompt: string }) => string);
  readonly failure?: { readonly code: 'provider_unavailable' | 'timeout' | 'provider_error'; readonly reason: string };
  readonly hang?: boolean;
  readonly timeoutMs?: number;
  readonly providerName?: string;
  readonly now?: () => number;
  readonly providers?: LlmGatewayOptions['providers'];
  readonly defaultProvider?: string;
}): LlmGateway {
  const provider =
    options?.providers === undefined
      ? createMockLlmProvider({
          name: options?.providerName ?? 'mock',
          text: options?.text ?? validOutput(),
          ...(options?.failure === undefined ? {} : { failure: options.failure }),
          ...(options?.hang === undefined ? {} : { hang: options.hang }),
          inputTokens: 120,
          outputTokens: 64,
          latencyMs: 12,
        })
      : undefined;
  const providers =
    options?.providers === undefined && provider !== undefined ? [provider] : (options?.providers ?? []);
  return createLlmGateway({
    providers,
    defaultProvider: options?.defaultProvider ?? options?.providerName ?? 'mock',
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options?.now === undefined ? {} : { now: options.now }),
  });
}
