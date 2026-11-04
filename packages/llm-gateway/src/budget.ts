export interface CallBudget {
  readonly maxLlmCalls: number;
  readonly callCount: number;
  readonly remaining: number;
  consume(): boolean;
}

export function createCallBudget(maxLlmCalls: number): CallBudget {
  const limit = Number.isFinite(maxLlmCalls) ? Math.max(0, Math.floor(maxLlmCalls)) : 0;
  let used = 0;
  return {
    maxLlmCalls: limit,
    get callCount() {
      return used;
    },
    get remaining() {
      return Math.max(0, limit - used);
    },
    consume() {
      if (used >= limit) return false;
      used += 1;
      return true;
    },
  };
}
