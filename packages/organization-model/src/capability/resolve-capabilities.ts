import type { PositionId } from '@maoeh/shared-types';
import type { Organization } from '../organization/organization.js';
import type { Position } from '../position/position.js';

/**
 * Capability → position resolution — the routing half of "the CEO calls a matching seat".
 *
 * Given the capabilities a goal needs, this answers **which seat in this organization does
 * that work**, with two organizational rules instead of name matching:
 *
 * 1. A seat matches only if it *declares* the capability in `Position.capabilities`.
 * 2. Among matching seats, a **staffed** seat wins (someone can actually pick the task up);
 *    ties go to the least-authoritative seat first (the most specific/most junior fit), then
 *    by id so the choice is deterministic. If every matching seat is empty, the task escalates
 *    to the nearest **staffed manager up the `reports_to` chain** — the classic "the seat is
 *    vacant, the boss covers it" rule — and only if no staffed ancestor exists at all does the
 *    resolver return the vacant seat itself (the work is then visible for `Task.Reassign`).
 *
 * Capabilities no seat declares are dropped: inventing a seat for them would be the kind of
 * hidden behaviour the organization model is supposed to make explicit.
 */

export interface CapabilityResolutionOptions {
  /**
   * Seats that must not be chosen to *hold* the work.
   *
   * The seat that composes a plan is a dispatcher, not an executor: a mandate's author schedules
   * the work it just decomposed and cannot end up as the assignee of its own dispatch. That is the
   * organizational rule "the CEO breaks the task book down and hands it to the seats that execute"
   * expressed where routing happens, instead of by position name.
   *
   * Seats listed here are not candidates and are skipped while walking the reporting chain. When
   * they are the *only* staffed way to carry a capability, the capability is omitted from the plan
   * (like a capability nobody declares) rather than silently assigned back to the dispatcher.
   */
  readonly excludeSeatIds?: readonly string[];
}

export interface CapabilityAssignment {
  /** The requested capability (deduped, input order preserved). */
  readonly capability: string;
  /** Seat that declares the capability (the "natural" home of this work). */
  readonly matchedPositionId: string;
  /** Seat that will actually hold the task (matched seat, or a staffed ancestor). */
  readonly positionId: string;
  /** `true` when `positionId` differs from `matchedPositionId` (the seat was vacant). */
  readonly escalated: boolean;
}

/** Staffed = has a live (not offboarded) employee in the seat. */
function holdersOf(organization: Organization, positionId: PositionId): number {
  return organization.employees.filter(
    (employee) =>
      employee.positionId === positionId && employee.status !== 'offboarded',
  ).length;
}

interface Candidate {
  readonly position: Position;
  readonly seat: Position;
  readonly depth: number;
  readonly authority: number;
}

function authorityOf(position: Position): number {
  return position.authorityLevel ?? 0;
}

function ancestorsOf(
  organization: Organization,
  start: Position,
): readonly { readonly position: Position; readonly depth: number }[] {
  const chain: { readonly position: Position; readonly depth: number }[] = [];
  const seen = new Set<string>([String(start.id)]);
  let current: Position | undefined = start;
  let depth = 0;
  while (current !== undefined && depth < organization.positions.length + 1) {
    chain.push({ position: current, depth });
    const nextId: PositionId | null = current.reportsToPositionId;
    if (nextId === null) break;
    if (seen.has(String(nextId))) break;
    seen.add(String(nextId));
    current = organization.positions.find((position) => position.id === nextId);
    depth += 1;
  }
  return chain;
}

function bestCandidate(candidates: readonly Candidate[]): Candidate {
  return [...candidates].sort(
    (left, right) =>
      left.depth - right.depth ||
      left.authority - right.authority ||
      String(left.position.id).localeCompare(String(right.position.id)),
  )[0] as Candidate;
}

function resolveOne(
  organization: Organization,
  capability: string,
  excluded: ReadonlySet<string>,
): CapabilityAssignment | null {
  const declaring = organization.positions.filter((position) =>
    (position.capabilities ?? []).includes(capability),
  );
  if (declaring.length === 0) return null;

  const candidates: Candidate[] = [];
  for (const position of declaring) {
    // An excluded seat is not a candidate at all — not as the natural home, and not as the
    // "boss covers the vacant seat" fallback either.
    if (excluded.has(String(position.id))) continue;
    const chain = ancestorsOf(organization, position);
    const staffed = chain.find(
      (link) => !excluded.has(String(link.position.id)) && holdersOf(organization, link.position.id) > 0,
    );
    const seat = staffed?.position ?? position;
    candidates.push({
      position,
      seat,
      depth: staffed?.depth ?? Number.POSITIVE_INFINITY,
      authority: authorityOf(seat),
    });
  }
  if (candidates.length === 0) return null;

  const best = bestCandidate(candidates);
  // Without an exclusion this keeps the legacy behaviour byte-for-byte: an unstaffed seat is
  // returned so the work stays visible for `Task.Reassign`. With one, "the only person who could
  // do this is the one handing it out" means the organization cannot carry it at all, and a plan
  // that omits it is honest where a plan that assigns it to the dispatcher is not.
  if (excluded.size > 0 && !Number.isFinite(best.depth)) return null;
  return {
    capability,
    matchedPositionId: String(best.position.id),
    positionId: String(best.seat.id),
    escalated: String(best.seat.id) !== String(best.position.id),
  };
}

/**
 * Resolve requested capabilities to seats. Order follows the (deduped) request; capabilities
 * with no declaring seat are omitted, and an empty result means "this organization cannot do
 * any of that work" — the caller must not schedule a workflow for it.
 */
export function resolveCapabilityAssignments(
  organization: Organization,
  capabilities: readonly string[],
  options: CapabilityResolutionOptions = {},
): readonly CapabilityAssignment[] {
  const excluded = new Set((options.excludeSeatIds ?? []).map((entry) => entry.trim()).filter((entry) => entry !== ''));
  const seen = new Set<string>();
  const assignments: CapabilityAssignment[] = [];
  for (const raw of capabilities) {
    const capability = raw.trim().toLowerCase();
    if (capability === '' || seen.has(capability)) continue;
    seen.add(capability);
    const assignment = resolveOne(organization, capability, excluded);
    if (assignment !== null) assignments.push(assignment);
  }
  return Object.freeze(assignments);
}
