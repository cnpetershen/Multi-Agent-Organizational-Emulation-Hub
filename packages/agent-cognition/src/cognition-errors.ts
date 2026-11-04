import type { LlmError } from '@maoeh/llm-gateway';

export type CognitionErrorCode =
  | 'missing_actor_context'
  | 'invalid_context'
  | 'invalid_profile'
  | 'invalid_request'
  | 'invalid_reasoning'
  | 'invalid_plan'
  | 'schema_violation'
  | 'malformed_output'
  | 'llm_gateway_unavailable'
  | 'llm_timeout'
  | 'budget_exceeded'
  | 'provider_error'
  | 'llm_auth_failed'
  | 'llm_rate_limited'
  | 'llm_account_unfunded';

export interface CognitionIssue {
  readonly field: string;
  readonly reason: string;
}

export interface CognitionError {
  readonly code: CognitionErrorCode;
  readonly issues: readonly CognitionIssue[];
}

export function cognitionError(
  code: CognitionErrorCode,
  issues: readonly CognitionIssue[],
): CognitionError {
  return { code, issues };
}

export function cognitionIssue(
  code: CognitionErrorCode,
  field: string,
  reason: string,
): CognitionError {
  return { code, issues: [{ field, reason }] };
}

const LLM_ERROR_CODES: Readonly<Record<string, CognitionErrorCode>> = {
  missing_actor_context: 'missing_actor_context',
  invalid_request: 'invalid_request',
  budget_exceeded: 'budget_exceeded',
  provider_unavailable: 'llm_gateway_unavailable',
  provider_error: 'provider_error',
  timeout: 'llm_timeout',
  auth_failed: 'llm_auth_failed',
  rate_limited: 'llm_rate_limited',
  account_unfunded: 'llm_account_unfunded',
};

export function mapLlmError(error: LlmError): CognitionError {
  const code = LLM_ERROR_CODES[error.code] ?? 'llm_gateway_unavailable';
  return {
    code,
    issues: error.issues.map((issue) => ({
      field: issue.field,
      reason: issue.reason,
    })),
  };
}
