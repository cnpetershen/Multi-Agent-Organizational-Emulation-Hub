import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EmployeeId, PositionId } from '@maoeh/shared-types';
import type { OrgGraph, OrgSnapshot } from '@maoeh/organization-model';
import { createOrgGraph, createOrgSnapshot, loadOrganization } from '@maoeh/organization-model';
import { createNodeFsOrganizationReader } from '../../helpers/organization-readers';

const seedRoot = fileURLToPath(
  new URL('../../../agents/future-ai-lab/', import.meta.url),
);

function loadSeed(): { graph: OrgGraph; snapshotOf: (id: string) => OrgSnapshot | null } {
  const result = loadOrganization(createNodeFsOrganizationReader(seedRoot));
  if (!result.ok) {
    throw new Error(
      result.error.issues
        .map((issue) => `${issue.source}: ${issue.reason}`)
        .join('\n'),
    );
  }
  const graph = createOrgGraph(result.value);
  return {
    graph,
    snapshotOf: (id: string) => createOrgSnapshot(graph, id as EmployeeId),
  };
}

const { graph, snapshotOf } = loadSeed();

describe('M0.2 组织定义输入：agents/future-ai-lab → OrgSnapshot 八问', () => {
  it('种子组织整体加载成功（1 公司 / 5 部门 / 15 岗位 / 6 员工）', () => {
    const organization = graph.organization;
    expect(organization.company.id).toBe('future-ai-lab');
    expect(organization.departments.map((d) => d.id)).toEqual([
      'business',
      'engineering',
      'marketing',
      'product',
      'research',
    ]);
    expect(organization.positions.map((p) => p.id)).toEqual([
      'agent-engineer',
      'ai-engineer',
      'ai-researcher',
      'backend-engineer',
      'business-analyst',
      'ceo',
      'cto',
      'devops-engineer',
      'engineer',
      'frontend-engineer',
      'growth-manager',
      'marketing-manager',
      'product-manager',
      'qa',
      'ux-designer',
    ]);
    expect(organization.employees.map((e) => e.id)).toEqual([
      'ceo-alex',
      'cto-john',
      'engineer-mike',
      'marketing-jack',
      'pm-bona',
      'qa-peter',
    ]);
    for (const entity of [
      ...organization.departments,
      ...organization.positions,
      ...organization.employees,
    ]) {
      expect(entity.companyId).toBe('future-ai-lab');
    }
    // 种子里除在岗 6 个岗位外全是公开空缺编制（`backend-engineer` 是原目标岗位树的空缺，
    // 新增的 8 个岗位是招聘位）——空编岗位必须无人在岗，在岗岗位必须有人。
    const VACANT = new Set([
      'agent-engineer',
      'ai-engineer',
      'ai-researcher',
      'backend-engineer',
      'business-analyst',
      'devops-engineer',
      'frontend-engineer',
      'growth-manager',
      'ux-designer',
    ]);
    for (const position of organization.positions) {
      const holder = graph.resolveByPosition(position.id);
      if (VACANT.has(position.id)) {
        expect(holder, `${position.id} 是公开空缺`).toBeNull();
        continue;
      }
      expect(holder, `岗位 ${position.id} 应当有人在岗`).not.toBeNull();
    }
  });

  it('三名新员工落在各自部门，并挂到已接好的汇报线上', () => {
    const byId = new Map(
      graph.organization.positions.map((position) => [position.id, position]),
    );
    expect(byId.get('product-manager')).toMatchObject({
      title: 'Product Manager',
      departmentId: 'product',
      reportsToPositionId: 'ceo',
    });
    expect(byId.get('marketing-manager')).toMatchObject({
      title: 'Marketing Manager',
      departmentId: 'marketing',
      reportsToPositionId: 'ceo',
    });
    expect(graph.resolveByPosition('product-manager' as PositionId)?.id).toBe('pm-bona');
    expect(graph.resolveByPosition('marketing-manager' as PositionId)?.id).toBe('marketing-jack');
    expect(graph.resolveByPosition('qa' as PositionId)?.id).toBe('qa-peter');
    expect(graph.getManagerOf('pm-bona' as EmployeeId)?.id).toBe('ceo-alex');
    expect(graph.getManagerOf('marketing-jack' as EmployeeId)?.id).toBe('ceo-alex');
    expect(graph.getManagerOf('qa-peter' as EmployeeId)?.id).toBe('cto-john');
  });

  it('问 1：这是哪家公司？(snapshot.company)', () => {
    const snapshot = snapshotOf('engineer-mike');
    expect(snapshot).not.toBeNull();
    expect(snapshot?.company).toEqual({
      id: 'future-ai-lab',
      name: 'Future AI Lab',
    });
  });

  it('问 2：该员工属于哪个部门？(snapshot.department)', () => {
    const snapshot = snapshotOf('engineer-mike');
    expect(snapshot?.department).not.toBeNull();
    expect(snapshot?.department?.id).toBe('engineering');
    expect(snapshot?.department?.name).toBe('Engineering');
    expect(snapshot?.department?.parent).toBeNull();
    // 基础组织结构 CEO → 部门 → 员工：部门有负责人，员工才有汇报对象。
    expect(snapshot?.department?.headPositionId).toBe('cto');
  });

  it('问 3：该员工的岗位是什么？(snapshot.position)', () => {
    const snapshot = snapshotOf('engineer-mike');
    expect(snapshot?.position).toMatchObject({
      id: 'engineer',
      title: 'Software Engineer',
      companyId: 'future-ai-lab',
      departmentId: 'engineering',
      reportsToPositionId: 'cto',
    });
  });

  it('问 4：该员工是谁？(snapshot.employee)', () => {
    const snapshot = snapshotOf('engineer-mike');
    expect(snapshot?.employee).toMatchObject({
      id: 'engineer-mike',
      name: 'Mike',
      positionId: 'engineer',
      companyId: 'future-ai-lab',
      status: 'defined',
    });
    expect(snapshot?.employee.employeeNo).toBeUndefined();
    expect(snapshot?.employee.kind).toBe('agent');
  });

  it('问 5：谁是其直属上级？(snapshot.manager) CEO 之下是部门负责人，负责人之下是员工', () => {
    expect(snapshotOf('engineer-mike')?.manager?.id).toBe('cto-john');
    expect(snapshotOf('cto-john')?.manager?.id).toBe('ceo-alex');
    // 公司级岗位是结构树的根：没有人再向上汇报。
    expect(snapshotOf('ceo-alex')?.manager).toBeNull();
    expect(graph.getManagerOf('engineer-mike' as EmployeeId)?.id).toBe('cto-john');
  });

  it('问 6：其直接下属有哪些？(snapshot.reports) 部门负责人带本部门全员', () => {
    expect(snapshotOf('cto-john')?.reports.map((e) => e.id)).toEqual(['engineer-mike', 'qa-peter']);
    expect(snapshotOf('ceo-alex')?.reports.map((e) => e.id)).toEqual([
      'cto-john',
      'marketing-jack',
      'pm-bona',
    ]);
    expect(graph.resolveByPosition('qa' as PositionId)?.id).toBe('qa-peter');
    expect(graph.resolveByPosition('cto' as PositionId)?.id).toBe('cto-john');
  });

  it('问 7：同岗位序列的同事是谁？(snapshot.peers) 种子每岗至多一人 → 均为空', () => {
    expect(snapshotOf('engineer-mike')?.peers).toEqual([]);
    expect(snapshotOf('cto-john')?.peers).toEqual([]);
    expect(graph.getPeers('ceo-alex' as EmployeeId)).toEqual([]);
  });

  it('问 8：同部门同事是谁？(snapshot.colleagues)', () => {
    expect(snapshotOf('engineer-mike')?.colleagues.map((e) => e.id)).toEqual([
      'cto-john',
      'qa-peter',
    ]);
    expect(snapshotOf('cto-john')?.colleagues.map((e) => e.id)).toEqual([
      'engineer-mike',
      'qa-peter',
    ]);
    expect(snapshotOf('ceo-alex')?.colleagues).toEqual([]);
  });

  it('公司级岗位无部门 → departmentId 为 null（契约可空偏离）', () => {
    const ceoSnapshot = snapshotOf('ceo-alex');
    expect(ceoSnapshot?.position.departmentId).toBeNull();
    expect(ceoSnapshot?.department).toBeNull();
  });

  it('不存在的员工 → snapshot 为 null', () => {
    expect(snapshotOf('ghost')).toBeNull();
    expect(graph.getEmployee('ghost' as EmployeeId)).toBeNull();
  });
});
