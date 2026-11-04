import { z } from 'zod';

export interface CognitionProfile {
  readonly id: string;
  readonly reasoningStyle: string;
  readonly planningStyle: string;
  readonly decisionFramework: string;
  readonly reflectionPolicy: string;
}

export const cognitionProfileSourceSchema = z.strictObject({
  id: z.string().min(1),
  reasoning_style: z.string().min(1),
  planning_style: z.string().min(1),
  decision_framework: z.string().min(1),
  reflection_policy: z.string().min(1),
});

export type CognitionProfileSource = z.infer<typeof cognitionProfileSourceSchema>;

export interface CognitionSourceReader {
  list(relativeDirectory: string): Promise<readonly string[]>;
  read(relativePath: string): Promise<unknown>;
}
