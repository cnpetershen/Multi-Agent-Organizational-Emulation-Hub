import { describe, expect, it } from 'vitest';
import type { PermissionPolicy } from '@maoeh/permission-system';
import {
  collectEvents,
  createControlHarness,
  operatorControlPolicy,
} from '../helpers/control-fixtures';

describe('M1.0 §27: human intervention never breaks autonomous operation', () => {
  it('keeps the company running through start / intervene / continue', async () => {
    const h = await createControlHarness();

    // Autonomous phase 1.
    const start = await h.plane.control.execute(h.command('Simulation.Start'));
    expect(start.status, JSON.stringify(start.failure)).toBe('accepted');
    const instanceId = await h.harness.startProductAnalysis();
    await h.harness.run(2);
    const tickBefore = h.simulation.scheduler.clock.currentTick;
    expect(tickBefore).toBe(3);

    // Human intervention: pause an agent and inject a new task.
    const pause = await h.plane.control.execute(
      h.command('Agent.Pause', {
        targetType: 'agent',
        targetId: 'engineer-mike',
        reason: 'mike is under review',
      }),
    );
    expect(pause.status, JSON.stringify(pause.failure)).toBe('accepted');

    const injected = await h.plane.control.execute(
      h.command('Organization.InjectTask', {
        targetType: 'organization',
        targetId: 'future-ai-lab',
        positionId: 'cto',
        title: 'Draft a migration plan',
        goal: 'Produce a migration plan',
        reason: 'board asked for it',
      } as never),
    );
    expect(injected.status, JSON.stringify(injected.failure)).toBe('accepted');

    // The simulation keeps running with the intervention in place.
    await h.harness.run(6);

    // The company is still alive and progressing.
    expect(h.simulation.scheduler.clock.currentTick).toBeGreaterThan(tickBefore);
    expect(h.simulation.scheduler.paused).toBe(false);

    // Independent autonomous progress still happened.
    const instance = h.simulation.instanceStore.get(instanceId);
    expect(instance).not.toBeNull();
    expect(['running', 'blocked', 'completed']).toContain(instance?.status);

    // The event store keeps an append-only, complete history.
    const events = await h.plane.control.query.getEventStream({ limit: 500 });
    expect(events.length).toBeGreaterThan(5);
    let previous = 0;
    for (const event of events) {
      expect(event.seq).toBeGreaterThan(previous);
      previous = event.seq;
    }

    // Every operator action remains audited.
    expect(h.plane.control.query.getRecentAudits(50).length).toBe(3);
    expect(h.audit.find(start.commandId)?.verdict).toBe('accepted');
  });

  it('pause does not kill: recovery, scheduler and state survive an operator pause', async () => {
    const h = await createControlHarness();
    await h.plane.control.execute(h.command('Simulation.Start'));
    const instanceId = await h.harness.startProductAnalysis();
    await h.harness.run(2);

    const eventsBefore = await collectEvents(h.simulation.eventStore);
    const pause = await h.plane.control.execute(h.command('Simulation.Pause'));
    expect(pause.status, JSON.stringify(pause.failure)).toBe('accepted');

    // While paused nothing moves and nothing is emitted.
    const pausedTick = await h.simulation.tick();
    expect(pausedTick.status).toBe('paused');
    expect(pausedTick.emittedEvents).toEqual([]);

    // EventStore intact: every pre-pause event is still replayable and unchanged.
    const eventsDuringPause = await collectEvents(h.simulation.eventStore);
    expect(
      eventsDuringPause.slice(0, eventsBefore.length).map((event) => event.eventId),
    ).toEqual(eventsBefore.map((event) => event.eventId));

    // Scheduler and workflow state intact.
    expect(h.simulation.scheduler.pending()).toEqual([]);
    expect(h.simulation.instanceStore.get(instanceId)).not.toBeNull();
    for (const employeeId of h.simulation.agents.keys()) {
      expect(h.simulation.stateStore.load(employeeId).version).toBeGreaterThanOrEqual(0);
    }

    // Recovery works while paused.
    const report = await h.simulation.recover();
    expect(report.eventCount).toBe(eventsDuringPause.length);
    expect(report.workflowInstanceCount).toBe(1);

    // Resume and the company continues where it stopped.
    const resume = await h.plane.control.execute(h.command('Simulation.Resume'));
    expect(resume.status, JSON.stringify(resume.failure)).toBe('accepted');
    const next = await h.simulation.tick();
    expect(next.status).not.toBe('paused');
    expect(next.tickNumber).toBe(report.tickNumber + 1);
  });

  it('a paused agent is skipped while the rest of the organization keeps working', async () => {
    const h = await createControlHarness();
    await h.plane.control.execute(h.command('Simulation.Start'));

    // Pause the QA engineer the seeded workflow does not need, so the workflow can still
    // advance while the paused employee is never woken.
    const pauseEngineer = await h.plane.control.execute(
      h.command('Agent.Pause', { targetType: 'agent', targetId: 'engineer-mike' }),
    );
    expect(pauseEngineer.status, JSON.stringify(pauseEngineer.failure)).toBe('accepted');

    const instanceId = await h.harness.startProductAnalysis();
    const results = await h.harness.run(3);
    const turnEmployees = results.flatMap((result) =>
      result.turns.map((turn) => turn.employeeId),
    );
    expect(turnEmployees).not.toContain('engineer-mike');
    // Other agents still got their turns and the workflow moved forward.
    expect(turnEmployees.length).toBeGreaterThan(0);
    expect(h.simulation.scheduler.paused).toBe(false);
    expect(h.simulation.instanceStore.get(instanceId)?.status).not.toBeNull();

    // Resume restores eligibility.
    const resumeEngineer = await h.plane.control.execute(
      h.command('Agent.Resume', { targetType: 'agent', targetId: 'engineer-mike' }),
    );
    expect(resumeEngineer.status, JSON.stringify(resumeEngineer.failure)).toBe('accepted');
    expect(h.simulation.isAgentPaused('engineer-mike' as never)).toBe(false);
  });

  it('every control path preserves permission, authority and audit enforcement', async () => {
    const policy: PermissionPolicy = operatorControlPolicy();
    const h = await createControlHarness({ policy });

    // Denied path: a structurally valid command still cannot bypass authorization.
    const deniedPlane = await createControlHarness({
      policy: { grants: [], denies: [] },
    });
    const denied = await deniedPlane.plane.control.execute(
      deniedPlane.command('Simulation.Pause'),
    );
    expect(denied.status).toBe('rejected');
    expect(denied.failure?.code).toBe('UNAUTHORIZED');
    expect(deniedPlane.simulation.scheduler.paused).toBe(false);
    expect(deniedPlane.plane.control.query.getRecentAudits(10)).toHaveLength(1);

    // Accepted path: the audit trail proves actor, reason and outcome.
    const accepted = await h.plane.control.execute(
      h.command('Simulation.Pause', { reason: 'maintenance window' }),
    );
    expect(accepted.status, JSON.stringify(accepted.failure)).toBe('accepted');
    const record = h.audit.find(accepted.commandId);
    expect(record?.actorId).toBe('operator-dana');
    expect(record?.actorKind).toBe('human');
    expect(record?.action.reason).toBe('maintenance window');
    expect(record?.verdict).toBe('accepted');
  });
});
