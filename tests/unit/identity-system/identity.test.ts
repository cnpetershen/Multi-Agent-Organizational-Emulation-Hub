import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CompanyId, CorrelationId, EmployeeId, PositionId } from '@maoeh/shared-types';
import type { Organization } from '@maoeh/organization-model';
import { loadOrganization } from '@maoeh/organization-model';
import { createIdentity, IdentityError } from '@maoeh/identity-system';
import {
  createMemoryOrganizationReader,
  createNodeFsOrganizationReader,
} from '../../helpers/organization-readers';

const seedRoot = fileURLToPath(
  new URL('../../../agents/future-ai-lab/', import.meta.url),
);

function load(files: Record<string, string>): Organization {
  const result = loadOrganization(createMemoryOrganizationReader(files));
  if (!result.ok) {
    throw new Error(
      result.error.issues
        .map((issue) => `${issue.source}: ${issue.reason}`)
        .join('\n'),
    );
  }
  return result.value;
}

function loadSeed(): Organization {
  const result = loadOrganization(createNodeFsOrganizationReader(seedRoot));
  if (!result.ok) throw new Error('seed organization failed to load');
  return result.value;
}

const eid = (value: string): EmployeeId => value as EmployeeId;
const corr = (value: string): CorrelationId => value as CorrelationId;

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('Identity（种子组织）', () => {
  const identity = createIdentity(loadSeed());

  it('createIdentity 注册全部员工，resolve 按 id 解析', () => {
    const mike = identity.resolve(eid('engineer-mike'));
    expect(mike).toEqual({
      employeeId: 'engineer-mike',
      employeeNo: null,
      name: 'Mike',
      kind: 'agent',
      status: 'defined',
      positionId: 'engineer',
      departmentId: 'engineering',
    });
    expect(identity.resolve(eid('ceo-alex')).departmentId).toBeNull();
  });

  it('actorContext：CEO 公司级岗位 → departmentId null，并持有终裁所需的决策域等级', () => {
    const context = identity.actorContext(eid('ceo-alex'), corr('corr-1'));
    expect(context.employeeId).toBe('ceo-alex');
    expect(context.positionId).toBe('ceo');
    expect(context.departmentId).toBeNull();
    expect(context.correlationId).toBe('corr-1');
    expect(context.onBehalfOf).toBeUndefined();
    // 战略/预算/人事所在域是 L5；跨域（含部门审批门）是 L4，见 03-data-model §3.4.2。
    expect(context.authorityByDomain).toEqual({
      engineering: 4,
      product: 4,
      ops: 4,
      marketing: 4,
      finance: 5,
      org: 5,
    });
  });

  it('actorContext：工程师只在 engineering 域持有 L1，其余域仍然 fail-closed L0', () => {
    const context = identity.actorContext(eid('engineer-mike'), corr('corr-2'));
    expect(context.departmentId).toBe('engineering');
    expect(context.authorityByDomain).toEqual({
      engineering: 1,
      product: 0,
      ops: 0,
      marketing: 0,
      finance: 0,
      org: 0,
    });
  });

  it('resolve 未知员工 → IdentityError(unknown_employee)', () => {
    const error = caught(() => identity.resolve(eid('ghost')));
    expect(error).toBeInstanceOf(IdentityError);
    expect((error as IdentityError).code).toBe('unknown_employee');
    expect((error as IdentityError).subject).toBe('ghost');
  });

  it('重复 register → IdentityError(duplicate_employee)', () => {
    const seed = loadSeed();
    const fresh = createIdentity(seed);
    const error = caught(() => fresh.register(seed.employees[0]));
    expect(error).toBeInstanceOf(IdentityError);
    expect((error as IdentityError).code).toBe('duplicate_employee');
  });
});

describe('Identity（合成组织：employee_no 映射与决策域权限）', () => {
  const files: Record<string, string> = {
    'company.yaml': 'id: acme\nname: Acme Corp\n',
    'departments/engineering.yaml': 'id: engineering\nname: Engineering\n',
    'positions/cto.yaml':
      'id: cto\ntitle: CTO\ndepartment: engineering\n' +
      'decision_domains:\n  engineering: L3\n  finance: L0\n',
    'positions/lead.yaml':
      'id: lead\ntitle: Lead\ndepartment: engineering\nauthority_level: 3\n',
    'employees/alice.yaml':
      'id: alice\nname: Alice\nposition: cto\nemployee_no: FAL-002\nkind: agent\n',
    'employees/bob.yaml': 'id: bob\nname: Bob\nposition: lead\nkind: human\n',
  };

  const identity = createIdentity(load(files));

  it('resolveByEmployeeNo：工号 ↔ id 双向解析', () => {
    expect(identity.resolveByEmployeeNo('FAL-002').employeeId).toBe('alice');
    expect(identity.resolve(eid('alice')).employeeNo).toBe('FAL-002');
    const error = caught(() => identity.resolveByEmployeeNo('FAL-999'));
    expect(error).toBeInstanceOf(IdentityError);
    expect((error as IdentityError).code).toBe('unknown_employee_no');
  });

  it('岗位 decision_domains → authorityByDomain（未声明域 L0）', () => {
    const context = identity.actorContext(eid('alice'), corr('corr-3'));
    expect(context.authorityByDomain).toEqual({
      engineering: 3,
      product: 0,
      ops: 0,
      marketing: 0,
      finance: 0,
      org: 0,
    });
  });

  it('仅声明 authority_level 而无 decision_domains → 仍全域 L0（fail-closed）', () => {
    const context = identity.actorContext(eid('bob'), corr('corr-4'));
    expect(context.authorityByDomain).toEqual({
      engineering: 0,
      product: 0,
      ops: 0,
      marketing: 0,
      finance: 0,
      org: 0,
    });
  });

  it('kind 保留在身份切片中', () => {
    expect(identity.resolve(eid('alice')).kind).toBe('agent');
    expect(identity.resolve(eid('bob')).kind).toBe('human');
  });

  it('员工占据不存在岗位（手工构造）→ 构造期即抛 unknown_position', () => {
    const broken: Organization = {
      company: { id: 'acme' as CompanyId, name: 'Acme' },
      departments: [],
      positions: [
        {
          id: 'ceo' as PositionId,
          companyId: 'acme' as CompanyId,
          departmentId: null,
          reportsToPositionId: null,
          title: 'CEO',
        },
      ],
      employees: [
        {
          id: 'zed' as EmployeeId,
          companyId: 'acme' as CompanyId,
          positionId: 'ghost' as PositionId,
          name: 'Zed',
          status: 'defined',
        },
      ],
    };
    const error = caught(() => createIdentity(broken));
    expect(error).toBeInstanceOf(IdentityError);
    expect((error as IdentityError).code).toBe('unknown_position');
    expect((error as IdentityError).subject).toBe('ghost');
  });

  it('两个员工共用同一工号 → 构造期即抛 duplicate_employee', () => {
    const duplicateNo: Organization = {
      company: { id: 'acme' as CompanyId, name: 'Acme' },
      departments: [],
      positions: [
        {
          id: 'ceo' as PositionId,
          companyId: 'acme' as CompanyId,
          departmentId: null,
          reportsToPositionId: null,
          title: 'CEO',
        },
      ],
      employees: [
        {
          id: 'a' as EmployeeId,
          companyId: 'acme' as CompanyId,
          positionId: 'ceo' as PositionId,
          employeeNo: 'FAL-001',
          name: 'A',
          status: 'defined',
        },
        {
          id: 'b' as EmployeeId,
          companyId: 'acme' as CompanyId,
          positionId: 'ceo' as PositionId,
          employeeNo: 'FAL-001',
          name: 'B',
          status: 'defined',
        },
      ],
    };
    const error = caught(() => createIdentity(duplicateNo));
    expect(error).toBeInstanceOf(IdentityError);
    expect((error as IdentityError).code).toBe('duplicate_employee');
    expect((error as IdentityError).subject).toBe('FAL-001');
  });
});
