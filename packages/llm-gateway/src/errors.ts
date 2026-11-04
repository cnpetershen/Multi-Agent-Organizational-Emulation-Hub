export type LlmErrorCode =
  | 'missing_actor_context'
  | 'invalid_request'
  | 'budget_exceeded'
  | 'provider_unavailable'
  | 'provider_error'
  | 'timeout'
  /** HTTP 401 — the credential was rejected. Needs a human; never worth retrying. */
  | 'auth_failed'
  /** HTTP 429 — the provider is throttling us. Transient; a later attempt can succeed. */
  | 'rate_limited'
  /** HTTP 402 — the account behind the key cannot pay. Needs a human; never worth retrying. */
  | 'account_unfunded';

export interface LlmIssue {
  readonly field: string;
  readonly reason: string;
}

export interface LlmError {
  readonly code: LlmErrorCode;
  readonly issues: readonly LlmIssue[];
}

export function llmError(code: LlmErrorCode, issues: readonly LlmIssue[]): LlmError {
  return { code, issues };
}

export type LlmFailure = { readonly ok: false; readonly error: LlmError };

export function llmFailure(code: LlmErrorCode, issues: readonly LlmIssue[]): LlmFailure {
  return { ok: false, error: llmError(code, issues) };
}
