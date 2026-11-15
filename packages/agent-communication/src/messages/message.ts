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
  /**
   * M3.1 idempotency: the sender's own key for "this is the same message". A repeated send with
   * the same sender + key returns the original message instead of appending a second
   * `Communication.MessageSent`, so a retried turn cannot duplicate a request.
   */
  readonly dedupeKey?: string;
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
  readonly dedupeKey?: string;
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
    ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
  };
  return Object.freeze(message);
}
