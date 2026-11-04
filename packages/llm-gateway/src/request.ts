export interface LlmRequest {
  readonly requestId: string;
  readonly system: string;
  readonly prompt: string;
  readonly provider?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /**
   * `json` asks the provider for a strict JSON object (OpenAI `response_format`). A provider that
   * cannot honour it ignores it; the caller still owns validating the shape it gets back.
   */
  readonly responseFormat?: 'json' | 'text';
  readonly traceId?: string | null;
}
