import { describe, expect, it } from 'vitest';
import type { Seq } from '@maoeh/event-store';
import type { Simulation } from '@maoeh/kernel';
import type { EmployeeId, OrgEvent } from '@maoeh/shared-types';

import { createControlHarness, type ControlHarness } from '../../helpers/control-fixtures';

const ACTIVITY_ROLES: readonly string[] = [
  'input',
  'runtime',
  'decision',
  'plan',
  'action',
  'task',
  'workflow',
  'communication',
];

async function storedEvents(simulation: Simulation): Promise<readonly OrgEvent[]> {
  const collected: OrgEvent[] = [];
  for await (const event of simulation.eventStore.replay(1 as Seq)) collected.push(event);
  return collected;
}

function injectTaskCommand(h: ControlHarness) {
  return h.command('Organization.InjectTask', {
    targetType: 'organization',
    targetId: 'future-ai-lab',
    extra: {
      positionId: 'ceo',
      title: 'Research a new market',
      goal: 'Explain the opportunity',
    },
  });
}

describe('M1.0 control plane: observation queries', () => {
  it('reports the simulation state before and after an operator pause', async () => {
    const h = await createControlHarness();

    const before = h.plane.control.query.getSimulationState();
    expect(before.status).toBe('running');
    expect(before.paused).toBe(false);
    expect(before.tick).toBe(0);
    expect(before.simTime).toBe(0);
    expect(before.tickDuration).toBe(1);
    expect(before.budgets.maxAgentTurns).toBeGreaterThan(0);
    expect(before.budgets.maxEvents).toBeGreaterThan(0);
    expect(before.budgets.maxTasks).toBeGreaterThan(0);
    expect(before.budgets.maxWorkflowTransitions).toBeGreaterThan(0);
    expect(before.budgets.maxLlmCalls).toBeGreaterThan(0);
    expect(before.pausedAgentIds).toEqual([]);

    const start = await h.plane.control.execute(h.command('Simulation.Start'));
    expect(start.status, JSON.stringify(start.failure)).toBe('accepted');

    const running = h.plane.control.query.getSimulationState();
    expect(running.status).toBe('running');
    expect(running.paused).toBe(false);
    expect(running.tick).toBe(1);
    expect(running.simTime).toBe(1);

    const pause = await h.plane.control.execute(h.command('Simulation.Pause'));
    expect(pause.status, JSON.stringify(pause.failure)).toBe('accepted');

    const paused = h.plane.control.query.getSimulationState();
    expect(paused.status).toBe('paused');
    expect(paused.paused).toBe(true);
    expect(paused.tick).toBe(1);
    expect(paused.simTime).toBe(1);

    const agentPause = await h.plane.control.execute(
      h.command('Agent.Pause', { targetId: 'ceo-alex' }),
    );
    expect(agentPause.status, JSON.stringify(agentPause.failure)).toBe('accepted');

    const withPausedAgent = h.plane.control.query.getSimulationState();
    expect(withPausedAgent.pausedAgentIds).toEqual(['ceo-alex']);
    // Pausing an agent never pauses the simulation itself.
    expect(withPausedAgent.paused).toBe(true);
    expect(h.simulation.scheduler.paused).toBe(true);
  });

  it('exposes departments, employees and agents, and null for unknown agents', async () => {
    const h = await createControlHarness();

    const departments = h.plane.control.query.getDepartments();
    expect(departments.map((department) => department.departmentId).sort()).toEqual([
      'business',
      'engineering',
      'marketing',
      'product',
      'research',
    ]);
    for (const department of departments) {
      expect(typeof department.name).toBe('string');
      expect(department.positionCount).toBeGreaterThanOrEqual(0);
      expect(department.employeeCount).toBeGreaterThanOrEqual(0);
      expect(department).toHaveProperty('parentDepartmentId');
      expect(department).toHaveProperty('headPositionId');
    }

    const employees = h.plane.control.query.getEmployees();
    expect(employees).toHaveLength(8);
    const dana = employees.find((employee) => employee.employeeId === 'operator-dana');
    expect(dana).toBeDefined();
    expect(dana?.kind).toBe('human');
    expect(dana?.positionId).toBe('board-operator');
    expect(dana?.positionTitle).toBe('Board Operator');
    expect(dana?.departmentId).toBe('product');

    const agents = h.plane.control.query.getAgents();
    expect(agents).toHaveLength(8);
    const alex = h.plane.control.query.getAgent('ceo-alex' as EmployeeId);
    expect(alex).not.toBeNull();
    expect(alex?.name).toBe('Alex');
    expect(alex?.positionId).toBe('ceo');
    expect(alex?.paused).toBe(false);
    expect(alex?.runtime).not.toBeNull();
    expect(alex?.currentTaskId).toBeNull();
    // 种子员工显式声明 `kind: agent`（控制台的“类型”字段据此显示 AI 员工）。
    expect(alex?.kind).toBe('agent');

    expect(h.plane.control.query.getAgent('no-such-employee' as EmployeeId)).toBeNull();
  });

  it('reports the agent runtime state and the operator pause overlay', async () => {
    const h = await createControlHarness();

    const before = h.plane.control.query.getAgentRuntimeState('ceo-alex' as EmployeeId);
    expect(before).not.toBeNull();
    expect(typeof before?.version).toBe('number');
    expect(typeof before?.presence).toBe('string');
    expect(typeof before?.employment).toBe('string');
    expect(before?.employeeId).toBe('ceo-alex');
    expect(before?.paused).toBe(false);
    // A human operator has no agent runtime bundle.
    expect(h.plane.control.query.getAgentRuntimeState('operator-dana' as EmployeeId)).toBeNull();

    const pause = await h.plane.control.execute(
      h.command('Agent.Pause', { targetId: 'ceo-alex' }),
    );
    expect(pause.status, JSON.stringify(pause.failure)).toBe('accepted');

    expect(h.plane.control.query.getAgentRuntimeState('ceo-alex' as EmployeeId)?.paused).toBe(true);
    expect(h.plane.control.query.getAgent('ceo-alex' as EmployeeId)?.paused).toBe(true);
    expect(h.plane.control.query.getControlState().pausedAgentIds).toEqual(['ceo-alex']);
    // An agent pause is an overlay: it does not pause the simulation.
    expect(h.simulation.scheduler.paused).toBe(false);
    const simulationState = h.plane.control.query.getSimulationState();
    expect(simulationState.status).toBe('running');
    expect(simulationState.paused).toBe(false);
    expect(simulationState.pausedAgentIds).toEqual(['ceo-alex']);
  });

  it('classifies agent activity and tolerates an agent with no activity', async () => {
    const h = await createControlHarness();

    const idle = await h.plane.control.query.getAgentActivity('engineer-mike' as EmployeeId);
    expect(idle.agentId).toBe('engineer-mike');
    expect(idle.entries).toEqual([]);
    expect(idle.cycles).toEqual([]);

    await h.harness.startProductAnalysis();
    await h.harness.run(1);

    // product-analysis 的 intake 步声明 product_requirement 能力，由产品座席 pm-bona 承担。
    const activity = await h.plane.control.query.getAgentActivity('pm-bona' as EmployeeId);
    expect(activity.agentId).toBe('pm-bona');
    expect(activity.entries.length).toBeGreaterThan(0);
    for (const entry of activity.entries) {
      expect(typeof entry.event.type).toBe('string');
      expect(ACTIVITY_ROLES).toContain(entry.role);
    }
    expect(activity.entries.map((entry) => entry.role)).toContain('runtime');
    expect(activity.cycles.length).toBeGreaterThan(0);
    expect(activity.cycles[0]?.cycleId).toMatch(/^cycle-/);

    const limited = await h.plane.control.query.getAgentActivity('pm-bona' as EmployeeId, 1);
    expect(limited.entries).toHaveLength(1);
    expect(limited.entries[0]?.event.seq).toBe(activity.entries.at(-1)?.event.seq);

    const bonaActivity = await h.plane.control.query.getAgentActivity('pm-bona' as EmployeeId);
    expect(bonaActivity.entries.every((entry) => entry.event.subjectId === 'pm-bona')).toBe(true);
  });

  it('exposes injected tasks and returns null for unknown tasks', async () => {
    const h = await createControlHarness();

    expect(h.plane.control.query.getTasks()).toEqual([]);
    expect(h.plane.control.query.getTask('task-unknown')).toBeNull();

    const outcome = await h.plane.control.execute(injectTaskCommand(h));
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const tasks = h.plane.control.query.getTasks();
    expect(tasks).toHaveLength(1);
    const summary = tasks[0];
    expect(summary?.title).toBe('Research a new market');
    // InjectTask dispatches to the target position, so the task is staffed immediately
    // (`ceo` is held by `ceo-alex`) instead of waiting for a manual reassignment.
    expect(summary?.status).toBe('assigned');
    expect(summary?.positionId).toBe('ceo');
    expect(summary?.assigneeEmployeeId).toBe('ceo-alex');

    const taskId = summary?.taskId ?? '';
    expect(taskId).not.toBe('');
    const task = h.plane.control.query.getTask(taskId);
    expect(task).not.toBeNull();
    expect(task?.goal).toBe('Explain the opportunity');
    expect(task?.outputs).toEqual([]);
    expect(task?.reviews).toEqual([]);
    expect(task?.verification).toBeNull();

    expect(h.plane.control.query.getTask('task-unknown')).toBeNull();
  });

  it('exposes workflow instances and returns null for unknown instances', async () => {
    const h = await createControlHarness();

    expect(h.plane.control.query.getWorkflows()).toEqual([]);
    expect(h.plane.control.query.getWorkflow('instance-unknown')).toBeNull();

    const instanceId = await h.harness.startProductAnalysis();

    const workflows = h.plane.control.query.getWorkflows();
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.instanceId).toBe(instanceId);
    expect(workflows[0]?.workflowId).toBe('product-analysis');
    expect(workflows[0]?.status).toBe('running');
    expect(workflows[0]?.title).toBe('Analyze the market');
    expect(workflows[0]?.activeStepIds.length).toBeGreaterThan(0);

    const view = h.plane.control.query.getWorkflow(instanceId);
    expect(view).not.toBeNull();
    expect(view?.goal).toBe('Explain the competitive landscape');
    expect(view?.initiatedBy).toBe('ceo-alex');
    expect(view?.correlationId.length).toBeGreaterThan(0);
    expect(view?.stepStates.length).toBeGreaterThan(0);
    expect(view?.approval).toBeNull();

    expect(h.plane.control.query.getWorkflow('instance-unknown')).toBeNull();
  });

  it('projects the definition transitions and derives paused from the real block', async () => {
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();

    const view = h.plane.control.query.getWorkflow(instanceId);
    expect(view).not.toBeNull();
    const transitions = view?.transitions ?? [];
    expect(transitions.map((transition) => transition.transitionId)).toContain('intake-brief__completed');
    expect(transitions.map((transition) => transition.transitionId)).toContain('design-gate__denied');
    const rejected = transitions.find((transition) => transition.transitionId === 'intake-brief__rejected');
    expect(rejected?.when).toEqual({ kind: 'task_status', status: 'rejected' });
    expect(rejected?.to).toEqual({ kind: 'fail', reason: 'intake_failed' });
    const completed = transitions.find((transition) => transition.transitionId === 'intake-brief__completed');
    expect(completed?.to).toEqual({ kind: 'stage', stageId: 'design' });

    expect(view?.paused).toBe(false);
    const pause = await h.plane.control.execute(h.command('Workflow.Pause', { targetId: instanceId }));
    expect(pause.status, JSON.stringify(pause.failure)).toBe('accepted');
    const paused = h.plane.control.query.getWorkflow(instanceId);
    expect(paused?.status).toBe('blocked');
    expect(paused?.blockedReason?.kind).toBe('manual');
    expect(paused?.paused).toBe(true);
    expect(h.plane.control.query.getControlState().pausedWorkflowIds).toContain(instanceId);

    const resume = await h.plane.control.execute(h.command('Workflow.Resume', { targetId: instanceId }));
    expect(resume.status, JSON.stringify(resume.failure)).toBe('accepted');
    expect(h.plane.control.query.getWorkflow(instanceId)?.paused).toBe(false);
    expect(h.plane.control.query.getControlState().pausedWorkflowIds).not.toContain(instanceId);
  });

  it('streams recent events newest-first and paginates the stream by exclusive seq cursor', async () => {
    const h = await createControlHarness();

    const inject = injectTaskCommand(h);
    const agentPause = h.command('Agent.Pause', { targetId: 'engineer-mike' });
    const instruct = h.command('Agent.Instruct', {
      targetId: 'cto-john',
      extra: { instruction: 'Draft the migration plan' },
    });

    for (const command of [inject, agentPause, instruct]) {
      const outcome = await h.plane.control.execute(command);
      expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    }

    const stream = await h.plane.control.query.getEventStream({});
    expect(stream.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stream.map((event) => event.type)).toEqual([
      // Company formation: a fresh simulation boots with its company channel (M1.0.1 K1).
      'Communication.ChannelOpened',
      'Task.Created',
      'Task.Assigned',
      'Control.TaskInjected',
      'Control.AgentPaused',
      'Control.AgentInstructed',
    ]);

    const recent = await h.plane.control.query.getRecentEvents({});
    expect(recent.map((event) => event.seq)).toEqual([6, 5, 4, 3, 2, 1]);

    const recentTwo = await h.plane.control.query.getRecentEvents({ limit: 2 });
    expect(recentTwo.map((event) => event.seq)).toEqual([6, 5]);

    const page = await h.plane.control.query.getEventStream({ cursor: 2 });
    expect(page.map((event) => event.seq)).toEqual([3, 4, 5, 6]);
    expect((await h.plane.control.query.getEventStream({ cursor: 5 })).map((event) => event.seq))
      .toEqual([6]);
    expect(await h.plane.control.query.getEventStream({ cursor: 6 })).toEqual([]);
    expect((await h.plane.control.query.getEventStream({ cursor: 1 })).map((event) => event.seq))
      .toEqual([2, 3, 4, 5, 6]);

    const controlOnly = await h.plane.control.query.getEventStream({
      eventTypePrefix: 'Control.',
    });
    expect(controlOnly.map((event) => event.type)).toEqual([
      'Control.TaskInjected',
      'Control.AgentPaused',
      'Control.AgentInstructed',
    ]);

    const createdOnly = await h.plane.control.query.getEventStream({
      eventTypes: ['Task.Created'],
    });
    expect(createdOnly.map((event) => event.type)).toEqual(['Task.Created']);
    expect(createdOnly[0]?.eventId).toBe(
      stream.find((event) => event.type === 'Task.Created')?.eventId,
    );

    const bySubject = await h.plane.control.query.getEventStream({ subjectId: 'engineer-mike' });
    expect(bySubject.map((event) => event.type)).toEqual(['Control.AgentPaused']);
    expect(bySubject.map((event) => event.subjectId)).toEqual(['engineer-mike']);
  });

  it('projects the control state', async () => {
    const h = await createControlHarness();

    const pause = h.command('Simulation.Pause');
    const agentPause = h.command('Agent.Pause', { targetId: 'ceo-alex' });
    for (const command of [pause, agentPause]) {
      const outcome = await h.plane.control.execute(command);
      expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    }

    const state = h.plane.control.query.getControlState();
    expect(state.simulationPaused).toBe(true);
    expect(state.pausedAgentIds).toEqual(['ceo-alex']);
    expect(state.tick).toBe(0);
    expect(state.simTime).toBe(0);
    expect(state.processedCommandIds).toContain(pause.commandId);
    expect(state.processedCommandIds).toContain(agentPause.commandId);
    // `processedCommandIds` is derived from `audit.recent()`, which is newest-first.
    expect(state.processedCommandIds[0]).toBe(agentPause.commandId);
  });

  it('keeps every query read-only: no new events and no clock movement', async () => {
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();
    const injected = await h.plane.control.execute(injectTaskCommand(h));
    expect(injected.status, JSON.stringify(injected.failure)).toBe('accepted');
    const agentPause = await h.plane.control.execute(
      h.command('Agent.Pause', { targetId: 'engineer-mike' }),
    );
    expect(agentPause.status, JSON.stringify(agentPause.failure)).toBe('accepted');

    const eventsBefore = await storedEvents(h.simulation);
    const tickBefore = h.simulation.scheduler.clock.currentTick;
    const simTimeBefore = Number(h.simulation.scheduler.clock.simTime);
    const pausedBefore = h.simulation.scheduler.paused;

    await h.plane.control.query.getOrganizationSnapshot();
    h.plane.control.query.getSimulationState();
    h.plane.control.query.getDepartments();
    h.plane.control.query.getEmployees();
    h.plane.control.query.getAgents();
    h.plane.control.query.getAgent('ceo-alex' as EmployeeId);
    h.plane.control.query.getAgentRuntimeState('ceo-alex' as EmployeeId);
    await h.plane.control.query.getAgentActivity('ceo-alex' as EmployeeId);
    h.plane.control.query.getWorkflows();
    h.plane.control.query.getWorkflow(instanceId);
    h.plane.control.query.getWorkflow('instance-unknown');
    h.plane.control.query.getTasks();
    h.plane.control.query.getTask('task-unknown');
    await h.plane.control.query.getRecentEvents({ limit: 10 });
    await h.plane.control.query.getEventStream({});
    h.plane.control.query.getAuditTrail('future-ai-lab');
    h.plane.control.query.getRecentAudits();
    h.plane.control.query.getControlState();

    const eventsAfter = await storedEvents(h.simulation);
    expect(eventsAfter.map((event) => event.eventId)).toEqual(
      eventsBefore.map((event) => event.eventId),
    );
    expect(eventsAfter).toHaveLength(eventsBefore.length);
    expect(h.simulation.scheduler.clock.currentTick).toBe(tickBefore);
    expect(Number(h.simulation.scheduler.clock.simTime)).toBe(simTimeBefore);
    expect(h.simulation.scheduler.paused).toBe(pausedBefore);
  });

  it('builds an organization snapshot with every section', async () => {
    const h = await createControlHarness();
    await h.harness.startProductAnalysis();
    const injected = await h.plane.control.execute(injectTaskCommand(h));
    expect(injected.status, JSON.stringify(injected.failure)).toBe('accepted');

    const snapshot = await h.plane.control.query.getOrganizationSnapshot();

    expect(snapshot.company.id).toBe('future-ai-lab');
    expect(snapshot.company.name).toBe('Future AI Lab');
    expect(snapshot.simulation.status).toBe('running');
    expect(snapshot.simulation.tick).toBe(0);
    expect(snapshot.departments).toHaveLength(5);
    expect(snapshot.employees).toHaveLength(8);
    expect(snapshot.agents).toHaveLength(8);
    expect(snapshot.workflows).toHaveLength(1);
    expect(snapshot.workflows[0]?.workflowId).toBe('product-analysis');
    // The workflow itself created one step task; the operator injected a second one.
    expect(snapshot.tasks.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.tasks.map((task) => task.title)).toContain('Research a new market');
    expect(snapshot.recentEvents.length).toBeGreaterThan(0);
    expect(snapshot.recentAudits.length).toBeGreaterThan(0);
    expect(snapshot.recentAudits[0]?.verdict).toBe('accepted');

    const seqs = snapshot.recentEvents.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => right - left));
  });
});
