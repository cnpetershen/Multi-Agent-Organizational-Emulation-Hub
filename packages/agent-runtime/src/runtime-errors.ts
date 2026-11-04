export interface RuntimeIssue {
  readonly field: string;
  readonly reason: string;
}

export type RuntimeErrorCode =
  | 'INVALID_AGENT_INSTANCE'
  | 'INVALID_STATE'
  | 'INVALID_TURN_INPUT'
  | 'EVENT_CONTRACT_VIOLATION';

export interface RuntimeError {
  readonly code: RuntimeErrorCode;
  readonly issues: readonly RuntimeIssue[];
}
