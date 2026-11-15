import { describe, expect, it } from 'vitest';
import type { PositionId } from '@maoeh/shared-types';
import type { WorkflowDefinition } from '@maoeh/workflow-engine';
import type { WorkflowFixture } from '../../helpers/workflow-fixtures';
import { createWorkflowFixture, must, sim } from '../../helpers/workflow-fixtures';

/**
 * M2 regression: a task that finishes while its workflow is paused must still be settled when
 * the workflow is resumed.
 *
 * The reactor refuses `advance` for a blocked instance and has no retry, so the task's terminal
 * event is dropped. Before the fix, `resume` only emitted `Workflow.InstanceResumed`: the
 * instance woke up `running` with an `active` step whose task was already `submitted` /
 * `completed`, and no later tick could ever move it. This test pins the reconciliation path.
 */

function pausedWorkflow(): WorkflowDefinition {
  return {
    workflowId: 'pause-reconcile',
    version: 1,
    name: 'Pause reconcile',
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
        ],
      },
    ],
  };
}

function acceptAndStart(fx: WorkflowFixture, taskId: string): void {
  const executor = fx.executorActor(taskId);
  const current = fx.tasks.get(taskId);
  if (current?.status === 'assigned') {
    must(fx.tasks.accept({ taskId, actor: executor, simTime: sim(1) }), 'tasks.accept');
  }
  const accepted = fx.tasks.get(taskId);
  if (accepted?.status === 'accepted') {
    must(fx.tasks.start({ taskId, actor: executor, simTime: sim(2) }), 'tasks.start');
  }
}

describe('M2 paused workflow reconciliation', () => {
  it('settles a task that was submitted while the workflow was paused', () => {
    const fx = createWorkflowFixture({ definitions: [pausedWorkflow()] });
    const started = must(
      fx.engine.start({
        workflowId: 'pause-reconcile',
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Pause then finish',
        goal: 'Prove resume settles the dropped completion',
      }),
      'engine.start',
    );
    const task = fx.currentTask(started.instance.instanceId);
    expect(task).not.toBeNull();
    if (task === null) return;
    acceptAndStart(fx, task.taskId);

    // Pause first: the instance is now blocked/manual.
    const paused = must(
      fx.engine.wait({
        instanceId: started.instance.instanceId,
        actor: fx.ceoActor,
        simTime: sim(3),
        reason: 'operator paused advancement',
      }),
      'engine.wait',
    );
    expect(paused.instance.status).toBe('blocked');

    // The executor finishes anyway; the reactor would call advance here and be refused.
    const submitted = must(
      fx.tasks.submit({
        taskId: task.taskId,
        actor: fx.executorActor(task.taskId),
        simTime: sim(4),
        submission: { summary: 'done while paused', data: { deliverable: 'the work' } },
      }),
      'tasks.submit',
    );
    const event = submitted.events[0];
    expect(event).toBeDefined();
    if (event === undefined) return;
    const refused = fx.engine.advance({
      instanceId: started.instance.instanceId,
      actor: fx.ceoActor,
      event,
      simTime: sim(5),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('instance_blocked');

    const resumed = must(
      fx.engine.resume({
        instanceId: started.instance.instanceId,
        actor: fx.ceoActor,
        simTime: sim(6),
        reason: 'operator resumed advancement',
      }),
      'engine.resume',
    );

    expect(resumed.instance.status).toBe('completed');
    expect(resumed.instance.activeStepIds).toEqual([]);
    expect(fx.tasks.get(task.taskId)?.status).toBe('completed');
    expect(resumed.events.map((entry) => entry.type)).toContain('Workflow.InstanceResumed');
    expect(resumed.events.map((entry) => entry.type)).toContain('Workflow.StepCompleted');
    expect(resumed.events.map((entry) => entry.type)).toContain('Workflow.InstanceCompleted');
  });

  it('leaves a running instance with no finished task unchanged on resume', () => {
    const fx = createWorkflowFixture({ definitions: [pausedWorkflow()] });
    const started = must(
      fx.engine.start({
        workflowId: 'pause-reconcile',
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Pause then resume empty',
        goal: 'No terminal task to reconcile',
      }),
      'engine.start',
    );
    must(
      fx.engine.wait({
        instanceId: started.instance.instanceId,
        actor: fx.ceoActor,
        simTime: sim(1),
      }),
      'engine.wait',
    );
    const resumed = must(
      fx.engine.resume({
        instanceId: started.instance.instanceId,
        actor: fx.ceoActor,
        simTime: sim(2),
      }),
      'engine.resume',
    );
    expect(resumed.outcome).toBe('resumed');
    expect(resumed.instance.status).toBe('running');
    expect(resumed.events.map((entry) => entry.type)).toEqual(['Workflow.InstanceResumed']);
  });
});
