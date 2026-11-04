import { describe, expect, it } from 'vitest';
import type { CorrelationId, OrgEvent, PositionId } from '@maoeh/shared-types';
import { createOrgEvent } from '@maoeh/event-system';
import type { WorkflowDefinition, WorkflowOperation, WorkflowTransition } from '@maoeh/workflow-engine';
import type { WorkflowFixture } from '../helpers/workflow-fixtures';
import { createWorkflowFixture, must, sim } from '../helpers/workflow-fixtures';

function startProductAnalysis(fx: WorkflowFixture): WorkflowOperation {
  return must(
    fx.engine.start({
      workflowId: 'product-analysis',
      actor: fx.ceoActor,
      simTime: sim(0),
      title: 'Analyze the market',
      goal: 'Explain the competitive landscape',
    }),
    'engine.start',
  );
}

function driveIntakeToSubmitted(
  fx: WorkflowFixture,
  taskId: string,
  data: Record<string, unknown>,
): OrgEvent {
  // The executor is whoever routing chose for this step — driving the task is the mechanics under
  // test, not the seat.
  const executor = fx.executorActor(taskId);
  const current = fx.tasks.get(taskId);
  if (current?.status === 'assigned') {
    must(fx.tasks.accept({ taskId, actor: executor, simTime: sim(1) }), 'tasks.accept');
  }
  const accepted = fx.tasks.get(taskId);
  if (accepted?.status === 'accepted') {
    must(fx.tasks.start({ taskId, actor: executor, simTime: sim(2) }), 'tasks.start');
  }
  const submitted = must(
    fx.tasks.submit({
      taskId,
      actor: executor,
      simTime: sim(3),
      submission: { summary: 'brief ready', data },
    }),
    'tasks.submit',
  );
  return submitted.events[0] as OrgEvent;
}

const singleStepDefinition = (
  overrides: {
    readonly workflowId?: string;
    readonly assignment?: { readonly kind: 'position'; readonly positionId: PositionId };
    readonly verification?: WorkflowDefinition['stages'][number]['steps'][number]['verification'];
    readonly maxAttempts?: number;
    readonly includeRejected?: boolean;
  } = {},
): WorkflowDefinition => {
  const transitions: WorkflowTransition[] = [
    {
      transitionId: 'do-work__completed',
      fromStepId: 'do-work',
      when: { kind: 'task_status', status: 'completed' },
      to: { kind: 'complete' },
    },
  ];
  if (overrides.includeRejected === true) {
    transitions.push({
      transitionId: 'do-work__rejected',
      fromStepId: 'do-work',
      when: { kind: 'task_status', status: 'rejected' },
      to: { kind: 'fail', reason: 'work_failed' },
    });
  }
  return {
    workflowId: overrides.workflowId ?? 'wf-retry',
    version: 1,
    name: 'Single Step Flow',
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
            stepId: 'do-work',
            name: 'Do work',
            kind: 'task',
            description: null,
            assignment: overrides.assignment ?? {
              kind: 'position',
              positionId: 'ceo' as PositionId,
            },
            verification: overrides.verification ?? null,
            maxAttempts: overrides.maxAttempts ?? 2,
            requiredAuthority: null,
            requiredRoles: [],
            approvalPolicy: 'single',
            requiredCount: 1,
          },
        ],
        transitions,
      },
    ],
  };
};

describe('M0.8 工作流启动与推进（workflow-engine start/advance）', () => {
  it('start 产出 InstanceStarted→Task.Created→Task.Assigned→StepEntered 并持久化实例', () => {
    const fx = createWorkflowFixture();
    const operation = startProductAnalysis(fx);

    expect(operation.outcome).toBe('transitioned');
    expect(operation.events.map((event) => event.type)).toEqual([
      'Workflow.InstanceStarted',
      'Task.Created',
      'Task.Assigned',
      'Workflow.StepEntered',
    ]);
    expect(operation.events[0]?.actorId).toBe('ceo-alex');
    expect(operation.events[1]?.actorId).toBe('workflow-engine');
    // Which seat the step lands on is routing's decision: the intake work is `product_requirement`,
    // provided by the product seat — not by the CEO that dispatched the mandate.
    expect(operation.events[2]?.payload).toMatchObject({
      assignment: { positionId: 'product-manager', assigneeEmployeeId: 'pm-bona' },
      attempt: 1,
    });

    const instanceId = operation.instance.instanceId;
    const stored = fx.instance(instanceId);
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('running');
    expect(stored?.currentStageId).toBe('intake');
    expect(stored?.activeStepIds).toEqual(['intake-brief']);
    expect(stored?.stepStates['intake-brief']?.status).toBe('active');
    expect(stored?.initiatedBy).toBe('ceo-alex');
    expect(stored?.processedEventIds).toEqual(operation.events.map((event) => event.eventId));

    const taskId = stored?.stepStates['intake-brief']?.taskId;
    expect(taskId).not.toBeNull();
    expect(fx.tasks.get(taskId ?? '')?.status).toBe('assigned');
    expect(fx.tasks.get(taskId ?? '')?.workflowInstanceId).toBe(instanceId);
  });

  it('start 失败：未知工作流、空标题、重复 instanceId', () => {
    const fx = createWorkflowFixture();
    const unknown = fx.engine.start({
      workflowId: 'ghost-workflow',
      actor: fx.ceoActor,
      simTime: sim(0),
      title: 'x',
      goal: 'y',
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('unknown_workflow');

    const emptyTitle = fx.engine.start({
      workflowId: 'product-analysis',
      actor: fx.ceoActor,
      simTime: sim(0),
      title: '',
      goal: 'y',
    });
    expect(emptyTitle.ok).toBe(false);
    if (!emptyTitle.ok) {
      expect(emptyTitle.error.code).toBe('invalid_input');
      expect(emptyTitle.error.issues[0]?.field).toBe('title');
    }

    const first = fx.engine.start({
      workflowId: 'product-analysis',
      actor: fx.ceoActor,
      simTime: sim(0),
      title: 'first',
      goal: 'y',
      instanceId: 'custom-1',
    });
    expect(first.ok).toBe(true);
    const second = fx.engine.start({
      workflowId: 'product-analysis',
      actor: fx.ceoActor,
      simTime: sim(1),
      title: 'second',
      goal: 'y',
      instanceId: 'custom-1',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('invalid_input');
      expect(second.error.issues[0]?.field).toBe('instanceId');
    }
  });

  it('start 前置检查：岗位无可任职员工 → invalid_definition', () => {
    const definition = singleStepDefinition({
      workflowId: 'wf-qa',
      assignment: { kind: 'position', positionId: 'backend-engineer' as PositionId },
    });
    const fx = createWorkflowFixture({ definitions: [definition] });
    const result = fx.engine.start({
      workflowId: 'wf-qa',
      actor: fx.ceoActor,
      simTime: sim(0),
      title: 'QA flow',
      goal: 'Assign to an empty position',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_definition');
    expect(result.error.issues[0]?.reason).toContain('has no assignable employee');
  });

  it('advance 幂等：重复事件 → duplicate 且不改状态', () => {
    const fx = createWorkflowFixture();
    const start = startProductAnalysis(fx);
    const duplicated = fx.engine.advance({
      instanceId: start.instance.instanceId,
      actor: fx.ceoActor,
      event: start.events[0] as OrgEvent,
      simTime: sim(5),
    });
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    expect(duplicated.value.outcome).toBe('duplicate');
    expect(duplicated.value.events).toEqual([]);
    expect(fx.instance(start.instance.instanceId)?.status).toBe('running');
  });

  it('advance 失败：未知实例；非任务事件 → ignored 并记录已处理', () => {
    const fx = createWorkflowFixture();
    const start = startProductAnalysis(fx);
    const instanceId = start.instance.instanceId;

    const unknown = fx.engine.advance({
      instanceId: 'ghost-instance',
      actor: fx.ceoActor,
      event: start.events[0] as OrgEvent,
      simTime: sim(1),
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('unknown_instance');

    const foreign = createOrgEvent(
      fx.registry,
      {
        companyId: fx.companyId,
        type: 'Workflow.InstanceResumed',
        occurredAtSim: sim(1),
        actorKind: 'employee',
        actorId: 'ceo-alex',
        subjectType: 'workflow',
        subjectId: instanceId,
        correlationId: 'corr-foreign' as CorrelationId,
        payload: { instanceId, resumedBy: 'ceo-alex' },
      },
      { eventIdGenerator: () => 'foreign-1' },
    );
    if (!foreign.ok) throw new Error('foreign event failed to build');

    const ignored = fx.engine.advance({
      instanceId,
      actor: fx.ceoActor,
      event: foreign.value,
      simTime: sim(1),
    });
    expect(ignored.ok).toBe(true);
    if (!ignored.ok) return;
    expect(ignored.value.outcome).toBe('ignored');
    expect(ignored.value.events).toEqual([]);
    expect(fx.instance(instanceId)?.processedEventIds).toContain('foreign-1');
  });

  it('advance 失败：taskId 不属于任何活动步 → task_not_in_instance', () => {
    const fx = createWorkflowFixture();
    const start = startProductAnalysis(fx);
    const ghost = must(
      fx.tasks.create({
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Ghost task',
        goal: 'Not part of the workflow',
        assignment: { kind: 'position', positionId: 'ceo' as PositionId },
      }),
      'tasks.create',
    );
    const result = fx.engine.advance({
      instanceId: start.instance.instanceId,
      actor: fx.ceoActor,
      event: ghost.events[0] as OrgEvent,
      simTime: sim(1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('task_not_in_instance');
  });

  it('progress 汇报被忽略；提交结果通过验证后推进到 design', () => {
    const fx = createWorkflowFixture();
    const start = startProductAnalysis(fx);
    const instanceId = start.instance.instanceId;
    const taskId = start.instance.stepStates['intake-brief']?.taskId;
    expect(taskId).not.toBeNull();

    must(fx.tasks.accept({ taskId: taskId ?? '', actor: fx.executorActor(taskId ?? ''), simTime: sim(1) }), 'accept');
    must(fx.tasks.start({ taskId: taskId ?? '', actor: fx.executorActor(taskId ?? ''), simTime: sim(2) }), 'start');
    const report = must(
      fx.tasks.report({
        taskId: taskId ?? '',
        actor: fx.executorActor(taskId ?? ''),
        simTime: sim(3),
        summary: 'halfway there',
      }),
      'report',
    );
    const ignored = fx.engine.advance({
      instanceId,
      actor: fx.ceoActor,
      event: report.events[0] as OrgEvent,
      simTime: sim(3),
    });
    expect(ignored.ok).toBe(true);
    if (!ignored.ok) return;
    expect(ignored.value.outcome).toBe('ignored');

    const submittedEvent = driveIntakeToSubmitted(fx, taskId ?? '', {
      problem: 'churn is rising',
      success_criteria: 'root causes identified',
    });
    const advanced = fx.engine.advance({
      instanceId,
      actor: fx.ceoActor,
      event: submittedEvent,
      simTime: sim(4),
    });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.value.outcome).toBe('transitioned');
    expect(advanced.value.events.map((event) => event.type)).toEqual([
      'Task.Completed',
      'Workflow.StepCompleted',
      'Task.Created',
      'Task.Assigned',
      'Workflow.StepEntered',
    ]);
    expect(advanced.value.task?.status).toBe('completed');

    const instance = advanced.value.instance;
    expect(instance.status).toBe('running');
    expect(instance.currentStageId).toBe('design');
    expect(instance.stepStates['intake-brief']?.status).toBe('done');
    expect(instance.stepStates['intake-brief']?.outcome).toBe('verified');
    expect(instance.stepStates['design-approach']?.status).toBe('active');
    expect(instance.activeStepIds).toEqual(['design-approach']);
    expect(fx.tasks.get(taskId ?? '')?.status).toBe('completed');
  });

  it('确定性验证缺键 → 步 rejected + 实例 aborted（走 rejected 分支）', () => {
    const fx = createWorkflowFixture();
    const start = startProductAnalysis(fx);
    const instanceId = start.instance.instanceId;
    const taskId = start.instance.stepStates['intake-brief']?.taskId ?? '';

    const submittedEvent = driveIntakeToSubmitted(fx, taskId, { problem: 'only problem' });
    const advanced = fx.engine.advance({
      instanceId,
      actor: fx.ceoActor,
      event: submittedEvent,
      simTime: sim(4),
    });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.value.outcome).toBe('aborted');
    expect(advanced.value.events.map((event) => event.type)).toEqual([
      'Task.Rejected',
      'Workflow.StepRejected',
      'Workflow.InstanceAborted',
    ]);
    expect(advanced.value.task?.status).toBe('rejected');
    expect(advanced.value.task?.attempt).toBe(2);

    const instance = advanced.value.instance;
    expect(instance.status).toBe('aborted');
    expect(instance.activeStepIds).toEqual([]);
    expect(instance.stepStates['intake-brief']?.status).toBe('rejected');
    expect(instance.stepStates['intake-brief']?.outcome).toContain('missing output keys');
    expect(fx.tasks.get(taskId)?.status).toBe('rejected');
  });

  it('无 rejected 分支的步骤失败 → 自动重派 outcome=retried', () => {
    const definition = singleStepDefinition({
      workflowId: 'wf-retry',
      verification: { kind: 'deterministic', requiredOutputKeys: ['answer'] },
      maxAttempts: 2,
    });
    const fx = createWorkflowFixture({ definitions: [definition] });
    const start = must(
      fx.engine.start({
        workflowId: 'wf-retry',
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Retry flow',
        goal: 'Exercise the retry path',
      }),
      'engine.start',
    );
    const taskId = start.instance.stepStates['do-work']?.taskId ?? '';

    const submittedEvent = driveIntakeToSubmitted(fx, taskId, { wrong: true });
    const advanced = fx.engine.advance({
      instanceId: start.instance.instanceId,
      actor: fx.ceoActor,
      event: submittedEvent,
      simTime: sim(4),
    });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.value.outcome).toBe('retried');
    expect(advanced.value.events.map((event) => event.type)).toEqual([
      'Task.Rejected',
      'Task.Assigned',
    ]);

    const instance = advanced.value.instance;
    expect(instance.status).toBe('running');
    expect(instance.stepStates['do-work']?.status).toBe('active');
    const task = fx.tasks.get(taskId);
    expect(task?.status).toBe('assigned');
    expect(task?.attempt).toBe(2);
  });

  it('任务取消 → 步 rejected + 实例 aborted，随后事件报 instance_terminal', () => {
    const fx = createWorkflowFixture();
    const start = startProductAnalysis(fx);
    const instanceId = start.instance.instanceId;
    const taskId = start.instance.stepStates['intake-brief']?.taskId ?? '';

    must(fx.tasks.accept({ taskId, actor: fx.executorActor(taskId), simTime: sim(1) }), 'accept');
    const startedEvent = must(
      fx.tasks.start({ taskId, actor: fx.executorActor(taskId), simTime: sim(2) }),
      'start',
    ).events[0] as OrgEvent;
    const cancelled = must(
      fx.tasks.cancel({ taskId, actor: fx.executorActor(taskId), simTime: sim(3), reason: 'superseded' }),
      'cancel',
    );

    const aborted = fx.engine.advance({
      instanceId,
      actor: fx.ceoActor,
      event: cancelled.events[0] as OrgEvent,
      simTime: sim(3),
    });
    expect(aborted.ok).toBe(true);
    if (!aborted.ok) return;
    expect(aborted.value.outcome).toBe('aborted');
    expect(aborted.value.events.map((event) => event.type)).toEqual([
      'Workflow.StepRejected',
      'Workflow.InstanceAborted',
    ]);
    expect(aborted.value.instance.status).toBe('aborted');
    expect(aborted.value.instance.stepStates['intake-brief']?.outcome).toBe('superseded');

    const afterTerminal = fx.engine.advance({
      instanceId,
      actor: fx.ceoActor,
      event: startedEvent,
      simTime: sim(4),
    });
    expect(afterTerminal.ok).toBe(false);
    if (!afterTerminal.ok) expect(afterTerminal.error.code).toBe('instance_terminal');
  });
});
