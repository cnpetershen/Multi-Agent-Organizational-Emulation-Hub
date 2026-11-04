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
