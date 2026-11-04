/**
 * M1.3 · Agent Lifecycle Management — the vocabulary of "an agent joins / an agent is archived".
 *
 * Two facts about this module matter:
 *
 * 1. **Archive is not deletion.** An archived agent keeps its `EmployeeId`, its position, its
 *    task history, its events and its audit trail. Only its *employment* is closed, which is
 *    exactly what the domain already models (`offboarded`, 04-agent-lifecycle §4.6: 离职 ≠ 删除).
 *    So M1.3 reuses that domain status instead of introducing a second "inactive employee"
 *    vocabulary — `lifecycle` is the projection the API and the console speak.
 *
 * 2. **The lifecycle has exactly two states** (`active` / `archived`). A runtime-created agent is
 *    born `active`; `Agent.Archive` moves it to `archived` and nothing moves it back (an archived
 *    agent is re-hired by creating a new one, which keeps the history honest).
 */
import type { EmployeeStatus } from '@maoeh/organization-model';

export const AGENT_LIFECYCLE_STATUSES = ['active', 'archived'] as const;

export type AgentLifecycleStatus = (typeof AGENT_LIFECYCLE_STATUSES)[number];

/** The domain status an archive produces. The employee record is closed, never removed. */
export const ARCHIVED_EMPLOYMENT_STATUS = 'offboarded' satisfies EmployeeStatus;

/** `true` when this employment status means "archived" (i.e. no longer on the roster). */
export function isArchivedEmployment(employmentStatus: string): boolean {
  return employmentStatus === ARCHIVED_EMPLOYMENT_STATUS;
}

/**
 * Project an employment status onto the agent lifecycle. Every employment state that is not
 * "offboarded" is still an agent the organization holds (including `on_leave` / `suspended`:
 * those are temporary employee states, not archived identities).
 */
export function agentLifecycleOf(employmentStatus: string): AgentLifecycleStatus {
  return isArchivedEmployment(employmentStatus) ? 'archived' : 'active';
}
