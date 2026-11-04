import type { EmployeeId } from '@maoeh/shared-types';
import type { Organization } from '../organization/organization.js';

/**
 * Who can be asked to do work — the agent-side half of capability routing.
 *
 * `resolve-capabilities` answers "which *seat* does this capability live in"; a capability
 * profile answers "which *people* can pick the task up right now". Both read the same
 * source of truth (`Position.capabilities`) and neither invents a skill the organization
 * never declared, so the two halves cannot drift.
 *
 * A profile is derived, never stored: it is rebuilt from the organization on every match,
 * which is what keeps the roster, the chart and the availability answer in sync after an
 * `Agent.Create` / `Agent.Archive` / operator pause.
 */
export interface CapabilityProfile {
  readonly employeeId: EmployeeId;
  readonly name: string;
  readonly kind: string;
  readonly positionId: string;
  readonly positionTitle: string;
  readonly departmentId: string | null;
  /** Capability tags the employee's seat declares, deduped, input order preserved. */
  readonly capabilities: readonly string[];
  /**
   * Fine-grained specializations the *person* declares (`Employee.expertise`) — what they are
   * individually good at, on top of what their seat owns. Deduped, input order preserved.
   */
  readonly expertise: readonly string[];
  /** Seat seniority (the position's authority level, 0 when the seat declares none). */
  readonly seniority: number;
  /** `false` when the employment cannot take new work, or the caller overrode availability. */
  readonly available: boolean;
}

/**
 * Employment states that cannot take new work. Deliberately a superset of `task-system`'s
 * non-executable list: a person on leave is still employed, but handing them *new* work is
 * never the right answer for a matcher whose whole point is "who can do this".
 */
const NON_AVAILABLE_EMPLOYMENT: ReadonlySet<string> = new Set([
  'suspended',
  'transferred',
  'offboarded',
  'on_leave',
]);

export function isEmploymentAvailable(status: string): boolean {
  return !NON_AVAILABLE_EMPLOYMENT.has(status);
}

export interface CapabilityProfileOptions {
  /**
   * Employees to mark unavailable on top of their employment status — the runtime's busy
   * set (already holding an in-flight task) and its operator-paused set. Availability is a
   * read-side judgement, so the caller supplies what only the runtime knows.
   */
  readonly unavailable?: ReadonlySet<EmployeeId>;
}

function dedupe(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return Object.freeze(out);
}

/**
 * One capability profile per employee, ordered by employee id so the same organization
 * always produces the same list (deterministic matching starts here).
 */
export function buildCapabilityProfiles(
  organization: Organization,
  options: CapabilityProfileOptions = {},
): readonly CapabilityProfile[] {
  const unavailable = options.unavailable;
  const profiles = organization.employees.map((employee) => {
    const position = organization.positions.find((entry) => entry.id === employee.positionId);
    return Object.freeze({
      employeeId: employee.id,
      name: employee.name,
      kind: employee.kind ?? 'agent',
      positionId: String(employee.positionId),
      positionTitle: position?.title ?? '',
      departmentId: position === undefined ? null : position.departmentId,
      capabilities: dedupe(position?.capabilities ?? []),
      expertise: dedupe(
        (employee.expertise ?? []).map((entry) => entry.trim().toLowerCase()),
      ),
      seniority: position?.authorityLevel ?? 0,
      available:
        isEmploymentAvailable(employee.status) &&
        !(unavailable?.has(employee.id) ?? false),
    }) satisfies CapabilityProfile;
  });
  return Object.freeze(
    [...profiles].sort((left, right) =>
      String(left.employeeId) < String(right.employeeId)
        ? -1
        : String(left.employeeId) > String(right.employeeId)
          ? 1
          : 0,
    ),
  );
}
