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
  MarkMessageProcessedInput,
  MarkMessageProcessedResult,
  MessageProcessingRecord,
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
  COMMUNICATION_MESSAGE_PROCESSED,
  COMMUNICATION_MESSAGE_SENT,
  isMessageProcessedEvent,
  isMessageSentEvent,
  messageProcessedPayloadSchema,
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
  /**
   * M3.1: close the lifecycle for one recipient. Emits `Communication.MessageProcessed` once;
   * a repeated call for the same (messageId, recipient) and the same outcome is a no-op.
   */
  markProcessed(
    input: MarkMessageProcessedInput,
  ): Result<MarkMessageProcessedResult | null, CommunicationFailure>;
  /** Recovery projection: rebuild the message store from `Communication.MessageSent`. */
  restoreMessage(event: OrgEvent): Result<Message, CommunicationFailure>;
  /** Recovery projection: rebuild delivery + processing state from the log (no new events). */
  restoreProcessing(event: OrgEvent): void;
  getChannel(channelId: string): Channel | null;
  getChannels(): readonly Channel[];
  getMessage(messageId: string): Message | null;
  getMessages(): readonly Message[];
  getDeliveries(): readonly DeliveryRecord[];
  getProcessing(): readonly MessageProcessingRecord[];
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

  /**
   * The `MessageSent` event behind each message, kept so a deduplicated send can hand back the
   * original fact instead of minting a second one. Rebuilt from the log during recovery
   * (`restoreMessage`), so a restarted kernel deduplicates against history it did not witness.
   */
  const sentEvents = new Map<string, OrgEvent>();
  const processing = new Map<string, MessageProcessingRecord>();

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

    // Idempotency (M3.1): the same sender + dedupeKey is the same message. Returning the
    // original fact makes a retried turn succeed without a second send on the log, a second
    // delivery to the recipient, or a second wakeup.
    if (input.dedupeKey !== undefined) {
      const existing = deps.messages
        .all()
        .find(
          (message) =>
            message.dedupeKey === input.dedupeKey &&
            String(message.senderEmployeeId) === String(input.senderEmployeeId),
        );
      if (existing !== undefined) {
        const original = sentEvents.get(existing.messageId);
        if (original === undefined) {
          return {
            ok: false,
            error: failure(
              'unknown_message',
              'dedupeKey',
              `message "${existing.messageId}" was restored without its send event`,
            ),
          };
        }
        return {
          ok: true,
          value: { message: existing, event: original, duplicate: true },
        };
      }
    }

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
      ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
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
        ...(message.dedupeKey === undefined ? {} : { dedupeKey: message.dedupeKey }),
      },
      eventId: nextEventId(),
    });
    if (!sent.ok) return { ok: false, error: eventFailure(sent.error) };

    deps.messages.save(message);
    sentEvents.set(message.messageId, sent.value);
    return { ok: true, value: { message, event: sent.value, duplicate: false } };
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

  /**
   * M3.1: the recipient consumed the message. One fact per (message, recipient): a later
   * `failed` can be upgraded by a `handled`, but the same outcome is never recorded twice, so a
   * retried turn cannot flood the log with "processed" noise.
   */
  const markProcessed = (
    input: MarkMessageProcessedInput,
  ): Result<MarkMessageProcessedResult | null, CommunicationFailure> => {
    const message = deps.messages.get(input.messageId);
    if (message === null) {
      return {
        ok: false,
        error: failure(
          'unknown_message',
          'messageId',
          `message "${input.messageId}" does not exist`,
        ),
      };
    }
    if (!message.recipientIds.includes(input.recipientId)) {
      return {
        ok: false,
        error: failure(
          'not_message_recipient',
          'recipientId',
          `employee "${String(input.recipientId)}" is not a recipient of message "${message.messageId}"`,
        ),
      };
    }
    const key = `${message.messageId} ${String(input.recipientId)}`;
    const existing = processing.get(key);
    if (
      existing !== undefined &&
      (existing.outcome === 'handled' || existing.outcome === input.outcome)
    ) {
      return { ok: true, value: null };
    }

    const created = createOrgEvent(deps.registry, {
      companyId: deps.companyId,
      type: COMMUNICATION_MESSAGE_PROCESSED,
      occurredAtSim: input.simTime,
      actorKind: 'employee',
      actorId: String(input.recipientId),
      subjectType: 'message',
      subjectId: message.messageId,
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      traceId: input.traceId ?? null,
      payload: {
        messageId: message.messageId,
        channelId: message.channelId,
        recipientId: String(input.recipientId),
        outcome: input.outcome,
      },
      eventId: nextEventId(),
    });
    if (!created.ok) return { ok: false, error: eventFailure(created.error) };

    const record: MessageProcessingRecord = Object.freeze({
      messageId: message.messageId,
      channelId: message.channelId,
      recipientId: input.recipientId,
      outcome: input.outcome,
      processedAtSim: input.simTime,
      sourceEventId: created.value.eventId,
    });
    processing.set(key, record);
    return { ok: true, value: { processing: record, event: created.value } };
  };

  /**
   * Recovery projection (M3.1): the in-memory message store is derived state, exactly like
   * channels and delivery records. Without this a restarted kernel remembered no message at all,
   * so a delivered-but-unprocessed message could never be traced or deduplicated.
   */
  const restoreMessage = (event: OrgEvent): Result<Message, CommunicationFailure> => {
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
      return { ok: false, error: communicationFailure('invalid_message', zodIssues(payload.error)) };
    }
    const message = createMessage({
      messageId: payload.data.messageId,
      channelId: payload.data.channelId,
      senderEmployeeId: payload.data.senderId as EmployeeId,
      recipientIds: payload.data.recipientIds as readonly string[] as readonly EmployeeId[],
      subject: payload.data.subject,
      body: payload.data.body,
      messageType: payload.data.messageType,
      createdAtSim: event.occurredAtSim,
      correlationId: event.correlationId as never,
      causationId: event.causationId,
      traceId: event.traceId,
      ...(payload.data.dedupeKey === undefined ? {} : { dedupeKey: payload.data.dedupeKey }),
    });
    if (!deps.messages.has(message.messageId)) deps.messages.save(message);
    sentEvents.set(message.messageId, event);
    return { ok: true, value: message };
  };

  const restoreProcessing = (event: OrgEvent): void => {
    if (!isMessageProcessedEvent(event.type)) return;
    const payload = messageProcessedPayloadSchema.safeParse(event.payload);
    if (!payload.success) return;
    const record: MessageProcessingRecord = Object.freeze({
      messageId: payload.data.messageId,
      channelId: payload.data.channelId,
      recipientId: payload.data.recipientId as EmployeeId,
      outcome: payload.data.outcome,
      processedAtSim: event.occurredAtSim,
      sourceEventId: event.eventId,
    });
    processing.set(`${record.messageId} ${String(record.recipientId)}`, record);
  };

  return {
    createChannel: openChannel,
    authorizeCommunication: authorizeSend,
    resolveRecipients: resolveRecipientIdentities,
    sendMessage: send,
    readMessage: read,
    deliverMessage: deliver,
    deliverFromEvent: deliverFrom,
    markProcessed,
    restoreMessage,
    restoreProcessing,
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
    getProcessing() {
      return Object.freeze([...processing.values()]);
    },
  };
}
