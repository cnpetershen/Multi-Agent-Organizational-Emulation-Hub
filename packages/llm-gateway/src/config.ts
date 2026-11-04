import type { Result } from '@maoeh/shared-types';

/**
 * LLM provider configuration (F6 single egress, ADR-008 observability).
 *
 * Why this schema lives in `llm-gateway` rather than in `@maoeh/config`: the gateway is the only
 * consumer today, `tests/architecture/a4-import-scan.test.ts` already names this package as the
 * single place a provider SDK may be imported, and pointing an otherwise empty package at itself
 * would buy an abstraction nobody uses. If a second subsystem ever needs configuration, promote
 * the *loader* — not this schema.
 *
 * Two properties are load-bearing and must survive any edit:
 *
 * 1. `mode` defaults to `mock`. CI and the simulation suite depend on a deterministic substrate
 *    (`docs/architecture/02-modules.md` §2.5: `FakeLlm` is the basis of testability), so a live
 *    model is opt-in, and an accidental live run under CI is refused rather than quietly billed.
 *
 * 2. A live run without a key is a configuration *error*, never a silent fallback to mock. The
 *    fallback would turn "the organization is thinking" into "the mock answered" — the exact
 *    confusion this repository already shipped once. See the note above the mock provider in
 *    `apps/api/src/composition.ts`.
 *
 * The loader takes its environment as an argument instead of reading `process.env` itself: the
 * gateway stays free of Node globals, tests inject an exact environment, and the composition root
 * — which already reads `process.env` for ports and state paths — stays the only layer that knows
 * how configuration reaches the process.
 */

/** Environment variable names. Exported so tests, docs and `.env.example` cannot drift apart. */
export const LLM_ENV = {
  mode: 'MAOEH_LLM_MODE',
  provider: 'MAOEH_LLM_PROVIDER',
  baseUrl: 'MAOEH_LLM_BASE_URL',
  model: 'MAOEH_LLM_MODEL',
  apiKey: 'MAOEH_LLM_API_KEY',
  thinking: 'MAOEH_LLM_THINKING',
  maxTokens: 'MAOEH_LLM_MAX_TOKENS',
  timeoutMs: 'MAOEH_LLM_TIMEOUT_MS',
  maxAttempts: 'MAOEH_LLM_MAX_ATTEMPTS',
  allowLiveInCi: 'MAOEH_LLM_ALLOW_LIVE_IN_CI',
} as const;

export const LLM_RUN_MODES = ['mock', 'live'] as const;
export type LlmRunMode = (typeof LLM_RUN_MODES)[number];

/**
 * Protocol families, not vendors. DeepSeek, Moonshot, Qwen, vLLM and Ollama all speak the OpenAI
 * chat-completions shape, so one adapter covers them and switching vendor is `baseUrl` + `model`.
 * Naming a vendor here would turn every new provider into a code change.
 */
export const LLM_PROVIDER_KINDS = ['mock', 'openai-compatible'] as const;
export type LlmProviderKind = (typeof LLM_PROVIDER_KINDS)[number];

export const LLM_THINKING_MODES = ['enabled', 'disabled'] as const;
export type LlmThinkingMode = (typeof LLM_THINKING_MODES)[number];

/**
 * Defaults are the DeepSeek endpoint named in the deployment request. `thinking` defaults to
 * `disabled` on purpose: thinking mode is *on by default* server-side at effort `high`, and in
 * thinking mode `temperature`, `presence_penalty` and `frequency_penalty` are accepted but have
 * no effect (DeepSeek "Thinking Mode"). Leaving it enabled would therefore both silently discard
 * `LlmRequest.temperature` and multiply the token cost of every turn of a multi-agent simulation.
 */
export const LLM_DEFAULTS = {
  mode: 'mock',
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  thinking: 'disabled',
  maxTokens: 8192,
  timeoutMs: 60_000,
  maxAttempts: 1,
} as const;

export const MOCK_PROVIDER_ID = 'mock';
const MOCK_BASE_URL = 'mock://in-process';
const MOCK_MODEL = 'mock-model-1';

/** Typo guards, not vendor limits: DeepSeek itself caps output at 384K tokens. */
const MAX_TOKENS_CEILING = 1_000_000;
const MAX_ATTEMPTS_CEILING = 10;

const HTTP_URL_PATTERN = /^https?:\/\/[^\s/]+/i;
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

export interface LlmProviderConfig {
  readonly id: string;
  readonly kind: LlmProviderKind;
  readonly baseUrl: string;
  readonly model: string;
  /** The secret itself, or `null` for a provider that needs none (the mock). */
  readonly apiKey: string | null;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly thinking: LlmThinkingMode;
}

export interface LlmGatewayConfig {
  readonly mode: LlmRunMode;
  readonly defaultProvider: string;
  readonly providers: readonly LlmProviderConfig[];
  readonly maxAttempts: number;
}

export interface LlmConfigIssue {
  readonly field: string;
  readonly reason: string;
}

export interface LlmConfigError {
  readonly code: 'invalid_config';
  readonly issues: readonly LlmConfigIssue[];
}

/** An unset variable and one set to blank are the same thing: "not configured". */
function readRaw(
  pEnv: Readonly<Record<string, string | undefined>>,
  pName: string,
): string | undefined {
  const raw = pEnv[pName];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readEnum<T extends string>(
  pEnv: Readonly<Record<string, string | undefined>>,
  pName: string,
  pAllowed: readonly T[],
  pFallback: T,
  pIssues: LlmConfigIssue[],
): T {
  const raw = readRaw(pEnv, pName);
  if (raw === undefined) return pFallback;
  const match = pAllowed.find((candidate) => candidate === raw);
  if (match === undefined) {
    pIssues.push({
      field: pName,
      reason: `must be one of ${pAllowed.join(' | ')}, received "${raw}"`,
    });
    return pFallback;
  }
  return match;
}

function readBoolean(
  pEnv: Readonly<Record<string, string | undefined>>,
  pName: string,
  pFallback: boolean,
  pIssues: LlmConfigIssue[],
): boolean {
  const raw = readRaw(pEnv, pName);
  if (raw === undefined) return pFallback;
  const lowered = raw.toLowerCase();
  if (TRUE_VALUES.has(lowered)) return true;
  if (FALSE_VALUES.has(lowered)) return false;
  pIssues.push({
    field: pName,
    reason: `must be a boolean (true/false/1/0), received "${raw}"`,
  });
  return pFallback;
}

function readPositiveInt(
  pEnv: Readonly<Record<string, string | undefined>>,
  pName: string,
  pFallback: number,
  pMax: number,
  pIssues: LlmConfigIssue[],
): number {
  const raw = readRaw(pEnv, pName);
  if (raw === undefined) return pFallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    pIssues.push({
      field: pName,
      reason: `must be a positive integer, received "${raw}"`,
    });
    return pFallback;
  }
  if (value > pMax) {
    pIssues.push({
      field: pName,
      reason: `must be at most ${pMax}, received "${raw}"`,
    });
    return pFallback;
  }
  return value;
}

/** A syntax sanity check, deliberately not full URL parsing: `URL` is not in the ES2022 lib. */
function isHttpUrl(pValue: string): boolean {
  return HTTP_URL_PATTERN.test(pValue);
}

/** CI is set by every major provider; `CI=false` and `CI=0` mean "not CI" in practice. */
function isCi(pEnv: Readonly<Record<string, string | undefined>>): boolean {
  const raw = readRaw(pEnv, 'CI');
  if (raw === undefined) return false;
  return !FALSE_VALUES.has(raw.toLowerCase());
}

/**
 * Parse and validate the LLM environment. Never throws: every problem becomes an issue, so an
 * operator sees all of them at once instead of fixing one and rediscovering the next.
 */
export function loadLlmGatewayConfig(
  pEnv: Readonly<Record<string, string | undefined>>,
): Result<LlmGatewayConfig, LlmConfigError> {
  const issues: LlmConfigIssue[] = [];

  const mode = readEnum(pEnv, LLM_ENV.mode, LLM_RUN_MODES, LLM_DEFAULTS.mode, issues);
  const thinking = readEnum(
    pEnv,
    LLM_ENV.thinking,
    LLM_THINKING_MODES,
    LLM_DEFAULTS.thinking,
    issues,
  );
  const maxTokens = readPositiveInt(
    pEnv,
    LLM_ENV.maxTokens,
    LLM_DEFAULTS.maxTokens,
    MAX_TOKENS_CEILING,
    issues,
  );
  const timeoutMs = readPositiveInt(
    pEnv,
    LLM_ENV.timeoutMs,
    LLM_DEFAULTS.timeoutMs,
    Number.MAX_SAFE_INTEGER,
    issues,
  );
  const maxAttempts = readPositiveInt(
    pEnv,
    LLM_ENV.maxAttempts,
    LLM_DEFAULTS.maxAttempts,
    MAX_ATTEMPTS_CEILING,
    issues,
  );

  const providerId = readRaw(pEnv, LLM_ENV.provider) ?? LLM_DEFAULTS.provider;
  const baseUrl = readRaw(pEnv, LLM_ENV.baseUrl) ?? LLM_DEFAULTS.baseUrl;
  const model = readRaw(pEnv, LLM_ENV.model) ?? LLM_DEFAULTS.model;
  const apiKey = readRaw(pEnv, LLM_ENV.apiKey) ?? null;
  const allowLiveInCi = readBoolean(pEnv, LLM_ENV.allowLiveInCi, false, issues);

  if (mode === 'live') {
    if (apiKey === null) {
      issues.push({
        field: LLM_ENV.apiKey,
        reason:
          'a live run requires an API key; refusing to start rather than silently falling back to the mock',
      });
    }
    if (!isHttpUrl(baseUrl)) {
      issues.push({
        field: LLM_ENV.baseUrl,
        reason: `must be an absolute http(s) URL, received "${baseUrl}"`,
      });
    }
    if (isCi(pEnv) && !allowLiveInCi) {
      issues.push({
        field: LLM_ENV.mode,
        reason: `live mode is refused while CI is set (set ${LLM_ENV.allowLiveInCi}=true to override)`,
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, error: { code: 'invalid_config', issues } };
  }

  const provider: LlmProviderConfig =
    mode === 'mock'
      ? {
          id: MOCK_PROVIDER_ID,
          kind: 'mock',
          baseUrl: MOCK_BASE_URL,
          model: MOCK_MODEL,
          apiKey: null,
          maxTokens,
          timeoutMs,
          thinking,
        }
      : {
          id: providerId,
          kind: 'openai-compatible',
          baseUrl,
          model,
          apiKey,
          maxTokens,
          timeoutMs,
          thinking,
        };

  return {
    ok: true,
    value: {
      mode,
      defaultProvider: provider.id,
      providers: [provider],
      maxAttempts,
    },
  };
}
