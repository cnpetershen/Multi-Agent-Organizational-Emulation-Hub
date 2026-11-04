import { describe, expect, it } from 'vitest';
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

/** The composition root's restart path: replay the log, rebuild audit, rehydrate. */
async function restart(store: ReturnType<typeof createInMemoryEventStore>) {
  const organization = loadSeedOrganizationWithOperators();
  const policy = operatorControlPolicy();
  const harness = await createSimulationHarness({ organization, eventStore: store });
  const audit = createAuditService();
  const plane = createKernelControlPlane({
    simulation: harness.simulation,
    authz: createAuthzService({ organization, policy }),
    registry: harness.simulation.registry,
    eventStore: store,
    auditService: audit,
  });
  await recoverControlPlane(plane.control, plane.audit, store);
  return { harness, plane };
}

/**
 * M1.4 §5.8 — "one `Work.SubmitBrief` = one audit row", across a restart.
 *
 * The live path records the row straight from the command (`actionType = command.commandType`),
 * while the rebuilt path can only know what the kernel's `COMMAND_BY_ACCEPTED_EVENT` inverse map
 * says. The log stays the single source of truth (BASELINE §14), so a brief whose acceptance event
 * is missing from that map is silently skipped during recovery — `?? ''` → `continue` — and the
 * trail loses every brief that was ever submitted. This test pins both directions: the live row
 * and its rebuilt twin must name the same command.
 */
describe('M1.4 brief audit rebuild', () => {
  it('rebuilds the audit row of a submitted brief from the event log alone', async () => {
    const store = createInMemoryEventStore();
    const first = await createControlHarness({ eventStore: store });

    const submitted = await first.plane.control.execute(
      first.command('Work.SubmitBrief', {
        targetId: 'ceo-alex',
        reason: 'board wants the login feature this sprint',
        workBrief: {
          title: 'Login feature',
          goal: 'Ship the login feature this sprint',
          context: 'Handed over by the board.',
          verificationKeys: ['endpoint', 'test-report'],
          priority: 2,
          dueAtSim: 600,
        },
      } as never),
    );
    expect(submitted.status, JSON.stringify(submitted.failure)).toBe('accepted');

    const live = first.plane.control.query
      .getRecentAudits(50)
      .find((record) => record.commandId === submitted.commandId);
    expect(live, 'the live path must record one audit row per command').toBeDefined();
    expect(live?.actionType).toBe('Work.SubmitBrief');
    expect(live?.verdict).toBe('accepted');

    const second = await restart(store);
    const rebuilt = second.plane.control.query
      .getRecentAudits(50)
      .find((record) => record.commandId === submitted.commandId);
    expect(rebuilt, 'a submitted brief must survive a restart as audit history').toBeDefined();
    expect(rebuilt?.actionType).toBe('Work.SubmitBrief');
    expect(rebuilt?.verdict).toBe('accepted');
    expect(rebuilt?.actorId).toBe(live?.actorId);
    expect(rebuilt?.reason).toBe('board wants the login feature this sprint');
    expect(rebuilt?.correlationId).toBe(live?.correlationId);
    expect(rebuilt?.details?.['replayedFromEvent']).toBe(true);

    // The brief itself is still projected from the very same log (§5.4 grouping intact).
    expect(await second.plane.control.query.getWorkBrief('brief-1')).not.toBeNull();
  });
});
