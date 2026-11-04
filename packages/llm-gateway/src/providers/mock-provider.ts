import type { Result } from '@maoeh/shared-types';
import type { LlmError, LlmErrorCode } from '../errors.js';
import { llmFailure } from '../errors.js';
import type { LlmProvider } from '../provider.js';
import type { LlmRequest } from '../request.js';
import type { LlmResponse } from '../response.js';

export interface MockLlmFailure {
  readonly code: LlmErrorCode;
  readonly reason: string;
}

export interface MockLlmProviderOptions {
  readonly name?: string;
  readonly model?: string;
  readonly text: string | ((request: LlmRequest) => string);
  readonly latencyMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly failure?: MockLlmFailure;
  readonly hang?: boolean;
}

export interface MockLlmProvider extends LlmProvider {
  readonly callCount: number;
  readonly requests: readonly LlmRequest[];
}

export function createMockLlmProvider(
  options: MockLlmProviderOptions,
): MockLlmProvider {
  const name = options.name ?? 'mock';
  const model = options.model ?? 'mock-model-1';
  const requests: LlmRequest[] = [];
  let calls = 0;

  return {
    name,
    get callCount() {
      return calls;
    },
    get requests() {
      return [...requests];
    },
    async generate(request): Promise<Result<LlmResponse, LlmError>> {
      calls += 1;
      requests.push(request);
      if (options.hang === true) {
        return new Promise<never>(() => undefined);
      }
      if (options.failure !== undefined) {
        return llmFailure(options.failure.code, [
          { field: 'provider', reason: options.failure.reason },
        ]);
      }
      const text = typeof options.text === 'function' ? options.text(request) : options.text;
      return {
        ok: true,
        value: {
          text,
          provider: name,
          model,
          latencyMs: options.latencyMs ?? 0,
          inputTokens: options.inputTokens ?? 0,
          outputTokens: options.outputTokens ?? 0,
        },
      };
    },
  };
}
