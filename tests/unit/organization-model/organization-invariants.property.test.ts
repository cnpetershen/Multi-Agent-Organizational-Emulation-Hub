import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createOrgGraph, createOrgSnapshot, loadOrganization } from '@maoeh/organization-model';
import type { EmployeeId } from '@maoeh/shared-types';
import { createMemoryOrganizationReader } from '../../helpers/organization-readers';

interface ForestSpec {
  departmentCount: number;
  departmentParents: Array<number | null>;
  positionManagers: Array<number | null>;
  positionDepartments: Array<number | null>;
}

function buildForestFiles(spec: ForestSpec): Record<string, string> {
  const files: Record<string, string> = {
    'company.yaml': 'id: acme\nname: Acme Corp\n',
  };
  spec.departmentParents.forEach((parent, index) => {
    const lines = [`id: d${index}`, `name: Department ${index}`];
    if (parent !== null) lines.push(`parent: d${parent}`);
    files[`departments/d${index}.yaml`] = `${lines.join('\n')}\n`;
  });
  spec.positionManagers.forEach((manager, index) => {
    const lines = [`id: p${index}`, `title: Role ${index}`];
    if (manager !== null) lines.push(`reports_to: p${manager}`);
    const department = spec.positionDepartments[index];
    if (department !== null) lines.push(`department: d${department}`);
    files[`positions/p${index}.yaml`] = `${lines.join('\n')}\n`;
  });
  spec.positionManagers.forEach((_, index) => {
    files[`employees/e${index}.yaml`] =
      `id: e${index}\nname: Employee ${index}\nposition: p${index}\n`;
  });
  return files;
}

const forestArb: fc.Arbitrary<ForestSpec> = fc
  .record({
    positionCount: fc.integer({ min: 1, max: 8 }),
    departmentCount: fc.integer({ min: 0, max: 4 }),
    managers: fc.array(fc.nat(100), { maxLength: 8 }),
    deptParents: fc.array(fc.nat(100), { maxLength: 4 }),
    posDepartments: fc.array(fc.nat(100), { maxLength: 8 }),
  })
  .map((raw) => {
    const departmentParents: Array<number | null> = [];
    for (let index = 0; index < raw.departmentCount; index += 1) {
      const value = raw.deptParents[index];
      departmentParents.push(
        index > 0 && value !== undefined ? value % index : null,
      );
    }
    const positionManagers: Array<number | null> = [];
    const positionDepartments: Array<number | null> = [];
    for (let index = 0; index < raw.positionCount; index += 1) {
      const manager = raw.managers[index];
      positionManagers.push(
        index > 0 && manager !== undefined ? manager % index : null,
      );
      const department = raw.posDepartments[index];
      positionDepartments.push(
        raw.departmentCount > 0 && department !== undefined
          ? department % raw.departmentCount
          : null,
      );
    }
    return {
      departmentCount: raw.departmentCount,
      departmentParents,
      positionManagers,
      positionDepartments,
    };
  });

function loadSpec(files: Record<string, string>) {
  return loadOrganization(createMemoryOrganizationReader(files));
}

describe('org-model 属性测试（02-modules §2.5：无环 / 唯一上级 / 部门连通 / 互逆）', () => {
  it('随机森林组织（经理与父部门索引恒小于自身）加载成功且不变量成立', () => {
    fc.assert(
      fc.property(forestArb, (spec) => {
        const result = loadSpec(buildForestFiles(spec));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const graph = createOrgGraph(result.value);
        const employees = result.value.employees;
        for (const employee of employees) {
          const manager = graph.getManagerOf(employee.id);
          if (manager !== null) {
            expect(
              graph.getReports(manager.id).some((r) => r.id === employee.id),
            ).toBe(true);
          }
          for (const report of graph.getReports(employee.id)) {
            expect(graph.getManagerOf(report.id)?.id).toBe(employee.id);
          }
          let steps = 0;
          let cursor = manager;
          while (cursor !== null) {
            cursor = graph.getManagerOf(cursor.id);
            steps += 1;
            expect(steps).toBeLessThanOrEqual(employees.length);
          }
          const managersOf = employees.filter((candidate) =>
            graph.getReports(candidate.id).some((r) => r.id === employee.id),
          );
          expect(managersOf.length).toBeLessThanOrEqual(1);
          const snapshot = createOrgSnapshot(graph, employee.id);
          expect(snapshot).not.toBeNull();
          expect(snapshot?.employee.id).toBe(employee.id);
          graph.getPeers(employee.id);
          graph.getColleagues(employee.id);
        }
        for (const department of result.value.departments) {
          let cursor = department.parent;
          let steps = 0;
          while (cursor !== null) {
            const parent = graph.getDepartment(cursor);
            expect(parent).not.toBeNull();
            cursor = parent !== null ? parent.parent : null;
            steps += 1;
            expect(steps).toBeLessThanOrEqual(result.value.departments.length);
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  it('岗位汇报线成环（环形结构）必被拒绝', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 8 }), (size) => {
        const files: Record<string, string> = {
          'company.yaml': 'id: acme\nname: Acme Corp\n',
        };
        for (let index = 0; index < size; index += 1) {
          const next = (index + 1) % size;
          files[`positions/p${index}.yaml`] =
            `id: p${index}\ntitle: Role ${index}\nreports_to: p${next}\n`;
          files[`employees/e${index}.yaml`] =
            `id: e${index}\nname: Employee ${index}\nposition: p${index}\n`;
        }
        const result = loadSpec(files);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        const cycleIssue = result.error.issues.find((issue) =>
          issue.reason.startsWith('reporting cycle:'),
        );
        expect(cycleIssue).toBeDefined();
        expect(cycleIssue?.entityType).toBe('position');
        expect(cycleIssue?.field).toBe('reports_to');
      }),
      { numRuns: 30 },
    );
  });

  it('部门父级成环（环形结构）必被拒绝', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6 }), (size) => {
        const files: Record<string, string> = {
          'company.yaml': 'id: acme\nname: Acme Corp\n',
        };
        for (let index = 0; index < size; index += 1) {
          const next = (index + 1) % size;
          files[`departments/d${index}.yaml`] =
            `id: d${index}\nname: Department ${index}\nparent: d${next}\n`;
        }
        const result = loadSpec(files);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(
          result.error.issues.some((issue) =>
            issue.reason.startsWith('department parent cycle:'),
          ),
        ).toBe(true);
      }),
      { numRuns: 30 },
    );
  });

  it('非法引用（随机悬空 reports_to）必被拒绝且定位到字段', () => {
    fc.assert(
      fc.property(fc.nat(1000), (salt) => {
        const result = loadSpec({
          'company.yaml': 'id: acme\nname: Acme Corp\n',
          'positions/p0.yaml': `id: p0\ntitle: Role\nreports_to: ghost${salt}\n`,
          'employees/e0.yaml': 'id: e0\nname: E\nposition: p0\n',
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(
          result.error.issues.some(
            (issue) =>
              issue.field === 'reports_to' &&
              issue.reason === `unknown position "ghost${salt}"`,
          ),
        ).toBe(true);
      }),
      { numRuns: 30 },
    );
  });

  it('未知员工快照恒为 null（属性化边界）', () => {
    fc.assert(
      fc.property(forestArb, fc.string({ minLength: 1, maxLength: 12 }), (spec, id) => {
        const result = loadSpec(buildForestFiles(spec));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const graph = createOrgGraph(result.value);
        const known = result.value.employees.some(
          (employee) => employee.id === id,
        );
        const snapshot = createOrgSnapshot(graph, id as EmployeeId);
        if (known) expect(snapshot).not.toBeNull();
        else expect(snapshot).toBeNull();
      }),
      { numRuns: 40 },
    );
  });
});
