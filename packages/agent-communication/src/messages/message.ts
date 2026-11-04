import type { CorrelationId, EmployeeId, SimTime } from '@maoeh/shared-types';
import type { MessageType } from './message-type.js';

export interface Message {
  readonly messageId: string;
  readonly channelId: string;
  readonly senderId: string;
  readonly senderEmployeeId: EmployeeId;
  readonly recipientIds: readonly EmployeeId[];
  readonly subject: string;
  readonly body: string;
  readonly messageType: MessageType;
  readonly createdAtSim: SimTime;
  readonly correlationId: CorrelationId;
  readonly causationId: string | null;
  readonly traceId: string | null;
  readonly replyToMessageId?: string;
}

export function messageSenderId(senderEmployeeId: EmployeeId): string {
  return String(senderEmployeeId);
}

export function createMessage(input: {
  readonly messageId: string;
  readonly channelId: string;
  readonly senderEmployeeId: EmployeeId;
  readonly recipientIds: readonly EmployeeId[];
  readonly subject: string;
  readonly body: string;
  readonly messageType: MessageType;
  readonly createdAtSim: SimTime;
  readonly correlationId: CorrelationId;
  readonly causationId?: string | null;
  readonly traceId?: string | null;
  readonly replyToMessageId?: string;
}): Message {
  const message: Message = {
    messageId: input.messageId,
    channelId: input.channelId,
    senderId: messageSenderId(input.senderEmployeeId),
    senderEmployeeId: input.senderEmployeeId,
    recipientIds: Object.freeze([...input.recipientIds]),
    subject: input.subject,
    body: input.body,
    messageType: input.messageType,
    createdAtSim: input.createdAtSim,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    traceId: input.traceId ?? null,
    ...(input.replyToMessageId !== undefined
      ? { replyToMessageId: input.replyToMessageId }
      : {}),
  };
  return Object.freeze(message);
}
