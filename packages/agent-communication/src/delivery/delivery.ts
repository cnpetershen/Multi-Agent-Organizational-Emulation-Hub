import type { EmployeeId, SimTime } from '@maoeh/shared-types';

export interface DeliveryRecord {
  readonly messageId: string;
  readonly recipientId: EmployeeId;
  readonly channelId: string;
  readonly deliveredAtSim: SimTime;
  readonly sourceEventId: string | null;
}

export function deliveryIdempotencyKey(recipientId: EmployeeId, messageId: string): string {
  return `${recipientId}|${messageId}`;
}

export function createDeliveryRecord(input: {
  readonly messageId: string;
  readonly recipientId: EmployeeId;
  readonly channelId: string;
  readonly deliveredAtSim: SimTime;
  readonly sourceEventId?: string;
}): DeliveryRecord {
  return Object.freeze({
    messageId: input.messageId,
    recipientId: input.recipientId,
    channelId: input.channelId,
    deliveredAtSim: input.deliveredAtSim,
    sourceEventId: input.sourceEventId ?? null,
  });
}
