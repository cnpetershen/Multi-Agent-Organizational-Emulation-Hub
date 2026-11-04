import type { Result } from '@maoeh/shared-types';
import type { LlmProviderConfig } from '../config.js';
import type { LlmError, LlmErrorCode } from '../errors.js';
import { llmFailure } from '../errors.js';
import type { LlmProvider } from '../provider.js';
import type { LlmRequest } from '../request.js';
import type { LlmResponse } from '../response.js';

/**
 * OpenAI-compatible chat-completions provider (F6 single egress).
 *
 * One adapter covers every service that speaks the OpenAI wire shape — DeepSeek, Moonshot, Qwen,
 * vLLM, Ollama — because the differences live in `baseUrl` and `model`, not in the protocol. That
 * is why the config names a protocol family rather than a vendor.
 *
 * This provider does exactly one HTTP request and reports exactly one outcome. It deliberately
 * does **not** retry: retrying here would hide attempts from the call budget and from the
 * `llm_calls` ledger, which ADR-008 makes the source of truth. Retries belong to the gateway,
 * which counts and records every attempt.
 *
 * Three DeepSeek behaviours are handled explicitly rather than inherited:
 *
 * 1. **Thinking mode is on by default** at effort `high`, and in that mode `temperature` is
 *    accepted but has no effect. We send `thinking: {type: 'disabled'}` unless configured
 *    otherwise, and omit `temperature` when thinking is on instead of sending a field we know is
 *    discarded.
 * 2. **JSON output** needs `response_format` *and* the word "json" plus a shape example in the
 *    prompt (`packages/agent-cognition/src/prompts/` already provides both).
 * 3. **An empty `json_object` response is a failure, not an answer.** DeepSeek documents that this
 *    happens occasionally. When JSON was requested and the content comes back blank we report
 *    `provider_error`, so the gateway's retry, budget and ledger machinery can see it. Reporting
 *    success with `text: ''` would instead surface as a non-retryable `malformed_output` deep in
 *    `agent-cognition` — the exact failure that once made the console look busy while the
 *    organization did nothing.
 */

export interface OpenAiCompatibleProviderOptions {
  readonly config: LlmProviderConfig;
  /** Injected by tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

function asRecord(pValue: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof pValue !== 'object' || pValue === null || Array.isArray(pValue)) return null;
  return pValue as Readonly<Record<string, unknown>>;
}

function asString(pValue: unknown): string | null {
  return typeof pValue === 'string' ? pValue : null;
}

function asCount(pValue: unknown): number | null {
  return typeof pValue === 'number' && Number.isFinite(pValue) ? pValue : null;
}

/** Keep an upstream body short and single-line: it goes into an error issue a human will read. */
function snippet(pText: string): string {
  const collapsed = pText.replace(/\s+/g, ' ').trim();
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
}

interface CompletionContent {
  readonly content: string;
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * Pull `choices[0].message.content` out of a chat-completions body, tolerating anything the
 * upstream returns. `reasoning_content` is deliberately ignored: the gateway's contract is the
 * final answer, and a chain of thought is not one.
 */
function extractContent(pBody: unknown): CompletionContent | null {
  const body = asRecord(pBody);
  if (body === null) return null;

  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const first = asRecord(choices[0]);
  if (first === null) return null;

  const message = asRecord(first['message']);
  if (message === null) return null;

  const content = asString(message['content']);
  if (content === null) return null;

  const usage = asRecord(body['usage']);
  return {
    content,
    model: asString(body['model']),
    inputTokens: usage === null ? null : asCount(usage['prompt_tokens']),
    outputTokens: usage === null ? null : asCount(usage['completion_tokens']),
  };
}

/**
 * HTTP status to error code. 401 and 402 are separated from the generic `provider_error` because
 * neither improves on retry — one needs a new key, the other needs money — while 429 does.
 */
function errorCodeForStatus(pStatus: number): LlmErrorCode {
  if (pStatus === 401) return 'auth_failed';
  if (pStatus === 402) return 'account_unfunded';
  if (pStatus === 429) return 'rate_limited';
  if (pStatus === 400 || pStatus === 422) return 'invalid_request';
  return 'provider_error';
}

function buildBody(
  pConfig: LlmProviderConfig,
  pRequest: LlmRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: pRequest.model ?? pConfig.model,
    messages: [
      { role: 'system', content: pRequest.system },
      { role: 'user', content: pRequest.prompt },
    ],
    max_tokens: pRequest.maxTokens ?? pConfig.maxTokens,
    stream: false,
  };

  if (pRequest.responseFormat === 'json') {
    body['response_format'] = { type: 'json_object' };
  }

  const thinkingDisabled = pConfig.thinking === 'disabled';
  if (thinkingDisabled) {
    body['thinking'] = { type: 'disabled' };
  }

  // Only meaningful when thinking is off; sending it otherwise would look like a setting that
  // works while the server silently drops it.
  if (pRequest.temperature !== undefined && thinkingDisabled) {
    body['temperature'] = pRequest.temperature;
  }

  return body;
}

function parseJson(pText: string): unknown {
  try {
    return JSON.parse(pText);
  } catch {
    return null;
  }
}

export function createOpenAiCompatibleProvider(
  pOptions: OpenAiCompatibleProviderOptions,
): LlmProvider {
  const { config } = pOptions;
  const doFetch = pOptions.fetchImpl ?? fetch;
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    name: config.id,

    async generate(pRequest: LlmRequest): Promise<Result<LlmResponse, LlmError>> {
      let response: Awaited<ReturnType<typeof doFetch>>;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey ?? ''}`,
          },
          body: JSON.stringify(buildBody(config, pRequest)),
        });
      } catch (error) {
        return llmFailure('provider_error', [
          {
            field: 'transport',
            reason: error instanceof Error ? error.message : String(error),
          },
        ]);
      }

      let raw: string;
      try {
        raw = await response.text();
      } catch (error) {
        return llmFailure('provider_error', [
          {
            field: 'transport',
            reason: `response body could not be read: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ]);
      }

      if (!response.ok) {
        return llmFailure(errorCodeForStatus(response.status), [
          {
            field: 'status',
            reason: `provider answered HTTP ${response.status}: ${snippet(raw)}`,
          },
        ]);
      }

      const extracted = extractContent(parseJson(raw));
      if (extracted === null) {
        return llmFailure('provider_error', [
          {
            field: 'response',
            reason: `provider answered HTTP ${response.status} without a usable completion: ${snippet(raw)}`,
          },
        ]);
      }

      const text = extracted.content;
      if (pRequest.responseFormat === 'json' && text.trim() === '') {
        return llmFailure('provider_error', [
          {
            field: 'response.text',
            reason:
              'provider returned an empty json_object response (documented upstream behaviour); retry or raise MAOEH_LLM_MAX_ATTEMPTS',
          },
        ]);
      }

      return {
        ok: true,
        value: {
          text,
          provider: config.id,
          model: extracted.model ?? config.model,
          // The gateway measures and overwrites latency around the whole attempt.
          latencyMs: 0,
          ...(extracted.inputTokens === null ? {} : { inputTokens: extracted.inputTokens }),
          ...(extracted.outputTokens === null ? {} : { outputTokens: extracted.outputTokens }),
        },
      };
    },
  };
}
