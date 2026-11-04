import { describe, expect, it } from 'vitest';
import type { OrgLoadIssue } from '@maoeh/organization-model';
import { loadOrganization } from '@maoeh/organization-model';
import { createMemoryOrganizationReader } from '../../helpers/organization-readers';

const companyFile = 'id: acme\nname: Acme Corp\n';

function loadIssues(files: Record<string, string>): readonly OrgLoadIssue[] {
  const result = loadOrganization(createMemoryOrganizationReader(files));
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected load failure');
  return result.error.issues;
}

function loadOk(files: Record<string, string>) {
  const result = loadOrganization(createMemoryOrganizationReader(files));
  if (!result.ok) {
    throw new Error(
      result.error.issues
        .map((issue) => `${issue.source} ${issue.field ?? ''}: ${issue.reason}`)
        .join('\n'),
    );
  }
  return result.value;
}

const minimalOrg: Record<string, string> = {
  'company.yaml': companyFile,
  'positions/ceo.yaml': 'id: ceo\ntitle: Chief Executive Officer\n',
  'employees/alex.yaml': 'id: alex\nname: Alex\nposition: ceo\n',
};

describe('loader 拒绝无效组织定义（定位到文件/实体/字段）', () => {
  it('未知字段 → 拒绝并定位', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'employees/alex.yaml': 'id: alex\nname: Alex\nposition: ceo\ndepartment: engineering\n',
    });
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue?.source).toBe('employees/alex.yaml');
    expect(issue?.entityType).toBe('employee');
    expect(issue?.entityId).toBe('alex');
    expect(issue?.field).toBe('department');
    expect(issue?.reason).toMatch(/nrecognized/);
  });

  it('缺失必填字段（position）→ 拒绝并定位', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'employees/alex.yaml': 'id: alex\nname: Alex\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('position');
    expect(issues[0]?.entityId).toBe('alex');
  });

  it('员工引用不存在的岗位 → 拒绝', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'employees/alex.yaml': 'id: alex\nname: Alex\nposition: ghost\n',
    });
    expect(issues).toEqual([
      {
        source: 'employees/alex.yaml',
        entityType: 'employee',
        entityId: 'alex',
        field: 'position',
        reason: 'unknown position "ghost"',
      },
    ]);
  });

  it('岗位引用不存在的部门 → 拒绝', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'positions/ceo.yaml': 'id: ceo\ntitle: CEO\ndepartment: ghost\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.entityType).toBe('position');
    expect(issues[0]?.field).toBe('department');
    expect(issues[0]?.reason).toBe('unknown department "ghost"');
  });

  it('重复实体 id → 拒绝并指向后出现的文件', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'employees/bob.yaml': 'id: alex\nname: Bob\nposition: ceo\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe('employees/bob.yaml');
    expect(issues[0]?.entityId).toBe('alex');
    expect(issues[0]?.reason).toContain('duplicate employee id "alex"');
    expect(issues[0]?.reason).toContain('employees/alex.yaml');
  });

  it('岗位自汇报 → 拒绝', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'positions/ceo.yaml': 'id: ceo\ntitle: CEO\nreports_to: ceo\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('reports_to');
    expect(issues[0]?.reason).toBe('a position cannot report to itself');
  });

  it('岗位引用不存在的汇报对象 → 拒绝', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'positions/ceo.yaml': 'id: ceo\ntitle: CEO\nreports_to: ghost\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('reports_to');
    expect(issues[0]?.reason).toBe('unknown position "ghost"');
  });

  it('汇报线成环 → 拒绝', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'positions/ceo.yaml': 'id: ceo\ntitle: CEO\nreports_to: cto\n',
      'positions/cto.yaml': 'id: cto\ntitle: CTO\nreports_to: ceo\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.entityType).toBe('position');
    expect(issues[0]?.entityId).toBe('ceo');
    expect(issues[0]?.field).toBe('reports_to');
    expect(issues[0]?.reason).toBe('reporting cycle: ceo -> cto -> ceo');
    expect(issues[0]?.source).toBe('positions/ceo.yaml');
  });

  it('部门父级成环 → 拒绝', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'departments/a.yaml': 'id: a\nname: A\nparent: b\n',
      'departments/b.yaml': 'id: b\nname: B\nparent: a\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.entityType).toBe('department');
    expect(issues[0]?.field).toBe('parent');
    expect(issues[0]?.reason).toBe('department parent cycle: a -> b -> a');
  });

  it('部门引用不存在的父级 → 拒绝', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'departments/a.yaml': 'id: a\nname: A\nparent: ghost\n',
    });
    expect(issues[0]?.field).toBe('parent');
    expect(issues[0]?.reason).toBe('unknown department "ghost"');
  });

  it('两个员工占据同一岗位 → 拒绝（一岗至多一人）', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'employees/bob.yaml': 'id: bob\nname: Bob\nposition: ceo\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe('employees/bob.yaml');
    expect(issues[0]?.entityId).toBe('bob');
    expect(issues[0]?.reason).toBe(
      'position "ceo" is already held by employee "alex"',
    );
  });

  it('缺失 company.yaml → 拒绝', () => {
    const issues = loadIssues({
      'positions/ceo.yaml': 'id: ceo\ntitle: CEO\n',
      'employees/alex.yaml': 'id: alex\nname: Alex\nposition: ceo\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      source: 'company.yaml',
      entityType: 'company',
      reason: 'file not found',
    });
  });

  it('YAML 语法错误 → 拒绝并带行列号', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'company.yaml': 'id: [unterminated\nname: Acme\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe('company.yaml');
    expect(issues[0]?.entityType).toBe('company');
    expect(typeof issues[0]?.line).toBe('number');
    expect(typeof issues[0]?.column).toBe('number');
  });

  it('非法枚举值（status）→ 拒绝并定位', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'employees/alex.yaml': 'id: alex\nname: Alex\nposition: ceo\nstatus: flying\n',
    });
    expect(issues[0]?.field).toBe('status');
  });

  it('authority_level 超出 0..5 → 拒绝', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'positions/ceo.yaml': 'id: ceo\ntitle: CEO\nauthority_level: 9\n',
    });
    expect(issues[0]?.field).toBe('authority_level');
  });

  it('decision_domains 出现未知决策域 → 拒绝', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'positions/ceo.yaml':
        'id: ceo\ntitle: CEO\ndecision_domains:\n  engineeringg: 3\n',
    });
    expect(issues[0]?.field).toBe('engineeringg');
  });

  it('多个文件的问题一次性全部收集', () => {
    const issues = loadIssues({
      ...minimalOrg,
      'employees/alex.yaml': 'id: alex\nname: Alex\nposition: ghost\n',
      'employees/bob.yaml': 'id: bob\nname: Bob\nposition: ceo2\n',
    });
    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.entityId)).toEqual(['alex', 'bob']);
  });
});

describe('loader 接受有效输入并归一化', () => {
  it('L 记法与数字等级都接受，decision_domains 转为数字', () => {
    const organization = loadOk({
      ...minimalOrg,
      'positions/ceo.yaml':
        'id: ceo\ntitle: CEO\nauthority_level: L5\ndecision_domains:\n  org: L5\n  finance: 0\n',
    });
    const position = organization.positions[0];
    expect(position?.id).toBe('ceo');
    expect(position?.authorityLevel).toBe(5);
    expect(position?.decisionDomains).toEqual({ org: 5, finance: 0 });
  });

  it('员工缺省 status 归一化为 defined，company_id 由公司盖章', () => {
    const organization = loadOk(minimalOrg);
    expect(organization.employees[0]?.status).toBe('defined');
    expect(organization.employees[0]?.companyId).toBe('acme');
    expect(organization.positions[0]?.companyId).toBe('acme');
  });

  it('公司字段 mission / founded_sim_day 可选装载', () => {
    const organization = loadOk({
      ...minimalOrg,
      'company.yaml':
        'id: acme\nname: Acme Corp\nmission: Build things\nfounded_sim_day: 1\n',
    });
    expect(organization.company).toEqual({
      id: 'acme',
      name: 'Acme Corp',
      mission: 'Build things',
      foundedSimDay: 1,
    });
  });
});
