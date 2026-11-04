import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import type { Seq } from '@maoeh/event-store';
import { createInMemoryEventStore } from '@maoeh/event-store';
import { createSimulationHarness } from '../helpers/simulation-fixtures';

async function drain(store: {
  replay(from: Seq): AsyncIterable<OrgEvent>;
}): Promise<readonly OrgEvent[]> {
  const collected: OrgEvent[] = [];
  for await (const event of store.replay(1 as Seq)) collected.push(event);
  return collected;
}

describe('M0.9 simulation: recovery', () => {
  it('does not persist a synthetic boot marker', async () => {
    const store = createInMemoryEventStore();
    const harness = await createSimulationHarness({ eventStore: store });
    await harness.startProductAnalysis();
    const events = await drain(store);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.type).not.toBe('System.SimClockTicked');
  });

  it('rebuilds task, workflow and agent state from a pre-populated store', async () => {
    const store = createInMemoryEventStore();
    const first = await createSimulationHarness({ eventStore: store });
    const instanceId = await first.startProductAnalysis();
    await first.run(2);

    const second = await createSimulationHarness({ eventStore: store });
    const recovery = second.simulation.recovery;
    expect(recovery.tickNumber).toBe(2);
    expect(recovery.cursor).toBeGreaterThan(0);
    expect(recovery.workflowInstanceCount).toBe(1);
    expect(recovery.taskCount).toBe(2);
    expect(recovery.agentStateCount).toBe(2);

    const instance = second.simulation.instanceStore.get(instanceId);
    expect(instance?.status).toBe('blocked');
    expect(instance?.activeStepIds).toContain('design-gate');
  });

  it('continues a crashed run to completion after restart', async () => {
    const store = createInMemoryEventStore();
    const first = await createSimulationHarness({ eventStore: store });
    const instanceId = await first.startProductAnalysis();
    await first.run(2);

    const second = await createSimulationHarness({ eventStore: store });
    const results = await second.run(4);
    expect(results[0]?.status).toBe('ok');
    const instance = second.simulation.instanceStore.get(instanceId);
    expect(instance?.status).toBe('completed');
    expect(second.provider.callCount).toBe(2);
  });

  it('recovers a completed run without replaying cognition', async () => {
    const store = createInMemoryEventStore();
    const first = await createSimulationHarness({ eventStore: store });
    const instanceId = await first.startProductAnalysis();
    await first.run(6);
    const beforeEvents = (await drain(store)).length;

    const second = await createSimulationHarness({ eventStore: store });
    expect(second.simulation.recovery.tickNumber).toBe(6);
    expect(second.simulation.instanceStore.get(instanceId)?.status).toBe('completed');

    const results = await second.run(3);
    expect(results.map((result) => result.status)).toEqual(['idle', 'idle', 'idle']);
    expect(second.provider.callCount).toBe(0);
    const afterEvents = await drain(store);
    expect(afterEvents.length).toBe(beforeEvents + 3);
  });

  it('seeks the scheduler clock to the recovered tick', async () => {
    const store = createInMemoryEventStore();
    const first = await createSimulationHarness({ eventStore: store });
    await first.startProductAnalysis();
    await first.run(3);

    const second = await createSimulationHarness({ eventStore: store });
    expect(second.simulation.scheduler.clock.currentTick).toBe(3);
    expect(second.simulation.scheduler.clock.simTime).toBe(3);
    const result = await second.simulation.tick();
    expect(result.tickNumber).toBe(4);
  });

  it('is idempotent when recover is invoked again', async () => {
    const store = createInMemoryEventStore();
    const harness = await createSimulationHarness({ eventStore: store });
    await harness.startProductAnalysis();
    await harness.run(2);
    const reportA = await harness.simulation.recover();
    const reportB = await harness.simulation.recover();
    expect(reportB).toEqual(reportA);
  });
});
