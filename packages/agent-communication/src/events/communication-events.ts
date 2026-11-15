import { z } from 'zod';
import type { Result } from '@maoeh/shared-types';
import type { EventContractFailure, EventRegistry } from '@maoeh/event-system';
import { CHANNEL_TYPES } from '../channels/channel.js';
import { COLLABORATION_LIMITS } from '../collaboration/collaboration-validation.js';
import { MESSAGE_LIMITS } from '../messages/message-validation.js';
import { MESSAGE_TYPES } from '../messages/message-type.js';
import {
  channelIdSchema,
  collaborationIdSchema,
  employeeIdSchema,
  messageIdSchema,
} from '../validation/ids.js';

export const COMMUNICATION_MESSAGE_SENT = 'Communication.MessageSent';
export const COMMUNICATION_CHANNEL_OPENED = 'Communication.ChannelOpened';
export const COMMUNICATION_COLLABORATION_REQUESTED = 'Communication.CollaborationRequested';
/**
 * M3.1 message lifecycle: `sent` is the `MessageSent` fact, `delivered` the delivery ledger entry
 * derived from it, and `processed` this event — emitted for a recipient when the turn that
 * consumed the message settles (handled, or failed without a retry pending). A `failed` outcome
 * may be upgraded once by a later `handled`; a duplicate message never produces a second send.
 */
export const COMMUNICATION_MESSAGE_PROCESSED = 'Communication.MessageProcessed';

export const messageSentPayloadSchema = z.object({
  messageId: messageIdSchema,
  channelId: channelIdSchema,
  senderId: z.string().min(1).max(64),
  recipientIds: z
    .array(employeeIdSchema)
    .min(MESSAGE_LIMITS.recipients.min)
    .max(MESSAGE_LIMITS.recipients.max),
  subject: z.string().min(MESSAGE_LIMITS.subject.min).max(MESSAGE_LIMITS.subject.max),
  body: z.string().min(MESSAGE_LIMITS.body.min).max(MESSAGE_LIMITS.body.max),
  messageType: z.enum(MESSAGE_TYPES),
  /** Optional so every message written before M3.1 replays unchanged. */
  dedupeKey: z.string().min(1).max(128).optional(),
});

export const messageProcessedPayloadSchema = z.object({
  messageId: messageIdSchema,
  channelId: channelIdSchema,
  recipientId: employeeIdSchema,
  outcome: z.enum(['handled', 'failed']),
});

export const channelOpenedPayloadSchema = z.object({
  channelId: channelIdSchema,
  channelType: z.enum(CHANNEL_TYPES),
  createdBy: employeeIdSchema,
  memberIds: z.array(employeeIdSchema).min(2).max(50),
});

export const collaborationRequestedPayloadSchema = z.object({
  collaborationId: collaborationIdSchema,
  fromAgentId: employeeIdSchema,
  toAgentId: employeeIdSchema,
  taskId: z
    .string()
    .min(COLLABORATION_LIMITS.taskId.min)
    .max(COLLABORATION_LIMITS.taskId.max),
  purpose: z
    .string()
    .min(COLLABORATION_LIMITS.purpose.min)
    .max(COLLABORATION_LIMITS.purpose.max),
});

export type MessageSentPayload = z.infer<typeof messageSentPayloadSchema>;

export type ChannelOpenedPayload = z.infer<typeof channelOpenedPayloadSchema>;

export type MessageProcessedPayload = z.infer<typeof messageProcessedPayloadSchema>;

export type CollaborationRequestedPayload = z.infer<typeof collaborationRequestedPayloadSchema>;

function registerOnce(
  registry: EventRegistry,
  type: string,
  schema: z.ZodType<unknown>,
): Result<void, EventContractFailure> {
  if (registry.isRegistered(type)) return { ok: true, value: undefined };
  return registry.register(type, schema);
}

export function registerCommunicationEvents(
  registry: EventRegistry,
): Result<void, EventContractFailure> {
  const sent = registerOnce(registry, COMMUNICATION_MESSAGE_SENT, messageSentPayloadSchema);
  if (!sent.ok) return sent;
  const opened = registerOnce(
    registry,
    COMMUNICATION_CHANNEL_OPENED,
    channelOpenedPayloadSchema,
  );
  if (!opened.ok) return opened;
  const collaboration = registerOnce(
    registry,
    COMMUNICATION_COLLABORATION_REQUESTED,
    collaborationRequestedPayloadSchema,
  );
  if (!collaboration.ok) return collaboration;
  const processed = registerOnce(
    registry,
    COMMUNICATION_MESSAGE_PROCESSED,
    messageProcessedPayloadSchema,
  );
  if (!processed.ok) return processed;
  return { ok: true, value: undefined };
}

export function isMessageSentEvent(type: string): boolean {
  return type === COMMUNICATION_MESSAGE_SENT;
}

export function isChannelOpenedEvent(type: string): boolean {
  return type === COMMUNICATION_CHANNEL_OPENED;
}

export function isCollaborationRequestedEvent(type: string): boolean {
  return type === COMMUNICATION_COLLABORATION_REQUESTED;
}

export function isMessageProcessedEvent(type: string): boolean {
  return type === COMMUNICATION_MESSAGE_PROCESSED;
}
