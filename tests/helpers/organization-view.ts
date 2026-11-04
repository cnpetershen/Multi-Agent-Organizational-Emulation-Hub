import type { EmployeeId } from '@maoeh/shared-types';
import type { OrganizationSnapshotView } from '@maoeh/agent-cognition';
import type { Organization } from '@maoeh/organization-model';

function named(id: string, name: string): { readonly id: EmployeeId; readonly name: string } {
  return { id: id as EmployeeId, name };
}

export function snapshotView(
  organization: Organization,
  employeeId: EmployeeId,
): OrganizationSnapshotView {
  const employee = organization.employees.find((candidate) => candidate.id === employeeId);
  if (employee === undefined) throw new Error(`employee ${employeeId} not found`);
  const position = organization.positions.find((candidate) => candidate.id === employee.positionId);
  if (position === undefined) throw new Error(`position for ${employeeId} not found`);

  const managerPositionId = position.reportsToPositionId;
  const managerEmployee =
    managerPositionId === null
      ? undefined
      : organization.employees.find((candidate) => candidate.positionId === managerPositionId);

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
    position: { id: position.id, title: position.title },
    employee: named(employee.id, employee.name),
    manager:
      managerEmployee === undefined ? null : named(managerEmployee.id, managerEmployee.name),
    reports: reports.map((candidate) => named(candidate.id, candidate.name)),
    peers: peers.map((candidate) => named(candidate.id, candidate.name)),
    colleagues,
  };
}
