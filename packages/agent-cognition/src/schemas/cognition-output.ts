import { z } from 'zod';

export const cognitionStepSchema = z.strictObject({
  action: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  reasonRef: z.number().int().min(0),
});

export const cognitionPlanSchema = z.strictObject({
  goal: z.string().min(1),
  doneWhen: z.string().min(1),
  steps: z.array(cognitionStepSchema).min(1).max(8),
});

export const cognitionOutputSchema = z.strictObject({
  interpretation: z.string().min(1),
  considerations: z.array(z.string().min(1)).min(1).max(12),
  conclusion: z.string().min(1),
  confidence: z.number().min(0).max(1),
  plan: cognitionPlanSchema,
});

export type CognitionStepDraft = z.infer<typeof cognitionStepSchema>;
export type CognitionPlanDraft = z.infer<typeof cognitionPlanSchema>;
export type CognitionOutputDraft = z.infer<typeof cognitionOutputSchema>;
