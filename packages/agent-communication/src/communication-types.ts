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
