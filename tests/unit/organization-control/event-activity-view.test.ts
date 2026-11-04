import { describe, expect, it } from 'vitest';
import { SYSTEM_SIM_CLOCK_TICKED } from '@maoeh/kernel';
import { BACKGROUND_EVENT_TYPE_PREFIXES } from '@maoeh/organization-control';

import {
  collectEvents,
  createControlHarness,
  type ControlHarness,
} from '../../helpers/control-fixtures';

/**
 * M1.2-B: one `System.SimClockTicked` marker is appended per tick, so a development
 * session that leaves the runtime running for a few minutes stores thousands of them.
 * The operator-facing activity view (`getRecentEvents`, which feeds `/api/events` and the
 * Overview "Recent events" card) must show what the company did — while the append-only
 * `EventStore` and the raw `getEventStream` keep every marker.
 */
async function seedActivity(h: ControlHarness): Promise<void> {
  const outcome = await h.plane.control.execute(
    h.command('Organization.InjectTask', {
      targetType: 'organization',
      targetId: 'future-ai-lab',
      extra: {
        positionId: 'ceo',
        title: 'Research a new market',
        goal: 'Explain the opportunity',
      },
    }),
  );
  expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
}

describe('M1.2-B: the activity view is not the clock', () => {
  it('holds clock markers out of getRecentEvents while the log keeps every one of them', async () => {
    const h = await createControlHarness();
    await seedActivity(h);
    await h.harness.run(6);

    const raw = await h.plane.control.query.getEventStream({ limit: 1000 });
    expect(raw.filter((event) => event.type === SYSTEM_SIM_CLOCK_TICKED).length).toBeGreaterThanOrEqual(6);

    const recent = await h.plane.control.query.getRecentEvents({ limit: 200 });
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.some((event) => event.type === SYSTEM_SIM_CLOCK_TICKED)).toBe(false);
    expect(recent.map((event) => event.type)).toContain('Control.TaskInjected');
    expect(recent.map((event) => event.type)).toContain('Task.Created');
    expect(recent.map((event) => event.type)).toContain('Task.Assigned');
    // The window is company activity: control, task, workflow, runtime, communication.
    const aggregates = new Set(recent.map((event) => event.type.split('.')[0]));
    expect([...aggregates].some((aggregate) => aggregate !== 'System')).toBe(true);
    expect(aggregates.has('Control')).toBe(true);
    expect(aggregates.has('Task')).toBe(true);
  });

  it('fills the requested limit with business events instead of clock markers', async () => {
    const h = await createControlHarness();
    await seedActivity(h);
    await h.harness.run(4);

    // The newest events in the store are tick markers, yet the page still comes back full:
    // the exclusion runs while the log is scanned, before `limit` slices it.
    const page = await h.plane.control.query.getRecentEvents({ limit: 2 });
    expect(page).toHaveLength(2);
    expect(page.map((event) => event.type)).not.toContain(SYSTEM_SIM_CLOCK_TICKED);
    expect(page[0]?.seq).toBeGreaterThan(page[1]?.seq ?? 0);
    expect(page.every((event) => event.type !== SYSTEM_SIM_CLOCK_TICKED)).toBe(true);
  });

  it('lets an explicit query reach the raw clock markers again', async () => {
    const h = await createControlHarness();
    await seedActivity(h);
    await h.harness.run(3);
    const query = h.plane.control.query;

    const clockOnly = await query.getRecentEvents({ eventTypePrefix: 'System.' });
    expect(clockOnly.length).toBeGreaterThan(0);
    expect(clockOnly.every((event) => event.type === SYSTEM_SIM_CLOCK_TICKED)).toBe(true);

    const rawView = await query.getRecentEvents({ limit: 1000, excludeEventTypePrefixes: [] });
    expect(rawView.some((event) => event.type === SYSTEM_SIM_CLOCK_TICKED)).toBe(true);
    expect(rawView.length).toBeGreaterThanOrEqual(clockOnly.length);
  });

  it('keeps the organization snapshot Recent events on company activity', async () => {
    const h = await createControlHarness();
    await seedActivity(h);
    await h.harness.run(4);

    const snapshot = await h.plane.control.query.getOrganizationSnapshot();
    expect(snapshot.recentEvents.length).toBeGreaterThan(0);
    expect(snapshot.recentEvents.some((event) => event.type.startsWith('System.'))).toBe(false);

    const seqs = snapshot.recentEvents.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => right - left));
  });

  it('leaves the EventStore complete: getEventStream returns every stored event', async () => {
    const h = await createControlHarness();
    await seedActivity(h);
    await h.harness.run(3);

    const stored = await collectEvents(h.simulation.eventStore);
    expect(stored.filter((event) => event.type === SYSTEM_SIM_CLOCK_TICKED).length).toBeGreaterThanOrEqual(3);

    const stream = await h.plane.control.query.getEventStream({ limit: stored.length + 10 });
    expect(stream).toHaveLength(stored.length);
    expect(stream.map((event) => event.seq)).toEqual(stored.map((event) => Number(event.seq)));

    // Reading the activity view never mutates the log.
    await h.plane.control.query.getRecentEvents({ limit: 1000 });
    expect(await collectEvents(h.simulation.eventStore)).toHaveLength(stored.length);
  });

  it('keeps the background prefix list pointed at the kernel clock marker', () => {
    expect(BACKGROUND_EVENT_TYPE_PREFIXES.length).toBeGreaterThan(0);
    expect(BACKGROUND_EVENT_TYPE_PREFIXES.some((prefix) => SYSTEM_SIM_CLOCK_TICKED.startsWith(prefix))).toBe(true);
  });
});
