import type { EmployeeId } from '@maoeh/shared-types';
import type { CommunicationService } from '@maoeh/agent-communication';
import type {
  CommunicationChannelView,
  CommunicationMessageView,
  CommunicationView,
} from '@maoeh/agent-cognition';

/**
 * The conversation surface one agent sees at the start of its cycle (M-COMMUNICATION).
 *
 * This module exists because `CommunicationService` was fully implemented, authorized, delivered
 * and logged — and still produced zero events in a live run: the cognition prompt carried no
 * `channelId` and no message contract, so a model could not write a sendable `SendMessage`. The
 * fix belongs on the cognition side (a channel the agent may name), not in the service, so this
 * view is derived from the service's own read models rather than duplicating any of its rules:
 *
 * - only channels the agent is a member of — a send to any other channel would be refused by
 *   `authorizeCommunication` after a wasted turn;
 * - the most recent messages, bounded, oldest first, because a planner needs the thread it is
 *   answering far more than it needs its whole history;
 * - bodies flattened and truncated, so one long message cannot crowd out the task it is about.
 *
 * No events are appended here and no state is mutated: this is a projection for a prompt.
 */
export interface CommunicationViewOptions {
  /** How many messages to show, newest last. Defaults to 6. */
  readonly maxMessages?: number;
  /** Hard cap on one message body handed to the prompt. Defaults to 500 characters. */
  readonly messageBodyLimit?: number;
}

const DEFAULT_MAX_MESSAGES = 6;
const DEFAULT_MESSAGE_BODY_LIMIT = 500;

/** One line, bounded — a prompt field, not a place to reproduce a whole document. */
function flattenBody(body: string, limit: number): string {
  const clean = body.replace(/\s+/g, ' ').trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

function channelsOf(
  communication: Pick<CommunicationService, 'getChannels'>,
  employeeId: EmployeeId,
): readonly CommunicationChannelView[] {
  return communication
    .getChannels()
    .filter((channel) => channel.status === 'active')
    .filter((channel) => channel.memberAgentIds.includes(employeeId))
    .map((channel) => ({
      channelId: channel.channelId,
      channelType: channel.channelType,
      memberIds: [...channel.memberAgentIds],
    }));
}

function messagesOf(
  communication: Pick<CommunicationService, 'getMessages'>,
  channels: readonly CommunicationChannelView[],
  options: CommunicationViewOptions,
): readonly CommunicationMessageView[] {
  const allowed = new Set(channels.map((channel) => channel.channelId));
  const limit = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const bodyLimit = options.messageBodyLimit ?? DEFAULT_MESSAGE_BODY_LIMIT;
  if (limit <= 0 || allowed.size === 0) return [];
  return communication
    .getMessages()
    .filter((message) => allowed.has(message.channelId))
    .slice(-limit)
    .map((message) => ({
      messageId: message.messageId,
      channelId: message.channelId,
      senderId: message.senderEmployeeId,
      recipientIds: [...message.recipientIds],
      subject: message.subject,
      body: flattenBody(message.body, bodyLimit),
      messageType: message.messageType,
      createdAtSim: message.createdAtSim,
    }));
}

/**
 * `undefined` means "nothing to say": the agent belongs to no channel, so the prompt renders no
 * communication section at all rather than an empty one a model would try to act on.
 */
export function communicationViewOf(
  communication: Pick<CommunicationService, 'getChannels' | 'getMessages'>,
  employeeId: EmployeeId,
  options: CommunicationViewOptions = {},
): CommunicationView | undefined {
  const channels = channelsOf(communication, employeeId);
  if (channels.length === 0) return undefined;
  return {
    channels,
    recentMessages: messagesOf(communication, channels, options),
  };
}
