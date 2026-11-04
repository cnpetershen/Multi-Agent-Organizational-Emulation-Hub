import type { EmployeeId } from '@maoeh/shared-types';
import type { Organization } from '../organization/organization.js';
import type { Position } from '../position/position.js';
import type { CapabilityProfile } from './capability-profile.js';
import { buildCapabilityProfiles, isEmploymentAvailable } from './capability-profile.js';

/**
 * Capability → **candidate agent** matching: "this work needs `implementation`; who in this
 * company can do it, ranked?".
 *
 * The ranking is a pure function of the organization and the requirement — no clock, no
 * randomness, no LLM — because a delegation decision has to be explainable after the fact
 * ("why Mike?" → "he is the only available holder of the implementation seat").
 *
 * Each capability resolves through the same organizational rule as `resolve-capabilities`:
 * the seats that *declare* it, staffed seats first; when every declaring seat is empty the
 * work escalates to the nearest staffed manager up the `reports_to` chain ("the seat is
 * vacant, the boss covers it"). The holders of those seats are the candidates.
 */

/** What a piece of work requires. Empty `requiredCapabilities` matches nobody, on purpose. */
export interface TaskRequirement {
  readonly title?: string;
  readonly goal?: string;
  readonly requiredCapabilities: readonly string[];
  /** Optional department scope: candidates from this department score higher. */
  readonly departmentId?: string | null;
}

export interface CandidateAgent {
  readonly profile: CapabilityProfile;
  /** The required capabilities this candidate can actually cover (input order preserved). */
  readonly matchedCapabilities: readonly string[];
  /**
   * The subset of `matchedCapabilities` the candidate covers through *personal expertise* rather
   * than the seat's declared tags — the evidence that makes "why this agent" answerable even when
   * the route went outside the org chart. Empty for the ordinary seat-routed case.
   */
  readonly expertiseMatched: readonly string[];
  readonly score: number;
  readonly departmentMatch: boolean;
  readonly available: boolean;
}

/** Points for one covered capability — the dominant term, so coverage outranks everything. */
export const CAPABILITY_MATCH_SCORE = 10;
/** Points for working in the requested department — a tie-break, never a substitute. */
export const DEPARTMENT_MATCH_SCORE = 5;

function norm(value: string): string {
  return value.trim().toLowerCase();
}

function declareCapability(position: Position, capability: string): boolean {
  return (position.capabilities ?? []).some((entry) => norm(entry) === capability);
}

function holdersOf(organization: Organization, positionId: string): readonly string[] {
  return organization.employees
    .filter(
      (employee) =>
        String(employee.positionId) === positionId && isEmploymentAvailable(employee.status),
    )
    .map((employee) => String(employee.id));
}

function nearestStaffedAncestor(organization: Organization, start: Position): Position | null {
  const seen = new Set<string>([String(start.id)]);
  let current: Position = start;
  for (let depth = 0; depth <= organization.positions.length; depth += 1) {
    if (holdersOf(organization, String(current.id)).length > 0) return current;
    const nextId: string | null =
      current.reportsToPositionId === null ? null : String(current.reportsToPositionId);
    if (nextId === null || seen.has(nextId)) return null;
    seen.add(nextId);
    const next = organization.positions.find((position) => String(position.id) === nextId);
    if (next === undefined) return null;
    current = next;
  }
  return null;
}

/**
 * Seats that carry `capability`, resolved through the staffing rule: declaring seats when at
 * least one is staffed, otherwise their nearest staffed manager. An empty result means no
 * seat in this organization declares the capability at all.
 */
function seatsForCapability(organization: Organization, capability: string): readonly Position[] {
  const declaring = organization.positions.filter((position) => declareCapability(position, capability));
  if (declaring.length === 0) return Object.freeze([]);
  const staffed = declaring.filter(
    (position) => holdersOf(organization, String(position.id)).length > 0,
  );
  if (staffed.length > 0) return Object.freeze(staffed);
  const escalated = declaring
    .map((position) => nearestStaffedAncestor(organization, position))
    .filter((position): position is Position => position !== null);
  return Object.freeze(escalated);
}

/**
 * Rank the available employees who can cover `requirement`.
 *
 * Candidates cover at least one required capability (a zero-match employee is never
 * returned), are available (employment allows work and the caller has not marked them
 * busy/paused), and are ordered by score descending, then seat seniority ascending (the
 * most specific / most junior fit wins a tie), then employee id — fully deterministic.
 * An empty requirement, or one nobody can cover, returns `[]`.
 *
 * A requirement is covered by either route: the seat declares it (the organizational default,
 * with vacant-seat escalation) or the person's own `expertise` contains it. Coverage — not the
 * route — drives the score, so a seat holder and a specialist who cover the same capabilities
 * rank on the same scale, and `expertiseMatched` keeps the two apart for the audit trail.
 */
export function matchCapabilityCandidates(
  organization: Organization,
  requirement: TaskRequirement,
  options: { readonly unavailable?: ReadonlySet<EmployeeId> } = {},
): readonly CandidateAgent[] {
  const required = Object.freeze(
    [...new Set(requirement.requiredCapabilities.map(norm).filter((value) => value !== ''))],
  );
  if (required.length === 0) return Object.freeze([]);

  const profiles = buildCapabilityProfiles(organization, options);
  const byEmployee = new Map<
    string,
    { profile: CapabilityProfile; seatCovered: Set<string>; covered: Set<string> }
  >();
  for (const profile of profiles) {
    if (!profile.available) continue;
    byEmployee.set(String(profile.employeeId), {
      profile,
      seatCovered: new Set<string>(),
      covered: new Set<string>(),
    });
  }

  // Pass 1 — the seat route: the holders of the seats that declare the requirement, including
  // the vacant-seat escalation `seatsForCapability` already applies.
  for (const capability of required) {
    const seats = new Set(
      seatsForCapability(organization, capability).map((position) => String(position.id)),
    );
    if (seats.size === 0) continue;
    for (const entry of byEmployee.values()) {
      if (!seats.has(entry.profile.positionId)) continue;
      entry.seatCovered.add(capability);
      entry.covered.add(capability);
    }
  }

  // Pass 2 — the expertise route: a person may cover a requirement their seat does not declare by
  // being personally specialized in it. This is person-level, so it never participates in the
  // vacant-seat escalation above; it only ever *widens* who can be asked.
  for (const capability of required) {
    for (const entry of byEmployee.values()) {
      if (entry.profile.expertise.includes(capability)) entry.covered.add(capability);
    }
  }

  const departmentId =
    requirement.departmentId === undefined || requirement.departmentId === null
      ? null
      : norm(String(requirement.departmentId));

  const candidates: CandidateAgent[] = [];
  for (const entry of byEmployee.values()) {
    // `matchedCapabilities` always reads in the requirement's own order, whichever route covered
    // each capability, so the recorded "why" is stable no matter which pass found it.
    const matched = required.filter((capability) => entry.covered.has(capability));
    if (matched.length === 0) continue;
    const expertiseMatched = matched.filter(
      (capability) => !entry.seatCovered.has(capability),
    );
    const departmentMatch =
      departmentId !== null && entry.profile.departmentId !== null
        ? norm(String(entry.profile.departmentId)) === departmentId
        : false;
    candidates.push(
      Object.freeze({
        profile: entry.profile,
        matchedCapabilities: Object.freeze([...matched]),
        expertiseMatched: Object.freeze([...expertiseMatched]),
        score:
          matched.length * CAPABILITY_MATCH_SCORE +
          (departmentMatch ? DEPARTMENT_MATCH_SCORE : 0),
        departmentMatch,
        available: entry.profile.available,
      }),
    );
  }

  return Object.freeze(
    candidates.sort(
      (left, right) =>
        right.score - left.score ||
        left.profile.seniority - right.profile.seniority ||
        String(left.profile.employeeId).localeCompare(String(right.profile.employeeId)),
    ),
  );
}

/** The single best candidate, or `null` when nothing in the organization can do the work. */
export function bestCapabilityMatch(
  organization: Organization,
  requirement: TaskRequirement,
  options: { readonly unavailable?: ReadonlySet<EmployeeId> } = {},
): CandidateAgent | null {
  return matchCapabilityCandidates(organization, requirement, options)[0] ?? null;
}
