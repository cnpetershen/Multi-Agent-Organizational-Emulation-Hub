import { fileURLToPath } from 'node:url';
import type {
  ActorContext,
  CompanyId,
  CorrelationId,
  EmployeeId,
  SimTime,
} from '@maoeh/shared-types';
import type {
  ChannelStore,
  CommunicationIdentity,
  CommunicationService,
  DeliveryStore,
  MessageStore,
  MessageType,
  SendMessageResult,
} from '@maoeh/agent-communication';
import {
  createCommunicationService,
  createInMemoryChannelStore,
  createInMemoryDeliveryStore,
  createInMemoryMessageStore,
  createResolvedIdentity,
} from '@maoeh/agent-communication';
import type { EventRegistry } from '@maoeh/event-system';
import { createEventRegistry } from '@maoeh/event-system';
import type { Identity } from '@maoeh/identity-system';
import { createIdentity } from '@maoeh/identity-system';
import type { Organization } from '@maoeh/organization-model';
import { loadOrganization } from '@maoeh/organization-model';
import type { AuthzService, PermissionPolicy } from '@maoeh/permission-system';
import { createAuthzService } from '@maoeh/permission-system';
import { createMemoryOrganizationReader, createNodeFsOrganizationReader } from './organization-readers';

export const seedRoot = fileURLToPath(
  new URL('../../agents/future-ai-lab/', import.meta.url),
);

export const sim = (minutes: number): SimTime => minutes as SimTime;

export const eid = (value: string): EmployeeId => value as EmployeeId;

export const defaultCommunicationPolicy: PermissionPolicy = {
  grants: [
    { subject: { kind: 'any' }, action: 'SendMessage', resource: 'channel:*' },
    { subject: { kind: 'any' }, action: 'channel.read', resource: 'channel:*' },
    { subject: { kind: 'any' }, action: 'message.read', resource: 'channel:*' },
  ],
  denies: [],
};

function loadSeedOrganization(): Organization {
  const result = loadOrganization(createNodeFsOrganizationReader(seedRoot));
  if (!result.ok) throw new Error('seed organization failed to load');
  return result.value;
}

export function loadMemoryOrganization(files: Record<string, string>): Organization {
  const result = loadOrganization(createMemoryOrganizationReader(files));
  if (!result.ok) {
    throw new Error(
      result.error.issues
        .map((issue) => `${issue.source}: ${issue.reason}`)
        .join('\n'),
    );
  }
  return result.value;
}

function communicationIdentityPort(
  identity: Identity,
  organization: Organization,
): CommunicationIdentity {
  const known = new Set<string>(organization.employees.map((employee) => employee.id));
  return {
    resolve(employeeId) {
      if (!known.has(employeeId)) {
        return { ok: false, error: { code: 'unknown_employee', employeeId } };
      }
      const resolved = identity.resolve(employeeId);
      return {
        ok: true,
        value: createResolvedIdentity({
          employeeId: resolved.employeeId,
          positionId: resolved.positionId,
          departmentId: resolved.departmentId,
        }),
      };
    },
  };
}

export interface CommunicationFixtureOptions {
  readonly policy?: PermissionPolicy;
  readonly organization?: Organization;
}

export interface CommunicationFixture {
  readonly service: CommunicationService;
  readonly organization: Organization;
  readonly identity: Identity;
  readonly registry: EventRegistry;
  readonly authz: AuthzService;
  readonly companyId: CompanyId;
  readonly ceo: ActorContext;
  readonly cto: ActorContext;
  readonly engineer: ActorContext;
  readonly channels: ChannelStore;
  readonly messages: MessageStore;
  readonly deliveries: DeliveryStore;
}

export function createCommunicationFixture(
  options?: CommunicationFixtureOptions,
): CommunicationFixture {
  const organization = options?.organization ?? loadSeedOrganization();
  const identity = createIdentity(organization);
  const registry = createEventRegistry();
  const authz = createAuthzService({
    organization,
    policy: options?.policy ?? defaultCommunicationPolicy,
  });
  const channels = createInMemoryChannelStore();
  const messages = createInMemoryMessageStore();
  const deliveries = createInMemoryDeliveryStore();
  const service = createCommunicationService({
    authz,
    identity: communicationIdentityPort(identity, organization),
    channels,
    messages,
    deliveries,
    registry,
    companyId: organization.company.id,
  });

  return {
    service,
    organization,
    identity,
    registry,
    authz,
    companyId: organization.company.id,
    ceo: identity.actorContext(eid('ceo-alex'), 'corr-ceo' as CorrelationId),
    cto: identity.actorContext(eid('cto-john'), 'corr-cto' as CorrelationId),
    engineer: identity.actorContext(eid('engineer-mike'), 'corr-eng' as CorrelationId),
    channels,
    messages,
    deliveries,
  };
}

interface OpenChannelOptions {
  readonly actor?: ActorContext;
  readonly members?: readonly EmployeeId[];
  readonly channelId?: string;
  readonly at?: number;
}

function setupFailure(label: string, issues: readonly { field: string; reason: string }[]): Error {
  return new Error(
    `${label}: ${issues.map((issue) => `${issue.field}: ${issue.reason}`).join('; ')}`,
  );
}

export function openDirectChannel(
  fixture: CommunicationFixture,
  options?: OpenChannelOptions,
): string {
  const result = fixture.service.createChannel({
    actor: options?.actor ?? fixture.ceo,
    channelType: 'direct',
    memberIds: options?.members ?? [eid('ceo-alex'), eid('cto-john')],
    simTime: sim(options?.at ?? 5),
    ...(options?.channelId !== undefined ? { channelId: options.channelId } : {}),
  });
  if (!result.ok) throw setupFailure('openDirectChannel failed', result.error.issues);
  return result.value.channel.channelId;
}

export function openGroupChannel(
  fixture: CommunicationFixture,
  options?: OpenChannelOptions,
): string {
  const result = fixture.service.createChannel({
    actor: options?.actor ?? fixture.ceo,
    channelType: 'group',
    memberIds: options?.members ?? [eid('ceo-alex'), eid('cto-john'), eid('engineer-mike')],
    simTime: sim(options?.at ?? 5),
    ...(options?.channelId !== undefined ? { channelId: options.channelId } : {}),
  });
  if (!result.ok) throw setupFailure('openGroupChannel failed', result.error.issues);
  return result.value.channel.channelId;
}

export interface DefaultMessageOptions {
  readonly channelId: string;
  readonly actor?: ActorContext;
  readonly sender?: EmployeeId;
  readonly recipients?: readonly EmployeeId[];
  readonly at?: number;
  readonly messageType?: MessageType;
  readonly subject?: string;
  readonly body?: string;
  readonly replyToMessageId?: string;
}

export function sendDefaultMessage(
  fixture: CommunicationFixture,
  options: DefaultMessageOptions,
): SendMessageResult {
  const result = fixture.service.sendMessage({
    actor: options.actor ?? fixture.ceo,
    senderEmployeeId: options.sender ?? eid('ceo-alex'),
    channelId: options.channelId,
    recipientIds: options.recipients ?? [eid('cto-john')],
    subject: options.subject ?? 'Release plan',
    body: options.body ?? 'Ship M0.7 before Friday.',
    messageType: options.messageType ?? 'request',
    simTime: sim(options.at ?? 10),
    ...(options.replyToMessageId !== undefined
      ? { replyToMessageId: options.replyToMessageId }
      : {}),
  });
  if (!result.ok) throw setupFailure('sendDefaultMessage failed', result.error.issues);
  return result.value;
}
