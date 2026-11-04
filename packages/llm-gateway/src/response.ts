export interface LlmResponse {
  readonly text: string;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}
