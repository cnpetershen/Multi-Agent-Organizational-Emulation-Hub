import type { EmployeeId } from '@maoeh/shared-types';
import type { Company } from '../company/company.js';
import type { Department } from '../department/department.js';
import type { Employee } from '../employee/employee.js';
import type { Position } from '../position/position.js';
import type { OrgGraph } from './org-graph.js';

export interface OrgSnapshot {
  company: Company;
  department: Department | null;
  position: Position;
  employee: Employee;
  manager: Employee | null;
  reports: Employee[];
  peers: Employee[];
  colleagues: Employee[];
}

export function createOrgSnapshot(
  graph: OrgGraph,
  employeeId: EmployeeId,
): OrgSnapshot | null {
  const employee = graph.getEmployee(employeeId);
  if (employee === null) return null;
  const position = graph.getPosition(employee.positionId);
  if (position === null) return null;
  const department =
    position.departmentId === null
      ? null
      : graph.getDepartment(position.departmentId);
  return {
    company: graph.organization.company,
    department,
    position,
    employee,
    manager: graph.getManagerOf(employeeId),
    reports: graph.getReports(employeeId),
    peers: graph.getPeers(employeeId),
    colleagues: graph.getColleagues(employeeId),
  };
}
