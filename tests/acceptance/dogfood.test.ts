import { beforeAll, describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import {
  createAcceptanceHarness,
  createObserver,
  renderTickTrace,
  type AcceptanceHarness,
  type TickTrace,
} from './runtime-harness';
import { collectEvents } from '../helpers/control-fixtures';

const TICKS = 8;

describe('M1.0 runtime acceptance: autonomous organization run', () => {
  let harness: AcceptanceHarness;
  let traces: readonly TickTrace[];

  beforeAll(async () => {
    harness = await createAcceptanceHarness();
    const observer = createObserver(harness);
    const collected: TickTrace[] = [];

    // STEP 3 — the board hands the company a mandate. This is the real control-plane
    // entry a human would use; the work itself is done autonomously afterwards.
    observer.beforeTick();
    const instructed = await harness.execute('Agent.Instruct', {
      targetType: 'agent',
      targetId: 'ceo-alex',
      instruction: 'Own the churn problem and drive it to a decision.',
      reason: 'board directive',
    });
    expect(instructed.status, JSON.stringify(instructed.failure)).toBe('accepted');
    collected.push(await observer.observe(await harness.control.simulation.tick()));

    for (let index = 0; index < TICKS; index += 1) {
      observer.beforeTick();
      const result = await harness.control.simulation.tick();
      collected.push(await observer.observe(result));
    }
    traces = Object.freeze(collected);

    console.log(traces.map(renderTickTrace).join('\n'));
  });

  it('observes every tick', () => {
    expect(traces.length).toBe(TICKS + 1);
  });

  it('produces a complete event chain', async () => {
    const events = await collectEvents(harness.control.simulation.eventStore);
    console.log(
      events
        .map((event: OrgEvent) => `${String(event.seq)} ${event.type} corr=${event.correlationId} cause=${String(event.causationId)}`)
        .join('\n'),
    );
    expect(events.length).toBeGreaterThan(0);
  });
});
