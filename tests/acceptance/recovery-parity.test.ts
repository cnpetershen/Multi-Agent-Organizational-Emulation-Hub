import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import { createInMemoryEventStore } from '@maoeh/event-store';
import type { Simulation } from '@maoeh/kernel';
import { createSimulationHarness, type SimulationHarness } from '../helpers/simulation-fixtures';
import { acceptanceCognition } from './runtime-harness';

const MID_TICKS = 2;
const TAIL_TICKS = 6;

function log(...parts: readonly unknown[]): void {
  console.log(...parts);
}

interface Snapshot {
  readonly tick: number;
  readonly simTime: number;
  readonly tasks: readonly string[];
  readonly workflows: readonly string[];
  readonly agents: readonly string[];
  readonly events: readonly string[];
}

async function capture(simulation: Simulation): Promise<Snapshot> {
  const events: OrgEvent[] = [];
  for await (const event of simulation.eventStore.replay(1 as never)) events.push(event);
  const tasks = simulation.taskStore
    .all()
    .map(
      (task) =>
        `${task.taskId}:${task.status}:${String(task.assignment.assigneeEmployeeId)}:${task.result === null ? 'no-result' : 'result'}`,
    )
    .sort();
  const workflows = simulation.instanceStore
    .all()
    .map(
      (instance) =>
        `${instance.instanceId}:${instance.status}:${instance.activeStepIds.join('+')}:${Object.entries(
          instance.stepStates,
        )
          .map(([stepId, state]) => `${stepId}=${state.status}`)
          .sort()
          .join(',')}:${instance.approval === null ? 'no-approval' : instance.approval.status}`,
    )
    .sort();
  const agents = [...simulation.agents.keys()]
    .map((employeeId) => {
      const state = simulation.stateStore.load(employeeId);
      return `${String(employeeId)}:${state.employment}:${state.presence}:${String(state.version)}:${state.currentCycleId ?? '-'}`;
    })
    .sort();
  return Object.freeze({
    tick: simulation.scheduler.clock.currentTick,
    simTime: Number(simulation.scheduler.clock.simTime),
    tasks: Object.freeze(tasks),
    workflows: Object.freeze(workflows),
    agents: Object.freeze(agents),
    events: Object.freeze(
      events.map((event) => `${String(event.seq)}:${event.eventId}:${event.type}`),
    ),
  });
}

async function scenario(): Promise<{
  readonly harness: SimulationHarness;
  readonly instanceId: string;
}> {
  const harness = await createSimulationHarness({ llmText: acceptanceCognition });
  const instanceId = await harness.startProductAnalysis();
  await harness.run(MID_TICKS);
  return { harness, instanceId };
}

describe('M1.0 runtime acceptance: recovery parity', () => {
  it('a restarted kernel rebuilds exactly the state the continuous run held', async () => {
    const continuous = await scenario();
    const midContinuous = await capture(continuous.harness.simulation);
    log('mid (continuous) tick', midContinuous.tick, midContinuous.workflows);

    // Simulate a process restart on top of the same (already durable) event log.
    const store = createInMemoryEventStore();
    const first = await createSimulationHarness({
      eventStore: store,
      llmText: acceptanceCognition,
    });
    await first.startProductAnalysis();
    await first.run(MID_TICKS);
    const beforeRestart = await capture(first.simulation);

    const second = await createSimulationHarness({
      eventStore: store,
      llmText: acceptanceCognition,
    });
    const report = await second.simulation.recover();
    const afterRecovery = await capture(second.simulation);
    log('recovery report', JSON.stringify(report));
    log('after recovery', afterRecovery.tick, afterRecovery.workflows);

    expect(beforeRestart).toEqual(afterRecovery);
    expect(afterRecovery.tick).toBe(midContinuous.tick);

    // Both paths keep running and must converge on the same final state.
    await continuous.harness.run(TAIL_TICKS);
    await second.run(TAIL_TICKS);

    const finalContinuous = await capture(continuous.harness.simulation);
    const finalRecovered = await capture(second.simulation);
    log('final (continuous)', finalContinuous.tick, finalContinuous.workflows);
    log('final (recovered) ', finalRecovered.tick, finalRecovered.workflows);

    expect(finalRecovered).toEqual(finalContinuous);
    expect(continuous.harness.simulation.instanceStore.get(continuous.instanceId)?.status).toBe(
      'completed',
    );
  });

  it('sanitizes the recovered tick cursor so the next tick consumes only new events', async () => {
    const store = createInMemoryEventStore();
    const first = await createSimulationHarness({
      eventStore: store,
      llmText: acceptanceCognition,
    });
    await first.startProductAnalysis();
    await first.run(MID_TICKS);

    const second = await createSimulationHarness({
      eventStore: store,
      llmText: acceptanceCognition,
    });
    const report = await second.simulation.recover();
    const next = await second.simulation.tick();
    log('cursor', report.cursor, 'next tick', next.tickNumber, 'input', next.inputEventCount);
    expect(next.inputEventCount).toBe(report.eventCount - report.cursor);
    expect(report.cursor).toBeGreaterThan(0);
  });
});
