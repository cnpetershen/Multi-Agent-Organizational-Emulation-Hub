import type { ActorContext, Result } from '@maoeh/shared-types';
import { recordLlmCall } from '@maoeh/observability';
import type { CallBudget } from './budget.js';
import type { LlmError, LlmErrorCode, LlmFailure } from './errors.js';
import { llmFailure } from './errors.js';
import type { LlmProvider } from './provider.js';
import type { LlmRequest } from './request.js';
import type { LlmResponse } from './response.js';

export interface LlmGenerateInput {
  readonly actorContext: ActorContext | undefined;
  readonly request: LlmRequest;
  readonly budget: CallBudget;
}

export interface LlmGatewayOptions {
  readonly providers: readonly LlmProvider[];
  readonly defaultProvider: string;
  readonly timeoutMs?: number;
  /**
   * Total attempts per call, including the first. Defaults to `1`, which is exactly the
   * single-shot behaviour this gateway had before retries existed.
   *
   * Every attempt consumes budget and is written to `llm_calls` on its own, so a retry can never
   * hide cost from the ADR-008 ledger. That is also why retrying lives here and not inside a
   * provider: a provider that retried internally would make one budget unit and one ledger row
   * stand for several HTTP calls.
   *
   * If a retry cannot get budget the loop stops and the provider's own failure is reported — a
   * `budget_exceeded` in its place would point the operator at the wrong problem.
   */
  readonly maxAttempts?: number;
  readonly now?: () => number;
}

export interface LlmGateway {
  generate(input: LlmGenerateInput): Promise<Result<LlmResponse, LlmError>>;
}

type RaceOutcome =
  | { readonly kind: 'result'; readonly result: Result<LlmResponse, LlmError> }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'rejected'; readonly message: string };

/**
 * Failures that another attempt can plausibly survive. Transport errors, upstream 5xx and
 * throttling are transient. A rejected credential, an unfunded account, a malformed request and a
 * missing actor context will fail identically forever — retrying them only spends money.
 */
const RETRYABLE_ERROR_CODES = new Set<LlmErrorCode>([
  'provider_error',
  'timeout',
  'rate_limited',
]);

function isRetryable(pCode: LlmErrorCode): boolean {
  return RETRYABLE_ERROR_CODES.has(pCode);
}

async function invokeProvider(
  provider: LlmProvider,
  request: LlmRequest,
  timeoutMs: number | undefined,
): Promise<Result<LlmResponse, LlmError>> {
  if (timeoutMs === undefined) {
    try {
      return await provider.generate(request);
    } catch (error) {
      return llmFailure('provider_error', [
        {
          field: 'provider',
          reason: error instanceof Error ? error.message : String(error),
        },
      ]);
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = provider.generate(request).then(
    (result): RaceOutcome => ({ kind: 'result', result }),
    (error: unknown): RaceOutcome => ({
      kind: 'rejected',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  const expired: Promise<RaceOutcome> = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });

  try {
    const outcome = await Promise.race([settled, expired]);
    if (outcome.kind === 'timeout') {
      return llmFailure('timeout', [
        {
          field: 'timeout',
          reason: `provider "${provider.name}" did not answer within ${timeoutMs}ms`,
        },
      ]);
    }
    if (outcome.kind === 'rejected') {
      return llmFailure('provider_error', [
        { field: 'provider', reason: outcome.message },
      ]);
    }
    return outcome.result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createLlmGateway(options: LlmGatewayOptions): LlmGateway {
  const now = options.now ?? Date.now;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 1));

  return {
    async generate(input): Promise<Result<LlmResponse, LlmError>> {
      const { actorContext, request, budget } = input;

      if (actorContext === undefined || actorContext === null) {
        return llmFailure('missing_actor_context', [
          {
            field: 'actorContext',
            reason: 'an ActorContext is required for every LLM call (A4)',
          },
        ]);
      }
      if (actorContext.employeeId.trim() === '') {
        return llmFailure('missing_actor_context', [
          { field: 'actorContext.employeeId', reason: 'employeeId must not be empty' },
        ]);
      }
      if (request.requestId.trim() === '') {
        return llmFailure('invalid_request', [
          { field: 'requestId', reason: 'requestId must not be empty' },
        ]);
      }
      if (request.system.trim() === '' || request.prompt.trim() === '') {
        return llmFailure('invalid_request', [
          { field: 'prompt', reason: 'system and prompt must not be empty' },
        ]);
      }

      const providerName = request.provider ?? options.defaultProvider;
      const provider = options.providers.find((candidate) => candidate.name === providerName);
      if (provider === undefined) {
        return llmFailure('provider_unavailable', [
          {
            field: 'provider',
            reason: `provider "${providerName}" is not registered`,
          },
        ]);
      }

      let lastFailure: LlmFailure | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (!budget.consume()) {
          // Nothing has been tried yet, so the exhausted budget is the headline problem. If an
          // attempt already failed, that failure is the actionable one.
          if (lastFailure === undefined) {
            return llmFailure('budget_exceeded', [
              {
                field: 'maxLlmCalls',
                reason: `call budget of ${budget.maxLlmCalls} is exhausted`,
              },
            ]);
          }
          break;
        }

        const startedAt = now();
        const outcome = await invokeProvider(provider, request, options.timeoutMs);
        const latencyMs = Math.max(0, now() - startedAt);

        if (!outcome.ok) {
          recordLlmCall({
            requestId: request.requestId,
            agentId: actorContext.employeeId,
            provider: provider.name,
            model: request.model ?? '',
            startedAt,
            latencyMs,
            callCount: budget.callCount,
            success: false,
          });
          if (!isRetryable(outcome.error.code)) return outcome;
          lastFailure = outcome;
          continue;
        }

        const response: LlmResponse = {
          ...outcome.value,
          provider: outcome.value.provider || provider.name,
          latencyMs,
        };

        recordLlmCall({
          requestId: request.requestId,
          agentId: actorContext.employeeId,
          provider: response.provider,
          model: response.model,
          startedAt,
          latencyMs,
          callCount: budget.callCount,
          success: true,
          inputTokens: response.inputTokens ?? null,
          outputTokens: response.outputTokens ?? null,
        });

        return { ok: true, value: response };
      }

      if (lastFailure !== undefined) return lastFailure;

      return llmFailure('provider_error', [
        { field: 'provider', reason: `provider "${provider.name}" was never attempted` },
      ]);
    },
  };
}
