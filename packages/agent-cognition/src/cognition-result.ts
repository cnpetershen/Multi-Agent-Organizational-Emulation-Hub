import type { Plan } from '@maoeh/shared-types';

export interface ReasoningResult {
  readonly interpretation: string;
  readonly considerations: readonly string[];
  readonly conclusion: string;
}

export interface CognitionLlmMetadata {
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly callCount: number;
}

export interface CognitionResult {
  readonly requestId: string;
  readonly interpretation: string;
  readonly reasoning: ReasoningResult;
  readonly plan: Plan;
  readonly confidence: number;
  readonly llmMetadata: CognitionLlmMetadata;
}
