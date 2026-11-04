import { z } from 'zod';
import { CHANNEL_LIMITS, CHANNEL_TYPES } from './channel.js';
import { channelIdSchema, employeeIdSchema } from '../validation/ids.js';

const memberIdsSchema = z
  .array(employeeIdSchema)
  .min(CHANNEL_LIMITS.members.min)
  .max(CHANNEL_LIMITS.members.max)
  .refine((memberIds) => new Set(memberIds).size === memberIds.length, {
    message: 'memberIds must be unique',
  });

export const channelDraftSchema = z
  .object({
    channelId: channelIdSchema,
    channelType: z.enum(CHANNEL_TYPES),
    memberIds: memberIdsSchema,
    createdBy: employeeIdSchema,
    simTime: z.number().int().min(0),
  })
  .superRefine((draft, context) => {
    if (draft.channelType === 'direct' && draft.memberIds.length !== 2) {
      context.addIssue({
        code: 'custom',
        path: ['memberIds'],
        message: 'direct channel requires exactly two members',
      });
    }
    if (!draft.memberIds.includes(draft.createdBy)) {
      context.addIssue({
        code: 'custom',
        path: ['memberIds'],
        message: 'creator must be a channel member',
      });
    }
  });
