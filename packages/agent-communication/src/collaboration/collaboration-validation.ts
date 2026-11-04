import { z } from 'zod';
import { employeeIdSchema } from '../validation/ids.js';

export const COLLABORATION_LIMITS = Object.freeze({
  purpose: Object.freeze({ min: 1, max: 500 }),
  taskId: Object.freeze({ min: 1, max: 64 }),
});

export const collaborationRequestDraftSchema = z
  .object({
    fromAgentId: employeeIdSchema,
    toAgentId: employeeIdSchema,
    taskId: z.string().min(COLLABORATION_LIMITS.taskId.min).max(COLLABORATION_LIMITS.taskId.max),
    purpose: z
      .string()
      .min(COLLABORATION_LIMITS.purpose.min)
      .max(COLLABORATION_LIMITS.purpose.max),
  })
  .refine((draft) => draft.fromAgentId !== draft.toAgentId, {
    message: 'an agent must not request collaboration with itself',
    path: ['toAgentId'],
  });

export type CollaborationRequestDraft = z.infer<typeof collaborationRequestDraftSchema>;
