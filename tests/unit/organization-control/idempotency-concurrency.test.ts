import { describe, expect, it } from 'vitest';
import type { Seq } from '@maoeh/event-store';
import type { Simulation } from '@maoeh/kernel';
import type { EmployeeId, OrgEvent } from '@maoeh/shared-types';

import { createControlHarness } from '../../helpers/control-fixtures';

/** Replay the whole event log so idempotency can be asserted against the store, not the outcome. */
async function storedEvents(simulation: Simulation): Promise<readonly OrgEvent[]> {
  const collected: OrgEvent[] = [];
  for await (const event of simulation.eventStore.replay(1 as Seq)) collected.push(event);
  return collected;
}

async function controlEventTypes(simulation: Simulation): Promise<readonly string[]> {
  return (await storedEvents(simulation))
    .filter((event) => event.type.startsWith('Control.'))
    .map((event) => event.type);
}

function payloadString(event: OrgEvent | undefined, key: string): string | null {
  if (event === undefined) return null;
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Readonly<Record<string, unknown>>)[key];
  return typeof value === 'string' ? value : null;
}

/** Rejections are logged as `Control.CommandRejected` (docs/architecture/M1.0 §7.3). */
async function rejectionsFor(simulation: Simulation, commandId: string): Promise<readonly OrgEvent[]> {
  return (await storedEvents(simulation)).filter(
    (event) => event.type === 'Control.CommandRejected' && payloadString(event, 'commandId') === commandId,
  );
}

describe('M1.0 control plane: idempotency', () => {
  it('replays the same commandId without applying it twice', async () => {
    const h = await createControlHarness();
    const command = h.command('Simulation.Pause');

    const first = await h.plane.control.execute(command);
    expect(first.status, JSON.stringify(first.failure)).toBe('accepted');
    expect(first.replayed).toBe(false);

    const second = await h.plane.control.execute(command);
    expect(second.status, JSON.stringify(second.failure)).toBe('accepted');
    expect(second.replayed).toBe(true);
    expect(second.events).toEqual(first.events);
    expect(second.auditId).toBe(first.auditId);
    expect(first.auditId).not.toBe('');

    expect(await controlEventTypes(h.simulation)).toEqual(['Control.SimulationPaused']);
  });

  it('is idempotent for Simulation.Pause', async () => {
    const h = await createControlHarness();
    const command = h.command('Simulation.Pause');

    const first = await h.plane.control.execute(command);
    const second = await h.plane.control.execute(command);

    expect(first.status, JSON.stringify(first.failure)).toBe('accepted');
    expect(second.replayed).toBe(true);
    expect(await controlEventTypes(h.simulation)).toEqual(['Control.SimulationPaused']);
    expect(h.audit.query({ commandId: command.commandId })).toHaveLength(1);
  });

  it('is idempotent for Agent.Pause', async () => {
    const h = await createControlHarness();
    const command = h.command('Agent.Pause', { targetId: 'ceo-alex' });

    const first = await h.plane.control.execute(command);
    const second = await h.plane.control.execute(command);

    expect(first.status, JSON.stringify(first.failure)).toBe('accepted');
    expect(second.status, JSON.stringify(second.failure)).toBe('accepted');
    expect(second.replayed).toBe(true);
    expect(second.events).toEqual(first.events);
    expect(await controlEventTypes(h.simulation)).toEqual(['Control.AgentPaused']);
  });

  it('is idempotent for Organization.InjectTask: a repeated commandId creates exactly one task', async () => {
    const h = await createControlHarness();
    const command = h.command('Organization.InjectTask', {
      targetType: 'organization',
      targetId: 'future-ai-lab',
      extra: {
        positionId: 'ceo',
        title: 'Research a new market',
        goal: 'Explain the opportunity',
      },
    });

    const first = await h.plane.control.execute(command);
    expect(first.status, JSON.stringify(first.failure)).toBe('accepted');
    expect(h.plane.control.query.getTasks()).toHaveLength(1);

    const second = await h.plane.control.execute(command);
    expect(second.status, JSON.stringify(second.failure)).toBe('accepted');
    expect(second.replayed).toBe(true);
    expect(second.events).toEqual(first.events);

    const tasks = h.plane.control.query.getTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('Research a new market');
    expect(await controlEventTypes(h.simulation)).toEqual([
      'Control.TaskInjected',
    ]);
  });

  it('rejects the same commandId reused with a different payload as CONFLICT', async () => {
    const h = await createControlHarness();
    const first = h.command('Simulation.Pause');
    const accepted = await h.plane.control.execute(first);
    expect(accepted.status, JSON.stringify(accepted.failure)).toBe('accepted');

    const conflicting = h.command('Simulation.Pause', {
      commandId: first.commandId,
      reason: 'a completely different intent for the same commandId',
    });
    const outcome = await h.plane.control.execute(conflicting);

    expect(outcome.status).toBe('rejected');
    expect(outcome.failure?.code, JSON.stringify(outcome.failure)).toBe('CONFLICT');
    expect(outcome.failure?.issues[0]?.field).toBe('commandId');
    expect(outcome.events).toEqual([]);
    expect(await controlEventTypes(h.simulation)).toEqual(['Control.SimulationPaused']);
  });
});

describe('M1.0 control plane: optimistic concurrency', () => {
  it('accepts expectedVersion equal to the current simulation tick', async () => {
    const h = await createControlHarness();
    expect(h.simulation.scheduler.clock.currentTick).toBe(0);

    const outcome = await h.plane.control.execute(
      h.command('Simulation.Pause', { expectedVersion: 0 }),
    );

    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    expect(h.simulation.scheduler.paused).toBe(true);
  });

  it('rejects expectedVersion below the current tick as STALE_VERSION', async () => {
    const h = await createControlHarness();
    const start = await h.plane.control.execute(h.command('Simulation.Start'));
    expect(start.status, JSON.stringify(start.failure)).toBe('accepted');
    expect(h.simulation.scheduler.clock.currentTick).toBe(1);

    const stale = h.command('Simulation.Pause', { expectedVersion: 0 });
    const outcome = await h.plane.control.execute(stale);

    expect(outcome.status).toBe('rejected');
    expect(outcome.failure?.code, JSON.stringify(outcome.failure)).toBe('STALE_VERSION');
    expect(outcome.failure?.actualVersion).toBe(1);

    const rejections = await rejectionsFor(h.simulation, stale.commandId);
    expect(rejections).toHaveLength(1);
    expect(outcome.events).toEqual([rejections[0]?.eventId]);
  });

  it('a stale rejection changes no state and appends no fact event', async () => {
    const h = await createControlHarness();
    const start = await h.plane.control.execute(h.command('Simulation.Start'));
    expect(start.status, JSON.stringify(start.failure)).toBe('accepted');

    const before = await controlEventTypes(h.simulation);
    expect(before).toEqual(['Control.SimulationStarted']);

    const stale = h.command('Simulation.Pause', { expectedVersion: 0 });
    const outcome = await h.plane.control.execute(stale);

    expect(outcome.status).toBe('rejected');
    expect(outcome.failure?.code).toBe('STALE_VERSION');
    expect(h.simulation.scheduler.paused).toBe(false);
    expect(h.plane.control.query.getSimulationState().status).toBe('running');

    const after = await controlEventTypes(h.simulation);
    expect(after).not.toContain('Control.SimulationPaused');
    expect(after).toEqual([...before, 'Control.CommandRejected']);

    const rejections = await rejectionsFor(h.simulation, stale.commandId);
    expect(rejections).toHaveLength(1);
    expect(payloadString(rejections[0], 'resultCode')).toBe('STALE_VERSION');
    expect(outcome.events).toEqual([rejections[0]?.eventId]);
  });

  it('Agent.Pause honours the agent AgentState version', async () => {
    const h = await createControlHarness();
    await h.harness.startProductAnalysis();
    await h.harness.run(3);

    const runtime = h.plane.control.query.getAgentRuntimeState('ceo-alex' as EmployeeId);
    expect(runtime).not.toBeNull();
    const version = runtime?.version ?? -1;
    expect(version).toBeGreaterThan(0);

    const stale = await h.plane.control.execute(
      h.command('Agent.Pause', { targetId: 'ceo-alex', expectedVersion: version - 1 }),
    );
    expect(stale.status).toBe('rejected');
    expect(stale.failure?.code, JSON.stringify(stale.failure)).toBe('STALE_VERSION');
    expect(stale.failure?.actualVersion).toBe(version);
    expect(h.plane.control.query.getAgentRuntimeState('ceo-alex' as EmployeeId)?.paused).toBe(
      false,
    );

    const accepted = await h.plane.control.execute(
      h.command('Agent.Pause', { targetId: 'ceo-alex', expectedVersion: version }),
    );
    expect(accepted.status, JSON.stringify(accepted.failure)).toBe('accepted');
    expect(h.plane.control.query.getAgentRuntimeState('ceo-alex' as EmployeeId)?.paused).toBe(
      true,
    );
  });

  it('rejects a second pause of an already paused agent as CONFLICT', async () => {
    const h = await createControlHarness();

    const first = await h.plane.control.execute(
      h.command('Agent.Pause', { targetId: 'ceo-alex' }),
    );
    expect(first.status, JSON.stringify(first.failure)).toBe('accepted');

    const secondCommand = h.command('Agent.Pause', { targetId: 'ceo-alex' });
    const second = await h.plane.control.execute(secondCommand);
    expect(second.status).toBe('rejected');
    expect(second.failure?.code, JSON.stringify(second.failure)).toBe('CONFLICT');
    expect(await controlEventTypes(h.simulation)).toEqual([
      'Control.AgentPaused',
      'Control.CommandRejected',
    ]);

    const rejections = await rejectionsFor(h.simulation, secondCommand.commandId);
    expect(rejections).toHaveLength(1);
    expect(payloadString(rejections[0], 'resultCode')).toBe('CONFLICT');
    expect(second.events).toEqual([rejections[0]?.eventId]);
  });

  it('keeps exactly one of two concurrently issued Agent.Pause commands', async () => {
    const h = await createControlHarness();

    const outcomes = await Promise.all([
      h.plane.control.execute(h.command('Agent.Pause', { targetId: 'ceo-alex' })),
      h.plane.control.execute(h.command('Agent.Pause', { targetId: 'ceo-alex' })),
    ]);

    const accepted = outcomes.filter((outcome) => outcome.status === 'accepted');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.failure?.code, JSON.stringify(rejected[0]?.failure)).toBe('CONFLICT');

    const types = await controlEventTypes(h.simulation);
    expect(types.filter((type) => type === 'Control.AgentPaused')).toHaveLength(1);
    expect(types.filter((type) => type === 'Control.CommandRejected')).toHaveLength(1);
  });
});
