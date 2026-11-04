import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition, WorkflowIssue } from '@maoeh/workflow-engine';
import { loadWorkflowDefinitions, parseWorkflowDefinition } from '@maoeh/workflow-engine';
import { resolveCapabilityAssignments } from '@maoeh/organization-model';
import {
  createMemoryWorkflowReader,
  createNodeFsWorkflowReader,
} from '../helpers/workflow-readers';
import { loadSeedOrganization } from '../helpers/workflow-fixtures';

function parse(
  source: string,
  sourceName = 'test-workflow.yaml',
): { readonly definition?: WorkflowDefinition; readonly issues: readonly WorkflowIssue[] } {
  const result = parseWorkflowDefinition(source, sourceName);
  if (result.ok) return { definition: result.value, issues: [] };
  return { issues: result.error.issues };
}

function issueFields(issues: readonly WorkflowIssue[]): readonly string[] {
  return issues.map((issue) => issue.field);
}

function issueReasons(issues: readonly WorkflowIssue[]): readonly string[] {
  return issues.map((issue) => issue.reason);
}

const MINIMAL = `workflow_id: wf-min
version: 1
name: Minimal Workflow
entry_stage: only
terminal_stages: [only]
stages:
  - stage_id: only
    name: Only
    steps:
      - step_id: only-task
        name: Do the thing
        kind: task
        assignment:
          kind: position
          position_id: ceo
        verification:
          kind: deterministic
          required_output_keys: [answer]
    transitions:
      - transition_id: only-task__done
        from_step_id: only-task
        when:
          kind: task_status
          status: completed
        to:
          kind: complete
`;

describe('M0.8 定义加载与校验（workflow-definition）', () => {
  it('加载全部 4 个种子工作流且全部通过校验', () => {
    const result = loadWorkflowDefinitions(createNodeFsWorkflowReader(), '');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((definition) => definition.workflowId)).toEqual([
      'decision-making',
      'hiring',
      'product-analysis',
      'product-development',
    ]);
  });

  it('product-analysis：入口/终点/审批门/确定性校验键与种子一致', () => {
    const result = loadWorkflowDefinitions(createNodeFsWorkflowReader(), '');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pa = result.value.find((definition) => definition.workflowId === 'product-analysis');
    expect(pa).toBeDefined();
    if (pa === undefined) return;
    expect(pa.entryStageId).toBe('intake');
    expect(pa.terminalStageIds).toEqual(['delivery']);
    expect(pa.cyclePolicy).toBe('forbid');

    const gate = pa.stages
      .flatMap((stage) => stage.steps)
      .find((step) => step.stepId === 'design-gate');
    expect(gate).toBeDefined();
    expect(gate?.kind).toBe('approval');
    expect(gate?.requiredRoles).toEqual(['ceo']);
    expect(gate?.approvalPolicy).toBe('single');
    expect(gate?.requiredCount).toBe(1);

    const brief = pa.stages.flatMap((stage) => stage.steps).find((step) => step.stepId === 'intake-brief');
    expect(brief?.verification?.requiredOutputKeys).toEqual(['problem', 'success_criteria']);
    expect(brief?.maxAttempts).toBe(2);
  });

  it('模板的任务步声明能力而不是座席，只有审批门写角色', () => {
    // 模板一旦把任务步钉在 `position_id` 上，就绕过了「能力 → 岗位」这条唯一路由契约：
    // product-analysis 的入口/交付步曾被固定交给 CEO，hiring 的写需求/发 offer 两步也是，
    // 于是每个实例都由 CEO 执行。审批是治理动作，仍由 required_roles 表达。
    const result = loadWorkflowDefinitions(createNodeFsWorkflowReader(), '');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(4);
    const taskSteps = result.value
      .flatMap((definition) => definition.stages.flatMap((stage) => stage.steps))
      .filter((step) => step.kind === 'task');
    expect(taskSteps.length).toBeGreaterThan(0);
    for (const step of taskSteps) {
      expect(step.assignment?.kind, step.stepId).toBe('capability');
    }
    const gate = result.value
      .flatMap((definition) => definition.stages.flatMap((stage) => stage.steps))
      .find((step) => step.stepId === 'design-gate');
    expect(gate?.requiredRoles).toEqual(['ceo']);
  });

  it('模板声明的每个能力，在种子组织里都有席位承接', () => {
    // 能力 → 岗位的解析发生在运行时（进入任务步的 preflight）：模板若写了没有席位声明的
    // 能力，模板要到启动那一刻才失败。这条在定义层先钉死——模板必须随时开得起来。
    const result = loadWorkflowDefinitions(createNodeFsWorkflowReader(), '');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const organization = loadSeedOrganization();
    const taskSteps = result.value
      .flatMap((definition) => definition.stages.flatMap((stage) => stage.steps))
      .filter((step) => step.kind === 'task');
    expect(taskSteps.length).toBeGreaterThan(0);
    for (const step of taskSteps) {
      const assignment = step.assignment;
      expect(assignment?.kind, step.stepId).toBe('capability');
      if (assignment?.kind !== 'capability') continue;
      const resolved = resolveCapabilityAssignments(organization, [assignment.capability]);
      expect(
        resolved.map((entry) => entry.positionId),
        `${step.stepId} → ${assignment.capability}`,
      ).not.toHaveLength(0);
    }
  });

  it('最小合法 YAML 解析成功并应用默认值', () => {
    const { definition, issues } = parse(MINIMAL);
    expect(issueReasons(issues)).toEqual([]);
    expect(definition).toBeDefined();
    expect(definition?.cyclePolicy).toBe('forbid');
    const step = definition?.stages[0]?.steps[0];
    expect(step?.maxAttempts).toBe(1);
    expect(step?.requiredCount).toBe(1);
    expect(step?.assignment).toEqual({ kind: 'position', positionId: 'ceo' });
  });

  it('内存 reader 与文件系统 reader 行为一致', () => {
    const result = loadWorkflowDefinitions(
      createMemoryWorkflowReader({ 'custom/workflow.yaml': MINIMAL }),
      '',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]?.workflowId).toBe('wf-min');
  });

  it('YAML 语法错误 → 报 yaml parse error', () => {
    const { definition, issues } = parse('workflow_id: [unclosed');
    expect(definition).toBeUndefined();
    expect(issues[0]?.reason).toContain('yaml parse error');
  });

  it('未知 entry_stage → entryStageId 问题', () => {
    const { issues } = parse(MINIMAL.replace('entry_stage: only', 'entry_stage: ghost'));
    expect(issueFields(issues)).toContain('entryStageId');
    expect(issueReasons(issues)).toContain('unknown stage ghost');
  });

  it('task 步缺少 assignment → 校验失败', () => {
    const broken = MINIMAL.replace(
      `        assignment:
          kind: position
          position_id: ceo
`,
      '',
    );
    const { definition, issues } = parse(broken);
    expect(definition).toBeUndefined();
    expect(issueFields(issues)).toContain('stages.only.steps.only-task.assignment');
  });

  it('verification.requiredOutputKeys 为空 → 校验失败', () => {
    const broken = MINIMAL.replace('[answer]', '[]');
    const { issues } = parse(broken);
    expect(issueFields(issues)).toContain(
      'stages.only.steps.only-task.verification.requiredOutputKeys',
    );
  });

  it('步没有出边 → every step needs an outgoing transition', () => {
    const broken = `workflow_id: wf-noedge
version: 1
name: No Edge
entry_stage: only
terminal_stages: [only]
stages:
  - stage_id: only
    name: Only
    steps:
      - step_id: s1
        name: S1
        kind: task
        assignment:
          kind: position
          position_id: ceo
      - step_id: s2
        name: S2
        kind: task
        assignment:
          kind: position
          position_id: ceo
    transitions:
      - transition_id: s1__next
        from_step_id: s1
        when:
          kind: task_status
          status: completed
        to:
          kind: step
          step_id: s2
`;
    const { issues } = parse(broken);
    expect(issueReasons(issues)).toContain('every step needs an outgoing transition');
  });

  it('出边条件重叠（completed 与 always）→ ambiguous overlap', () => {
    const broken = MINIMAL.replace(
      `        to:
          kind: complete
`,
      `        to:
          kind: complete
      - transition_id: only-task__always
        from_step_id: only-task
        when:
          kind: always
        to:
          kind: fail
          reason: nope
`,
    );
    const { issues } = parse(broken);
    expect(issueReasons(issues).some((reason) => reason.includes('overlap'))).toBe(true);
  });

  it('审批步必须有 approval_decision 出边', () => {
    const source = `workflow_id: wf-gate
version: 1
name: Gate
entry_stage: review
terminal_stages: [review]
stages:
  - stage_id: review
    name: Review
    steps:
      - step_id: gate
        name: Gate
        kind: approval
        required_roles: [ceo]
    transitions:
      - transition_id: gate__always
        from_step_id: gate
        when:
          kind: always
        to:
          kind: complete
`;
    const { issues } = parse(source);
    expect(issueReasons(issues)).toContain(
      'approval steps require at least one approval_decision transition',
    );
  });

  it('single 策略要求 requiredCount=1；quorum 不得超过角色数', () => {
    const gateSource = (policy: string, count: number, roles: string): string => `workflow_id: wf-p
version: 1
name: P
entry_stage: s
terminal_stages: [s]
stages:
  - stage_id: s
    name: S
    steps:
      - step_id: g
        name: G
        kind: approval
        required_roles: [${roles}]
        approval_policy: ${policy}
        required_count: ${count}
    transitions:
      - transition_id: g__granted
        from_step_id: g
        when:
          kind: approval_decision
          decision: granted
        to:
          kind: complete
      - transition_id: g__denied
        from_step_id: g
        when:
          kind: approval_decision
          decision: denied
        to:
          kind: fail
          reason: denied
`;
    expect(issueReasons(parse(gateSource('single', 2, 'ceo')).issues)).toContain(
      'single policy requires requiredCount=1',
    );
    expect(issueReasons(parse(gateSource('quorum', 3, 'ceo, cto')).issues)).toContain(
      'quorum cannot exceed the number of roles',
    );
    expect(parse(gateSource('quorum', 2, 'ceo, cto')).issues).toEqual([]);
  });

  it('automated 步只能走 always 出边', () => {
    const source = `workflow_id: wf-auto
version: 1
name: Auto
entry_stage: s
terminal_stages: [s]
stages:
  - stage_id: s
    name: S
    steps:
      - step_id: a
        name: A
        kind: automated
      - step_id: b
        name: B
        kind: task
        assignment:
          kind: position
          position_id: ceo
    transitions:
      - transition_id: a__done
        from_step_id: a
        when:
          kind: task_status
          status: completed
        to:
          kind: complete
      - transition_id: b__done
        from_step_id: b
        when:
          kind: task_status
          status: completed
        to:
          kind: step
          step_id: a
`;
    const { issues } = parse(source);
    expect(issueReasons(issues)).toContain(
      'automated steps may only branch on always conditions',
    );
  });

  it('不可达步与重复步 id 均被报告', () => {
    const source = `workflow_id: wf-dup
version: 1
name: Dup
entry_stage: a
terminal_stages: [a]
stages:
  - stage_id: a
    name: A
    steps:
      - step_id: s1
        name: S1
        kind: task
        assignment:
          kind: position
          position_id: ceo
      - step_id: s2
        name: S2
        kind: task
        assignment:
          kind: position
          position_id: ceo
    transitions:
      - transition_id: s1__done
        from_step_id: s1
        when:
          kind: task_status
          status: completed
        to:
          kind: complete
      - transition_id: s2__done
        from_step_id: s2
        when:
          kind: task_status
          status: completed
        to:
          kind: complete
  - stage_id: b
    name: B
    steps:
      - step_id: s2
        name: S2 again
        kind: task
        assignment:
          kind: position
          position_id: ceo
    transitions:
      - transition_id: s2__b
        from_step_id: s2
        when:
          kind: task_status
          status: completed
        to:
          kind: complete
`;
    const { issues } = parse(source);
    expect(issueReasons(issues)).toContain('step ids must be globally unique');
    expect(issueReasons(issues)).toContain('step is unreachable from the entry stage');
  });

  it('cyclePolicy=forbid 检出环；allow 放行', () => {
    const source = (cyclePolicy: string): string => `workflow_id: wf-cycle
version: 1
name: Cycle
cycle_policy: ${cyclePolicy}
entry_stage: a
terminal_stages: [b]
stages:
  - stage_id: a
    name: A
    steps:
      - step_id: s1
        name: S1
        kind: task
        assignment:
          kind: position
          position_id: ceo
    transitions:
      - transition_id: s1__next
        from_step_id: s1
        when:
          kind: task_status
          status: completed
        to:
          kind: stage
          stage_id: b
  - stage_id: b
    name: B
    steps:
      - step_id: s2
        name: S2
        kind: task
        assignment:
          kind: position
          position_id: ceo
    transitions:
      - transition_id: s2__back
        from_step_id: s2
        when:
          kind: task_status
          status: completed
        to:
          kind: step
          step_id: s1
      - transition_id: s2__fail
        from_step_id: s2
        when:
          kind: task_status
          status: rejected
        to:
          kind: complete
`;
    expect(issueReasons(parse(source('forbid')).issues)).toContain(
      'workflow graph contains a cycle but cyclePolicy is forbid',
    );
    expect(parse(source('allow')).issues).toEqual([]);
  });
});
