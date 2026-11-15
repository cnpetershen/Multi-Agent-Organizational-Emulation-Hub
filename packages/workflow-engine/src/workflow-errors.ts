import type { AuthzDecision } from '@maoeh/permission-system';

export interface WorkflowIssue {
  readonly field: string;
  readonly reason: string;
}

export type WorkflowErrorCode =
  | 'invalid_input'
  | 'invalid_actor'
  | 'unknown_workflow'
  | 'invalid_definition'
  | 'unknown_instance'
  | 'instance_not_running'
  | 'instance_not_draft'
  | 'instance_blocked'
  | 'instance_terminal'
  | 'approval_not_open'
  | 'approval_already_decided'
  | 'human_approval_required'
  | 'permission_denied'
  | 'authority_insufficient'
  | 'step_not_active'
  | 'task_not_in_instance'
  | 'no_matching_transition'
  | 'ambiguous_transition'
  | 'auto_step_overflow'
  | 'verification_not_applicable'
  | 'event_contract_violation'
  | 'task_command_failed';

export type WorkflowDenial = Extract<AuthzDecision, { readonly allow: false }>;

export interface WorkflowFailure {
  readonly code: WorkflowErrorCode;
  readonly issues: readonly WorkflowIssue[];
  readonly denial?: WorkflowDenial;
}

export function workflowIssue(field: string, reason: string): WorkflowIssue {
  return { field, reason };
}

export function workflowFailure(
  code: WorkflowErrorCode,
  issues: readonly WorkflowIssue[],
): WorkflowFailure {
  return { code, issues };
}

export function workflowError(
  code: WorkflowErrorCode,
  field: string,
  reason: string,
): WorkflowFailure {
  return { code, issues: [workflowIssue(field, reason)] };
}

function describeDenied(denial: WorkflowDenial): string {
  const parts: string[] = [denial.reason];
  if (denial.requiredAuthority !== undefined) {
    parts.push(`requiredAuthority=${denial.requiredAuthority}`);
  }
  if (denial.escalateTo !== undefined) {
    parts.push(`escalateTo=${denial.escalateTo}`);
  }
  return parts.join(' ');
}

export function workflowPermissionFailure(
  action: string,
  denial: WorkflowDenial,
): WorkflowFailure {
  return {
    code: 'permission_denied',
    issues: [workflowIssue('permission', `${action}: ${describeDenied(denial)}`)],
    denial,
  };
}
