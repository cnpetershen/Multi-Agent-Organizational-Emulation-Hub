import type { AuthorityLevel, EmployeeId } from '@maoeh/shared-types';

export type AuthzDenialReason = 'NO_PERMISSION' | 'OUT_OF_SCOPE' | 'NEEDS_APPROVAL';

export type AuthzDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly reason: AuthzDenialReason;
      readonly requiredAuthority?: AuthorityLevel;
      readonly escalateTo?: EmployeeId;
    };

export const ALLOW: AuthzDecision = { allow: true };

export function deny(reason: 'NO_PERMISSION' | 'OUT_OF_SCOPE'): AuthzDecision {
  return { allow: false, reason };
}

export function needsApproval(
  requiredAuthority: AuthorityLevel,
  escalateTo?: EmployeeId,
): AuthzDecision {
  if (escalateTo === undefined) {
    return { allow: false, reason: 'NEEDS_APPROVAL', requiredAuthority };
  }
  return { allow: false, reason: 'NEEDS_APPROVAL', requiredAuthority, escalateTo };
}
