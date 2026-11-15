import { describe, expect, it } from 'vitest';
import { generateWorkflowDefinition } from '../../../packages/workflow-engine/src/workflow-generation';
import { buildCapabilityPlan } from '@maoeh/workflow-engine';
import type { WorkflowFixture } from '../../helpers/workflow-fixtures';
import { createWorkflowFixture, must, sim } from '../../helpers/workflow-fixtures';
import { loadSeedOrganization } from '../../helpers/simulation-fixtures';

const seed = loadSeedOrganization();

describe('generated workflow definition: failed branch is defined and selected', () => {
  const definitionOf = (capabilities: readonly string[], instanceId: string) => {
    const { plan, issues } = buildCapabilityPlan(seed, capabilities);
    if (plan === null) throw new Error(`no plan for ${capabilities.join(',')}: ${JSON.stringify(issues)}`);
    return generateWorkflowDefinition({
      instanceId,
      title: 'Branch test',
      goal: 'fail explicitly',
      plan,
      approvalRoles: ['ceo'],
    });
  };

  it('generates one failed branch per capability stage', () => {
    const definition = definitionOf(['product_requirement', 'implementation'], 'i-failed-branches');
    const capabilityStages = definition.stages.filter((stage) =>
      stage.steps.some((step) => step.kind === 'task'),
    );
    expect(capabilityStages.length).toBe(2);
    for (const stage of capabilityStages) {
      expect(
        stage.transitions.find(
          (transition) =>
            transition.when.kind === 'task_status' &&
            (transition.when as { status: string }).status === 'failed',
        ),
      ).toMatchObject({ transitionId: `${stage.stageId}__failed` });
      expect(
        stage.transitions.some(
          (transition) =>
            transition.to.kind === 'fail' &&
            (transition.to as { reason?: string }).reason === `${stage.stageId}_failed`,
        ),
      ).toBe(true);
    }
    expect(definition.stages.map((stage) => stage.stageId)).toEqual(['stage-1', 'stage-2', 'stage-approve']);
  });

  it('a real Task.Failed selects the failed branch, not the rejected branch', () => {
    const definition = definitionOf(['product_requirement'], 'i-failed-branch-exec');
    const fx: WorkflowFixture = createWorkflowFixture({ definitions: [definition] });
    const op = must(
      fx.engine.start({
        workflowId: definition.workflowId,
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Branch test',
        goal: 'fail explicitly',
      }),
      'start',
    );
    const task = fx.currentTask(op.instance.instanceId);
    if (task === null) throw new Error('no task');
    const executor = fx.executorActor(task.taskId);
    if (fx.tasks.get(task.taskId)?.status === 'assigned') {
      must(fx.tasks.accept({ taskId: task.taskId, actor: executor, simTime: sim(1) }), 'accept');
    }
    if (fx.tasks.get(task.taskId)?.status === 'accepted') {
      must(fx.tasks.start({ taskId: task.taskId, actor: executor, simTime: sim(2) }), 'start');
    }
    const failed = must(
      fx.tasks.fail({ taskId: task.taskId, actor: executor, simTime: sim(3), reason: 'boom' }),
      'tasks.fail',
    );
    const advanced = must(
      fx.engine.advance({
        instanceId: op.instance.instanceId,
        actor: fx.ceoActor,
        event: failed.events[0]!,
        simTime: sim(4),
      }),
      'advance',
    );
    const aborted = advanced.events.find((event) => event.type === 'Workflow.InstanceAborted');
    expect((aborted?.payload as { reason?: string; detail?: string }).reason).toBe('failed');
    expect((aborted?.payload as { reason?: string; detail?: string }).detail).toBe('stage-1_failed');
    expect(advanced.events.map((event) => event.type)).not.toContain('Workflow.InstanceCompleted');
    const stepRejected = advanced.events.find((event) => event.type === 'Workflow.StepRejected');
    expect(stepRejected).toBeDefined();
  });

  it('a real Task.Rejected still selects the rejected branch alongside the failed one', () => {
    const definition = definitionOf(['product_requirement'], 'i-rejected-branch-exec');
    const fx: WorkflowFixture = createWorkflowFixture({ definitions: [definition] });
    const op = must(
      fx.engine.start({
        workflowId: definition.workflowId,
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Branch test',
        goal: 'reject explicitly',
      }),
      'start',
    );
    const task = fx.currentTask(op.instance.instanceId)!;
    const executor = fx.executorActor(task.taskId);
    if (fx.tasks.get(task.taskId)?.status === 'assigned') {
      must(fx.tasks.accept({ taskId: task.taskId, actor: executor, simTime: sim(1) }), 'accept');
    }
    if (fx.tasks.get(task.taskId)?.status === 'accepted') {
      must(fx.tasks.start({ taskId: task.taskId, actor: executor, simTime: sim(2) }), 'start');
    }
    const rejected = must(
      fx.tasks.reject({ taskId: task.taskId, actor: executor, simTime: sim(3), reason: 'not acceptable' }),
      'tasks.reject',
    );
    const advanced = must(
      fx.engine.advance({
        instanceId: op.instance.instanceId,
        actor: fx.ceoActor,
        event: rejected.events[0]!,
        simTime: sim(4),
      }),
      'advance',
    );
    const aborted = advanced.events.find((event) => event.type === 'Workflow.InstanceAborted');
    // The rejected branch targets fail with reason `stage-1_rejected`.
    expect((aborted?.payload as { detail?: string }).detail).toBe('stage-1_rejected');
  });

  it('a real Task.Cancelled aborts independently of the failed/rejected branches', () => {
    const definition = definitionOf(['product_requirement'], 'i-cancelled-branch-exec');
    const fx: WorkflowFixture = createWorkflowFixture({ definitions: [definition] });
    const op = must(
      fx.engine.start({
        workflowId: definition.workflowId,
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Branch test',
        goal: 'cancel explicitly',
      }),
      'start',
    );
    const task = fx.currentTask(op.instance.instanceId);
    if (task === null) throw new Error('no task');
    const executor = fx.executorActor(task.taskId);
    if (fx.tasks.get(task.taskId)?.status === 'assigned') {
      must(fx.tasks.accept({ taskId: task.taskId, actor: executor, simTime: sim(1) }), 'accept');
    }
    if (fx.tasks.get(task.taskId)?.status === 'accepted') {
      must(fx.tasks.start({ taskId: task.taskId, actor: executor, simTime: sim(2) }), 'start');
    }
    const cancelled = must(
      fx.tasks.cancel({ taskId: task.taskId, actor: executor, simTime: sim(3), reason: 'stop' }),
      'tasks.cancel',
    );
    const advanced = must(
      fx.engine.advance({
        instanceId: op.instance.instanceId,
        actor: fx.ceoActor,
        event: cancelled.events[0]!,
        simTime: sim(4),
      }),
      'advance',
    );
    const aborted = advanced.events.find((event) => event.type === 'Workflow.InstanceAborted');
    expect((aborted?.payload as { reason?: string }).reason).toBe('task_cancelled');
    expect(advanced.events.map((event) => event.type)).not.toContain('Workflow.InstanceCompleted');
  });
});
