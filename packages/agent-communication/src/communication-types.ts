import type {
  ActorContext,
  CorrelationId,
  EmployeeId,
  OrgEvent,
  SimTime,
} from '@maoeh/shared-types';
import type { Channel, ChannelType } from './channels/channel.js';
import type { MessageType } from './messages/message-type.js';
import type { Message } from './messages/message.js';
import type { ResolvedIdentity } from './identity/communication-identity.js';

export interface SendMessageInput {
  readonly actor: ActorContext;
  readonly senderEmployeeId: EmployeeId;
  readonly channelId: string;
  readonly recipientIds: readonly EmployeeId[];
  readonly subject: string;
  readonly body: string;
  readonly messageType: MessageType;
  readonly simTime: SimTime;
  readonly replyToMessageId?: string;
  readonly correlationId?: CorrelationId;
  readonly causationId?: string | null;
  readonly traceId?: string | null;
  /** M3.1: the sender's idempotency key — a second send with the same sender + key is a no-op. */
  readonly dedupeKey?: string;
}

export type AuthorizeCommunicationInput = SendMessageInput;

export interface CreateChannelInput {
  readonly actor: ActorContext;
  readonly channelId?: string;
  readonly channelType: ChannelType;
  readonly memberIds: readonly EmployeeId[];
  readonly simTime: SimTime;
}

export interface ReadMessageInput {
  readonly actor: ActorContext;
  readonly messageId: string;
}

export interface DeliverMessageInput {
  readonly messageId: string;
  readonly recipientId: EmployeeId;
  readonly simTime: SimTime;
  readonly sourceEventId?: string;
}

export interface ResolveRecipientsInput {
  readonly recipientIds: readonly EmployeeId[];
}

export interface SendMessageResult {
  readonly message: Message;
  /**
   * The event that put this message on the log.
   *
   * On a duplicate send this is the **original** event, which is already appended: `duplicate` is
   * true and the caller must not append it again. The field stays non-null so the normal path is
   * unchanged; the alternative — a null event — would force every caller to branch on success.
   */
  readonly event: OrgEvent;
  /** `true` when the send replayed an earlier message with the same sender + dedupeKey. */
  readonly duplicate: boolean;
}

/** M3.1: the recipient's handling of a message, once — the "processed" half of send → deliver → process. */
export const MESSAGE_PROCESSING_OUTCOMES = ['handled', 'failed'] as const;

export type MessageProcessingOutcome = (typeof MESSAGE_PROCESSING_OUTCOMES)[number];

export interface MessageProcessingRecord {
  readonly messageId: string;
  readonly channelId: string;
  readonly recipientId: EmployeeId;
  readonly outcome: MessageProcessingOutcome;
  readonly processedAtSim: SimTime;
  readonly sourceEventId: string;
}

export interface MarkMessageProcessedInput {
  readonly messageId: string;
  readonly recipientId: EmployeeId;
  readonly outcome: MessageProcessingOutcome;
  readonly simTime: SimTime;
  readonly correlationId: CorrelationId;
  readonly causationId?: string | null;
  readonly traceId?: string | null;
}

export interface MarkMessageProcessedResult {
  readonly processing: MessageProcessingRecord;
  readonly event: OrgEvent;
}

export interface CreateChannelResult {
  readonly channel: Channel;
  readonly event: OrgEvent;
}

export interface AuthorizedSend {
  readonly channel: Channel;
  readonly recipients: readonly ResolvedIdentity[];
}

export interface ReadMessageResult {
  readonly message: Message;
  readonly channel: Channel;
}
