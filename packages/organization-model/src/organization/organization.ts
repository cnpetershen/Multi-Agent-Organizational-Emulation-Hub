import type { Company } from '../company/company.js';
import type { Department } from '../department/department.js';
import type { Employee } from '../employee/employee.js';
import type { Position } from '../position/position.js';

export interface Organization {
  company: Company;
  departments: Department[];
  positions: Position[];
  employees: Employee[];
}
