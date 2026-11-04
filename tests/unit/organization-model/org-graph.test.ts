import { describe, expect, it } from 'vitest';
import type { EmployeeId, PositionId } from '@maoeh/shared-types';
import type { OrgSnapshot } from '@maoeh/organization-model';
import { createOrgGraph, createOrgSnapshot, loadOrganization } from '@maoeh/organization-model';
import { createMemoryOrganizationReader } from '../../helpers/organization-readers';

const files: Record<string, string> = {
  'company.yaml': 'id: acme\nname: Acme Corp\n',
  'departments/engineering.yaml': 'id: engineering\nname: Engineering\n',
  'departments/platform.yaml':
    'id: platform\nname: Platform\nparent: engineering\n',
  'positions/ceo.yaml': 'id: ceo\ntitle: CEO\n',
  'positions/cto.yaml':
    'id: cto\ntitle: CTO\ndepartment: engineering\nreports_to: ceo\n',
  'positions/eng1.yaml':
    'id: eng1\ntitle: Engineer\ndepartment: engineering\nreports_to: cto\nkey: engineer\n',
  'positions/eng2.yaml':
    'id: eng2\ntitle: Engineer II\ndepartment: engineering\nreports_to: cto\nkey: engineer\n',
  'positions/qa.yaml':
    'id: qa\ntitle: QA\ndepartment: platform\nreports_to: ceo\n',
  'employees/alex.yaml': 'id: alex\nname: Alex\nposition: ceo\n',
  'employees/john.yaml': 'id: john\nname: John\nposition: cto\n',
  'employees/mike.yaml': 'id: mike\nname: Mike\nposition: eng1\n',
  'employees/sara.yaml': 'id: sara\nname: Sara\nposition: eng2\n',
};

function loadSyntheticOrganization(override: Record<string, string> = files) {
  const result = loadOrganization(createMemoryOrganizationReader(override));
  if (!result.ok) {
    throw new Error(
      result.error.issues
        .map((issue) => `${issue.source}: ${issue.reason}`)
        .join('\n'),
    );
  }
  return result.value;
}

function loadSynthetic(override: Record<string, string> = files) {
  return createOrgGraph(loadSyntheticOrganization(override));
}

const graph = loadSynthetic();

const eid = (value: string): EmployeeId => value as EmployeeId;
const pid = (value: string): PositionId => value as PositionId;

/**
 * A seat holding a retired record *before* a live one — the state `Agent.Archive` plus a
 * re-hire produces at runtime. The loader forbids it in seed files ("position is already held
 * by employee"), which is why this is built by mutating a loaded organization.
 */
function organizationWithRehiredSeat(positionId: string) {
  const organization = loadSyntheticOrganization();
  organization.employees.push({
    id: eid('quinn'),
    companyId: organization.company.id,
    positionId: pid(positionId),
    name: 'Quinn',
    status: 'active',
  });
  organization.employees.unshift({
    id: eid('adam'),
    companyId: organization.company.id,
    positionId: pid(positionId),
    name: 'Adam',
    status: 'offboarded',
  });
  return organization;
}

describe('OrgGraph 汇报线（合成组织：alex ← john ← mike/sara；qa 空缺）', () => {
  it('getManagerOf：逐级向上，顶层为 null', () => {
    expect(graph.getManagerOf(eid('mike'))?.id).toBe('john');
    expect(graph.getManagerOf(eid('sara'))?.id).toBe('john');
    expect(graph.getManagerOf(eid('john'))?.id).toBe('alex');
    expect(graph.getManagerOf(eid('alex'))).toBeNull();
  });

  it('getReports：直接下属按岗位推导，空缺岗位不产生虚假下属', () => {
    expect(graph.getReports(eid('john')).map((e) => e.id)).toEqual(['mike', 'sara']);
    expect(graph.getReports(eid('alex')).map((e) => e.id)).toEqual(['john']);
    expect(graph.getReports(eid('mike'))).toEqual([]);
  });

  it('getReports 与 getManagerOf 互逆', () => {
    const employees = graph.organization.employees;
    for (const employee of employees) {
      for (const report of graph.getReports(employee.id)) {
        expect(graph.getManagerOf(report.id)?.id).toBe(employee.id);
      }
      const manager = graph.getManagerOf(employee.id);
      if (manager !== null) {
        expect(
          graph.getReports(manager.id).some((r) => r.id === employee.id),
        ).toBe(true);
      }
    }
  });

  it('每人至多出现在一个上级的 getReports 中（唯一上级）', () => {
    for (const employee of graph.organization.employees) {
      const managers = graph.organization.employees.filter((candidate) =>
        graph.getReports(candidate.id).some((r) => r.id === employee.id),
      );
      expect(managers.length).toBeLessThanOrEqual(1);
    }
  });

  it('resolveByPosition：岗位占用/空缺', () => {
    expect(graph.resolveByPosition(pid('ceo'))?.id).toBe('alex');
    expect(graph.resolveByPosition(pid('eng2'))?.id).toBe('sara');
    expect(graph.resolveByPosition(pid('qa'))).toBeNull();
    expect(graph.resolveByPosition(pid('ghost'))).toBeNull();
  });

  it('resolveByPosition：同岗位的离职记录不遮蔽在岗者', () => {
    // M1.3 hires into a staffed seat instead of deleting the previous holder, so `qa` can carry a
    // retired record beside a live one. "First match" hands back the retired employee — which is
    // how a workflow step targeting that seat failed its preflight and deadlocked the instance,
    // with task assignment, reporting lines and the console all misreading the seat too.
    const rehired = createOrgGraph(organizationWithRehiredSeat('qa'));
    expect(rehired.resolveByPosition(pid('qa'))?.id).toBe('quinn');
    // The reporting line follows the live holder, not the retired one.
    expect(rehired.getManagerOf(eid('quinn'))?.id).toBe('alex');
  });

  it('resolveByPosition：同岗位只有离职者时仍返回该记录（岗位不因离职而显示空缺）', () => {
    // The fallback is deliberate: "who sits here" must still name someone, so the console and the
    // reporting lines do not report a seat that has a holder as vacant. Whether that person can
    // take *work* stays the caller's rule (`TaskService`, the workflow engine).
    const organization = loadSyntheticOrganization();
    organization.employees.push({
      id: eid('adam'),
      companyId: organization.company.id,
      positionId: pid('qa'),
      name: 'Adam',
      status: 'offboarded',
    });
    expect(createOrgGraph(organization).resolveByPosition(pid('qa'))?.id).toBe('adam');
  });
});

describe('OrgGraph 同侪与同部门（key 派生 PEER、部门派生同事）', () => {
  it('getPeers：同 key 岗位的员工互为同侪，跨 key 无同侪', () => {
    expect(graph.getPeers(eid('mike')).map((e) => e.id)).toEqual(['sara']);
    expect(graph.getPeers(eid('sara')).map((e) => e.id)).toEqual(['mike']);
    expect(graph.getPeers(eid('john'))).toEqual([]);
    expect(graph.getPeers(eid('alex'))).toEqual([]);
  });

  it('getColleagues：同部门（含父子部门不合并），CEO 无部门 → 空', () => {
    expect(graph.getColleagues(eid('mike')).map((e) => e.id)).toEqual([
      'john',
      'sara',
    ]);
    expect(graph.getColleagues(eid('john')).map((e) => e.id)).toEqual([
      'mike',
      'sara',
    ]);
    expect(graph.getColleagues(eid('sara')).map((e) => e.id)).toEqual([
      'john',
      'mike',
    ]);
    expect(graph.getColleagues(eid('alex'))).toEqual([]);
  });

  it('getColleagues 不把子部门成员并入父部门', () => {
    const graphWithQa = loadSynthetic({
      ...files,
      'employees/quinn.yaml': 'id: quinn\nname: Quinn\nposition: qa\n',
    });
    expect(
      graphWithQa.getColleagues(eid('mike')).map((e) => e.id),
    ).toEqual(['john', 'sara']);
    expect(graphWithQa.getColleagues(eid('quinn'))).toEqual([]);
    expect(graphWithQa.getManagerOf(eid('quinn'))?.id).toBe('alex');
    expect(graphWithQa.getReports(eid('alex')).map((e) => e.id)).toEqual([
      'john',
      'quinn',
    ]);
  });
});

describe('OrgSnapshot（合成组织）', () => {
  it('完整快照：manager/reports/peers/colleagues 齐备', () => {
    const snapshot: OrgSnapshot | null = createOrgSnapshot(graph, eid('mike'));
    expect(snapshot).not.toBeNull();
    expect(snapshot?.employee.id).toBe('mike');
    expect(snapshot?.department?.id).toBe('engineering');
    expect(snapshot?.position.id).toBe('eng1');
    expect(snapshot?.manager?.id).toBe('john');
    expect(snapshot?.reports).toEqual([]);
    expect(snapshot?.peers.map((e) => e.id)).toEqual(['sara']);
    expect(snapshot?.colleagues.map((e) => e.id)).toEqual(['john', 'sara']);
    expect(snapshot?.company.id).toBe('acme');
  });

  it('顶层管理者的快照：reports 非空、manager 为 null', () => {
    const snapshot = createOrgSnapshot(graph, eid('alex'));
    expect(snapshot?.manager).toBeNull();
    expect(snapshot?.reports.map((e) => e.id)).toEqual(['john']);
    expect(snapshot?.department).toBeNull();
    expect(snapshot?.colleagues).toEqual([]);
  });

  it('未知员工 → null', () => {
    expect(createOrgSnapshot(graph, eid('ghost'))).toBeNull();
  });
});
