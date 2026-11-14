import { describe, expect, it } from 'vitest';
import type { PositionId } from '@maoeh/shared-types';
import type { WorkflowDefinition } from '@maoeh/workflow-engine';
import type { WorkflowFixture } from '../../helpers/workflow-fixtures';
import { createWorkflowFixture, must, sim } from '../../helpers/workflow-fixtures';

/**
 * F2: a task that failed and a task that was rejected are different facts. The task fold keeps
 * both as `status='rejected'` (for the state machine), so the failure provenance has to travel
 * on the record; `resume()` must then select the failed branch for a real failure, and the
 * rejected branch for a real rejection — never one for the other.
 */
function bothBranches(): WorkflowDefinition {
  return {
    workflowId: 'f2-branches',
    version: 1,
    name: 'F2 branches',
    description: null,
    cyclePolicy: 'forbid',
    entryStageId: 'work',
    terminalStageIds: ['work'],
    stages: [
      {
        stageId: 'work',
        name: 'Work',
        steps: [
          {
            stepId: 'do-work',
            name: 'Do the work',
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
            transitionId: 'do-work__completed',
            fromStepId: 'do-work',
            when: { kind: 'task_status', status: 'completed' },
            to: { kind: 'complete' },
          },
          {
            transitionId: 'do-work__rejected',
            fromStepId: 'do-work',
            when: { kind: 'task_status', status: 'rejected' },
            to: { kind: 'fail', reason: 'rejected_branch' },
          },
          {
            transitionId: 'do-work__failed',
            fromStepId: 'do-work',
            when: { kind: 'task_status', status: 'failed' },
            to: { kind: 'fail', reason: 'failed_branch' },
          },
        ],
      },
    ],
  };
}

function start(fx: WorkflowFixture) {
  return must(
    fx.engine.start({
      workflowId: 'f2-branches',
      actor: fx.ceoActor,
      simTime: sim(0),
      title: 'F2',
      goal: 'Select the branch that matches the terminal fact',
    }),
    'engine.start',
  );
}

function acceptStart(fx: WorkflowFixture, taskId: string): void {
  const executor = fx.executorActor(taskId);
  if (fx.tasks.get(taskId)?.status === 'assigned') must(fx.tasks.accept({ taskId, actor: executor, simTime: sim(1) }), 'accept');
  if (fx.tasks.get(taskId)?.status === 'accepted') must(fx.tasks.start({ taskId, actor: executor, simTime: sim(2) }), 'start');
}

function abortedDetail(events: readonly { readonly type: string; readonly payload: unknown }[]): string | null {
  const aborted = events.find((event) => event.type === 'Workflow.InstanceAborted');
  return aborted === undefined ? null : (aborted.payload as { detail?: string }).detail ?? null;
}

describe('M2 F2 failed/rejected provenance', () => {
  it('normal execution: Task.Failed selects the failed branch', () => {
    const fx = createWorkflowFixture({ definitions: [bothBranches()] });
    const op = start(fx);
    const task = fx.currentTask(op.instance.instanceId);
    if (task === null) throw new Error('no task');
    acceptStart(fx, task.taskId);
    const failed = must(
      fx.tasks.fail({ taskId: task.taskId, actor: fx.executorActor(task.taskId), simTime: sim(3), reason: 'boom' }),
      'tasks.fail',
    );
    const advanced = must(
      fx.engine.advance({ instanceId: op.instance.instanceId, actor: fx.ceoActor, event: failed.events[0]!, simTime: sim(4) }),
      'engine.advance',
    );
    expect(abortedDetail(advanced.events)).toBe('failed_branch');
  });

  it('pause + fail + resume selects the failed branch', () => {
    const fx = createWorkflowFixture({ definitions: [bothBranches()] });
    const op = start(fx);
    const task = fx.currentTask(op.instance.instanceId);
    if (task === null) throw new Error('no task');
    acceptStart(fx, task.taskId);
    must(fx.engine.wait({ instanceId: op.instance.instanceId, actor: fx.ceoActor, simTime: sim(3) }), 'wait');
    must(
      fx.tasks.fail({ taskId: task.taskId, actor: fx.executorActor(task.taskId), simTime: sim(4), reason: 'boom while paused' }),
      'tasks.fail',
    );
    const resumed = must(
      fx.engine.resume({ instanceId: op.instance.instanceId, actor: fx.ceoActor, simTime: sim(5) }),
      'engine.resume',
    );
    expect(abortedDetail(resumed.events)).toBe('failed_branch');
  });

  it('pause + reject + resume selects the rejected branch', () => {
    const fx = createWorkflowFixture({ definitions: [bothBranches()] });
    const op = start(fx);
    const task = fx.currentTask(op.instance.instanceId);
    if (task === null) throw new Error('no task');
    acceptStart(fx, task.taskId);
    must(fx.engine.wait({ instanceId: op.instance.instanceId, actor: fx.ceoActor, simTime: sim(3) }), 'wait');
    must(
      fx.tasks.reject({ taskId: task.taskId, actor: fx.executorActor(task.taskId), simTime: sim(4), reason: 'not acceptable' }),
      'tasks.reject',
    );
    const resumed = must(
      fx.engine.resume({ instanceId: op.instance.instanceId, actor: fx.ceoActor, simTime: sim(5) }),
      'engine.resume',
    );
    expect(abortedDetail(resumed.events)).toBe('rejected_branch');
  });

  it('pause + cancel + resume aborts as cancelled without a completion', () => {
    const fx = createWorkflowFixture({ definitions: [bothBranches()] });
    const op = start(fx);
    const task = fx.currentTask(op.instance.instanceId);
    if (task === null) throw new Error('no task');
    acceptStart(fx, task.taskId);
    must(fx.engine.wait({ instanceId: op.instance.instanceId, actor: fx.ceoActor, simTime: sim(3) }), 'wait');
    must(
      fx.tasks.cancel({ taskId: task.taskId, actor: fx.ceoActor, simTime: sim(4), reason: 'stop it' }),
      'tasks.cancel',
    );
    const resumed = must(
      fx.engine.resume({ instanceId: op.instance.instanceId, actor: fx.ceoActor, simTime: sim(5) }),
      'engine.resume',
    );
    expect(resumed.instance.status).toBe('aborted');
    expect(resumed.events.map((event) => event.type)).toContain('Workflow.StepRejected');
    expect(resumed.events.map((event) => event.type)).not.toContain('Workflow.InstanceCompleted');
    const aborted = resumed.events.find((event) => event.type === 'Workflow.InstanceAborted');
    expect((aborted?.payload as { reason?: string }).reason).toBe('task_cancelled');
  });
});
