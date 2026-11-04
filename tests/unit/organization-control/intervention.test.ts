import { describe, expect, it } from 'vitest';
import type { EmployeeId, OrgEvent } from '@maoeh/shared-types';
import type { WorkflowDefinition } from '@maoeh/workflow-engine';
import { loadWorkflowDefinitions } from '@maoeh/workflow-engine';
import {
  CONTROL_AGENT_INSTRUCTED,
  CONTROL_AGENT_PAUSED,
  CONTROL_AGENT_RESUMED,
  CONTROL_AGENT_REVIEW_REQUESTED,
  CONTROL_AGENT_TASK_CANCELLED,
  CONTROL_TASK_CANCELLED,
  CONTROL_TASK_REASSIGNED,
  CONTROL_TASK_REVIEW_REQUESTED,
  CONTROL_WORKFLOW_APPROVAL_DECIDED,
  CONTROL_WORKFLOW_CANCELLED,
} from '@maoeh/organization-control';
import type { ControlHarness } from '../../helpers/control-fixtures';
import {
  approvalGateOpen,
  collectEvents,
  createControlHarness,
  humanDecidableWorkflowDefinitions,
} from '../../helpers/control-fixtures';
import { createNodeFsWorkflowReader } from '../../helpers/workflow-readers';
import { must } from '../../helpers/workflow-fixtures';

const CEO = 'ceo-alex';
const CTO = 'cto-john';
const ENGINEER = 'engineer-mike';
// product-analysis 的 intake/delivery 步声明 product_requirement 能力，由产品座席承担。
const PM = 'pm-bona';

function payloadOf(event: OrgEvent | undefined): Readonly<Record<string, unknown>> {
  const payload = event?.payload;
  return typeof payload === 'object' && payload !== null
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

function eventsOfType(events: readonly OrgEvent[], type: string): readonly OrgEvent[] {
  return events.filter((event) => event.type === type);
}

async function storedEvents(h: ControlHarness): Promise<readonly OrgEvent[]> {
  return collectEvents(h.simulation.eventStore);
}

/** Seed definitions whose approval gates are also decidable by the human `board-operator`. */
function humanDecidableSeedWorkflows(): readonly WorkflowDefinition[] {
  return humanDecidableWorkflowDefinitions(
    must(loadWorkflowDefinitions(createNodeFsWorkflowReader(), ''), 'seed workflows'),
  );
}

/** Inject a task through the documented control command and return its id. */
async function injectTask(
  h: ControlHarness,
  positionId: string,
  title: string,
): Promise<string> {
  const outcome = await h.plane.control.execute(
    h.command('Organization.InjectTask', {
      extra: { title, goal: `goal for ${title}`, positionId },
    } as never),
  );
  expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
  const task = h.plane.control.query.getTasks().find((summary) => summary.title === title);
  if (task === undefined) throw new Error(`injected task "${title}" is not visible`);
  return task.taskId;
}

/** Reassign a task to a position, which also resolves its assignee employee. */
async function reassignTo(
  h: ControlHarness,
  taskId: string,
  positionId: string,
): Promise<void> {
  const outcome = await h.plane.control.execute(
    h.command('Task.Reassign', { targetId: taskId, extra: { positionId } } as never),
  );
  expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
}

describe('M1.0 control plane: intervention — agent', () => {
  it('pauses a single agent without pausing the simulation', async () => {
    const h = await createControlHarness();
    const outcome = await h.plane.control.execute(
      h.command('Agent.Pause', { targetId: CEO }),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    expect(eventsOfType(await storedEvents(h), CONTROL_AGENT_PAUSED)).toHaveLength(1);
    expect(h.plane.control.query.getAgentRuntimeState(CEO as EmployeeId)?.paused).toBe(true);
    expect(h.plane.control.query.getSimulationState().pausedAgentIds).toContain(CEO);
    expect(h.plane.control.query.getControlState().pausedAgentIds).toContain(CEO);
    // Pausing one agent is not pausing the organization.
    expect(h.simulation.scheduler.paused).toBe(false);
    expect(h.simulation.scheduler.clock.currentTick).toBe(0);
  });

  it('never wakes a paused agent while other agents keep progressing', async () => {
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();

    const first = await h.harness.run(1);
    expect(first[0]?.turns.map((turn) => turn.employeeId)).toEqual([PM]);

    const pause = await h.plane.control.execute(h.command('Agent.Pause', { targetId: CEO }));
    expect(pause.status, JSON.stringify(pause.failure)).toBe('accepted');

    const after = await h.harness.run(2);
    const turned = after.flatMap((result) => result.turns.map((turn) => turn.employeeId));
    expect(turned).toContain(CTO);
    expect(turned).not.toContain(CEO);

    // The workflow advanced to the gate while the paused CEO produced nothing.
    const workflow = h.plane.control.query.getWorkflow(instanceId);
    expect(workflow?.stepStates.find((step) => step.stepId === 'design-approach')?.status).toBe(
      'done',
    );
    expect(h.plane.control.query.getAgentRuntimeState(CEO as EmployeeId)?.paused).toBe(true);
  });

  it('resumes the agent, which recovers the work that arrived while it was paused', async () => {
    const h = await createControlHarness();
    const firstInstance = await h.harness.startProductAnalysis();
    await h.harness.run(1);
    expect(
      (await h.plane.control.execute(h.command('Agent.Pause', { targetId: CEO }))).status,
    ).toBe('accepted');
    const pausedRuns = await h.harness.run(2);
    expect(pausedRuns.flatMap((result) => result.turns.map((turn) => turn.employeeId))).not.toContain(
      CEO,
    );
    // The workflow reached the CEO's approval gate while the CEO was paused.
    expect(approvalGateOpen(h.simulation, firstInstance)).toBe(true);

    const resume = await h.plane.control.execute(h.command('Agent.Resume', { targetId: CEO }));
    expect(resume.status, JSON.stringify(resume.failure)).toBe('accepted');
    expect(eventsOfType(await storedEvents(h), CONTROL_AGENT_RESUMED)).toHaveLength(1);
    expect(h.plane.control.query.getAgentRuntimeState(CEO as EmployeeId)?.paused).toBe(false);
    expect(h.plane.control.query.getSimulationState().pausedAgentIds).not.toContain(CEO);

    const secondInstance = await h.harness.startProductAnalysis();
    expect(secondInstance).not.toBe(firstInstance);
    const afterResume = await h.harness.run(1);
    // Resume is not just "eligible for future work": the approval that arrived while the CEO was
    // paused is re-offered (workflow priority first), together with the brand new intake task
    // (which now routes to the product seat, pm-bona, rather than the CEO).
    expect(afterResume[0]?.turns.map((turn) => turn.employeeId)).toEqual([CEO, PM]);
    expect(h.plane.control.query.getWorkflow(firstInstance)?.approval?.status).toBe('granted');
  });

  it('records an instruction in Control.AgentInstructed', async () => {
    const h = await createControlHarness();
    const outcome = await h.plane.control.execute(
      h.command('Agent.Instruct', {
        targetId: CEO,
        extra: { instruction: 'prefer the phased rollout' },
      } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const instructed = eventsOfType(await storedEvents(h), CONTROL_AGENT_INSTRUCTED);
    expect(instructed).toHaveLength(1);
    expect(payloadOf(instructed[0])).toMatchObject({
      commandId: outcome.commandId,
      agentId: CEO,
      instruction: 'prefer the phased rollout',
      operatorId: 'operator-dana',
    });
    expect(typeof payloadOf(instructed[0])['instructionId']).toBe('string');
    expect(h.plane.control.query.getControlState().issuedInstructionIds).toHaveLength(1);
  });

  it('refuses to instruct a paused agent as AGENT_PAUSED', async () => {
    const h = await createControlHarness();
    expect((await h.plane.control.execute(h.command('Agent.Pause', { targetId: CEO }))).status).toBe(
      'accepted',
    );
    const outcome = await h.plane.control.execute(
      h.command('Agent.Instruct', { targetId: CEO, extra: { instruction: 'wake up' } } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('rejected');
    expect(outcome.failure?.code).toBe('AGENT_PAUSED');
    expect(eventsOfType(await storedEvents(h), CONTROL_AGENT_INSTRUCTED)).toHaveLength(0);
  });

  it('refuses to address an unknown agent as INVALID_TARGET', async () => {
    const h = await createControlHarness();
    const outcome = await h.plane.control.execute(
      h.command('Agent.Instruct', {
        targetId: 'ghost-agent',
        extra: { instruction: 'do something' },
      } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('rejected');
    expect(outcome.failure?.code).toBe('INVALID_TARGET');
    expect(outcome.failure?.issues[0]?.field).toBe('target.targetId');
  });

  it('cancels the addressed agent task through the task system', async () => {
    const h = await createControlHarness();
    const taskId = await injectTask(h, 'ceo', 'cancel the ceo task');
    await reassignTo(h, taskId, 'ceo');
    expect(h.plane.control.query.getTask(taskId)?.assigneeEmployeeId).toBe(CEO);

    const outcome = await h.plane.control.execute(
      h.command('Agent.CancelTask', { targetId: CEO, extra: { taskId } } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    expect(h.plane.control.query.getTask(taskId)?.status).toBe('cancelled');
    const types = (await storedEvents(h)).map((event) => event.type);
    expect(types).toContain(CONTROL_AGENT_TASK_CANCELLED);
    // The domain event is reused, not reimplemented by the control plane.
    expect(types).toContain('Task.Cancelled');
  });

  it('refuses to cancel a task that belongs to a different agent', async () => {
    const h = await createControlHarness();
    const taskId = await injectTask(h, 'engineer', 'engineer owns this');
    await reassignTo(h, taskId, 'engineer');
    expect(h.plane.control.query.getTask(taskId)?.assigneeEmployeeId).toBe(ENGINEER);

    const outcome = await h.plane.control.execute(
      h.command('Agent.CancelTask', { targetId: CEO, extra: { taskId } } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('rejected');
    expect(outcome.failure?.code).toBe('INVALID_TARGET');
    expect(h.plane.control.query.getTask(taskId)?.status).not.toBe('cancelled');
  });

  it('records a review request with a reviewId', async () => {
    const h = await createControlHarness();
    const taskId = await injectTask(h, 'ceo', 'needs a review');
    const outcome = await h.plane.control.execute(
      h.command('Agent.RequestReview', { targetId: CEO, extra: { taskId } } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const requested = eventsOfType(await storedEvents(h), CONTROL_AGENT_REVIEW_REQUESTED);
    expect(requested).toHaveLength(1);
    expect(payloadOf(requested[0])).toMatchObject({
      commandId: outcome.commandId,
      agentId: CEO,
      taskId,
    });
    expect(typeof payloadOf(requested[0])['reviewId']).toBe('string');
    // RequestReview records the request without moving the task out of its current status
    // (the task is `assigned` because InjectTask dispatches it to the target position).
    expect(h.plane.control.query.getTask(taskId)?.status).toBe('assigned');
  });

  it('rejects agent task commands that name an unknown task as NOT_FOUND', async () => {
    const h = await createControlHarness();
    const cancel = await h.plane.control.execute(
      h.command('Agent.CancelTask', { targetId: CEO, extra: { taskId: 'task-unknown' } } as never),
    );
    expect(cancel.status, JSON.stringify(cancel.failure)).toBe('rejected');
    expect(cancel.failure?.code).toBe('NOT_FOUND');

    const review = await h.plane.control.execute(
      h.command('Agent.RequestReview', {
        targetId: CEO,
        extra: { taskId: 'task-unknown' },
      } as never),
    );
    expect(review.status, JSON.stringify(review.failure)).toBe('rejected');
    expect(review.failure?.code).toBe('NOT_FOUND');
  });
});

describe('M1.0 control plane: intervention — workflow', () => {
  it('pauses a workflow manually (blocked/manual) and resumes it', async () => {
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();

    const pause = await h.plane.control.execute(
      h.command('Workflow.Pause', { targetId: instanceId }),
    );
    expect(pause.status, JSON.stringify(pause.failure)).toBe('accepted');
    const paused = h.plane.control.query.getWorkflow(instanceId);
    expect(paused?.status).toBe('blocked');
    expect(paused?.blockedReason?.kind).toBe('manual');
    // A manual pause reuses WorkflowEngine.wait; it is not a cancellation.
    const types = (await storedEvents(h)).map((event) => event.type);
    expect(types).toContain('Workflow.InstanceBlocked');
    expect(types).not.toContain(CONTROL_WORKFLOW_CANCELLED);

    const again = await h.plane.control.execute(
      h.command('Workflow.Pause', { targetId: instanceId }),
    );
    expect(again.status, JSON.stringify(again.failure)).toBe('rejected');
    expect(again.failure?.code).toBe('WORKFLOW_BLOCKED');

    const resume = await h.plane.control.execute(
      h.command('Workflow.Resume', { targetId: instanceId }),
    );
    expect(resume.status, JSON.stringify(resume.failure)).toBe('accepted');
    expect(h.plane.control.query.getWorkflow(instanceId)?.status).toBe('running');
  });

  it('refuses Approve/Reject when no approval is open as INVALID_STATE', async () => {
    const h = await createControlHarness({ workflowDefinitions: humanDecidableSeedWorkflows() });
    const instanceId = await h.harness.startProductAnalysis();
    expect(approvalGateOpen(h.simulation, instanceId)).toBe(false);

    for (const commandType of ['Workflow.Approve', 'Workflow.Reject'] as const) {
      const outcome = await h.plane.control.execute(h.command(commandType, { targetId: instanceId }));
      expect(outcome.status, `${commandType} ${JSON.stringify(outcome.failure)}`).toBe('rejected');
      expect(outcome.failure?.code, commandType).toBe('INVALID_STATE');
    }
  });

  it('lets the human operator grant an open approval and advance the workflow', async () => {
    const h = await createControlHarness({ workflowDefinitions: humanDecidableSeedWorkflows() });
    const instanceId = await h.harness.startProductAnalysis();
    await h.harness.run(2);
    expect(approvalGateOpen(h.simulation, instanceId)).toBe(true);
    const gate = h.plane.control.query.getWorkflow(instanceId);
    expect(gate?.status).toBe('blocked');
    expect(gate?.blockedReason?.kind).toBe('approval');

    const approve = await h.plane.control.execute(
      h.command('Workflow.Approve', { targetId: instanceId }),
    );
    expect(approve.status, JSON.stringify(approve.failure)).toBe('accepted');

    const decided = eventsOfType(await storedEvents(h), CONTROL_WORKFLOW_APPROVAL_DECIDED);
    expect(decided).toHaveLength(1);
    expect(payloadOf(decided[0])).toMatchObject({
      commandId: approve.commandId,
      instanceId,
      stepId: 'design-gate',
      decision: 'granted',
    });

    const after = h.plane.control.query.getWorkflow(instanceId);
    expect(after?.approval?.status).toBe('granted');
    expect(after?.approval?.grantedBy).toContain('operator-dana');
    expect(after?.status).toBe('running');
    expect(after?.stepStates.find((step) => step.stepId === 'delivery-synthesize')?.status).toBe(
      'active',
    );

    // The operator's own vote is already recorded. A second approval is refused before the
    // workflow engine's `approval_already_decided` guard can fire, because the control plane
    // requires an OPEN approval; the exact observed code is INVALID_STATE.
    const again = await h.plane.control.execute(
      h.command('Workflow.Approve', { targetId: instanceId }),
    );
    expect(again.status, JSON.stringify(again.failure)).toBe('rejected');
    expect(again.failure?.code).toBe('INVALID_STATE');
  });

  it('lets the human operator deny an open approval, aborting the workflow', async () => {
    const h = await createControlHarness({ workflowDefinitions: humanDecidableSeedWorkflows() });
    const instanceId = await h.harness.startProductAnalysis();
    await h.harness.run(2);
    expect(approvalGateOpen(h.simulation, instanceId)).toBe(true);

    const reject = await h.plane.control.execute(
      h.command('Workflow.Reject', { targetId: instanceId }),
    );
    expect(reject.status, JSON.stringify(reject.failure)).toBe('accepted');

    const events = await storedEvents(h);
    expect(payloadOf(eventsOfType(events, CONTROL_WORKFLOW_APPROVAL_DECIDED)[0])).toMatchObject({
      instanceId,
      decision: 'denied',
    });
    expect(events.map((event) => event.type)).toContain('Workflow.InstanceAborted');
    expect(h.plane.control.query.getWorkflow(instanceId)?.status).toBe('aborted');
  });

  it('cancels a workflow instance and records Control.WorkflowCancelled', async () => {
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();

    const outcome = await h.plane.control.execute(
      h.command('Workflow.Cancel', { targetId: instanceId }),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    expect(h.plane.control.query.getWorkflow(instanceId)?.status).toBe('aborted');
    const types = (await storedEvents(h)).map((event) => event.type);
    expect(types).toContain(CONTROL_WORKFLOW_CANCELLED);
    expect(types).toContain('Workflow.InstanceAborted');
  });

  it('rejects every workflow command for an unknown instance as NOT_FOUND', async () => {
    const h = await createControlHarness();
    for (const commandType of [
      'Workflow.Pause',
      'Workflow.Resume',
      'Workflow.Cancel',
      'Workflow.Approve',
      'Workflow.Reject',
    ] as const) {
      const outcome = await h.plane.control.execute(
        h.command(commandType, { targetId: 'instance-unknown' }),
      );
      expect(outcome.status, `${commandType} ${JSON.stringify(outcome.failure)}`).toBe('rejected');
      expect(outcome.failure?.code, commandType).toBe('NOT_FOUND');
    }
  });
});

describe('M1.0 control plane: intervention — task', () => {
  it('cancels a task and reuses the Task.Cancelled domain event', async () => {
    const h = await createControlHarness();
    const taskId = await injectTask(h, 'ceo', 'cancel me');

    const outcome = await h.plane.control.execute(h.command('Task.Cancel', { targetId: taskId }));
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    expect(h.plane.control.query.getTask(taskId)?.status).toBe('cancelled');

    const events = await storedEvents(h);
    const types = events.map((event) => event.type);
    expect(types).toContain(CONTROL_TASK_CANCELLED);
    expect(types).toContain('Task.Cancelled');
    const domainCancellation = eventsOfType(events, 'Task.Cancelled')[0];
    expect(payloadOf(domainCancellation)).toMatchObject({ taskId });
  });

  it('reassigns a task to the engineer position and resolves the assignee', async () => {
    const h = await createControlHarness();
    const taskId = await injectTask(h, 'ceo', 'reassign me');

    const outcome = await h.plane.control.execute(
      h.command('Task.Reassign', { targetId: taskId, extra: { positionId: 'engineer' } } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const task = h.plane.control.query.getTask(taskId);
    expect(task?.positionId).toBe('engineer');
    expect(task?.assigneeEmployeeId).toBe(ENGINEER);
    const reassigned = eventsOfType(await storedEvents(h), CONTROL_TASK_REASSIGNED);
    expect(reassigned).toHaveLength(1);
    expect(payloadOf(reassigned[0])).toMatchObject({
      commandId: outcome.commandId,
      taskId,
      positionId: 'engineer',
    });
  });

  it('requests a task review with a reviewId', async () => {
    const h = await createControlHarness();
    const taskId = await injectTask(h, 'ceo', 'review me');

    const outcome = await h.plane.control.execute(
      h.command('Task.RequestReview', { targetId: taskId }),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    const requested = eventsOfType(await storedEvents(h), CONTROL_TASK_REVIEW_REQUESTED);
    expect(requested).toHaveLength(1);
    expect(payloadOf(requested[0])).toMatchObject({ commandId: outcome.commandId, taskId });
    expect(typeof payloadOf(requested[0])['reviewId']).toBe('string');
  });

  it('rejects every task command for an unknown task as NOT_FOUND', async () => {
    const h = await createControlHarness();

    const cancel = await h.plane.control.execute(
      h.command('Task.Cancel', { targetId: 'task-unknown' }),
    );
    expect(cancel.status, JSON.stringify(cancel.failure)).toBe('rejected');
    expect(cancel.failure?.code).toBe('NOT_FOUND');

    const reassign = await h.plane.control.execute(
      h.command('Task.Reassign', {
        targetId: 'task-unknown',
        extra: { positionId: 'engineer' },
      } as never),
    );
    expect(reassign.status, JSON.stringify(reassign.failure)).toBe('rejected');
    expect(reassign.failure?.code).toBe('NOT_FOUND');

    const review = await h.plane.control.execute(
      h.command('Task.RequestReview', { targetId: 'task-unknown' }),
    );
    expect(review.status, JSON.stringify(review.failure)).toBe('rejected');
    expect(review.failure?.code).toBe('NOT_FOUND');
  });
});
