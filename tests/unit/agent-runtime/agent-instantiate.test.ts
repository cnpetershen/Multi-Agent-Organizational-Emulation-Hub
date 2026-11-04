import { describe, expect, it } from 'vitest';
import type { CorrelationId, DepartmentId, EmployeeId, PositionId, SimTime } from '@maoeh/shared-types';
import type { AgentDefinition } from '@maoeh/agent-definition';
import type { Organization } from '@maoeh/organization-model';
import { loadOrganization } from '@maoeh/organization-model';
import { createIdentity } from '@maoeh/identity-system';
import { createInitialAgentState } from '@maoeh/runtime-state';
import { instantiateAgent } from '@maoeh/agent-runtime';
import { createMemoryOrganizationReader } from '../../helpers/organization-readers';

const orgFiles: Record<string, string> = {
  'company.yaml': 'id: acme\nname: Acme Corp\n',
  'departments/engineering.yaml': 'id: engineering\nname: Engineering\n',
  'positions/ceo.yaml': 'id: ceo\ntitle: Chief Executive Officer\n',
  'positions/engineer.yaml': 'id: engineer\ntitle: Software Engineer\ndepartment: engineering\n',
  'employees/alice.yaml': 'id: alice\nname: Alice\nposition: ceo\n',
  'employees/bob.yaml': 'id: bob\nname: Bob\nposition: engineer\n',
};

function loadTestOrganization(): Organization {
  const result = loadOrganization(createMemoryOrganizationReader(orgFiles));
  if (!result.ok) throw new Error('test organization failed to load');
  return result.value;
}

const organization = loadTestOrganization();
const identity = createIdentity(organization);
const contextAlice = identity.actorContext('alice' as EmployeeId, 'corr-alice' as CorrelationId);
const contextBob = identity.actorContext('bob' as EmployeeId, 'corr-bob' as CorrelationId);
const sim = (minutes: number): SimTime => minutes as SimTime;

function makeDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'agent-alice',
    employeeId: 'alice' as EmployeeId,
    positionId: 'ceo' as PositionId,
    identity: { name: 'Alice', traits: ['strategic'] },
    responsibilities: ['company_strategy'],
    capabilities: { decision: ['approve_budget'] },
    cognitionProfileId: 'exec-strategic',
    memoryPolicy: { retain: ['strategic_decisions'] },
    toolPolicy: { allowed: ['meeting'] },
    ...overrides,
  };
}

describe('Agent Runtime：instantiateAgent 成功路径', () => {
  it('实例字段绑定：id/definitionId/employeeId/createdAtSim', () => {
    const result = instantiateAgent(makeDefinition(), contextAlice, sim(7));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe('agent:agent-alice');
    expect(result.value.definitionId).toBe('agent-alice');
    expect(result.value.employeeId).toBe('alice');
    expect(result.value.createdAtSim).toBe(7);
  });

  it('初始状态等于 createInitialAgentState：presence idle / employment defined / version 0 / branch live', () => {
    const result = instantiateAgent(makeDefinition(), contextAlice, sim(0));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toEqual(createInitialAgentState('alice' as EmployeeId));
    expect(result.value.state.presence).toBe('idle');
    expect(result.value.state.employment).toBe('defined');
    expect(result.value.state.version).toBe(0);
    expect(result.value.state.branchId).toBe('live');
  });

  it('实例 id 确定性：同一定义重复实例化 → 相同 id；不同定义 → 不同 id', () => {
    const first = instantiateAgent(makeDefinition(), contextAlice, sim(0));
    const second = instantiateAgent(makeDefinition(), contextAlice, sim(99));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.id).toBe(second.value.id);
    const other = instantiateAgent(
      makeDefinition({
        id: 'agent-bob',
        employeeId: 'bob' as EmployeeId,
        positionId: 'engineer' as PositionId,
        departmentId: 'engineering' as DepartmentId,
        identity: { name: 'Bob', traits: ['careful'] },
      }),
      contextBob,
      sim(0),
    );
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(other.value.id).toBe('agent:agent-bob');
    expect(other.value.id).not.toBe(first.value.id);
  });

  it('state 为每次实例化新建的对象（非共享引用）', () => {
    const first = instantiateAgent(makeDefinition(), contextAlice, sim(0));
    const second = instantiateAgent(makeDefinition(), contextAlice, sim(0));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.state).not.toBe(second.value.state);
    expect(first.value.state).toEqual(second.value.state);
  });

  it('完整部门绑定（definition.departmentId === context.departmentId）通过', () => {
    const bobDefinition = makeDefinition({
      id: 'agent-bob',
      employeeId: 'bob' as EmployeeId,
      positionId: 'engineer' as PositionId,
      departmentId: 'engineering' as DepartmentId,
      identity: { name: 'Bob', traits: ['careful'] },
    });
    const result = instantiateAgent(bobDefinition, contextBob, sim(0));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.employeeId).toBe('bob');
    expect(result.value.state).toEqual(createInitialAgentState('bob' as EmployeeId));
  });
});

describe('Agent Runtime：identity binding 失败（Result 错误，不抛异常）', () => {
  it('employeeId 不匹配 → field employeeId', () => {
    let failed = false;
    expect(() => {
      const result = instantiateAgent(makeDefinition({ employeeId: 'bob' as EmployeeId }), contextAlice, sim(0));
      if (result.ok) return;
      failed = true;
      expect(result.error.issues.map((issue) => issue.field)).toEqual(['employeeId']);
      expect(result.error.issues[0]?.reason).toContain('definition is bound to "bob"');
    }).not.toThrow();
    expect(failed).toBe(true);
  });

  it('positionId 不匹配 → field positionId', () => {
    const result = instantiateAgent(
      makeDefinition({ positionId: 'engineer' as PositionId }),
      contextAlice,
      sim(0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.map((issue) => issue.field)).toEqual(['positionId']);
  });

  it('departmentId 不匹配：definition 有部门但 context 无部门 → field departmentId', () => {
    const result = instantiateAgent(
      makeDefinition({ departmentId: 'engineering' as DepartmentId }),
      contextAlice,
      sim(0),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.map((issue) => issue.field)).toEqual(['departmentId']);
  });

  it('departmentId 不匹配：definition 无部门但 context 有部门 → field departmentId', () => {
    const bobNoDepartment = makeDefinition({
      id: 'agent-bob',
      employeeId: 'bob' as EmployeeId,
      positionId: 'engineer' as PositionId,
      identity: { name: 'Bob', traits: ['careful'] },
    });
    const result = instantiateAgent(bobNoDepartment, contextBob, sim(0));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.map((issue) => issue.field)).toEqual(['departmentId']);
  });

  it('多重不匹配：三类 binding 错误同时聚合', () => {
    const brokenDefinition = makeDefinition({
      employeeId: 'bob' as EmployeeId,
      positionId: 'engineer' as PositionId,
      departmentId: 'engineering' as DepartmentId,
    });
    const result = instantiateAgent(brokenDefinition, contextAlice, sim(0));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.issues.map((issue) => issue.field).sort()).toEqual([
      'departmentId',
      'employeeId',
      'positionId',
    ]);
  });
});
