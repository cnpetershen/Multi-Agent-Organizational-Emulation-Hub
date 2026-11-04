import type { CompanyId, DepartmentId, PositionId } from '@maoeh/shared-types';

export interface Department {
  id: DepartmentId;
  companyId: CompanyId;
  parent: DepartmentId | null;
  key?: string;
  name: string;
  headPositionId: PositionId | null;
  budget?: unknown;
}
