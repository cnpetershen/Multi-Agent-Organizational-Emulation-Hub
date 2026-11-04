import type { EmployeeId, PositionId } from '@maoeh/shared-types';
import type { CapabilityOfferView, OrganizationSnapshotView } from '@maoeh/agent-cognition';
import type { Organization } from '@maoeh/organization-model';
import { isExecutableEmployment } from '@maoeh/organization-model';

function named(id: string, name: string): { readonly id: EmployeeId; readonly name: string } {
  return { id: id as EmployeeId, name };
}

/**
 * The staffed seat a vacant seat's work escalates to *for this viewer* — the same walk
 * `resolveCapabilityAssignments` performs up the `reports_to` chain, skipping the viewer's own
 * seat because a dispatcher's seat never holds the work it schedules. Cycle-safe: a loop in the
 * chain stops the walk instead of hanging it.
 */
function coveringSeatOf(
  organization: Organization,
  start: Organization['positions'][number],
  viewerSeatId: string,
): PositionId | null {
  let current: Organization['positions'][number] | undefined = start;
  const seen = new Set<string>();
  let depth = 0;
  while (current !== undefined && depth <= organization.positions.length) {
    const seatId: PositionId = current.id;
    const idKey = String(seatId);
    if (seen.has(idKey)) break;
    seen.add(idKey);
    if (idKey !== viewerSeatId) {
      const holder = organization.employees.some(
        (employee) => employee.positionId === seatId && isExecutableEmployment(employee.status),
      );
      if (holder) return seatId;
    }
    const nextId: PositionId | null = current.reportsToPositionId;
    if (nextId === null) return null;
    current = organization.positions.find((position) => position.id === nextId);
    depth += 1;
  }
  return null;
}

/**
 * The organization's capability roll-up: which capabilities the company provides and which
 * seats provide them. Read straight off the live chart so a seat created at runtime
 * (`Agent.Create`) is visible to the very next plan, and so the planner sees the same seats the
 * capability router will consider.
 *
 * `staffed` uses the canonical employment predicate (`isExecutableEmployment`), the same one
 * seat-holder resolution uses: a seat whose only holder has been let go is reported vacant
 * rather than silently advertised as available. `coveredBy` mirrors the router's escalation for
 * the viewing seat, so "vacant but the boss covers it" and "vacant with nobody to carry it" —
 * the only state a `RecommendHire` can fix — are distinguishable from the prompt alone.
 */
function capabilityMapOf(
  organization: Organization,
  viewerSeatId: string,
): readonly CapabilityOfferView[] {
  const byCapability = new Map<
    string,
    { id: PositionId; title: string; staffed: boolean; coveredBy: PositionId | null }[]
  >();
  for (const position of organization.positions) {
    const staffed = organization.employees.some(
      (employee) =>
        employee.positionId === position.id && isExecutableEmployment(employee.status),
    );
    const coveredBy = coveringSeatOf(organization, position, viewerSeatId);
    for (const capability of position.capabilities ?? []) {
      const seats = byCapability.get(capability) ?? [];
      seats.push({ id: position.id, title: position.title, staffed, coveredBy });
      byCapability.set(capability, seats);
    }
  }
  return Object.freeze(
    [...byCapability.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([capability, seats]) =>
        Object.freeze({
          capability,
          seats: Object.freeze(
            [...seats].sort((left, right) =>
              String(left.id) < String(right.id) ? -1 : String(left.id) > String(right.id) ? 1 : 0,
            ),
          ),
        }),
      ),
  );
}

export function organizationSnapshotView(
  organization: Organization,
  employeeId: EmployeeId,
): OrganizationSnapshotView {
  const employee = organization.employees.find((candidate) => candidate.id === employeeId);
  if (employee === undefined) throw new Error(`employee ${String(employeeId)} not found`);
  const position = organization.positions.find(
    (candidate) => candidate.id === employee.positionId,
  );
  if (position === undefined) {
    throw new Error(`position for ${String(employeeId)} not found`);
  }

  // The manager is resolved with the same employment predicate seat-holder resolution uses: a
  // retired holder is not who this agent reports to, so showing them as "Manager" would send the
  // agent to escalate to someone the organization has already let go (M1.3).
  const managerEmployee =
    position.reportsToPositionId === null
      ? undefined
      : organization.employees.find(
          (candidate) =>
            candidate.positionId === position.reportsToPositionId &&
            isExecutableEmployment(candidate.status),
        );

  const reports = organization.employees.filter((candidate) => {
    const candidatePosition = organization.positions.find(
      (entry) => entry.id === candidate.positionId,
    );
    return candidatePosition !== undefined && candidatePosition.reportsToPositionId === position.id;
  });

  const peers = organization.employees.filter(
    (candidate) => candidate.positionId === position.id && candidate.id !== employee.id,
  );

  const department =
    position.departmentId === null
      ? null
      : (organization.departments.find((entry) => entry.id === position.departmentId) ?? null);

  const colleagues =
    department === null
      ? []
      : organization.employees
          .filter((candidate) => {
            const candidatePosition = organization.positions.find(
              (entry) => entry.id === candidate.positionId,
            );
            return (
              candidate.id !== employee.id &&
              candidatePosition !== undefined &&
              candidatePosition.departmentId === department.id
            );
          })
          .map((candidate) => named(candidate.id, candidate.name));

  return {
    company: { id: organization.company.id, name: organization.company.name },
    department: department === null ? null : { id: department.id, name: department.name },
    position:
      position.capabilities === undefined || position.capabilities.length === 0
        ? { id: position.id, title: position.title }
        : { id: position.id, title: position.title, capabilities: [...position.capabilities] },
    capabilityMap: capabilityMapOf(organization, String(position.id)),
    employee: named(employee.id, employee.name),
    manager:
      managerEmployee === undefined ? null : named(managerEmployee.id, managerEmployee.name),
    reports: reports.map((candidate) => named(candidate.id, candidate.name)),
    peers: peers.map((candidate) => named(candidate.id, candidate.name)),
    colleagues,
  };
}
