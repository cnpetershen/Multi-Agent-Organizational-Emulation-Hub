import type { DepartmentId, EmployeeId, PositionId } from '@maoeh/shared-types';
import type { Department } from '../department/department.js';
import type { Employee } from '../employee/employee.js';
import { isExecutableEmployment } from '../employee/employee.js';
import type { Position } from '../position/position.js';
import type { Organization } from './organization.js';

export interface OrgGraph {
  readonly organization: Organization;
  getEmployee(employeeId: EmployeeId): Employee | null;
  getDepartment(departmentId: DepartmentId): Department | null;
  getPosition(positionId: PositionId): Position | null;
  getManagerOf(employeeId: EmployeeId): Employee | null;
  getReports(employeeId: EmployeeId): Employee[];
  getPeers(employeeId: EmployeeId): Employee[];
  getColleagues(employeeId: EmployeeId): Employee[];
  resolveByPosition(positionId: PositionId): Employee | null;
}

/**
 * The graph reads **employees** from the live `organization.employees` array instead of a
 * boot-time index, because M1.3 lets the Runtime place a new agent at runtime (`Agent.Create`):
 * authority checks, task assignment by position, reporting lines and the console read model all
 * resolve employees through this graph, and all of them must see the same roster as the
 * organization object.
 *
 * Positions and departments are live for the same reason: `Agent.Create` may also create a
 * **new position** at runtime (an operator types a title the chart does not have yet), so a
 * boot-time position index would make the reporting line, the department roll-up and the
 * capability matcher disagree with the organization object the command just changed. The chart
 * only ever grows, so a live lookup is the boot-time index plus the rows added later.
 */
export function createOrgGraph(organization: Organization): OrgGraph {
  const findDepartment = (departmentId: DepartmentId): Department | undefined =>
    organization.departments.find((department) => department.id === departmentId);

  const findPosition = (positionId: PositionId): Position | undefined =>
    organization.positions.find((position) => position.id === positionId);

  const findEmployee = (employeeId: EmployeeId): Employee | null =>
    organization.employees.find((employee) => employee.id === employeeId) ?? null;

  const getEmployee = (employeeId: EmployeeId): Employee | null => findEmployee(employeeId);

  const getDepartment = (departmentId: DepartmentId): Department | null =>
    findDepartment(departmentId) ?? null;

  const getPosition = (positionId: PositionId): Position | null =>
    findPosition(positionId) ?? null;

  /**
   * Who holds a seat.
   *
   * A seat can carry more than one employee record, because M1.3 hires into a staffed seat
   * instead of deleting the previous holder: `Agent.Archive` is a status change, so a retired
   * record keeps pointing at the seat it used to occupy. Taking the first match therefore hands
   * back a person the company has already let go — which is how a workflow step targeting that
   * seat came to fail its preflight ("employee X has employment status offboarded") and deadlock
   * the instance, while the live holder sat right there in the same seat.
   *
   * So: prefer someone who can still carry the seat's work, and fall back to a non-executable
   * holder only when nobody else sits there — that fallback keeps reporting lines and the console
   * able to name a seat's occupant instead of reporting a staffed seat as vacant.
   *
   * Callers that hand out work still apply their own rule on top: `TaskService` leaves the task
   * on the position when the only holder is retired, and the `WorkflowEngine` refuses to enter a
   * step whose seat has nobody executable. This answers "who sits here", not "can they take work".
   */
  const resolveByPosition = (positionId: PositionId): Employee | null => {
    const holders = organization.employees.filter(
      (employee) => employee.positionId === positionId,
    );
    return holders.find((employee) => isExecutableEmployment(employee.status)) ?? holders[0] ?? null;
  };

  const peerKeyOf = (employee: Employee): string | null => {
    const position = findPosition(employee.positionId);
    if (position === undefined) return null;
    return position.key ?? position.id;
  };

  const getManagerOf = (employeeId: EmployeeId): Employee | null => {
    const employee = findEmployee(employeeId);
    if (employee === null) return null;
    const position = findPosition(employee.positionId);
    if (position === undefined || position.reportsToPositionId === null) return null;
    return resolveByPosition(position.reportsToPositionId);
  };

  const getReports = (employeeId: EmployeeId): Employee[] => {
    const employee = findEmployee(employeeId);
    if (employee === null) return [];
    const reports: Employee[] = [];
    for (const position of organization.positions) {
      if (position.reportsToPositionId === employee.positionId) {
        const report = resolveByPosition(position.id);
        if (report !== null) reports.push(report);
      }
    }
    return reports;
  };

  const getPeers = (employeeId: EmployeeId): Employee[] => {
    const employee = findEmployee(employeeId);
    if (employee === null) return [];
    const peerKey = peerKeyOf(employee);
    if (peerKey === null) return [];
    return organization.employees.filter(
      (other) => other.id !== employee.id && peerKeyOf(other) === peerKey,
    );
  };

  const getColleagues = (employeeId: EmployeeId): Employee[] => {
    const employee = findEmployee(employeeId);
    if (employee === null) return [];
    const position = findPosition(employee.positionId);
    if (position === undefined || position.departmentId === null) return [];
    return organization.employees.filter((other) => {
      if (other.id === employee.id) return false;
      const otherPosition = findPosition(other.positionId);
      return (
        otherPosition !== undefined &&
        otherPosition.departmentId === position.departmentId
      );
    });
  };

  return {
    organization,
    getEmployee,
    getDepartment,
    getPosition,
    getManagerOf,
    getReports,
    getPeers,
    getColleagues,
    resolveByPosition,
  };
}
