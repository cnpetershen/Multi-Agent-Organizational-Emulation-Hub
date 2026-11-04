import { describe, expect, it } from 'vitest';
import {
  colleaguesOf,
  departmentHeadOf,
  departmentName,
  employeeOf,
  focusRef,
  peersOf,
  reportsOf,
} from '../../../apps/web/src/derive';

/**
 * The agent record is built from lookups over the snapshot the console already holds. They are
 * pure functions over the wire payload, so they are pinned here rather than through a render:
 * the employee's `employeeNo`, the department name behind its `departmentId`, the reverse of the
 * reporting line, and its peers/colleagues by position and department.
 *
 * The fixtures mirror the shapes `/api/snapshot` returns (`employeeId` on the roster,
 * `positionId` on the org chart, `departmentId` on both) — the record renders nothing that is
 * not in one of them.
 */

const employees = [
  { employeeId: 'ceo-alex', name: 'Alex', employeeNo: 'FAL-001', positionId: 'ceo', departmentId: null, managerEmployeeId: null },
  { employeeId: 'cto-john', name: 'John', employeeNo: 'FAL-002', positionId: 'cto', departmentId: 'engineering', managerEmployeeId: 'ceo-alex' },
  { employeeId: 'engineer-mike', name: 'Mike', employeeNo: null, positionId: 'engineer', departmentId: 'engineering', managerEmployeeId: 'cto-john' },
];

const departments = [
  { departmentId: 'engineering', name: 'Engineering', headPositionId: 'cto' },
  { departmentId: 'product', name: 'Product', headPositionId: 'product-manager' },
];

const positions = [
  { positionId: 'cto', title: 'Chief Technology Officer', departmentId: 'engineering' },
  { positionId: 'product-manager', title: 'Product Manager', departmentId: 'product' },
];

const agents = [
  { employeeId: 'ceo-alex', positionId: 'ceo', departmentId: null, lifecycle: 'active' },
  { employeeId: 'cto-john', positionId: 'cto', departmentId: 'engineering', lifecycle: 'active' },
  { employeeId: 'engineer-mike', positionId: 'engineer', departmentId: 'engineering', lifecycle: 'active' },
  { employeeId: 'engineer-priya', positionId: 'engineer', departmentId: 'engineering', lifecycle: 'active' },
];

describe('agent record lookups', () => {
  it('finds the roster row behind an agent id, and nothing for an unknown or empty id', () => {
    expect(employeeOf(employees, 'ceo-alex')?.['employeeNo']).toBe('FAL-001');
    expect(employeeOf(employees, 'engineer-mike')?.['employeeNo']).toBeNull();
    expect(employeeOf(employees, 'ghost')).toBeNull();
    expect(employeeOf(employees, '')).toBeNull();
  });

  it('resolves a department name, keeps an unknown id visible, and stays empty outside any department', () => {
    expect(departmentName(departments, 'engineering')).toBe('Engineering');
    expect(departmentName(departments, 'product')).toBe('Product');
    expect(departmentName(departments, 'ops')).toBe('ops');
    expect(departmentName(departments, null)).toBe('');
    expect(departmentName(departments, '')).toBe('');
  });

  it('names the department head, keeps an unstaffed head visible, and stays empty outside any department', () => {
    expect(departmentHeadOf(departments, positions, employees, 'engineering')).toBe('Chief Technology Officer · John');
    // 岗位空缺时仍然报出负责人岗位，这样“部门 → 员工”在空缺部门里也读得出来。
    expect(departmentHeadOf(departments, positions, employees, 'product')).toBe('Product Manager');
    expect(departmentHeadOf(departments, positions, employees, null)).toBe('');
    expect(departmentHeadOf(departments, positions, employees, 'ops')).toBe('');
  });

  it('reads the reporting line in both directions', () => {
    expect(reportsOf(employees, 'ceo-alex').map((row) => row['employeeId'])).toEqual(['cto-john']);
    expect(reportsOf(employees, 'cto-john').map((row) => row['employeeId'])).toEqual(['engineer-mike']);
    expect(reportsOf(employees, 'engineer-mike')).toEqual([]);
    expect(reportsOf(employees, '')).toEqual([]);
  });

  it('lists peers by position and colleagues by department, never the agent itself', () => {
    const mike = agents[2] as Record<string, unknown>;
    expect(peersOf(agents, mike).map((row) => row['employeeId'])).toEqual(['engineer-priya']);
    expect(colleaguesOf(agents, mike).map((row) => row['employeeId'])).toEqual(['cto-john', 'engineer-priya']);
  });

  it('gives a company-level position no colleagues instead of every other department-less agent', () => {
    const alex = agents[0] as Record<string, unknown>;
    expect(colleaguesOf(agents, alex)).toEqual([]);
    expect(peersOf(agents, alex)).toEqual([]);
  });

  it('renders the runtime focus reference, and nothing when the runtime reports none', () => {
    expect(focusRef({ focus: { refType: 'task', refId: 'task-3' } })).toBe('task · task-3');
    expect(focusRef({ focus: { refType: 'task', refId: '' } })).toBe('task');
    expect(focusRef({ focus: { refType: '', refId: 'task-3' } })).toBe('task-3');
    expect(focusRef({ focus: null })).toBe('');
    expect(focusRef({})).toBe('');
    expect(focusRef(null)).toBe('');
  });
});
