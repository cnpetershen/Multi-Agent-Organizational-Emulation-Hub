import { z } from 'zod';
import type {
  ActorContext,
  CompanyId,
  CorrelationId,
  DepartmentId,
  EmployeeId,
  EventType,
  OrgEvent,
  PositionId,
  PresenceState,
  SimTime,
} from '@maoeh/shared-types';
import { PRESENCE_STATES } from '@maoeh/shared-types';
import type { AgentDefinition } from '@maoeh/agent-definition';
import type { EventRegistry } from '@maoeh/event-system';
import { createEventRegistry, createOrgEvent } from '@maoeh/event-system';
import type { AgentInstance } from '@maoeh/agent-runtime';
import { instantiateAgent } from '@maoeh/agent-runtime';
import type { Identity } from '@maoeh/identity-system';
import { createIdentity } from '@maoeh/identity-system';
import type { Organization } from '@maoeh/organization-model';
import { loadOrganization } from '@maoeh/organization-model';
import { createMemoryOrganizationReader } from './organization-readers';

const orgFiles: Record<string, string> = {
  'company.yaml': 'id: acme\nname: Acme Corp\n',
  'departments/engineering.yaml': 'id: engineering\nname: Engineering\n',
  'positions/ceo.yaml': 'id: ceo\ntitle: Chief Executive Officer\n',
  'positions/engineer.yaml': 'id: engineer\ntitle: Software Engineer\ndepartment: engineering\n',
  'employees/alice.yaml': 'id: alice\nname: Alice\nposition: ceo\n',
  'employees/bob.yaml': 'id: bob\nname: Bob\nposition: engineer\n',
};

export const sim = (minutes: number): SimTime => minutes as SimTime;

export interface RuntimeFixture {
  readonly organization: Organization;
  readonly identity: Identity;
  readonly registry: EventRegistry;
  readonly alice: AgentInstance;
  readonly bob: AgentInstance;
  readonly aliceContext: ActorContext;
  readonly bobContext: ActorContext;
  readonly companyId: CompanyId;
}

function definition(
  id: string,
  employeeId: EmployeeId,
  positionId: PositionId,
  name: string,
  departmentId?: DepartmentId,
): AgentDefinition {
  return {
    id,
    employeeId,
    positionId,
    ...(departmentId === undefined ? {} : { departmentId }),
    identity: { name, traits: ['diligent'] },
    responsibilities: ['keep_the_lights_on'],
    capabilities: { decision: ['operate'] },
    cognitionProfileId: 'tech-task',
    memoryPolicy: { retain: ['decisions'] },
    toolPolicy: { allowed: ['meeting'] },
  };
}

function buildInstance(
  def: AgentDefinition,
  identity: Identity,
): { readonly instance: AgentInstance; readonly context: ActorContext } {
  const context = identity.actorContext(def.employeeId, `corr-${def.employeeId}` as CorrelationId);
  const created = instantiateAgent(def, context, sim(0));
  if (!created.ok) {
    throw new Error(
      created.error.issues.map((issue) => `${issue.field}: ${issue.reason}`).join('\n'),
    );
  }
  return { instance: created.value, context };
}

export function createRuntimeFixture(): RuntimeFixture {
  const loaded = loadOrganization(createMemoryOrganizationReader(orgFiles));
  if (!loaded.ok) throw new Error('fixture organization failed to load');
  const organization = loaded.value;
  const identity = createIdentity(organization);

  const registry = createEventRegistry();
  const presence = registry.register(
    'Runtime.PresenceChanged',
    z.object({ employeeId: z.string().min(1), presence: z.enum(PRESENCE_STATES) }),
  );
  const task = registry.register('Task.Completed', z.object({ taskId: z.string() }));
  if (!presence.ok || !task.ok) throw new Error('fixture registry setup failed');

  const alice = buildInstance(
    definition('agent-alice', 'alice' as EmployeeId, 'ceo' as PositionId, 'Alice'),
    identity,
  );
  const bob = buildInstance(
    definition(
      'agent-bob',
      'bob' as EmployeeId,
      'engineer' as PositionId,
      'Bob',
      'engineering' as DepartmentId,
    ),
    identity,
  );

  return {
    organization,
    identity,
    registry,
    alice: alice.instance,
    bob: bob.instance,
    aliceContext: alice.context,
    bobContext: bob.context,
    companyId: organization.company.id,
  };
}

export interface BuildEventOptions {
  readonly eventId: string;
  readonly type?: string;
  readonly subjectId?: string | null;
  readonly actorId?: string | null;
  readonly payload: unknown;
  readonly occurredAtSim?: number;
  readonly correlationId?: string;
}

export function buildEvent(
  registry: EventRegistry,
  companyId: CompanyId,
  options: BuildEventOptions,
): OrgEvent {
  const result = createOrgEvent(
    registry,
    {
      companyId,
      type: options.type ?? 'Runtime.PresenceChanged',
      occurredAtSim: sim(options.occurredAtSim ?? 10),
      actorKind: 'employee',
      actorId: options.actorId ?? null,
      subjectType: options.subjectId === null ? null : 'employee',
      subjectId: options.subjectId ?? null,
      correlationId: options.correlationId ?? 'corr-runtime',
      payload: options.payload,
    },
    { eventIdGenerator: () => options.eventId },
  );
  if (!result.ok) {
    throw new Error(result.error.issues.map((issue) => `${issue.field}: ${issue.reason}`).join('\n'));
  }
  return result.value;
}

export function presenceEvent(
  registry: EventRegistry,
  companyId: CompanyId,
  options: {
    readonly eventId: string;
    readonly subjectId: string | null;
    readonly presence: PresenceState;
    readonly employeeId?: string | null;
    readonly occurredAtSim?: number;
    readonly actorId?: string | null;
    readonly correlationId?: string;
  },
): OrgEvent {
  const employeeId = options.employeeId === undefined ? options.subjectId : options.employeeId;
  return buildEvent(registry, companyId, {
    eventId: options.eventId,
    subjectId: options.subjectId,
    actorId: options.actorId ?? null,
    occurredAtSim: options.occurredAtSim ?? 10,
    correlationId: options.correlationId ?? 'corr-runtime',
    payload: { employeeId, presence: options.presence },
  });
}

export function unregisteredPresenceEvent(companyId: CompanyId): OrgEvent {
  return {
    seq: 0,
    eventId: 'in-unregistered-1',
    companyId,
    type: 'Runtime.CycleStarted' as EventType,
    version: 1,
    occurredAtSim: sim(10),
    occurredAtWall: '',
    actorKind: 'system',
    actorId: null,
    subjectType: 'employee',
    subjectId: 'alice',
    payload: { cycleId: 'cycle-1' },
    causationId: null,
    correlationId: 'corr-runtime',
    traceId: null,
  };
}
