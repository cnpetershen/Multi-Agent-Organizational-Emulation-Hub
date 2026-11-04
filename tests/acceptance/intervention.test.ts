import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import {
  createAcceptanceHarness,
  createObserver,
  renderTickTrace,
  type AcceptanceHarness,
  type TickTrace,
} from './runtime-harness';
import { approvalGateOpen, collectEvents } from '../helpers/control-fixtures';

function log(...parts: readonly unknown[]): void {
  console.log(...parts);
}

async function step(harness: AcceptanceHarness, traces: TickTrace[]): Promise<TickTrace> {
  const observer = createObserver(harness);
  observer.beforeTick();
  const result = await harness.control.simulation.tick();
  const trace = await observer.observe(result);
  traces.push(trace);
  return trace;
}

describe('M1.0 runtime acceptance: human intervention', () => {  it('Scenario A/B — pause and resume the simulation without restarting it', async () => {
    const harness = await createAcceptanceHarness();
    const traces: TickTrace[] = [];
    await harness.execute('Agent.Instruct', {
      targetType: 'agent',
      targetId: 'ceo-alex',
      instruction: 'Own the churn problem.',
      reason: 'board directive',
    });
    await step(harness, traces);
    await step(harness, traces);

    const tickBeforePause = harness.control.simulation.scheduler.clock.currentTick;
    const pause = await harness.execute('Simulation.Pause', {
      targetType: 'simulation',
      targetId: 'future-ai-lab',
      reason: 'board recess',
    });
    log('A: pause outcome', pause.status, pause.failure, pause.events);

    const pausedTick = await harness.control.simulation.scheduler.paused;
    const pausedTickResult = await harness.control.simulation.tick();
    const duringPause = harness.control.simulation.scheduler.clock.currentTick;
    log(
      'A: pausedFlag',
      pausedTick,
      'tickResult',
      pausedTickResult.status,
      'events',
      pausedTickResult.emittedEvents.length,
      'tickBefore/after',
      tickBeforePause,
      duringPause,
    );
    expect(pausedTick).toBe(true);
    expect(pausedTickResult.status).toBe('paused');
    expect(pausedTickResult.emittedEvents).toEqual([]);
    expect(duringPause).toBe(tickBeforePause);

    const resume = await harness.execute('Simulation.Resume', {
      targetType: 'simulation',
      targetId: 'future-ai-lab',
      reason: 'board reconvenes',
    });
    log('B: resume outcome', resume.status, resume.failure, resume.events);
    const resumed = await step(harness, traces);
    log('B: resumedTick', resumed.tickNumber, resumed.status, resumed.turns.length);
    expect(resumed.tickNumber).toBe(tickBeforePause + 1);

    const events = await collectEvents(harness.control.simulation.eventStore);
    const controlTypes = events.filter((e) => e.type.startsWith('Control.')).map((e) => e.type);
    log('A/B: control events', controlTypes);
    expect(controlTypes).toContain('Control.SimulationPaused');
    expect(controlTypes).toContain('Control.SimulationResumed');
  });

  it('Scenario C/D — pause an agent, then resume it', async () => {
    const harness = await createAcceptanceHarness();
    const traces: TickTrace[] = [];

    // CEO turns a board directive into a workflow.
    await harness.execute('Agent.Instruct', {
      targetType: 'agent',
      targetId: 'ceo-alex',
      instruction: 'Own the churn problem.',
      reason: 'board directive',
    });
    await step(harness, traces); // CEO turns the directive into a workflow; intake goes to the product seat
    await step(harness, traces); // intake finishes -> design-approach assigned to CTO

    const instanceId = harness.control.simulation.instanceStore.all()[0]?.instanceId ?? '';
    log('C: workflow after 2 ticks', instanceId, harness.control.simulation.instanceStore.get(instanceId)?.status);
    const ctoTaskId = harness.control.simulation.instanceStore.get(instanceId)?.stepStates['design-approach']?.taskId;
    log('C: cto task', ctoTaskId, harness.control.simulation.taskStore.get(String(ctoTaskId))?.status);

    const pauseCto = await harness.execute('Agent.Pause', {
      targetType: 'agent',
      targetId: 'cto-john',
      reason: 'CTO is on leave',
    });
    log('C: pause CTO', pauseCto.status, pauseCto.failure);

    const before = traces.length;
    const ctoTurnsWhilePaused: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const trace = await step(harness, traces);
      ctoTurnsWhilePaused.push(
        ...trace.turns.filter((turn) => turn.employeeId === 'cto-john').map((turn) => turn.employeeId),
      );
    }
    log(traces.slice(before).map(renderTickTrace).join('\n'));
    expect(ctoTurnsWhilePaused).toEqual([]);

    // The CEO is unaffected: a second directive still gets worked while the CTO is paused.
    const ceoTurns = traces.slice(before).flatMap((trace) => trace.turns).filter((turn) => turn.employeeId === 'ceo-alex');
    log('C: CEO turns while CTO paused', ceoTurns.length);

    const resumeCto = await harness.execute('Agent.Resume', {
      targetType: 'agent',
      targetId: 'cto-john',
      reason: 'CTO is back',
    });
    log('D: resume CTO', resumeCto.status, resumeCto.failure);

    const afterResume = traces.length;
    for (let index = 0; index < 4; index += 1) {
      await step(harness, traces);
    }
    const resumedTraces = traces.slice(afterResume);
    log(resumedTraces.map(renderTickTrace).join('\n'));

    const ctoTurnsAfterResume = resumedTraces.flatMap((trace) => trace.turns).filter((turn) => turn.employeeId === 'cto-john');
    log('D: CTO turns after resume', ctoTurnsAfterResume.length);
    log(
      'D: workflow after resume',
      harness.control.simulation.instanceStore.get(instanceId)?.status,
      harness.control.simulation.instanceStore.get(instanceId)?.activeStepIds,
    );
    expect(ctoTurnsAfterResume.length).toBeGreaterThan(0);
  });

  it('Scenario F — an injected task really enters the organization and really finishes', async () => {
    const harness = await createAcceptanceHarness();
    const inspect = await harness.execute('Organization.InjectTask', {
      targetType: 'organization',
      targetId: 'future-ai-lab',
      positionId: 'cto',
      title: 'Audit the deploy pipeline',
      goal: 'Find the slowest stage of the deploy pipeline',
      reason: 'board requested a review',
    } as never);
    log('F: inject outcome', inspect.status, inspect.failure, inspect.events);

    const events = await collectEvents(harness.control.simulation.eventStore);
    const injected = events.filter((e) => e.type === 'Control.TaskInjected');
    log('F: injected events', injected.map((e) => e.type));
    const taskId = String((injected[0]?.payload as { readonly taskId?: string } | undefined)?.taskId ?? '');
    const task = harness.control.simulation.taskStore.get(taskId);
    log(
      'F: task',
      taskId,
      'status=',
      task?.status,
      'assignee=',
      String(task?.assignment.assigneeEmployeeId),
      'position=',
      String(task?.assignment.positionId),
      'workflow=',
      String(task?.workflowInstanceId),
    );

    const traces: TickTrace[] = [];
    for (let index = 0; index < 5; index += 1) await step(harness, traces);
    log(traces.map(renderTickTrace).join('\n'));
    const turns = traces.flatMap((trace) => trace.turns);
    log('F: turns over 5 ticks', turns.map((turn) => `${turn.employeeId}:${turn.status}`));
    const after = harness.control.simulation.taskStore.get(taskId);
    log('F: task after 5 ticks', after?.status, String(after?.assignment.assigneeEmployeeId));

    expect(task).not.toBeNull();
    expect(traces.some((trace) => trace.turns.length > 0)).toBe(true);

    // M1.0.1 K2: the standalone task also *ends* — the whole lifecycle is on the record and the
    // organization goes idle again instead of holding submitted work forever.
    expect(after?.status).toBe('completed');
    expect(after?.result).not.toBeNull();
    const lifecycle = (await collectEvents(harness.control.simulation.eventStore))
      .filter(
        (event) =>
          event.type.startsWith('Task.') &&
          (event.payload as { readonly taskId?: string } | undefined)?.taskId === taskId,
      )
      .map((event) => event.type);
    log('F: task lifecycle', lifecycle);
    expect(lifecycle).toEqual([
      'Task.Created',
      'Task.Assigned',
      'Task.Accepted',
      'Task.Started',
      'Task.ProgressReported',
      'Task.Completed',
    ]);
    expect(traces.at(-1)?.status).toBe('idle');
  });

  it('Scenario G — a human approval gate continues the workflow to completion', async () => {
    const harness = await createAcceptanceHarness({ humanDecidableApprovals: true });
    const traces: TickTrace[] = [];
    await harness.execute('Agent.Instruct', {
      targetType: 'agent',
      targetId: 'ceo-alex',
      instruction: 'Own the churn problem.',
      reason: 'board directive',
    });

    let instanceId = '';
    let gateReached = false;
    for (let index = 0; index < 8 && !gateReached; index += 1) {
      const trace = await step(harness, traces);
      instanceId = trace.workflowChanges[0]?.instanceId ?? instanceId;
      gateReached = approvalGateOpen(harness.control.simulation, instanceId);
    }
    log(traces.map(renderTickTrace).join('\n'));
    const instance = harness.control.simulation.instanceStore.get(instanceId);
    log('G: at gate', instanceId, instance?.status, JSON.stringify(instance?.approval));
    expect(gateReached).toBe(true);

    const approve = await harness.execute('Workflow.Approve', {
      targetType: 'workflow',
      targetId: instanceId,
      reason: 'board approves the approach',
    });
    log('G: approve', approve.status, approve.failure, approve.events);
    expect(approve.status, JSON.stringify(approve.failure)).toBe('accepted');

    const beforeApproval = traces.length;
    for (let index = 0; index < 6; index += 1) {
      await step(harness, traces);
      if (harness.control.simulation.instanceStore.get(instanceId)?.status === 'completed') break;
    }
    log(traces.slice(beforeApproval).map(renderTickTrace).join('\n'));
    const completed = harness.control.simulation.instanceStore.get(instanceId);
    log('G: final', completed?.status, completed?.activeStepIds);
    expect(completed?.status).toBe('completed');
  });

  it('Scenario H — every human intervention is traceable command -> audit -> event -> state', async () => {
    const harness = await createAcceptanceHarness();
    const audit = harness.control.audit;

    const calls = [
      harness.execute('Simulation.Pause', {
        targetType: 'simulation',
        targetId: 'future-ai-lab',
        reason: 'trace pause',
      }),
    ];
    const pause = await calls[0];
    const resume = await harness.execute('Simulation.Resume', {
      targetType: 'simulation',
      targetId: 'future-ai-lab',
      reason: 'trace resume',
    });
    const instruct = await harness.execute('Agent.Instruct', {
      targetType: 'agent',
      targetId: 'ceo-alex',
      instruction: 'trace instruction',
      reason: 'trace instruct',
    });

    for (const outcome of [pause, resume, instruct]) {
      const record = audit.find(outcome.commandId);
      log('H:', outcome.commandId, outcome.commandType, outcome.status, '| audit:', record?.verdict, record?.actionType, '| events:', outcome.events.join(','));
      expect(record, outcome.commandId).not.toBeNull();
      expect(record?.verdict).toBe(outcome.status);
    }

    const events = await collectEvents(harness.control.simulation.eventStore);
    for (const outcome of [pause, resume, instruct]) {
      const controlEvent = events.find((event: OrgEvent) =>
        (event.payload as { readonly commandId?: string } | undefined)?.commandId === outcome.commandId,
      );
      log('H: control event for', outcome.commandId, controlEvent?.type, controlEvent?.eventId);
      expect(controlEvent, outcome.commandId).toBeDefined();
    }
    log('H: audit size', audit.recent(100).length);
    expect(audit.recent(100).length).toBe(3);
  });
});
