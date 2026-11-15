import { describe, expect, it } from 'vitest';
import type { PositionId, CorrelationId, SimTime } from '@maoeh/shared-types';
import { systemActor, employeeActor } from '@maoeh/permission-system';
import { createSimulationHarness } from '../helpers/simulation-fixtures';
import type { WorkflowDefinition } from '@maoeh/workflow-engine';
import { sim } from '../helpers/workflow-fixtures';

const definitions: readonly WorkflowDefinition[] = Object.freeze([
  {
    workflowId: 'watchdog-test',
    version: 1,
    name: 'Watchdog test',
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
            assignment: { kind: 'position', positionId: 'engineer' as PositionId },
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
  },
]);

describe('stall watchdog over a real kernel', () => {
  it('fails a task that never sees activity and aborts the workflow through the failed branch', async () => {
    const harness = await createSimulationHarness({
      workflowDefinitions: definitions,
      // An agent that plans an empty step keeps the task open without ever running it —
      // exactly the wedge the watchdog exists for. We accept and start the task by hand,
      // then the model stays silent.
      llmText: () =>
        JSON.stringify({
          interpretation: 'noop',
          considerations: ['a', 'b'],
          conclusion: 'noop',
          confidence: 0.5,
          plan: { goal: 'noop', doneWhen: 'noop', steps: [] },
        }),
    });
    const sim_ = harness.simulation;
    const started = sim_.workflow.start({
      workflowId: 'watchdog-test',
      actor: systemActor('hq', 'corr-watchdog-start'),
      simTime: sim(0) as SimTime,
      title: 'Watchdog',
      goal: 'Proves the watchdog',
    });
    if (!started.ok) throw new Error('workflow.start failed');
    const instanceId = started.value.instance.instanceId;
    const candidates = sim_.tasks.all().filter((candidate) => candidate.workflowInstanceId === instanceId);
    const task = candidates[0];
    if (task === undefined) throw new Error('the workflow did not create its task');
    const assignee = task.assignment.assigneeEmployeeId;
    if (assignee === null) throw new Error('the task has no assignee');

    const executor = employeeActor(
      sim_.identity.actorContext(assignee, 'corr-watchdog-executor' as CorrelationId),
    );
    const accepted = sim_.tasks.accept({ taskId: task.taskId, actor: executor, simTime: sim(1) as SimTime });
    if (!accepted.ok) throw new Error('accept failed');
    const startedTask = sim_.tasks.start({ taskId: task.taskId, actor: executor, simTime: sim(2) as SimTime });
    if (!startedTask.ok) throw new Error('start failed');

    // The tick driver is the only path that can honestly advance the kernel past the stall.
    for (let index = 0; index < 60; index += 1) {
      await sim_.tick();
    }

    const failed = sim_.tasks.get(task.taskId);
    expect(String(failed?.failureReason ?? '')).toContain('watchdog');
    const aborted = sim_.instanceStore.get(instanceId);
    expect(aborted?.status).toBe('aborted');
  });

  it('does not fail/reject a task whose workflow instance is paused', async () => {
    const harness = await createSimulationHarness({
      workflowDefinitions: definitions,
      llmText: () =>
        JSON.stringify({
          interpretation: 'noop',
          considerations: ['a', 'b'],
          conclusion: 'noop',
          confidence: 0.5,
          plan: { goal: 'noop', doneWhen: 'noop', steps: [] },
        }),
    });
    const sim_ = harness.simulation;
    const started = sim_.workflow.start({
      workflowId: 'watchdog-test',
      actor: systemActor('hq', 'corr-watchdog-paused'),
      simTime: sim(0) as SimTime,
      title: 'Paused watchdog',
      goal: 'A paused task must not be touched',
    });
    if (!started.ok) throw new Error('workflow.start failed');
    const instanceId = started.value.instance.instanceId;
    const task = sim_.tasks.all().find((candidate) => candidate.workflowInstanceId === instanceId);
    if (task === undefined) throw new Error('the workflow did not create its task');
    const executor = employeeActor(
      sim_.identity.actorContext(task.assignment.assigneeEmployeeId!, 'corr-watchdog-paused-exec' as CorrelationId),
    );
    expect(sim_.tasks.accept({ taskId: task.taskId, actor: executor, simTime: sim(1) as SimTime }).ok).toBe(true);
    expect(sim_.tasks.start({ taskId: task.taskId, actor: executor, simTime: sim(2) as SimTime }).ok).toBe(true);
    const paused = sim_.workflow.wait({
      instanceId,
      actor: harness.actor('ceo-alex') as never,
      simTime: sim(3) as SimTime,
      reason: 'acceptance pause',
    });
    expect(paused.ok).toBe(true);
    if (!paused.ok) return;
    await sim_.inject(paused.value.events);
    expect(sim_.instanceStore.get(instanceId)?.status).toBe('blocked');
    expect(sim_.instanceStore.get(instanceId)?.blockedReason?.kind).toBe('manual');

    for (let index = 0; index < 60; index += 1) await sim_.tick();

    expect(sim_.tasks.get(task.taskId)?.status).toBe('started');
    expect(sim_.tasks.get(task.taskId)?.failureReason ?? null).toBeNull();
    expect(sim_.instanceStore.get(instanceId)?.status).toBe('blocked');
  });
});
