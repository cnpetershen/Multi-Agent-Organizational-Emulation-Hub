import { describe, expect, it } from 'vitest';
import type { Organization } from '@maoeh/organization-model';
import { loadOrganization } from '@maoeh/organization-model';
import type {
  AgentDefinition,
  AgentDefinitionSourceReader,
  LoadAgentDefinitionsOptions,
} from '@maoeh/agent-definition';
import { loadAgentDefinitions } from '@maoeh/agent-definition';
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

function memoryAgentReader(files: Record<string, string>): AgentDefinitionSourceReader {
  return {
    async list(relativeDirectory) {
      const prefix = `${relativeDirectory}/`;
      return Object.keys(files)
        .filter((path) => path.startsWith(prefix) && path.endsWith('.yaml'))
        .sort();
    },
    async read(relativePath) {
      return files[relativePath] ?? null;
    },
  };
}

const validAliceDefinition = [
  'id: agent-alice',
  'employee: alice',
  'position: ceo',
  'identity:',
  '  name: Alice',
  '  traits:',
  '    - strategic',
  'responsibilities:',
  '  - company_strategy',
  'capabilities:',
  '  decision:',
  '    - approve_budget',
  'cognition_profile: exec-strategic',
  'memory_policy:',
  '  retain:',
  '    - strategic_decisions',
  'tool_policy:',
  '  allowed:',
  '    - meeting',
  '',
].join('\n');

function load(
  files: Record<string, string>,
  overrides: Partial<LoadAgentDefinitionsOptions> = {},
): ReturnType<typeof loadAgentDefinitions> {
  return loadAgentDefinitions({
    reader: memoryAgentReader(files),
    organization: loadTestOrganization(),
    cognitionProfileIds: ['exec-strategic'],
    ...overrides,
  });
}

async function expectFailure(
  files: Record<string, string>,
  overrides: Partial<LoadAgentDefinitionsOptions> = {},
): Promise<readonly { source: string; field: string; reason: string }[]> {
  const result = await load(files, overrides);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected failure but loader succeeded');
  return result.error.issues;
}

describe('Agent Definition：有效加载与字段映射', () => {
  it('有效定义：YAML snake_case → AgentDefinition camelCase 精确映射', async () => {
    const result = await load({ 'agent-definitions/alice.yaml': validAliceDefinition });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    const definition = result.value[0] as AgentDefinition;
    expect(definition.id).toBe('agent-alice');
    expect(definition.employeeId).toBe('alice');
    expect(definition.positionId).toBe('ceo');
    expect(definition.departmentId).toBeUndefined();
    expect(definition.identity).toEqual({ name: 'Alice', traits: ['strategic'] });
    expect(definition.responsibilities).toEqual(['company_strategy']);
    expect(definition.capabilities).toEqual({ decision: ['approve_budget'] });
    expect(definition.cognitionProfileId).toBe('exec-strategic');
    expect(definition.memoryPolicy).toEqual({ retain: ['strategic_decisions'] });
    expect(definition.toolPolicy).toEqual({ allowed: ['meeting'] });
  });

  it('department 字段 → departmentId（存在性通过校验）', async () => {
    const withDepartment = validAliceDefinition
      .replace('employee: alice', 'employee: bob')
      .replace('position: ceo', 'position: engineer\ndepartment: engineering');
    const result = await load({ 'agent-definitions/bob.yaml': withDepartment });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.departmentId).toBe('engineering');
    expect(result.value[0]?.employeeId).toBe('bob');
  });

  it('identity.description 可选：缺失时不出现在结果中', async () => {
    const result = await load({ 'agent-definitions/alice.yaml': validAliceDefinition });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const definition = result.value[0] as AgentDefinition;
    expect('description' in definition.identity).toBe(false);
  });

  it('空目录 → 成功返回空列表', async () => {
    const result = await load({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('多文件加载：按路径排序、全部成功', async () => {
    const bobDefinition = validAliceDefinition
      .replace('id: agent-alice', 'id: agent-bob')
      .replace('employee: alice', 'employee: bob')
      .replace('position: ceo', 'position: engineer')
      .replace('name: Alice', 'name: Bob')
      .replace('cognition_profile: exec-strategic', 'cognition_profile: exec-strategic\ndepartment: engineering');
    const result = await load({
      'agent-definitions/zeta.yaml': validAliceDefinition,
      'agent-definitions/alpha.yaml': bobDefinition,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((definition) => definition.id)).toEqual(['agent-bob', 'agent-alice']);
  });
});

describe('Agent Definition：schema 校验（invalid rejection）', () => {
  it('缺 id / 空 id → field id', async () => {
    const missingId = validAliceDefinition.replace('id: agent-alice\n', '');
    const issuesMissing = await expectFailure({ 'agent-definitions/a.yaml': missingId });
    expect(issuesMissing.map((issue) => issue.field)).toContain('id');
    const emptyId = validAliceDefinition.replace('id: agent-alice', 'id: ""');
    const issuesEmpty = await expectFailure({ 'agent-definitions/a.yaml': emptyId });
    expect(issuesEmpty.map((issue) => issue.field)).toContain('id');
  });

  it('缺必备结构（identity / capabilities / memory_policy / tool_policy）→ 对应 field', async () => {
    const cases: readonly (readonly [string, string])[] = [
      ['identity:\n  name: Alice\n  traits:\n    - strategic\n', 'identity'],
      ['capabilities:\n  decision:\n    - approve_budget\n', 'capabilities'],
      ['memory_policy:\n  retain:\n    - strategic_decisions\n', 'memory_policy'],
      ['tool_policy:\n  allowed:\n    - meeting\n', 'tool_policy'],
    ];
    for (const [block, field] of cases) {
      const withoutBlock = validAliceDefinition.replace(block, '');
      const issues = await expectFailure({ 'agent-definitions/a.yaml': withoutBlock });
      expect(issues.map((issue) => issue.field)).toContain(field);
    }
  });

  it('policy 格式非法：retain 空数组 / allowed 空数组 / responsibilities 空数组 / 空 trait', async () => {
    const emptyRetain = validAliceDefinition.replace('- strategic_decisions', '');
    expect(
      (await expectFailure({ 'agent-definitions/a.yaml': emptyRetain })).map((issue) => issue.field),
    ).toContain('memory_policy.retain');
    const emptyAllowed = validAliceDefinition.replace('- meeting', '');
    expect(
      (await expectFailure({ 'agent-definitions/a.yaml': emptyAllowed })).map((issue) => issue.field),
    ).toContain('tool_policy.allowed');
    const emptyResponsibilities = validAliceDefinition.replace('- company_strategy', '');
    expect(
      (await expectFailure({ 'agent-definitions/a.yaml': emptyResponsibilities })).map(
        (issue) => issue.field,
      ),
    ).toContain('responsibilities');
    const emptyTrait = validAliceDefinition.replace('- strategic', '- ""');
    expect(
      (await expectFailure({ 'agent-definitions/a.yaml': emptyTrait })).map((issue) => issue.field),
    ).toContain('identity.traits.0');
  });

  it('未知字段（strictObject）→ field definition', async () => {
    const withExtra = `${validAliceDefinition}owner: human\n`;
    const issues = await expectFailure({ 'agent-definitions/a.yaml': withExtra });
    expect(issues.map((issue) => issue.field)).toContain('definition');
  });

  it('YAML 语法错误 → field yaml（含来源路径）', async () => {
    const issues = await expectFailure({
      'agent-definitions/broken.yaml': 'id: [unclosed\nemployee: alice\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe('agent-definitions/broken.yaml');
    expect(issues[0]?.field).toBe('yaml');
  });

  it('空文件 → field content', async () => {
    const issues = await expectFailure({ 'agent-definitions/empty.yaml': '' });
    expect(issues.map((issue) => issue.field)).toContain('content');
  });

  it('内容非对象（标量）→ field definition', async () => {
    const issues = await expectFailure({ 'agent-definitions/number.yaml': '42\n' });
    expect(issues.map((issue) => issue.field)).toContain('definition');
  });
});

describe('Agent Definition：引用完整性', () => {
  it('employee 不存在 → field employee', async () => {
    const ghostEmployee = validAliceDefinition.replace('employee: alice', 'employee: ghost');
    const issues = await expectFailure({ 'agent-definitions/a.yaml': ghostEmployee });
    expect(issues.map((issue) => issue.field)).toContain('employee');
    expect(issues[0]?.reason).toContain('does not exist');
  });

  it('position 不存在 → field position', async () => {
    const ghostPosition = validAliceDefinition.replace('position: ceo', 'position: ghost');
    const issues = await expectFailure({ 'agent-definitions/a.yaml': ghostPosition });
    expect(issues.map((issue) => issue.field)).toContain('position');
  });

  it('department 不存在 → field department', async () => {
    const ghostDepartment = `${validAliceDefinition}department: ghost\n`;
    const issues = await expectFailure({ 'agent-definitions/a.yaml': ghostDepartment });
    expect(issues.map((issue) => issue.field)).toContain('department');
  });

  it('cognitionProfileId 不存在（不在提供的 profile 集合中）→ field cognition_profile', async () => {
    const ghostProfile = validAliceDefinition.replace(
      'cognition_profile: exec-strategic',
      'cognition_profile: ghost-profile',
    );
    const issues = await expectFailure({ 'agent-definitions/a.yaml': ghostProfile });
    expect(issues.map((issue) => issue.field)).toContain('cognition_profile');
    const emptyRegistry = await expectFailure({ 'agent-definitions/a.yaml': validAliceDefinition }, {
      cognitionProfileIds: [],
    });
    expect(emptyRegistry.map((issue) => issue.field)).toContain('cognition_profile');
  });
});

describe('Agent Definition：唯一性与聚合', () => {
  it('重复 definition id → 第二个文件 field id', async () => {
    const second = validAliceDefinition.replace('employee: alice', 'employee: bob');
    const issues = await expectFailure({
      'agent-definitions/a.yaml': validAliceDefinition,
      'agent-definitions/b.yaml': second.replace('position: ceo', 'position: engineer'),
    });
    const duplicateId = issues.filter(
      (issue) => issue.field === 'id' && issue.source === 'agent-definitions/b.yaml',
    );
    expect(duplicateId).toHaveLength(1);
    expect(duplicateId[0]?.reason).toContain('duplicate agent definition id');
  });

  it('同一员工两个定义 → field employee（每员工一个实例约束）', async () => {
    const issues = await expectFailure({
      'agent-definitions/a.yaml': validAliceDefinition,
      'agent-definitions/b.yaml': validAliceDefinition.replace('id: agent-alice', 'id: agent-alice-2'),
    });
    const duplicateEmployee = issues.filter((issue) => issue.field === 'employee');
    expect(duplicateEmployee).toHaveLength(1);
    expect(duplicateEmployee[0]?.source).toBe('agent-definitions/b.yaml');
  });

  it('多个文件各自报错：issues 全量聚合、来源可区分', async () => {
    const issues = await expectFailure({
      'agent-definitions/one.yaml': validAliceDefinition.replace('employee: alice', 'employee: ghost'),
      'agent-definitions/two.yaml': validAliceDefinition.replace('id: agent-alice', 'id: ""'),
    });
    const sources = issues.map((issue) => issue.source);
    expect(sources).toContain('agent-definitions/one.yaml');
    expect(sources).toContain('agent-definitions/two.yaml');
    const twoFields = issues
      .filter((issue) => issue.source === 'agent-definitions/two.yaml')
      .map((issue) => issue.field);
    expect(twoFields).toContain('id');
  });

  it('错误时不返回部分结果（fail-closed）', async () => {
    const result = await load({
      'agent-definitions/a.yaml': validAliceDefinition,
      'agent-definitions/b.yaml': validAliceDefinition.replace('employee: alice', 'employee: ghost'),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect('value' in result).toBe(false);
  });
});
