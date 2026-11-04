import type { CompanyId, UserId } from '@maoeh/shared-types';

export interface Company {
  id: CompanyId;
  name: string;
  /**
   * The `User` (founder) who owns this AI company — M1.5 `User owns Organization`.
   *
   * Absent only for a company loaded from a source that does not name an owner; the
   * composition root stamps it from the ownership record the moment the organization is
   * composed, so every company the console can open has an owner.
   */
  ownerId?: UserId;
  mission?: string;
  strategy?: unknown;
  foundedSimDay?: number;
}
