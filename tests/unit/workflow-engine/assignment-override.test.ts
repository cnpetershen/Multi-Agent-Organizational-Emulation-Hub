import { describe, expect, it } from 'vitest';
import { createAuthorityService } from '@maoeh/authority-engine';
import type { WorkflowDefinition } from '@maoeh/workflow-engine';
import {
  ASSIGNMENT_OVERRIDES_CONTEXT_KEY,
  WORKFLOW_STEP_ASSIGNMENT_OVERRIDDEN,
  assignmentOverridesOf,
  replayWorkflowInstance,
} from '@maoeh/workflow-engine';
import {
  createWorkflowFixture,
  must,
  sim,
} from '../../helpers/workflow-fixtures';

/**
 * M1.8 · 实例级一次性改派�? *
 * - override 只写实例�?`context.assignmentOverrides`，definition 与其他实例不受影响；
 * - 整批校验、全过才提交；任何一条失�?�?命令拒绝、零事件�? * - 只允许未进入�?task step；approval step 与已进入 step 一律拒绝；
 * - 员工存在且可执行是硬闸门；`requiredRoles` / `requiredAuthority` 由内核复核；
 * - 相同值的重复提交�?accepted no-op（accepted、零事件）�? */

const override = (
  f: ReturnType<typeof createWorkflowFixture>,
  entries: readonly { stepId: string; employeeId: string }[],
) =>
  f.engine.overrideAssignments({
    instanceId: 'instance-1',
    actor: f.ceoActor,
    simTime: sim(2),
    reason: 'operator adjusted the plan before activation',
    overrides: entries,
  });

const overridesOf = (
  instance: import('@maoeh/workflow-engine').WorkflowInstance | null,
) => {
  if (instance === null) throw new Error('instance-1 does not exist');
  return assignmentOverridesOf(instance);
};

const guardedDefinition = (
  guarded: Partial<{ requiredAuthority: { domain: 'engineering'; level: number }; requiredRoles: string[] }>,
): WorkflowDefinition => ({
  workflowId: 'guarded-override-test',
  version: 1,
  name: 'Guarded override test',
  cyclePolicy: 'forbid',
  entryStageId: 'setup',
  terminalStageIds: ['guarded'],
  stages: [
    {
      stageId: 'setup',
      name: 'Setup stage',
      steps: [
        {
          stepId: 'setup-task',
          name: 'Setup task',
          kind: 'task',
          description: null,
          capability: null,
          assignment: { kind: 'capability', capability: 'implementation' },
          verification: { kind: 'deterministic', requiredOutputKeys: ['deliverable'] },
          maxAttempts: 1,
          requiredAuthority: null,
          requiredRoles: [],
          approvalPolicy: 'single',
          requiredCount: 1,
        },
      ],
      transitions: [
        {
          transitionId: 'setup-task__completed',
          fromStepId: 'setup-task',
          when: { kind: 'task_status', status: 'completed' },
          to: { kind: 'stage', stageId: 'guarded' },
        },
      ],
    },
    {
      stageId: 'guarded',
      name: 'Guarded stage',
      steps: [
        {
          stepId: 'guarded-task',
          name: 'Guarded task',
          kind: 'task',
          description: null,
          capability: null,
          assignment: { kind: 'capability', capability: 'implementation' },
          verification: { kind: 'deterministic', requiredOutputKeys: ['deliverable'] },
          maxAttempts: 1,
          requiredAuthority: guarded.requiredAuthority ?? null,
          requiredRoles: guarded.requiredRoles ?? [],
          approvalPolicy: 'single',
          requiredCount: 1,
        },
      ],
      transitions: [
        {
          transitionId: 'guarded-task__completed',
          fromStepId: 'guarded-task',
          when: { kind: 'task_status', status: 'completed' },
          to: { kind: 'complete' },
        },
      ],
    },
  ],
});

const startGuarded = (f: ReturnType<typeof createWorkflowFixture>) =>
  must(
    f.engine.start({
      workflowId: 'guarded-override-test',
      actor: f.ceoActor,
      simTime: sim(1),
      title: 'Guarded mandate',
      goal: 'Deliver with the guard rails on.',
    }),
    'guarded start',
  );

describe('workflow engine: M1.8 assignment override', () => {
  it('records a per-instance override, folds it into context and leaves the definition alone', () => {
    const f = createWorkflowFixture();
    const started = must(
      f.engine.start({
        workflowId: 'product-development',
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Board directive',
        goal: 'Ship the thing.',
      }),
      'start',
    );
    f.record(started);
    // requirement-analysis has entered (pm-bona); technical-design has not.
    expect(f.instance('instance-1')?.stepStates['technical-design']).toBeUndefined();

    const result = override(f, [{ stepId: 'technical-design', employeeId: 'cto-john' }]);
    const operation = must(result, 'override');
    expect(operation.events).toHaveLength(1);
    const event = operation.events[0];
    expect(event?.type).toBe(WORKFLOW_STEP_ASSIGNMENT_OVERRIDDEN);
    expect(event?.payload).toMatchObject({
      instanceId: 'instance-1',
      stepId: 'technical-design',
      employeeId: 'cto-john',
      previousEmployeeId: null,
    });

    const instance = f.instance('instance-1');
    expect(overridesOf(instance)).toEqual({
      'technical-design': 'cto-john',
    });
    expect(instance?.context[ASSIGNMENT_OVERRIDES_CONTEXT_KEY]).toEqual({
      'technical-design': 'cto-john',
    });

    // The definition is untouched: the seat resolution at entry still defaults to capability.
    const definition = f.definitionStore.get('product-development');
    const designStep = definition?.stages
      .flatMap((stage) => stage.steps)
      .find((step) => step.stepId === 'technical-design');
    expect(designStep?.assignment).toEqual({ kind: 'capability', capability: 'technical_design' });
  });

  it('applies a whole batch atomically �?a bad entry rejects everything', () => {
    const f = createWorkflowFixture();
    must(
      f.engine.start({
        workflowId: 'product-development',
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Board directive',
        goal: 'Ship the thing.',
      }),
      'start',
    );

    const rejected = override(f, [
      { stepId: 'technical-design', employeeId: 'cto-john' },
      { stepId: 'implementation-task', employeeId: 'ghost-employee' },
    ]);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('expected refusal');
    expect(rejected.error.code).toBe('invalid_input');
    expect(rejected.error.issues.map((issue) => issue.field)).toContain('overrides.1.employeeId');

    // Nothing was folded, nothing persisted.
    const instance = f.instance('instance-1');
    expect(instance?.context[ASSIGNMENT_OVERRIDES_CONTEXT_KEY]).toBeUndefined();
  });

  it('accepts the whole batch when every entry is valid, keeping one event per real change', () => {
    const f = createWorkflowFixture();
    must(
      f.engine.start({
        workflowId: 'product-development',
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Board directive',
        goal: 'Ship the thing.',
      }),
      'start',
    );

    const operation = must(
      override(f, [
        { stepId: 'technical-design', employeeId: 'cto-john' },
        { stepId: 'implementation-task', employeeId: 'qa-peter' },
      ]),
      'batch override',
    );
    expect(operation.events).toHaveLength(2);
    expect(overridesOf(f.instance('instance-1'))).toEqual({
      'technical-design': 'cto-john',
      'implementation-task': 'qa-peter',
    });
  });

  it('an identical re-submission is an accepted no-op with zero events', () => {
    const f = createWorkflowFixture();
    must(
      f.engine.start({
        workflowId: 'product-development',
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Board directive',
        goal: 'Ship the thing.',
      }),
      'start',
    );
    must(
      override(f, [{ stepId: 'technical-design', employeeId: 'cto-john' }]),
      'first override',
    );
    const again = must(
      override(f, [{ stepId: 'technical-design', employeeId: 'cto-john' }]),
      're-submitted override',
    );
    expect(again.events).toHaveLength(0);
    const instance = f.instance('instance-1');
    expect(overridesOf(instance)).toEqual({
      'technical-design': 'cto-john',
    });
  });

  it('refuses unknown steps, approval steps and already-entered steps', () => {
    const f = createWorkflowFixture();
    must(
      f.engine.start({
        workflowId: 'product-development',
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Board directive',
        goal: 'Ship the thing.',
      }),
      'start',
    );

    const unknown = override(f, [{ stepId: 'no-such-step', employeeId: 'cto-john' }]);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error('expected refusal');
    expect(unknown.error.issues[0]?.field).toBe('overrides.0.stepId');

    const approval = override(f, [{ stepId: 'technical-review', employeeId: 'cto-john' }]);
    expect(approval.ok).toBe(false);
    if (approval.ok) throw new Error('expected refusal');
    expect(approval.error.issues[0]?.field).toBe('overrides.0.stepId');
    expect(approval.error.issues[0]?.reason).toContain('approval');

    const entered = override(f, [{ stepId: 'requirement-analysis', employeeId: 'cto-john' }]);
    expect(entered.ok).toBe(false);
    if (entered.ok) throw new Error('expected refusal');
    expect(entered.error.issues[0]?.reason).toContain('already entered');
  });

  it('replay from the log rebuilds the override �?recovery sees the same truth', () => {
    const f = createWorkflowFixture();
    const started = must(
      f.engine.start({
        workflowId: 'product-development',
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Board directive',
        goal: 'Ship the thing.',
      }),
      'start',
    );
    f.record(started);
    const overridden = must(
      override(f, [{ stepId: 'technical-design', employeeId: 'cto-john' }]),
      'override',
    );
    f.record(overridden);

    const replayed = replayWorkflowInstance(f.sink);
    expect(replayed).not.toBeNull();
    expect(overridesOf(replayed)).toEqual({
      'technical-design': 'cto-john',
    });
  });

  it('enforces requiredRoles: a mismatched employee is refused, the named role holder passes', () => {
    const organization = createWorkflowFixture().organization;
    const f = createWorkflowFixture({
      organization,
      definitions: [guardedDefinition({ requiredRoles: ['cto'] })],
      authority: createAuthorityService(organization),
    });
    startGuarded(f);

    const weak = override(f, [{ stepId: 'guarded-task', employeeId: 'engineer-mike' }]);
    expect(weak.ok).toBe(false);
    if (weak.ok) throw new Error('expected refusal');
    expect(weak.error.issues.some((issue) => issue.field === 'overrides.0.employeeId')).toBe(true);

    const strong = override(f, [{ stepId: 'guarded-task', employeeId: 'cto-john' }]);
    expect(strong.ok).toBe(true);
  });

  it('enforces requiredAuthority on the assignee: level 1 refused, level 3 accepted', () => {
    const organization = createWorkflowFixture().organization;
    const f = createWorkflowFixture({
      organization,
      definitions: [guardedDefinition({ requiredAuthority: { domain: 'engineering', level: 3 } })],
      authority: createAuthorityService(organization),
    });
    startGuarded(f);

    const weak = override(f, [{ stepId: 'guarded-task', employeeId: 'engineer-mike' }]);
    expect(weak.ok).toBe(false);
    if (weak.ok) throw new Error('expected refusal');
    expect(weak.error.issues.some((issue) => issue.field === 'overrides.0.employeeId')).toBe(true);

    const strong = override(f, [{ stepId: 'guarded-task', employeeId: 'cto-john' }]);
    expect(strong.ok).toBe(true);
  });

  it('activation honours the override: the pinned employee gets the task', () => {
    const f = createWorkflowFixture();
    must(
      f.engine.start({
        workflowId: 'product-development',
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Board directive',
        goal: 'Ship the thing.',
      }),
      'start',
    );
    // Pin the not-yet-entered design step to the CEO. No capability route would ever put
    // the CEO on a technical_design task; only the override may.
    must(
      override(f, [{ stepId: 'technical-design', employeeId: 'ceo-alex' }]),
      'override to ceo',
    );
    // Drive the first step to completion so design activates.
    const firstTask = f.currentTask('instance-1');
    expect(firstTask).not.toBeNull();
    if (firstTask === null) throw new Error('missing first task');
    const executor = f.executorActor(String(firstTask.taskId));
    must(
      f.tasks.accept({ taskId: firstTask.taskId, actor: executor, simTime: sim(2) }),
      'accept requirement analysis',
    );
    must(
      f.tasks.start({ taskId: firstTask.taskId, actor: executor, simTime: sim(3) }),
      'start requirement analysis',
    );
    const submitted = must(
      f.tasks.submit({
        taskId: firstTask.taskId,
        actor: executor,
        simTime: sim(4),
        submission: { summary: 'scope settled', data: { scope: 'x' } },
      }),
      'submit requirement analysis',
    );
    must(
      f.engine.advance({
        instanceId: 'instance-1',
        actor: executor,
        event: submitted.events[0] as NonNullable<typeof submitted.events[0]>,
        simTime: sim(5),
      }),
      'advance after requirement analysis',
    );

    const instance = f.instance('instance-1');
    const design = instance?.stepStates['technical-design'];
    expect(design?.status).toBe('active');
    const designTask = design?.taskId == null ? null : f.taskStore.get(design.taskId);
    expect(designTask?.assignment.kind).toBe('employee');
    expect(designTask?.assignment.assigneeEmployeeId).toBe('ceo-alex');
  });
});

