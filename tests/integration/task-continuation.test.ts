import { describe, expect, it } from 'vitest';
import type { PositionId, SimTime } from '@maoeh/shared-types';
import type { WorkflowDefinition } from '@maoeh/workflow-engine';
import { createSimulationHarness } from '../helpers/simulation-fixtures';
import { sim } from '../helpers/workflow-fixtures';

const definition: WorkflowDefinition = {
  workflowId: 'continuation-test',
  version: 1,
  name: 'Continuation test',
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
};

const acceptOnly = {
  interpretation: 'accept the task first',
  considerations: ['the state machine says assigned -> AcceptTask'],
  conclusion: 'accept now',
  confidence: 0.9,
  plan: {
    goal: 'accept the task',
    doneWhen: 'the task is accepted',
    steps: [{ action: 'AcceptTask', args: { taskId: 'task-1' }, reasonRef: 0 }],
  },
};

const startOnly = {
  interpretation: 'start the accepted task',
  considerations: ['accepted -> StartTask'],
  conclusion: 'start now',
  confidence: 0.9,
  plan: {
    goal: 'start the task',
    doneWhen: 'the task is started',
    steps: [{ action: 'StartTask', args: { taskId: 'task-1' }, reasonRef: 0 }],
  },
};

const submitOnly = {
  interpretation: 'submit the started task',
  considerations: ['started -> SubmitReport'],
  conclusion: 'submit now',
  confidence: 0.9,
  plan: {
    goal: 'submit the task',
    doneWhen: 'the task is submitted',
    steps: [
      {
        action: 'SubmitReport',
        args: { taskId: 'task-1', summary: 'done', data: { result: 'ok' } },
        reasonRef: 0,
      },
    ],
  },
};

async function allEvents(simulation: {
  readonly eventStore: { replay(from: never): AsyncIterable<{ readonly type: string; readonly eventId: string }> };
}): Promise<readonly { readonly type: string; readonly eventId: string }[]> {
  const events: { readonly type: string; readonly eventId: string }[] = [];
  for await (const event of simulation.eventStore.replay(1 as never)) events.push(event);
  return events;
}

describe('accepted task continuation wakeup', () => {
  it('wakes an assignee that only accepted, so the next model turn can start and submit', async () => {
    let engineerCalls = 0;
    const harness = await createSimulationHarness({
      workflowDefinitions: [definition],
      llmText: (request) => {
        if (request.prompt.includes('taskId=task-1')) {
          engineerCalls += 1;
          if (request.prompt.includes('status=assigned')) return JSON.stringify(acceptOnly);
          if (request.prompt.includes('status=accepted')) return JSON.stringify(startOnly);
          if (request.prompt.includes('status=started')) return JSON.stringify(submitOnly);
        }
        return JSON.stringify(acceptOnly);
      },
    });
    const simulation = harness.simulation;
    const started = simulation.workflow.start({
      workflowId: definition.workflowId,
      actor: harness.actor('ceo-alex') as never,
      simTime: sim(0) as SimTime,
      title: 'Continuation',
      goal: 'Prove the scheduler continues an accepted task',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await simulation.inject(started.value.events);
    const task = simulation.tasks
      .all()
      .find((candidate) => candidate.workflowInstanceId === started.value.instance.instanceId);
    expect(task).toBeDefined();
    if (task === undefined) return;
    const assignee = task.assignment.assigneeEmployeeId;
    expect(assignee).not.toBeNull();
    if (assignee === null) return;

    const assigned = (await allEvents(simulation)).find(
      (event) => event.type === 'Task.Assigned' && event.eventId !== '',
    );
    expect(assigned).toBeDefined();
    simulation.scheduler.enqueue({
      companyId: simulation.config.companyId,
      agentId: assignee,
      reason: 'EVENT',
      trigger: { kind: 'task', eventTypeId: 'Task.Assigned' },
      sourceEventId: assigned?.eventId ?? null,
      scheduledAtSim: sim(0) as SimTime,
    });

    await simulation.tick();
    expect(simulation.tasks.get(task.taskId)?.status).toBe('accepted');
    const continuation = simulation.scheduler.queue().find((wakeup) => wakeup.reason === 'TURN');
    expect(continuation, 'the accepted task must get a continuation wakeup').toBeDefined();

    await simulation.tick();
    expect(simulation.tasks.get(task.taskId)?.status).toBe('started');
    const secondContinuation = simulation.scheduler.queue().find((wakeup) => wakeup.reason === 'TURN');
    expect(secondContinuation, 'a started task must get a second continuation').toBeDefined();

    await simulation.tick();
    expect(simulation.tasks.get(task.taskId)?.status).toBe('completed');
    expect(simulation.instanceStore.get(started.value.instance.instanceId)?.status).toBe('completed');
    expect(engineerCalls).toBeGreaterThanOrEqual(3);
    const events = await allEvents(simulation);
    expect(events.some((event) => event.type === 'Task.Rejected')).toBe(false);
    expect(events.some((event) => event.type === 'Task.Failed')).toBe(false);
  });
});
