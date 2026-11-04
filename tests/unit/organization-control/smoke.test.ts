import { describe, expect, it } from 'vitest';
import { createControlHarness } from '../../helpers/control-fixtures';

describe('M1.0 control plane: smoke', () => {
  it('builds a control plane over the running simulation with a human operator', async () => {
    const h = await createControlHarness();
    expect(h.plane.control).toBeDefined();
    expect(h.organization.employees.map((e) => e.id)).toContain('operator-dana');
    expect(h.simulation.agents.size).toBe(6);
  });

  it('starts and pauses the simulation through an authorized command', async () => {
    const h = await createControlHarness();
    const start = await h.plane.control.execute(h.command('Simulation.Start'));
    expect(start.status, JSON.stringify(start.failure)).toBe('accepted');
    expect(start.events).toContain('ctrl-evt-1');
    expect(h.simulation.scheduler.clock.currentTick).toBe(1);

    const pause = await h.plane.control.execute(h.command('Simulation.Pause'));
    expect(pause.status, JSON.stringify(pause.failure)).toBe('accepted');
    expect(h.simulation.scheduler.paused).toBe(true);

    const tick = await h.simulation.tick();
    expect(tick.status).toBe('paused');
    expect(h.simulation.scheduler.clock.currentTick).toBe(1);
  });

  it('rejects control commands when the operator has no grant', async () => {
    const h = await createControlHarness({ policy: { grants: [], denies: [] } });
    const outcome = await h.plane.control.execute(h.command('Simulation.Pause'));
    expect(outcome.status).toBe('rejected');
    expect(outcome.failure?.code).toBe('UNAUTHORIZED');
    expect(h.simulation.scheduler.paused).toBe(false);
  });

  it('is idempotent per commandId', async () => {
    const h = await createControlHarness();
    const command = h.command('Simulation.Pause');
    const first = await h.plane.control.execute(command);
    const second = await h.plane.control.execute(command);
    expect(first.status).toBe('accepted');
    expect(second.status).toBe('accepted');
    expect(second.replayed).toBe(true);
    expect(second.events).toEqual(first.events);
  });

  it('injects a task into the organization through the normal task mechanism', async () => {
    const h = await createControlHarness();
    const outcome = await h.plane.control.execute(
      h.command('Organization.InjectTask', {
        targetType: 'organization',
        targetId: 'future-ai-lab',
        positionId: 'ceo',
        title: 'Research a new market',
        goal: 'Explain the opportunity',
      } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    const tasks = h.plane.control.query.getTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('Research a new market');
  });

  it('exposes an organization snapshot', async () => {
    const h = await createControlHarness();
    const snapshot = await h.plane.control.query.getOrganizationSnapshot();
    expect(snapshot.company.id).toBe('future-ai-lab');
    expect(snapshot.employees.length).toBeGreaterThanOrEqual(5);
    expect(snapshot.agents).toHaveLength(8);
  });
});
