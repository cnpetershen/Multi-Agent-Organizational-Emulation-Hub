import { z } from 'zod';
import { MESSAGE_TYPES } from './message-type.js';
import { channelIdSchema, employeeIdSchema, messageIdSchema } from '../validation/ids.js';

export const MESSAGE_LIMITS = {
  subject: { min: 1, max: 200 },
  body: { min: 1, max: 10_000 },
  recipients: { min: 1, max: 50 },
} as const;

export const recipientIdsSchema = z
  .array(employeeIdSchema)
  .min(MESSAGE_LIMITS.recipients.min)
  .max(MESSAGE_LIMITS.recipients.max);

export const messageDraftSchema = z.object({
  senderEmployeeId: employeeIdSchema,
  channelId: channelIdSchema,
  recipientIds: recipientIdsSchema,
  subject: z.string().min(MESSAGE_LIMITS.subject.min).max(MESSAGE_LIMITS.subject.max),
  body: z.string().min(MESSAGE_LIMITS.body.min).max(MESSAGE_LIMITS.body.max),
  messageType: z.enum(MESSAGE_TYPES),
  simTime: z.number().int().min(0),
  replyToMessageId: messageIdSchema.optional(),
  correlationId: z.string().min(1).optional(),
  causationId: z.string().min(1).nullable().optional(),
  traceId: z.string().min(1).nullable().optional(),
});
