import type { EmployeeId, SimTime } from '@maoeh/shared-types';
import type { CommunicationErrorCode } from '../communication-errors.js';

export const DELIVERY_STATUSES = ['delivered', 'rejected', 'duplicate'] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface DeliveryResult {
  readonly messageId: string;
  readonly recipientId: EmployeeId;
  readonly channelId: string;
  readonly status: DeliveryStatus;
  readonly recordedAtSim: SimTime;
  readonly rejectionCode?: CommunicationErrorCode;
  readonly sourceEventId?: string;
}

export function createDeliveryResult(input: {
  readonly messageId: string;
  readonly recipientId: EmployeeId;
  readonly channelId: string;
  readonly status: DeliveryStatus;
  readonly recordedAtSim: SimTime;
  readonly rejectionCode?: CommunicationErrorCode;
  readonly sourceEventId?: string;
}): DeliveryResult {
  return Object.freeze({
    messageId: input.messageId,
    recipientId: input.recipientId,
    channelId: input.channelId,
    status: input.status,
    recordedAtSim: input.recordedAtSim,
    ...(input.rejectionCode !== undefined ? { rejectionCode: input.rejectionCode } : {}),
    ...(input.sourceEventId !== undefined ? { sourceEventId: input.sourceEventId } : {}),
  });
}
