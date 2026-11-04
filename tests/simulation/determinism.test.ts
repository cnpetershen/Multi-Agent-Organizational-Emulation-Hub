import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import type { WorkflowInstance } from '@maoeh/workflow-engine';
import { withoutBookkeeping } from '@maoeh/workflow-engine';
import { createInMemoryEventStore } from '@maoeh/event-store';
import { createSimulationHarness } from '../helpers/simulation-fixtures';

function fingerprint(events: readonly OrgEvent[]): readonly unknown[] {
  return events.map((event) => [event.type, event.payload]);
}

function instanceOf(
  store: { get(id: string): WorkflowInstance | null },
  id: string,
): WorkflowInstance {
  const instance = store.get(id);
  if (instance === null) throw new Error(`instance ${id} missing`);
  return instance;
}

describe('M0.9 simulation: determinism', () => {
  it('produces identical event streams and outcomes for identical seeds', async () => {
    const first = await createSimulationHarness();
    const firstId = await first.startProductAnalysis();
    const firstResults = await first.run(6);

    const second = await createSimulationHarness();
    const secondId = await second.startProductAnalysis();
    const secondResults = await second.run(6);

    expect(firstId).toBe(secondId);
    expect(fingerprint(firstResults.flatMap((result) => result.emittedEvents))).toEqual(
      fingerprint(secondResults.flatMap((result) => result.emittedEvents)),
    );
    expect(
      withoutBookkeeping(instanceOf(first.simulation.instanceStore, firstId)),
    ).toEqual(withoutBookkeeping(instanceOf(second.simulation.instanceStore, secondId)));
  });

  it('reaches the same final state whether run straight or resumed mid-flight', async () => {
    const straight = await createSimulationHarness();
    const straightId = await straight.startProductAnalysis();
    await straight.run(6);

    const store = createInMemoryEventStore();
    const crashed = await createSimulationHarness({ eventStore: store });
    const crashedId = await crashed.startProductAnalysis();
    await crashed.run(2);
    const resumed = await createSimulationHarness({ eventStore: store });
    await resumed.run(4);

    expect(crashedId).toBe(straightId);
    expect(
      withoutBookkeeping(instanceOf(resumed.simulation.instanceStore, crashedId)),
    ).toEqual(withoutBookkeeping(instanceOf(straight.simulation.instanceStore, straightId)));
  });
});
