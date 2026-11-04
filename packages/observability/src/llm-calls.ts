export interface LlmCallRecord {
  readonly requestId: string;
  readonly agentId: string | null;
  readonly provider: string;
  readonly model: string;
  readonly startedAt: number;
  readonly latencyMs: number;
  readonly callCount: number;
  readonly success: boolean;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface LlmCallInput {
  readonly requestId: string;
  readonly agentId?: string | null;
  readonly provider: string;
  readonly model: string;
  readonly startedAt: number;
  readonly latencyMs: number;
  readonly callCount: number;
  readonly success: boolean;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
}

const calls: LlmCallRecord[] = [];

export function recordLlmCall(input: LlmCallInput): LlmCallRecord {
  const record: LlmCallRecord = {
    requestId: input.requestId,
    agentId: input.agentId ?? null,
    provider: input.provider,
    model: input.model,
    startedAt: input.startedAt,
    latencyMs: input.latencyMs,
    callCount: input.callCount,
    success: input.success,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
  };
  calls.push(record);
  return record;
}

export function getLlmCalls(): readonly LlmCallRecord[] {
  return [...calls];
}

export function resetLlmCalls(): void {
  calls.length = 0;
}
