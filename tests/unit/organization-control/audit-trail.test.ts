import { describe, expect, it } from 'vitest';
import type { Seq } from '@maoeh/event-store';
import type { Simulation } from '@maoeh/kernel';
import type { OrgEvent } from '@maoeh/shared-types';

import { createControlHarness } from '../../helpers/control-fixtures';

async function storedEvents(simulation: Simulation): Promise<readonly OrgEvent[]> {
  const collected: OrgEvent[] = [];
  for await (const event of simulation.eventStore.replay(1 as Seq)) collected.push(event);
  return collected;
}

function payloadString(event: OrgEvent | undefined, key: string): string | null {
  if (event === undefined) return null;
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Readonly<Record<string, unknown>>)[key];
  return typeof value === 'string' ? value : null;
}

/** Rejections are logged as `Control.CommandRejected` (docs/architecture/M1.0 §7.3). */
async function rejectionsFor(
  simulation: Simulation,
  commandId: string,
): Promise<readonly OrgEvent[]> {
  return (await storedEvents(simulation)).filter(
    (event) =>
      event.type === 'Control.CommandRejected' && payloadString(event, 'commandId') === commandId,
  );
}

describe('M1.0 control plane: audit trail', () => {
  it('records exactly one accepted record per accepted command', async () => {
    const h = await createControlHarness();
    const command = h.command('Simulation.Pause');
    const outcome = await h.plane.control.execute(command);
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const record = h.audit.find(command.commandId);
    expect(record).not.toBeNull();
    expect(record?.verdict).toBe('accepted');
    expect(record?.action.type).toBe('Simulation.Pause');
    expect(record?.action.reason.trim().length).toBeGreaterThan(0);
    expect(record?.target.targetId).toBe('future-ai-lab');
    expect(record?.target.targetType).toBe('simulation');
    expect(record?.action.resource).toBe('simulation:future-ai-lab');
    expect(record?.eventIds).toEqual(outcome.events);
    expect(record?.eventIds.length).toBeGreaterThan(0);
    expect(h.audit.query({ commandId: command.commandId })).toHaveLength(1);
    expect(h.audit.recent()).toHaveLength(1);
  });

  it('records a rejected record carrying the failure code', async () => {
    const h = await createControlHarness();
    const first = await h.plane.control.execute(h.command('Simulation.Pause'));
    expect(first.status, JSON.stringify(first.failure)).toBe('accepted');

    const second = h.command('Simulation.Pause');
    const outcome = await h.plane.control.execute(second);
    expect(outcome.status).toBe('rejected');
    expect(outcome.failure?.code, JSON.stringify(outcome.failure)).toBe('CONFLICT');

    const record = h.audit.find(second.commandId);
    expect(record).not.toBeNull();
    expect(record?.verdict).toBe('rejected');
    expect(record?.resultCode).toBe('CONFLICT');
    expect(record?.action.type).toBe('Simulation.Pause');

    const rejections = await rejectionsFor(h.simulation, second.commandId);
    expect(rejections).toHaveLength(1);
    expect(payloadString(rejections[0], 'resultCode')).toBe('CONFLICT');
    expect(record?.eventIds).toEqual(outcome.events);
    expect(record?.eventIds).toEqual([rejections[0]?.eventId]);
    expect(h.audit.query({ commandId: second.commandId })).toHaveLength(1);
  });

  it('appends no fact event for a rejected command, only the rejection marker', async () => {
    const h = await createControlHarness();
    const accepted = h.command('Simulation.Pause');
    const first = await h.plane.control.execute(accepted);
    expect(first.status, JSON.stringify(first.failure)).toBe('accepted');

    const rejected = h.command('Simulation.Pause');
    const outcome = await h.plane.control.execute(rejected);
    expect(outcome.status).toBe('rejected');
    expect(outcome.failure?.code).toBe('CONFLICT');

    const controlEvents = (await storedEvents(h.simulation)).filter((event) =>
      event.type.startsWith('Control.'),
    );
    expect(controlEvents.map((event) => event.type)).toEqual([
      'Control.SimulationPaused',
      'Control.CommandRejected',
    ]);
    // The refused command left no fact event: exactly one pause was ever applied.
    expect(controlEvents.filter((event) => event.type === 'Control.SimulationPaused')).toHaveLength(
      1,
    );
    expect(outcome.events).toEqual([controlEvents[1]?.eventId]);
    expect(payloadString(controlEvents[1], 'commandId')).toBe(rejected.commandId);
    expect(h.simulation.scheduler.paused).toBe(true);
  });

  it('is append-only and immutable: records are frozen and a second command appends a second record', async () => {
    const h = await createControlHarness();
    const pause = h.command('Simulation.Pause');
    await h.plane.control.execute(pause);

    const before = h.audit.recent();
    expect(before).toHaveLength(1);
    const record = before[0];
    expect(record).toBeDefined();
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record?.action)).toBe(true);
    expect(Object.isFrozen(record?.target)).toBe(true);
    expect(Object.isFrozen(record?.eventIds)).toBe(true);
    expect(Object.isFrozen(record?.details)).toBe(true);

    const mutable = record as unknown as { verdict: string };
    expect(() => {
      mutable.verdict = 'failed';
    }).toThrow();

    const resume = h.command('Simulation.Resume');
    const outcome = await h.plane.control.execute(resume);
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const after = h.audit.recent();
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]?.commandId).toBe(resume.commandId);
    expect(after[1]?.commandId).toBe(pause.commandId);
    expect(after[1]?.verdict).toBe('accepted');
  });

  it('returns recent(n) newest-first and bounded', async () => {
    const h = await createControlHarness();
    const start = h.command('Simulation.Start');
    const pause = h.command('Simulation.Pause');
    const resume = h.command('Simulation.Resume');

    for (const command of [start, pause, resume]) {
      const outcome = await h.plane.control.execute(command);
      expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    }

    expect(h.audit.recent().map((entry) => entry.commandId)).toEqual([
      resume.commandId,
      pause.commandId,
      start.commandId,
    ]);
    expect(h.audit.recent(2).map((entry) => entry.commandId)).toEqual([
      resume.commandId,
      pause.commandId,
    ]);
    expect(h.audit.recent(1)).toHaveLength(1);
    expect(h.audit.recent(0)).toHaveLength(0);
    expect(h.audit.recent(100)).toHaveLength(3);
  });

  it('stamps each record with the operator identity and the command correlation', async () => {
    const h = await createControlHarness();
    const command = h.command('Simulation.Pause', { causationId: 'cause-1' });
    const outcome = await h.plane.control.execute(command);
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const record = h.audit.find(command.commandId);
    expect(record?.actorId).toBe('operator-dana');
    expect(record?.actorKind).toBe('human');
    expect(record?.correlationId).toBe(command.correlationId);
    expect(record?.correlationId).toMatch(/^corr-control-/);
    expect(record?.causationId).toBe('cause-1');
    expect(record?.createdAtSim).toBe(Number(command.createdAtSim));
    expect(record?.createdAtSim).toBe(0);

    const correlated = h.audit.forCorrelation(command.correlationId);
    expect(correlated.map((entry) => entry.commandId)).toEqual([command.commandId]);
  });

  it('defaults causationId to null when the command carries none', async () => {
    const h = await createControlHarness();
    const command = h.command('Simulation.Pause');
    expect(command.causationId).toBeNull();
    await h.plane.control.execute(command);
    expect(h.audit.find(command.commandId)?.causationId).toBeNull();
  });

  it('links an accepted command to the event it appended and to the projected state', async () => {
    const h = await createControlHarness();
    const command = h.command('Simulation.Pause');
    const outcome = await h.plane.control.execute(command);
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const record = h.audit.find(command.commandId);
    expect(record).not.toBeNull();
    const eventIds = new Set(record?.eventIds ?? []);

    const events = await storedEvents(h.simulation);
    const linked = events.filter((event) => eventIds.has(event.eventId));
    expect(linked).toHaveLength(1);

    const event = linked[0];
    expect(event?.type).toBe('Control.SimulationPaused');
    expect(payloadString(event, 'commandId')).toBe(command.commandId);
    expect(payloadString(event, 'reason')).toBe(command.reason);

    expect(h.simulation.scheduler.paused).toBe(true);
    expect(h.plane.control.state().simulationPaused).toBe(true);
  });

  it('exposes the audit trail for a resource target', async () => {
    const h = await createControlHarness();
    const pause = h.command('Simulation.Pause');
    await h.plane.control.execute(pause);
    const agentPause = h.command('Agent.Pause', { targetId: 'ceo-alex' });
    const agentOutcome = await h.plane.control.execute(agentPause);
    expect(agentOutcome.status, JSON.stringify(agentOutcome.failure)).toBe('accepted');

    const simulationTrail = h.plane.control.query.getAuditTrail('future-ai-lab');
    expect(simulationTrail.length).toBeGreaterThan(0);
    expect(
      simulationTrail.every((entry) => entry.audit.actionResource === 'simulation:future-ai-lab'),
    ).toBe(true);
    expect(simulationTrail.map((entry) => entry.audit.commandId)).toContain(pause.commandId);

    const agentTrail = h.plane.control.query.getAuditTrail('ceo-alex');
    expect(agentTrail.map((entry) => entry.audit.actionResource)).toEqual(['agent:ceo-alex']);
    expect(agentTrail.map((entry) => entry.audit.commandId)).toEqual([agentPause.commandId]);

    expect(h.plane.control.query.getAuditTrail('no-such-resource')).toEqual([]);

    const recentAudits = h.plane.control.query.getRecentAudits(1);
    expect(recentAudits).toHaveLength(1);
    expect(recentAudits[0]?.commandId).toBe(agentPause.commandId);
    expect(recentAudits[0]?.verdict).toBe('accepted');
  });
});
