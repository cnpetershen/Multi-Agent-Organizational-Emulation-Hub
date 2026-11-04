import type { Action } from '@maoeh/shared-types';
import type { AuthzDecision } from '@maoeh/permission-system';

export type CommunicationIssue = {
  readonly field: string;
  readonly reason: string;
};

export type DeniedDecision = Extract<AuthzDecision, { allow: false }>;

export type CommunicationErrorCode =
  | 'invalid_actor'
  | 'invalid_sender'
  | 'invalid_recipient'
  | 'invalid_member'
  | 'invalid_message'
  | 'invalid_channel'
  | 'invalid_collaboration'
  | 'sender_mismatch'
  | 'duplicate_channel'
  | 'unknown_channel'
  | 'channel_closed'
  | 'not_channel_member'
  | 'recipient_not_channel_member'
  | 'not_message_recipient'
  | 'permission_denied'
  | 'unknown_message'
  | 'event_contract_violation';

export interface CommunicationFailure {
  readonly code: CommunicationErrorCode;
  readonly issues: readonly CommunicationIssue[];
  readonly denial?: DeniedDecision;
}

export function communicationFailure(
  code: CommunicationErrorCode,
  issues: readonly CommunicationIssue[],
): CommunicationFailure {
  return { code, issues };
}

export function issue(field: string, reason: string): CommunicationIssue {
  return { field, reason };
}

export function failure(
  code: CommunicationErrorCode,
  field: string,
  reason: string,
): CommunicationFailure {
  return { code, issues: [issue(field, reason)] };
}

function describeDenied(decision: DeniedDecision): string {
  const parts: string[] = [decision.reason];
  if (decision.requiredAuthority !== undefined) {
    parts.push(`requiredAuthority=${decision.requiredAuthority}`);
  }
  if (decision.escalateTo !== undefined) {
    parts.push(`escalateTo=${decision.escalateTo}`);
  }
  return parts.join(' ');
}

export function permissionFailure(action: Action, decision: DeniedDecision): CommunicationFailure {
  return {
    code: 'permission_denied',
    issues: [issue('permission', `${action}: ${describeDenied(decision)}`)],
    denial: decision,
  };
}
