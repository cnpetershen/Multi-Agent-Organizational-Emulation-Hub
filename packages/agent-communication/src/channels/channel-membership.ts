import type { EmployeeId } from '@maoeh/shared-types';
import type { Channel } from './channel.js';

export function isChannelMember(channel: Channel, employeeId: EmployeeId): boolean {
  return channel.memberAgentIds.includes(employeeId);
}

export function channelMemberIds(channel: Channel): readonly EmployeeId[] {
  return channel.memberAgentIds;
}

export function countChannelMembers(channel: Channel): number {
  return channel.memberAgentIds.length;
}
