import type { CompanyId, UserId } from '@maoeh/shared-types';
import type { User } from './user.js';

/**
 * Which seed builds the organization behind an ownership record.
 *
 * - `lab` — the full Future AI Lab roster (departments, positions and every employee the
 *   seed defines). This is the company a fresh install already has.
 * - `starter` — the same chart (departments + positions, so every seat can be hired into)
 *   with only the CEO on the roster: what a newly founded company starts with. Its other
 *   agents are hired at runtime through `Agent.Create` and come back from the company's own
 *   event log on replay.
 */
export type CompanySeed = 'lab' | 'starter';

/**
 * An AI company as the ownership model sees it (M1.5 `User owns Organization`).
 *
 * `Organization.id` **is** `Company.id` — the `organizationId` an agent, task or artifact
 * carries is the existing `companyId`, which every M0–M1 table and event already partitions
 * by. Owning a company therefore never required a second scoping column; it required an
 * owner.
 */
export interface OwnedOrganization {
  readonly id: CompanyId;
  readonly name: string;
  readonly ownerId: UserId;
  readonly seed: CompanySeed;
}

/** Everything `GET /api/ownership` answers with: the founders, their companies, and which company the runtime currently runs. */
export interface OwnershipState {
  readonly users: readonly User[];
  readonly organizations: readonly OwnedOrganization[];
  readonly activeOrganizationId: CompanyId;
}
