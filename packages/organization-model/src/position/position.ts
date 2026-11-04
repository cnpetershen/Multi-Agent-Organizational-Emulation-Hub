import type {
  AuthorityLevel,
  CompanyId,
  DecisionDomain,
  DepartmentId,
  PositionId,
} from '@maoeh/shared-types';

export type PositionStatus = 'open' | 'filled' | 'frozen' | 'closed';

export interface Position {
  id: PositionId;
  companyId: CompanyId;
  departmentId: DepartmentId | null;
  reportsToPositionId: PositionId | null;
  key?: string;
  title: string;
  roleCode?: string;
  authorityLevel?: AuthorityLevel;
  responsibilities?: unknown;
  requiredSkills?: unknown;
  headcount?: number;
  status?: PositionStatus;
  decisionDomains?: Partial<Record<DecisionDomain, AuthorityLevel>>;
  /**
   * Capability tags this seat provides (e.g. `product_requirement`, `implementation`).
   *
   * Task routing resolves **capability → position** from this list, never from the position's
   * name or title: a "Game Developer" seat with `implementation` is callable exactly like the
   * stock `engineer` seat, and a seat with no tags simply never matches. Additive and optional,
   * so the seed chart and every existing reader are unchanged.
   */
  capabilities?: readonly string[];
}
