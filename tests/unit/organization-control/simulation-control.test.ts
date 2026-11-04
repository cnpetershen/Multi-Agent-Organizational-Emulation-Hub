import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import type { ControlCommandType, ControlOutcome } from '@maoeh/organization-control';
import {
  CONTROL_COMMAND_REJECTED,
  CONTROL_SIMULATION_PAUSED,
  CONTROL_SIMULATION_RESUMED,
  CONTROL_SIMULATION_SOUGHT,
  CONTROL_SIMULATION_STARTED,
  CONTROL_SIMULATION_STEPPED,
} from '@maoeh/organization-control';
import type { ControlHarness } from '../../helpers/control-fixtures';
import { collectEvents, createControlHarness } from '../../helpers/control-fixtures';

function payloadOf(event: OrgEvent | undefined): Readonly<Record<string, unknown>> {
  const payload = event?.payload;
  return typeof payload === 'object' && payload !== null
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

function typesOf(events: readonly OrgEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

async function execute(
  h: ControlHarness,
  commandType: ControlCommandType,
  overrides: Record<string, unknown> = {},
): Promise<ControlOutcome> {
  return h.plane.control.execute(h.command(commandType, overrides as never));
}

describe('M1.0 control plane: simulation control', () => {
  it('start ticks exactly once and records Control.SimulationStarted', async () => {
    const h = await createControlHarness();
    expect(h.simulation.scheduler.clock.currentTick).toBe(0);

    const outcome = await execute(h, 'Simulation.Start');
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    expect(h.simulation.scheduler.clock.currentTick).toBe(1);
    expect(h.simulation.scheduler.paused).toBe(false);

    const events = await collectEvents(h.simulation.eventStore);
    expect(typesOf(events)).toContain(CONTROL_SIMULATION_STARTED);
    expect(outcome.events).toHaveLength(1);
  });

  it('pause stops the clock: a paused tick is a no-op that moves nothing', async () => {
    const h = await createControlHarness();
    const pause = await execute(h, 'Simulation.Pause');
    expect(pause.status, JSON.stringify(pause.failure)).toBe('accepted');
    expect(h.simulation.scheduler.paused).toBe(true);
    expect(typesOf(await collectEvents(h.simulation.eventStore))).toContain(
      CONTROL_SIMULATION_PAUSED,
    );

    const eventsBefore = await collectEvents(h.simulation.eventStore);
    const tick = await h.simulation.tick();
    expect(tick.status).toBe('paused');
    expect(tick.emittedEvents).toHaveLength(0);
    // The cursor is a watermark over the log: it must not advance on a paused tick.
    expect(tick.cursor).toBe(tick.cursorBefore);
    expect(h.simulation.scheduler.clock.currentTick).toBe(0);
    expect(await collectEvents(h.simulation.eventStore)).toHaveLength(eventsBefore.length);
  });

  it('resume restarts the clock', async () => {
    const h = await createControlHarness();
    expect((await execute(h, 'Simulation.Pause')).status).toBe('accepted');
    expect(h.simulation.scheduler.paused).toBe(true);

    const resume = await execute(h, 'Simulation.Resume');
    expect(resume.status, JSON.stringify(resume.failure)).toBe('accepted');
    expect(h.simulation.scheduler.paused).toBe(false);
    expect(typesOf(await collectEvents(h.simulation.eventStore))).toContain(
      CONTROL_SIMULATION_RESUMED,
    );

    await h.simulation.tick();
    expect(h.simulation.scheduler.clock.currentTick).toBe(1);
  });

  it('refuses redundant pause/resume transitions as CONFLICT', async () => {
    const h = await createControlHarness();
    const first = await execute(h, 'Simulation.Pause');
    expect(first.status, JSON.stringify(first.failure)).toBe('accepted');

    const second = await execute(h, 'Simulation.Pause');
    expect(second.status, JSON.stringify(second.failure)).toBe('rejected');
    expect(second.failure?.code).toBe('CONFLICT');
    const pausedEvents = (await collectEvents(h.simulation.eventStore)).filter(
      (event) => event.type === CONTROL_SIMULATION_PAUSED,
    );
    expect(pausedEvents).toHaveLength(1);

    const running = await createControlHarness();
    const resumeWhenRunning = await execute(running, 'Simulation.Resume');
    expect(resumeWhenRunning.status, JSON.stringify(resumeWhenRunning.failure)).toBe('rejected');
    expect(resumeWhenRunning.failure?.code).toBe('CONFLICT');
    expect(running.simulation.scheduler.paused).toBe(false);
  });

  it('step advances exactly one tick while remaining paused', async () => {
    const h = await createControlHarness();
    expect((await execute(h, 'Simulation.Start')).status).toBe('accepted');
    expect((await execute(h, 'Simulation.Pause')).status).toBe('accepted');
    const before = h.simulation.scheduler.clock.currentTick;

    const step = await execute(h, 'Simulation.Step');
    expect(step.status, JSON.stringify(step.failure)).toBe('accepted');
    expect(h.simulation.scheduler.clock.currentTick).toBe(before + 1);
    expect(h.simulation.scheduler.paused).toBe(true);

    const stepped = (await collectEvents(h.simulation.eventStore)).filter(
      (event) => event.type === CONTROL_SIMULATION_STEPPED,
    );
    expect(stepped).toHaveLength(1);
    const tickStatus = payloadOf(stepped[0])['tickStatus'];
    expect(typeof tickStatus).toBe('string');
    expect(tickStatus).not.toBe('paused');

    // The pause overlay is restored after the single step.
    const tick = await h.simulation.tick();
    expect(tick.status).toBe('paused');
    expect(h.simulation.scheduler.clock.currentTick).toBe(before + 1);
  });

  it('step advances exactly one tick while running', async () => {
    const h = await createControlHarness();
    const step = await execute(h, 'Simulation.Step');
    expect(step.status, JSON.stringify(step.failure)).toBe('accepted');
    expect(h.simulation.scheduler.clock.currentTick).toBe(1);
    expect(h.simulation.scheduler.paused).toBe(false);
  });

  it('seeks forward, records Control.SimulationSought and keeps moving from there', async () => {
    const h = await createControlHarness();
    const outcome = await execute(h, 'Simulation.Seek', { extra: { tickNumber: 5 } });
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    expect(h.simulation.scheduler.clock.currentTick).toBe(5);

    const sought = (await collectEvents(h.simulation.eventStore)).find(
      (event) => event.type === CONTROL_SIMULATION_SOUGHT,
    );
    expect(sought).toBeDefined();
    expect(payloadOf(sought)).toMatchObject({
      commandId: outcome.commandId,
      fromTick: 0,
      toTick: 5,
    });

    await h.simulation.tick();
    expect(h.simulation.scheduler.clock.currentTick).toBe(6);
  });

  it('refuses a backward seek as UNSUPPORTED and never rewrites history', async () => {
    const h = await createControlHarness();
    expect((await execute(h, 'Simulation.Seek', { extra: { tickNumber: 5 } })).status).toBe(
      'accepted',
    );
    const eventsBefore = await collectEvents(h.simulation.eventStore);
    const command = h.command('Simulation.Seek', { extra: { tickNumber: 3 } } as never);

    const outcome = await h.plane.control.execute(command);
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('rejected');
    expect(outcome.failure?.code).toBe('UNSUPPORTED');
    expect(outcome.failure?.issues[0]?.field).toBe('tickNumber');
    expect(h.simulation.scheduler.clock.currentTick).toBe(5);
    // The refusal is still fully traceable through the audit record.
    expect(h.audit.find(command.commandId)?.resultCode).toBe('UNSUPPORTED');

    // No fake rollback: a refusal forges no fact event. It is recorded as exactly one
    // `Control.CommandRejected` marker carrying the failure code, and the clock stays put.
    const after = await collectEvents(h.simulation.eventStore);
    const appended = after.slice(eventsBefore.length);
    const markers = appended.filter((event) => event.type === CONTROL_COMMAND_REJECTED);
    expect(appended).toHaveLength(markers.length);
    expect(markers).toHaveLength(1);
    expect(payloadOf(markers[0])).toMatchObject({
      commandId: command.commandId,
      targetId: 'future-ai-lab',
      resultCode: 'UNSUPPORTED',
    });
    expect(outcome.events).toEqual([markers[0]?.eventId]);
    expect(h.plane.control.query.getControlState().simulationPaused).toBe(false);
  });

  it('refuses a non-integer (non-aligned) seek tick without touching the clock', async () => {
    const h = await createControlHarness();
    expect((await execute(h, 'Simulation.Seek', { extra: { tickNumber: 4 } })).status).toBe(
      'accepted',
    );

    const outcome = await execute(h, 'Simulation.Seek', { extra: { tickNumber: 2.5 } });
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('rejected');
    expect(outcome.failure?.code).toBe('INVALID_COMMAND');
    expect(outcome.failure?.issues[0]?.field).toBe('tickNumber');
    expect(h.simulation.scheduler.clock.currentTick).toBe(4);
    // Note: the clock's own `target % tickDuration` alignment guard is unreachable through
    // the command path — the kernel port converts a tick number with `clock.at(tick)`, which
    // is aligned by construction. A fractional tick is the only non-aligned input the command
    // can express, and structural validation rejects it before dispatch.
  });

  it('pause is not kill: resume recovers and the event log stays append-only', async () => {
    const h = await createControlHarness();
    await h.harness.startProductAnalysis();
    const runs = await h.harness.run(1);
    // intake 步声明 product_requirement 能力，由该能力的座席（pm-bona）承担，而非 CEO。
    expect(runs[0]?.turns.map((turn) => turn.employeeId)).toEqual(['pm-bona']);
    const eventsBeforePause = await collectEvents(h.simulation.eventStore);
    const tickBefore = h.simulation.scheduler.clock.currentTick;

    expect((await execute(h, 'Simulation.Pause')).status).toBe('accepted');
    expect((await execute(h, 'Simulation.Resume')).status).toBe('accepted');
    expect(h.simulation.scheduler.clock.currentTick).toBe(tickBefore);

    const report = await h.simulation.recover();
    expect(report.tickNumber).toBe(tickBefore);
    const eventsAfter = await collectEvents(h.simulation.eventStore);
    expect(report.eventCount).toBe(eventsAfter.length);
    expect(eventsAfter).toHaveLength(eventsBeforePause.length + 2);
    expect(eventsAfter.slice(0, eventsBeforePause.length).map((event) => event.eventId)).toEqual(
      eventsBeforePause.map((event) => event.eventId),
    );
    expect(eventsAfter.slice(-2).map((event) => event.type)).toEqual([
      CONTROL_SIMULATION_PAUSED,
      CONTROL_SIMULATION_RESUMED,
    ]);

    // Pausing is expressed only through the command surface: the runtime has no
    // writable `status` field that a caller could flip behind the control plane's back.
    expect((h.simulation as unknown as Record<string, unknown>)['status']).toBeUndefined();
    expect(h.simulation.scheduler.paused).toBe(false);
  });

  it('is deterministic: the same command sequence yields the same tick and event types', async () => {
    const sequence: readonly ControlCommandType[] = [
      'Simulation.Start',
      'Simulation.Pause',
      'Simulation.Step',
      'Simulation.Resume',
      'Simulation.Start',
    ];
    const drive = async (h: ControlHarness): Promise<void> => {
      for (const commandType of sequence) {
        const outcome = await execute(h, commandType);
        expect(outcome.status, `${commandType}: ${JSON.stringify(outcome.failure)}`).toBe(
          'accepted',
        );
      }
    };
    const controlTypesOf = async (h: ControlHarness): Promise<readonly string[]> =>
      typesOf(await collectEvents(h.simulation.eventStore)).filter((type) =>
        type.startsWith('Control.'),
      );

    const first = await createControlHarness();
    const second = await createControlHarness();
    await drive(first);
    await drive(second);

    expect(await controlTypesOf(second)).toEqual(await controlTypesOf(first));
    expect(second.simulation.scheduler.clock.currentTick).toBe(
      first.simulation.scheduler.clock.currentTick,
    );
    expect(first.simulation.scheduler.clock.currentTick).toBe(3);
  });
});
