import { describe, expect, it } from 'vitest';
import type { WorkflowInstance } from '@maoeh/workflow-engine';
import {
  DRAFT_CONTEXT_KEY,
  WORKFLOW_DRAFT_CONFIRMED,
  WORKFLOW_STEP_ENTERED,
  replayWorkflowInstance,
} from '@maoeh/workflow-engine';
import {
  createWorkflowFixture,
  must,
  sim,
} from '../../helpers/workflow-fixtures';

/**
 * M1.9 · 草稿确认态。
 *
 * capability 生成的工作流以 `awaitConfirmation` 创建时：定义落库、实例入库、但**没有
 * 任何步骤入场**；`confirm()` 丢掉 `context.draft` 并进入入口阶段。这是
 * "安排好了 → 投影到画布 → 改派 → 人点头才执行" 的引擎底座。
 */
describe('workflow engine: M1.9 draft confirmation', () => {
  it('parks a draft instance with no step entered and the draft marker on context', () => {
    const f = createWorkflowFixture();
    const started = must(
      f.engine.start({
        capabilities: ['implementation'],
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Draft plan',
        goal: 'Ship the thing.',
        awaitConfirmation: true,
      }),
      'draft start',
    );
    expect(started.instance.activeStepIds).toEqual([]);
    expect(started.instance.stepStates).toEqual({});
    expect(started.instance.context[DRAFT_CONTEXT_KEY]).toBe(true);
    expect(f.currentTask('instance-1')).toBeNull();
  });

  it('keeps the override a draft stages and enters the entry stage only on confirm', () => {
    const f = createWorkflowFixture();
    must(
      f.engine.start({
        capabilities: ['implementation'],
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Draft plan',
        goal: 'Ship the thing.',
        awaitConfirmation: true,
      }),
      'draft start',
    );
    const instance = f.instance('instance-1');
    if (instance === null) throw new Error('instance-1 does not exist');
    const definition = f.definitionStore.get(instance.workflowId);
    if (definition === null) throw new Error('definition not saved');
    const taskStepId = definition.stages
      .flatMap((stage) => stage.steps)
      .find((step) => step.kind === 'task')?.stepId;
    if (taskStepId === undefined) throw new Error('no task step in definition');

    // The human pins the not-yet-entered step — the only time this is possible.
    must(
      f.engine.overrideAssignments({
        instanceId: 'instance-1',
        actor: f.ceoActor,
        simTime: sim(2),
        reason: 'senior owns it',
        overrides: [{ stepId: taskStepId, employeeId: 'ceo-alex' }],
      }),
      'stage override on draft',
    );

    // Still parked: overrides staged, nothing entered.
    expect(f.instance('instance-1')?.stepStates[taskStepId]).toBeUndefined();

    const confirmed = must(
      f.engine.confirm({
        instanceId: 'instance-1',
        actor: f.ceoActor,
        simTime: sim(3),
        reason: 'plan approved on canvas',
      }),
      'confirm',
    );
    expect(confirmed.events.map((event) => event.type)).toContain(WORKFLOW_DRAFT_CONFIRMED);
    expect(confirmed.events.map((event) => event.type)).toContain(WORKFLOW_STEP_ENTERED);

    const after = f.instance('instance-1');
    expect(after?.context[DRAFT_CONTEXT_KEY]).toBeUndefined();
    const state = after?.stepStates[taskStepId];
    expect(state?.status).toBe('active');
    const task = state?.taskId == null ? null : f.taskStore.get(state.taskId);
    expect(task?.assignment.kind).toBe('employee');
    expect(task?.assignment.assigneeEmployeeId).toBe('ceo-alex');
  });

  it('refuses to confirm any instance that is not a draft — the entry runs only once', () => {
    const f = createWorkflowFixture();
    // A non-draft start (template) enters its first step immediately.
    const started = must(
      f.engine.start({
        workflowId: 'product-development',
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Normal run',
        goal: 'Ship it.',
      }),
      'template start',
    );
    const rejected = f.engine.confirm({
      instanceId: started.instance.instanceId,
      actor: f.ceoActor,
      simTime: sim(2),
      reason: 'should not apply',
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('expected refusal');
    expect(rejected.error.code).toBe('instance_not_draft');
  });

  it('a draft that is confirmed replays to the identical state from the log', () => {
    const f = createWorkflowFixture();
    const started = must(
      f.engine.start({
        capabilities: ['implementation'],
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Draft plan',
        goal: 'Ship the thing.',
        awaitConfirmation: true,
      }),
      'draft start',
    );
    f.record(started);
    const confirmed = must(
      f.engine.confirm({
        instanceId: 'instance-1',
        actor: f.ceoActor,
        simTime: sim(2),
        reason: 'go',
      }),
      'confirm',
    );
    f.record(confirmed);
    const replayed: WorkflowInstance | null = replayWorkflowInstance(f.sink);
    expect(replayed).not.toBeNull();
    expect(replayed?.context[DRAFT_CONTEXT_KEY]).toBeUndefined();
    expect(Object.keys(replayed?.stepStates ?? {}).length).toBeGreaterThan(0);
    expect(replayed?.activeStepIds.length).toBeGreaterThan(0);
  });
});
