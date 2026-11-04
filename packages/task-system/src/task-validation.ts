import { z } from 'zod';

export const taskSubmissionSchema = z.object({
  summary: z.string().min(1).max(4000),
  data: z.record(z.string(), z.unknown()),
  artifacts: z.array(z.string().min(1)).optional(),
});

export type TaskSubmission = z.infer<typeof taskSubmissionSchema>;
