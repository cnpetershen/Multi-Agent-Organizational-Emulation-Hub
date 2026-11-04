import { describe, expect, it, vi } from 'vitest';
import { createInMemoryEventStore } from '@maoeh/event-store';
import { createAuditService } from '@maoeh/audit-system';
import { createAuthzService } from '@maoeh/permission-system';
import { createKernelControlPlane, recoverControlPlane } from '@maoeh/kernel';
import {
  createControlHarness,
  loadSeedOrganizationWithOperators,
  operatorControlPolicy,
} from '../helpers/control-fixtures';
import { createSimulationHarness } from '../helpers/simulation-fixtures';

/**
 * M1.0 §10 — recovery / idempotency / concurrency across a restart.
 *
 * A restarted kernel must (a) still be paused if the operator paused it, and (b) still refuse
 * to re-apply a commandId it already processed — both derived from the event log alone.
 */
async function restart(store: ReturnType<typeof createInMemoryEventStore>) {
  const organization = loadSeedOrganizationWithOperators();
  const policy = operatorControlPolicy();
  const harness = await createSimulationHarness({
    organization,
    eventStore: store,
  });
  const audit = createAuditService();
  const plane = createKernelControlPlane({
    simulation: harness.simulation,
    authz: createAuthzService({ organization, policy }),
    registry: harness.simulation.registry,
    eventStore: store,
    auditService: audit,
  });
  await recoverControlPlane(plane.control, plane.audit, store);
  return { harness, plane, audit, organization, policy };
}

describe('M1.0 recovery: control state survives a kernel restart', () => {
  it('replays an operator pause from the event store after restart', async () => {
    const store = createInMemoryEventStore();
    const first = await createControlHarness({ eventStore: store });

    const start = await first.plane.control.execute(first.command('Simulation.Start'));
    expect(start.status, JSON.stringify(start.failure)).toBe('accepted');
    const pause = await first.plane.control.execute(first.command('Simulation.Pause'));
    expect(pause.status, JSON.stringify(pause.failure)).toBe('accepted');
    expect(first.simulation.scheduler.paused).toBe(true);

    // Restart on the same event store.
    const second = await restart(store);

    // The fresh kernel recovers the clock, and the control plane replays the pause.
    expect(second.harness.simulation.scheduler.paused).toBe(true);
    expect(second.plane.control.state().simulationPaused).toBe(true);
    const tick = await second.harness.simulation.tick();
    expect(tick.status).toBe('paused');
    expect(tick.tickNumber).toBe(second.harness.simulation.scheduler.clock.currentTick);
  });

  it('replays an operator agent pause from the event store after restart', async () => {
    const store = createInMemoryEventStore();
    const first = await createControlHarness({ eventStore: store });
    await first.plane.control.execute(first.command('Simulation.Start'));
    const pauseAgent = await first.plane.control.execute(
      first.command('Agent.Pause', { targetType: 'agent', targetId: 'ceo-alex' }),
    );
    expect(pauseAgent.status, JSON.stringify(pauseAgent.failure)).toBe('accepted');

    const second = await restart(store);
    expect(second.plane.control.state().pausedAgentIds).toContain('ceo-alex');
    expect(second.harness.simulation.isAgentPaused('ceo-alex' as never)).toBe(true);

    // The paused agent is not eligible for a turn while the rest keep working.
    await second.harness.startProductAnalysis();
    const results = await second.harness.run(3);
    const turned = results.flatMap((result) => result.turns.map((turn) => turn.employeeId));
    expect(turned).not.toContain('ceo-alex');
  });

  it('keeps command idempotency across a restart (a replayed commandId never re-applies)', async () => {
    const store = createInMemoryEventStore();
    const first = await createControlHarness({ eventStore: store });
    const command = first.command('Simulation.Start');
    const accepted = await first.plane.control.execute(command);
    expect(accepted.status, JSON.stringify(accepted.failure)).toBe('accepted');
    await first.plane.control.execute(first.command('Simulation.Pause'));

    const second = await restart(store);
    const tickBefore = second.harness.simulation.scheduler.clock.currentTick;

    // Same commandId after restart: it must be recognised as already processed.
    const replay = await second.plane.control.execute(command);
    expect(replay.replayed).toBe(true);
    expect(replay.commandId).toBe(command.commandId);
    expect(second.harness.simulation.scheduler.clock.currentTick).toBe(tickBefore);
  });

  it('rebuilds the audit trail from control events after restart', async () => {
    const store = createInMemoryEventStore();
    const first = await createControlHarness({ eventStore: store });
    const accepted = await first.plane.control.execute(first.command('Simulation.Start'));
    const rejected = await first.plane.control.execute(
      first.command('Simulation.Seek', { tickNumber: 0, extra: {} } as never),
    );
    expect(accepted.status).toBe('accepted');
    expect(rejected.status).toBe('rejected');

    const second = await restart(store);
    const rebuilt = second.plane.control.query.getRecentAudits(50);
    expect(rebuilt.length).toBeGreaterThanOrEqual(2);
    expect(rebuilt.some((entry) => entry.commandId === accepted.commandId)).toBe(true);
    expect(rebuilt.some((entry) => entry.commandId === rejected.commandId)).toBe(true);
    expect(rebuilt.every((entry) => entry.actorId === 'operator-dana')).toBe(true);
  });

  it('rebuilds the audit record of a deletion, whose state is no longer there to re-read', async () => {
    const store = createInMemoryEventStore();
    const first = await createControlHarness({ eventStore: store });
    const instanceId = await first.harness.startProductAnalysis();
    const deleted = await first.plane.control.execute(
      first.command('Workflow.Delete', { targetId: instanceId }),
    );
    expect(deleted.status, JSON.stringify(deleted.failure)).toBe('accepted');

    const second = await restart(store);
    // The instance is gone, so the log is the only place its removal can still be explained.
    expect(second.plane.control.query.getWorkflow(instanceId)).toBeNull();
    const entry = second.plane.control.query
      .getRecentAudits(50)
      .find((record) => record.commandId === deleted.commandId);
    expect(entry, 'a deletion must survive a restart as audit history').toBeDefined();
    expect(entry?.actionType).toBe('Workflow.Delete');
    expect(entry?.verdict).toBe('accepted');
    expect(entry?.actionResource).toBe(`workflow_instance:${instanceId}`);
  });

  it('rejections are recorded on the event log so refusals are replayable too', async () => {
    const store = createInMemoryEventStore();
    const h = await createControlHarness({
      eventStore: store,
      policy: { grants: [], denies: [] },
    });
    const denied = await h.plane.control.execute(h.command('Simulation.Pause'));
    expect(denied.status).toBe('rejected');
    expect(denied.failure?.code).toBe('UNAUTHORIZED');

    const second = await restart(store);
    const rebuilt = second.plane.control.query.getRecentAudits(50);
    const entry = rebuilt.find((record) => record.commandId === denied.commandId);
    expect(entry, 'a refused command must be replayable').toBeDefined();
    expect(entry?.verdict).toBe('rejected');
    expect(entry?.resultCode).toBe('UNAUTHORIZED');
  });

  it('recovery is idempotent: recovering twice does not duplicate audit records', async () => {
    const store = createInMemoryEventStore();
    const first = await createControlHarness({ eventStore: store });
    await first.plane.control.execute(first.command('Simulation.Start'));
    await first.plane.control.execute(first.command('Simulation.Pause'));

    const second = await restart(store);
    const countAfterFirstRecovery = second.plane.control.query.getRecentAudits(100).length;
    await second.harness.simulation.recover();
    const recoveredAgain = second.plane.control.query.getRecentAudits(100);
    expect(recoveredAgain.length).toBe(countAfterFirstRecovery);
  });

  it('seeds the control-event counter from the log so a restart never reissues an event id', async () => {
    const store = createInMemoryEventStore();
    const first = await createControlHarness({ eventStore: store });
    const started = await first.plane.control.execute(first.command('Simulation.Start'));
    expect(started.status, JSON.stringify(started.failure)).toBe('accepted');
    const paused = await first.plane.control.execute(first.command('Simulation.Pause'));
    expect(paused.status, JSON.stringify(paused.failure)).toBe('accepted');

    // `vi.resetModules` drops the process-local control-event counter, exactly as a real restart
    // does. Without seeding it, the fresh plane would reissue `ctrl-evt-1`/`ctrl-evt-2` and the
    // event store would refuse the next command as a duplicate of an already-recorded event.
    vi.resetModules();
    const kernel = await import('@maoeh/kernel');
    const policy = operatorControlPolicy();
    const plane = kernel.createKernelControlPlane({
      simulation: first.simulation,
      authz: createAuthzService({ organization: loadSeedOrganizationWithOperators(), policy }),
      registry: first.simulation.registry,
      eventStore: store,
    });
    await kernel.recoverControlPlane(plane.control, plane.audit, store);

    const afterRestart = first.command('Simulation.Resume');
    const resumed = await plane.control.execute({
      ...afterRestart,
      commandId: 'cmd-after-restart',
      correlationId: 'corr-after-restart',
    });
    expect(resumed.status, JSON.stringify(resumed.failure)).toBe('accepted');
  });
});
