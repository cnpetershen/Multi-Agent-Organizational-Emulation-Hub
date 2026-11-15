import type { Action } from '@maoeh/shared-types';
import type { AuthzDecision } from '@maoeh/permission-system';

export interface TaskIssue {
  readonly field: string;
  readonly reason: string;
}

export type TaskErrorCode =
  | 'invalid_input'
  | 'invalid_reason'
  | 'invalid_actor'
  | 'unknown_task'
  | 'invalid_transition'
  | 'not_assignee'
  | 'not_task_owner'
  | 'permission_denied'
  | 'out_of_scope'
  | 'insufficient_authority'
  | 'dispatch_quota_exceeded'
  | 'unknown_employee'
  | 'unknown_position'
  | 'employee_not_executable'
  | 'retries_exhausted'
  | 'invalid_result'
  | 'self_verification_forbidden'
  | 'verification_not_applicable'
  | 'handoff_not_recipient'
  | 'handoff_not_open'
  | 'handoff_pending'
  | 'handoff_already_accepted'
  | 'event_contract_violation';

export type TaskDenial = Extract<AuthzDecision, { readonly allow: false }>;

export interface TaskFailure {
  readonly code: TaskErrorCode;
  readonly issues: readonly TaskIssue[];
  readonly denial?: TaskDenial;
}

export function taskIssue(field: string, reason: string): TaskIssue {
  return { field, reason };
}

export function taskFailure(
  code: TaskErrorCode,
  issues: readonly TaskIssue[],
): TaskFailure {
  return { code, issues };
}

export function taskError(
  code: TaskErrorCode,
  field: string,
  reason: string,
): TaskFailure {
  return { code, issues: [taskIssue(field, reason)] };
}

function describeDenied(denial: TaskDenial): string {
  const parts: string[] = [denial.reason];
  if (denial.requiredAuthority !== undefined) {
    parts.push(`requiredAuthority=${denial.requiredAuthority}`);
  }
  if (denial.escalateTo !== undefined) {
    parts.push(`escalateTo=${denial.escalateTo}`);
  }
  return parts.join(' ');
}

export function taskPermissionFailure(
  action: Action,
  denial: TaskDenial,
): TaskFailure {
  return {
    code: 'permission_denied',
    issues: [taskIssue('permission', `${action}: ${describeDenied(denial)}`)],
    denial,
  };
}
