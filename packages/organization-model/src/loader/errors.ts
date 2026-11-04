export type OrgEntityType =
  | 'company'
  | 'department'
  | 'position'
  | 'employee'
  | 'organization';

export interface OrgLoadIssue {
  source: string;
  entityType: OrgEntityType;
  entityId?: string;
  field?: string;
  line?: number;
  column?: number;
  reason: string;
}

export interface OrgLoadFailure {
  issues: readonly OrgLoadIssue[];
}
