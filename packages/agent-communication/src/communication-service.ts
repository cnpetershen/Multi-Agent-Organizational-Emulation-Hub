import type { CompanyId, EmployeeId, OrgEvent, Result } from '@maoeh/shared-types';
import type { EventContractFailure, EventRegistry } from '@maoeh/event-system';
import { createOrgEvent } from '@maoeh/event-system';
import type { CommunicationFailure } from './communication-errors.js';
import { communicationFailure, failure, issue } from './communication-errors.js';
import type {
  AuthorizeCommunicationInput,
  AuthorizedSend,
  CreateChannelInput,
  CreateChannelResult,
  DeliverMessageInput,
  ReadMessageInput,
  ReadMessageResult,
  ResolveRecipientsInput,
  SendMessageInput,
  SendMessageResult,
} from './communication-types.js';
import type { AuthorizerDeps } from './authorization/communication-authorizer.js';
import { authorizeCommunication, authorizeRead } from './authorization/communication-authorizer.js';
import { unknownActor, validateActorContext } from './authorization/actor-context.js';
import type { Channel } from './channels/channel.js';
import { createChannel } from './channels/channel.js';
import { isChannelMember } from './channels/channel-membership.js';
import { channelDraftSchema } from './channels/channel-validation.js';
import type { DeliveryResult } from './delivery/delivery-result.js';
import { createDeliveryResult } from './delivery/delivery-result.js';
import { createDeliveryRecord } from './delivery/delivery.js';
import type { DeliveryRecord } from './delivery/delivery.js';
import {
  COMMUNICATION_CHANNEL_OPENED,
  COMMUNICATION_MESSAGE_SENT,
  isMessageSentEvent,
  messageSentPayloadSchema,
  registerCommunicationEvents,
} from './events/communication-events.js';
import type { ResolvedIdentity } from './identity/communication-identity.js';
import type { Message } from './messages/message.js';
import { createMessage } from './messages/message.js';
import { recipientIdsSchema } from './messages/message-validation.js';
import type { DeliveryStore } from './stores/stores.js';
import { zodIssues } from './validation/zod-issues.js';

export interface CommunicationServiceDeps extends AuthorizerDeps {
  readonly deliveries: DeliveryStore;
  readonly registry: EventRegistry;
  readonly companyId: CompanyId;
}

export interface CommunicationServiceOptions {
  readonly messageIdGenerator?: () => string;
  readonly channelIdGenerator?: () => string;
  readonly eventIdGenerator?: () => string;
}

export interface CommunicationService {
  createChannel(input: CreateChannelInput): Result<CreateChannelResult, CommunicationFailure>;
  authorizeCommunication(
    input: AuthorizeCommunicationInput,
  ): Result<AuthorizedSend, CommunicationFailure>;
  resolveRecipients(
    input: ResolveRecipientsInput,
  ): Result<readonly ResolvedIdentity[], CommunicationFailure>;
  sendMessage(input: SendMessageInput): Result<SendMessageResult, CommunicationFailure>;
  readMessage(input: ReadMessageInput): Result<ReadMessageResult, CommunicationFailure>;
  deliverMessage(input: DeliverMessageInput): Result<DeliveryResult, CommunicationFailure>;
  deliverFromEvent(event: OrgEvent): Result<readonly DeliveryResult[], CommunicationFailure>;
  getChannel(channelId: string): Channel | null;
  getChannels(): readonly Channel[];
  getMessage(messageId: string): Message | null;
  getMessages(): readonly Message[];
  getDeliveries(): readonly DeliveryRecord[];
}

function eventFailure(failureValue: EventContractFailure): CommunicationFailure {
  return communicationFailure(
    'event_contract_violation',
    failureValue.issues.map((eventIssue) => issue(eventIssue.field, eventIssue.reason)),
  );
}

export function createCommunicationService(
  deps: CommunicationServiceDeps,
  options?: CommunicationServiceOptions,
): CommunicationService {
  registerCommunicationEvents(deps.registry);

  let messageCounter = 0;
  let channelCounter = 0;
  let eventCounter = 0;
  const nextMessageId = options?.messageIdGenerator ?? (() => `msg-${++messageCounter}`);
  const nextChannelId = options?.channelIdGenerator ?? (() => `chan-${++channelCounter}`);
  const nextEventId = options?.eventIdGenerator ?? (() => `evt-${++eventCounter}`);

  const openChannel = (
    input: CreateChannelInput,
  ): Result<CreateChannelResult, CommunicationFailure> => {
    const actorFailure = validateActorContext(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };

    const channelId = input.channelId ?? nextChannelId();
    const parsedDraft = channelDraftSchema.safeParse({
      channelId,
      channelType: input.channelType,
      memberIds: input.memberIds,
      createdBy: input.actor.employeeId,
      simTime: input.simTime,
    });
    if (!parsedDraft.success) {
      return {
        ok: false,
        error: communicationFailure('invalid_channel', zodIssues(parsedDraft.error)),
      };
    }
    if (deps.channels.has(channelId)) {
      return {
        ok: false,
        error: failure('duplicate_channel', 'channelId', `channel "${channelId}" already exists`),
      };
    }

    const creator = deps.identity.resolve(input.actor.employeeId);
    if (!creator.ok) return { ok: false, error: unknownActor(input.actor.employeeId) };
    if (
      creator.value.positionId !== input.actor.positionId ||
      creator.value.departmentId !== input.actor.departmentId
    ) {
      return {
        ok: false,
        error: failure(
          'invalid_actor',
          'actor.employeeId',
          'creator identity does not match the actor context',
        ),
      };
    }
    for (const memberId of input.memberIds) {
      const member = deps.identity.resolve(memberId);
      if (!member.ok) {
        return {
          ok: false,
          error: failure(
            'invalid_member',
            'memberIds',
            `identity system cannot resolve employee "${memberId}"`,
          ),
        };
      }
    }

    const channel = createChannel({
      channelId,
      channelType: input.channelType,
      memberAgentIds: input.memberIds,
      createdBy: input.actor.employeeId,
      createdAtSim: input.simTime,
    });
    const opened = createOrgEvent(deps.registry, {
      companyId: deps.companyId,
      type: COMMUNICATION_CHANNEL_OPENED,
      occurredAtSim: input.simTime,
      actorKind: 'employee',
      actorId: String(input.actor.employeeId),
      subjectType: 'channel',
      subjectId: channel.channelId,
      correlationId: input.actor.correlationId,
      payload: {
        channelId: channel.channelId,
        channelType: channel.channelType,
        createdBy: String(channel.createdBy),
        memberIds: [...channel.memberAgentIds],
      },
      eventId: nextEventId(),
    });
    if (!opened.ok) return { ok: false, error: eventFailure(opened.error) };

    deps.channels.save(channel);
    return { ok: true, value: { channel, event: opened.value } };
  };

  const authorizeSend = (
    input: AuthorizeCommunicationInput,
  ): Result<AuthorizedSend, CommunicationFailure> => authorizeCommunication(deps, input);

  const resolveRecipientIdentities = (
    input: ResolveRecipientsInput,
  ): Result<readonly ResolvedIdentity[], CommunicationFailure> => {
    const parsed = recipientIdsSchema.safeParse(input.recipientIds);
    if (!parsed.success) {
      return {
        ok: false,
        error: communicationFailure('invalid_recipient', zodIssues(parsed.error)),
      };
    }
    const resolved: ResolvedIdentity[] = [];
    for (const recipientId of input.recipientIds) {
      const identity = deps.identity.resolve(recipientId);
      if (!identity.ok) {
        return {
          ok: false,
          error: failure(
            'invalid_recipient',
            'recipientIds',
            `identity system cannot resolve employee "${recipientId}"`,
          ),
        };
      }
      resolved.push(identity.value);
    }
    return { ok: true, value: Object.freeze(resolved) };
  };

  const send = (input: SendMessageInput): Result<SendMessageResult, CommunicationFailure> => {
    const authorized = authorizeCommunication(deps, input);
    if (!authorized.ok) return authorized;

    const message = createMessage({
      messageId: nextMessageId(),
      channelId: input.channelId,
      senderEmployeeId: input.senderEmployeeId,
      recipientIds: input.recipientIds,
      subject: input.subject,
      body: input.body,
      messageType: input.messageType,
      createdAtSim: input.simTime,
      correlationId: input.correlationId ?? input.actor.correlationId,
      causationId: input.causationId ?? null,
      traceId: input.traceId ?? null,
      ...(input.replyToMessageId !== undefined
        ? { replyToMessageId: input.replyToMessageId }
        : {}),
    });

    const sent = createOrgEvent(deps.registry, {
      companyId: deps.companyId,
      type: COMMUNICATION_MESSAGE_SENT,
      occurredAtSim: input.simTime,
      actorKind: 'employee',
      actorId: message.senderId,
      subjectType: 'message',
      subjectId: message.messageId,
      correlationId: message.correlationId,
      causationId: message.causationId,
      traceId: message.traceId,
      payload: {
        messageId: message.messageId,
        channelId: message.channelId,
        senderId: message.senderId,
        recipientIds: [...message.recipientIds],
        subject: message.subject,
        body: message.body,
        messageType: message.messageType,
      },
      eventId: nextEventId(),
    });
    if (!sent.ok) return { ok: false, error: eventFailure(sent.error) };

    deps.messages.save(message);
    return { ok: true, value: { message, event: sent.value } };
  };

  const read = (input: ReadMessageInput): Result<ReadMessageResult, CommunicationFailure> =>
    authorizeRead(deps, input);

  const deliver = (
    input: DeliverMessageInput,
  ): Result<DeliveryResult, CommunicationFailure> => {
    const message = deps.messages.get(input.messageId);
    if (message === null) {
      return {
        ok: false,
        error: failure('unknown_message', 'messageId', `message "${input.messageId}" does not exist`),
      };
    }
    const participates =
      message.senderEmployeeId === input.recipientId ||
      message.recipientIds.includes(input.recipientId);
    if (!participates) {
      return {
        ok: false,
        error: failure(
          'not_message_recipient',
          'recipientId',
          `employee "${input.recipientId}" is neither the sender nor a recipient of message "${message.messageId}"`,
        ),
      };
    }
    const channel = deps.channels.get(message.channelId);
    if (channel === null) {
      return {
        ok: false,
        error: failure(
          'unknown_channel',
          'channelId',
          `channel "${message.channelId}" does not exist`,
        ),
      };
    }
    const existing = deps.deliveries.find(input.recipientId, input.messageId);
    if (existing !== null) {
      return {
        ok: true,
        value: createDeliveryResult({
          messageId: input.messageId,
          recipientId: input.recipientId,
          channelId: existing.channelId,
          status: 'duplicate',
          recordedAtSim: existing.deliveredAtSim,
          ...(existing.sourceEventId !== null ? { sourceEventId: existing.sourceEventId } : {}),
        }),
      };
    }
    if (channel.status !== 'active') {
      return {
        ok: true,
        value: createDeliveryResult({
          messageId: input.messageId,
          recipientId: input.recipientId,
          channelId: channel.channelId,
          status: 'rejected',
          rejectionCode: 'channel_closed',
          recordedAtSim: input.simTime,
        }),
      };
    }
    if (!isChannelMember(channel, input.recipientId)) {
      return {
        ok: true,
        value: createDeliveryResult({
          messageId: input.messageId,
          recipientId: input.recipientId,
          channelId: channel.channelId,
          status: 'rejected',
          rejectionCode: 'not_channel_member',
          recordedAtSim: input.simTime,
        }),
      };
    }

    deps.deliveries.save(
      createDeliveryRecord({
        messageId: input.messageId,
        recipientId: input.recipientId,
        channelId: channel.channelId,
        deliveredAtSim: input.simTime,
        ...(input.sourceEventId !== undefined ? { sourceEventId: input.sourceEventId } : {}),
      }),
    );
    return {
      ok: true,
      value: createDeliveryResult({
        messageId: input.messageId,
        recipientId: input.recipientId,
        channelId: channel.channelId,
        status: 'delivered',
        recordedAtSim: input.simTime,
        ...(input.sourceEventId !== undefined ? { sourceEventId: input.sourceEventId } : {}),
      }),
    };
  };

  const deliverFrom = (event: OrgEvent): Result<readonly DeliveryResult[], CommunicationFailure> => {
    if (!isMessageSentEvent(event.type)) {
      return {
        ok: false,
        error: failure(
          'invalid_message',
          'event.type',
          `expected "${COMMUNICATION_MESSAGE_SENT}" but got "${event.type}"`,
        ),
      };
    }
    const payload = messageSentPayloadSchema.safeParse(event.payload);
    if (!payload.success) {
      return {
        ok: false,
        error: communicationFailure('invalid_message', zodIssues(payload.error)),
      };
    }
    const results: DeliveryResult[] = [];
    for (const recipientId of payload.data.recipientIds) {
      const result = deliver({
        messageId: payload.data.messageId,
        recipientId: recipientId as EmployeeId,
        simTime: event.occurredAtSim,
        sourceEventId: event.eventId,
      });
      if (!result.ok) return result;
      results.push(result.value);
    }
    return { ok: true, value: Object.freeze(results) };
  };

  return {
    createChannel: openChannel,
    authorizeCommunication: authorizeSend,
    resolveRecipients: resolveRecipientIdentities,
    sendMessage: send,
    readMessage: read,
    deliverMessage: deliver,
    deliverFromEvent: deliverFrom,
    getChannel(channelId) {
      return deps.channels.get(channelId);
    },
    getChannels() {
      return deps.channels.all();
    },
    getMessage(messageId) {
      return deps.messages.get(messageId);
    },
    getMessages() {
      return deps.messages.all();
    },
    getDeliveries() {
      return deps.deliveries.all();
    },
  };
}
