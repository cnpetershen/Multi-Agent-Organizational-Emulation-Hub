import { describe, expect, it } from 'vitest';
import type { CognitionProfile, CognitionSourceReader } from '@maoeh/agent-cognition';
import { loadCognitionProfiles } from '@maoeh/agent-cognition';

function memoryReader(files: Record<string, string>): CognitionSourceReader {
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

const validProfile = [
  'id: exec-strategic',
  'reasoning_style: strategic',
  'planning_style: long_term',
  'decision_framework: risk_adjusted',
  'reflection_policy: weekly_retrospective',
  '',
].join('\n');

function load(files: Record<string, string>): ReturnType<typeof loadCognitionProfiles> {
  return loadCognitionProfiles({ reader: memoryReader(files) });
}

async function expectFailure(
  files: Record<string, string>,
): Promise<readonly { source: string; field: string; reason: string }[]> {
  const result = await load(files);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected failure but loader succeeded');
  return result.error.issues;
}

describe('Cognition Profile：配置校验与字段映射', () => {
  it('有效 profile：YAML snake_case → CognitionProfile camelCase 精确映射', async () => {
    const result = await load({ 'cognition/exec-strategic.yaml': validProfile });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    const profile = result.value[0] as CognitionProfile;
    expect(profile).toEqual({
      id: 'exec-strategic',
      reasoningStyle: 'strategic',
      planningStyle: 'long_term',
      decisionFramework: 'risk_adjusted',
      reflectionPolicy: 'weekly_retrospective',
    });
  });

  it('多 profile：按路径排序、全部成功', async () => {
    const second = validProfile
      .replace('exec-strategic', 'tech-task')
      .replace('strategic', 'technical')
      .replace('long_term', 'task_oriented');
    const result = await load({
      'cognition/zeta.yaml': validProfile,
      'cognition/alpha.yaml': second,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((profile) => profile.id)).toEqual(['tech-task', 'exec-strategic']);
  });

  it('空目录 → 成功返回空列表', async () => {
    const result = await load({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('缺字段 → 对应 field（4 个必备字段逐一校验）', async () => {
    const fields: readonly (readonly [string, string])[] = [
      ['id: exec-strategic\n', 'id'],
      ['reasoning_style: strategic\n', 'reasoning_style'],
      ['planning_style: long_term\n', 'planning_style'],
      ['decision_framework: risk_adjusted\n', 'decision_framework'],
      ['reflection_policy: weekly_retrospective\n', 'reflection_policy'],
    ];
    for (const [line, field] of fields) {
      const withoutLine = validProfile.replace(line, '');
      const issues = await expectFailure({ 'cognition/a.yaml': withoutLine });
      expect(issues.map((issue) => issue.field)).toContain(field);
    }
  });

  it('空字符串字段 → 对应 field', async () => {
    const emptyStyle = validProfile.replace('reasoning_style: strategic', 'reasoning_style: ""');
    const issues = await expectFailure({ 'cognition/a.yaml': emptyStyle });
    expect(issues.map((issue) => issue.field)).toContain('reasoning_style');
  });

  it('未知字段（strictObject）→ field profile', async () => {
    const withExtra = `${validProfile}model_temperature: 0.7\n`;
    const issues = await expectFailure({ 'cognition/a.yaml': withExtra });
    expect(issues.map((issue) => issue.field)).toContain('profile');
  });

  it('YAML 语法错误 → field yaml（含来源路径）', async () => {
    const issues = await expectFailure({
      'cognition/broken.yaml': 'id: [unclosed\nreasoning_style: strategic\n',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.source).toBe('cognition/broken.yaml');
    expect(issues[0]?.field).toBe('yaml');
  });

  it('空文件 → field content', async () => {
    const issues = await expectFailure({ 'cognition/empty.yaml': '' });
    expect(issues.map((issue) => issue.field)).toContain('content');
  });

  it('内容非对象（标量）→ field profile', async () => {
    const issues = await expectFailure({ 'cognition/number.yaml': '42\n' });
    expect(issues.map((issue) => issue.field)).toContain('profile');
  });

  it('重复 id → 第二个文件 field id', async () => {
    const issues = await expectFailure({
      'cognition/a.yaml': validProfile,
      'cognition/b.yaml': validProfile,
    });
    const duplicates = issues.filter(
      (issue) => issue.field === 'id' && issue.source === 'cognition/b.yaml',
    );
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.reason).toContain('duplicate cognition profile id');
  });
});
