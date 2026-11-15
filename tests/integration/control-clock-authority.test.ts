import { describe, expect, it } from 'vitest';
import { auditLegacyWork } from '@maoeh/organization-control';
import { collectEvents, createControlHarness } from '../helpers/control-fixtures';

/**
 * M3.0 · the kernel clock is authoritative for control commands.
 *
 * The production log contains a `Task.Cancelled` at sim 0 for a task created at sim 63048: the
 * console stamped a command with its own (stale) copy of the clock, and the control plane wrote a
 * terminal fact into the past. A command may not rewrite history backwards; it must be stamped at
 * least at "now". A command stamped *ahead* is left alone (replays and tests legitimately arrive
 * later in sim time).
 */
describe('M3.0 control plane: kernel clock authority', () => {
  it('never writes a domain fact earlier than the current simulation time', async () => {
    const h = await createControlHarness();
    // A seat nobody fills: the task is assigned to a position with no holder, so it stays open.
    const injected = await h.plane.control.execute(
      h.command('Organization.InjectTask', {
        targetType: 'organization',
        targetId: 'future-ai-lab',
        extra: {
          title: 'Vacant-seat work',
          goal: 'Nobody can pick this up yet',
          positionId: 'ai-researcher',
        },
      } as never),
    );
    expect(injected.status, JSON.stringify(injected.failure)).toBe('accepted');
    const taskId = h.plane.control.query.getTasks()[0]?.taskId ?? '';
    await h.harness.run(1);
    const now = Number(h.simulation.scheduler.clock.simTime);
    expect(now).toBeGreaterThan(0);

    // The stale-clock command: exactly the shape the console produced in production.
    const cancelled = await h.plane.control.execute(
      h.command('Task.Cancel', {
        targetType: 'task',
        targetId: taskId,
        reason: 'stale console clock',
        createdAtSim: 0 as never,
      } as never),
    );
    expect(cancelled.status, JSON.stringify(cancelled.failure)).toBe('accepted');

    const events = await collectEvents(h.simulation.eventStore);
    const created = events.find(
      (event) =>
        event.type === 'Task.Created' &&
        (event.payload as Readonly<Record<string, unknown>>)['taskId'] === taskId,
    );
    const terminal = events.find(
      (event) =>
        event.type === 'Task.Cancelled' &&
        (event.payload as Readonly<Record<string, unknown>>)['taskId'] === taskId,
    );
    expect(terminal?.occurredAtSim).toBe(now);
    expect(Number(terminal?.occurredAtSim)).toBeGreaterThanOrEqual(Number(created?.occurredAtSim));

    const audit = auditLegacyWork({
      tasks: h.simulation.tasks.all(),
      events,
      organization: h.organization,
      simTime: now,
    });
    expect(audit.findings.filter((finding) => finding.code === 'chronology_violation')).toEqual([]);
  });

  it('leaves a command that is already stamped ahead alone', async () => {
    const h = await createControlHarness();
    await h.harness.run(1);
    const now = Number(h.simulation.scheduler.clock.simTime);
    const ahead = now + 10;

    const paused = await h.plane.control.execute(
      h.command('Agent.Pause', {
        targetType: 'agent',
        targetId: 'cto-john',
        reason: 'board pause',
        createdAtSim: ahead as never,
      } as never),
    );
    expect(paused.status, JSON.stringify(paused.failure)).toBe('accepted');

    const events = await collectEvents(h.simulation.eventStore);
    const pauseEvent = events.find((event) => event.type === 'Control.AgentPaused');
    expect(pauseEvent?.occurredAtSim).toBe(ahead);
  });
});
