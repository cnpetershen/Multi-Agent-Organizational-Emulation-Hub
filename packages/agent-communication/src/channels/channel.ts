import type { EmployeeId, SimTime } from '@maoeh/shared-types';

export const CHANNEL_TYPES = ['direct', 'group'] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CHANNEL_STATUSES = ['active', 'closed'] as const;

export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

export const CHANNEL_LIMITS = {
  members: { min: 2, max: 50 },
} as const;

export interface Channel {
  readonly channelId: string;
  readonly channelType: ChannelType;
  readonly memberAgentIds: readonly EmployeeId[];
  readonly createdBy: EmployeeId;
  readonly createdAtSim: SimTime;
  readonly status: ChannelStatus;
}

export function createChannel(input: {
  readonly channelId: string;
  readonly channelType: ChannelType;
  readonly memberAgentIds: readonly EmployeeId[];
  readonly createdBy: EmployeeId;
  readonly createdAtSim: SimTime;
}): Channel {
  return Object.freeze({
    channelId: input.channelId,
    channelType: input.channelType,
    memberAgentIds: Object.freeze([...input.memberAgentIds]),
    createdBy: input.createdBy,
    createdAtSim: input.createdAtSim,
    status: 'active' as const,
  });
}

export function closeChannel(channel: Channel): Channel {
  return Object.freeze({ ...channel, status: 'closed' as const });
}
