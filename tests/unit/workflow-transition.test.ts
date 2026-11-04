import { describe, expect, it } from 'vitest';
import type { PositionId } from '@maoeh/shared-types';
import type { WorkflowDefinition } from '@maoeh/workflow-engine';
import {
  conditionsOverlap,
  loadWorkflowDefinitions,
  parseWorkflowDefinition,
  selectTransitions,
} from '@maoeh/workflow-engine';
import { createNodeFsWorkflowReader } from '../helpers/workflow-readers';

function loadProductAnalysis(): WorkflowDefinition {
  const result = loadWorkflowDefinitions(createNodeFsWorkflowReader(), '');
  if (!result.ok) throw new Error('seed workflows failed to load');
  const definition = result.value.find((entry) => entry.workflowId === 'product-analysis');
  if (definition === undefined) throw new Error('product-analysis missing');
  return definition;
}

describe('M0.8 转移选择（workflow-transition）', () => {
  const definition = loadProductAnalysis();

  it('task completed 输入命中 completed 分支', () => {
    const selected = selectTransitions(definition, 'intake-brief', {
      kind: 'task',
      status: 'completed',
    });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.value).toHaveLength(1);
    expect(selected.value[0]?.to.kind).toBe('stage');
  });

  it('task rejected 与 failed 输入都命中 rejected 分支', () => {
    const rejected = selectTransitions(definition, 'intake-brief', {
      kind: 'task',
      status: 'rejected',
    });
    const failed = selectTransitions(definition, 'intake-brief', {
      kind: 'task',
      status: 'failed',
    });
    expect(rejected.ok && failed.ok).toBe(true);
    if (!rejected.ok || !failed.ok) return;
    expect(rejected.value[0]?.transitionId).toBe('intake-brief__rejected');
    expect(failed.value[0]?.transitionId).toBe('intake-brief__rejected');
  });

  it('审批步不接受 task 输入 → no_matching_transition', () => {
    const selected = selectTransitions(definition, 'design-gate', {
      kind: 'task',
      status: 'completed',
    });
    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.error.code).toBe('no_matching_transition');
  });

  it('审批步按 granted/denied 决策选择分支', () => {
    const granted = selectTransitions(definition, 'design-gate', {
      kind: 'approval',
      decision: 'granted',
    });
    const denied = selectTransitions(definition, 'design-gate', {
      kind: 'approval',
      decision: 'denied',
    });
    expect(granted.ok && denied.ok).toBe(true);
    if (!granted.ok || !denied.ok) return;
    expect(granted.value[0]?.to.kind).toBe('stage');
    expect(denied.value[0]?.to.kind).toBe('fail');
  });

  it('未知 step → invalid_definition；always 不匹配 none 以外的任务输入', () => {
    const unknown = selectTransitions(definition, 'ghost-step', { kind: 'none' });
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe('invalid_definition');

    const alwaysDef = parseWorkflowDefinition(
      `workflow_id: wf-always
version: 1
name: Always
entry_stage: s
terminal_stages: [s]
stages:
  - stage_id: s
    name: S
    steps:
      - step_id: a
        name: A
        kind: automated
    transitions:
      - transition_id: a__next
        from_step_id: a
        when:
          kind: always
        to:
          kind: complete
`,
      'always',
    );
    if (!alwaysDef.ok) throw new Error('always definition failed to parse');
    const matched = selectTransitions(alwaysDef.value, 'a', { kind: 'none' });
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;
    expect(matched.value[0]?.transitionId).toBe('a__next');
  });

  it('运行时歧义（两个重叠分支同时可命中）→ ambiguous_transition', () => {
    const duplicated = {
      transitionId: 'a__two',
      fromStepId: 'a',
      when: { kind: 'task_status', status: 'completed' },
      to: { kind: 'fail', reason: 'dup' },
    } as const;
    const definition: WorkflowDefinition = {
      workflowId: 'wf-amb',
      version: 1,
      name: 'Ambiguous',
      description: null,
      cyclePolicy: 'forbid',
      entryStageId: 's',
      terminalStageIds: ['s'],
      stages: [
        {
          stageId: 's',
          name: 'S',
          steps: [
            {
              stepId: 'a',
              name: 'A',
              kind: 'task',
              description: null,
              assignment: { kind: 'position', positionId: 'ceo' as PositionId },
              verification: null,
              maxAttempts: 1,
              requiredAuthority: null,
              requiredRoles: [],
              approvalPolicy: 'single',
              requiredCount: 1,
            },
          ],
          transitions: [
            {
              transitionId: 'a__one',
              fromStepId: 'a',
              when: { kind: 'task_status', status: 'completed' },
              to: { kind: 'complete' },
            },
            duplicated,
          ],
        },
      ],
    };
    const selected = selectTransitions(definition, 'a', {
      kind: 'task',
      status: 'completed',
    });
    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.error.code).toBe('ambiguous_transition');
  });
});

describe('M0.8 条件重叠判定（conditionsOverlap）', () => {
  it('always 与任何条件重叠', () => {
    expect(
      conditionsOverlap({ kind: 'always' }, { kind: 'task_status', status: 'completed' }),
    ).toBe(true);
    expect(
      conditionsOverlap({ kind: 'always' }, { kind: 'approval_decision', decision: 'denied' }),
    ).toBe(true);
  });

  it('rejected 覆盖 rejected+failed；completed 不与 failed 重叠', () => {
    expect(
      conditionsOverlap(
        { kind: 'task_status', status: 'rejected' },
        { kind: 'task_status', status: 'failed' },
      ),
    ).toBe(true);
    expect(
      conditionsOverlap(
        { kind: 'task_status', status: 'completed' },
        { kind: 'task_status', status: 'failed' },
      ),
    ).toBe(false);
    expect(
      conditionsOverlap(
        { kind: 'task_status', status: 'completed' },
        { kind: 'task_status', status: 'rejected' },
      ),
    ).toBe(false);
  });

  it('审批决策按决策值判定；跨类别不重叠', () => {
    expect(
      conditionsOverlap(
        { kind: 'approval_decision', decision: 'granted' },
        { kind: 'approval_decision', decision: 'granted' },
      ),
    ).toBe(true);
    expect(
      conditionsOverlap(
        { kind: 'approval_decision', decision: 'granted' },
        { kind: 'approval_decision', decision: 'denied' },
      ),
    ).toBe(false);
    expect(
      conditionsOverlap(
        { kind: 'approval_decision', decision: 'granted' },
        { kind: 'task_status', status: 'completed' },
      ),
    ).toBe(false);
  });
});
