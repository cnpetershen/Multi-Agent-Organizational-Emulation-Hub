import { describe, expect, it } from 'vitest';
import type { EmployeeId } from '@maoeh/shared-types';
import {
  approvalGateOpen,
  collectEvents,
  createControlHarness,
} from '../helpers/control-fixtures';

const CEO = 'ceo-alex';

/**
 * Regression for the M1.0 runtime defect found by dogfooding:
 *
 * An employee paused by the operator used to *lose* any work that arrived while it was paused
 * (the tick cursor moves on and `Control.*` events are deliberately not wakeup-eligible), so
 * `Agent.Resume` left it idle forever and the workflow stalled at the gate.
 *
 * Pause must defer work; resume must deliver the original event.
 */
describe('M1.0 regression: pausing an agent defers its work instead of dropping it', () => {
  it('re-offers the event that arrived while the agent was paused, and advances the workflow', async () => {
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();

    // The CEO does the intake step, then goes on leave.
    await h.harness.run(1);
    expect(
      (await h.plane.control.execute(h.command('Agent.Pause', { targetId: CEO }))).status,
    ).toBe('accepted');

    // The CTO drives the design step and the workflow blocks on the CEO's approval gate.
    const pausedRuns = await h.harness.run(2);
    expect(
      pausedRuns.flatMap((result) => result.turns.map((turn) => turn.employeeId)),
    ).not.toContain(CEO);
    expect(approvalGateOpen(h.simulation, instanceId)).toBe(true);
    // Deferred, not queued: the wakeup queue is a cache and the event log is the source of truth.
    expect(h.simulation.scheduler.pending()).toEqual([]);

    await h.plane.control.execute(h.command('Agent.Resume', { targetId: CEO }));

    const afterResume = await h.harness.run(1);
    const ceoTurns = (afterResume[0]?.turns ?? []).filter((turn) => turn.employeeId === CEO);
    expect(ceoTurns).toHaveLength(1);

    // The recovered turn carries the *original* triggering event, not a tick marker.
    const approval = (await collectEvents(h.simulation.eventStore)).find(
      (event) => event.type === 'Workflow.ApprovalRequested',
    );
    expect(approval).toBeDefined();
    expect(ceoTurns[0]?.sourceEventId).toBe(approval?.eventId);

    // And the recovered work really moved the organization forward.
    expect(h.plane.control.query.getWorkflow(instanceId)?.approval?.status).toBe('granted');
    expect(h.simulation.isAgentPaused(CEO as EmployeeId)).toBe(false);
  });

  it('does not re-offer work the agent already handled before the pause', async () => {
    const h = await createControlHarness();
    await h.harness.startProductAnalysis();
    await h.harness.run(1);
    await h.plane.control.execute(h.command('Agent.Pause', { targetId: CEO }));
    await h.plane.control.execute(h.command('Agent.Resume', { targetId: CEO }));

    // Nothing new arrived for the CEO while it was paused, so resume must not invent a turn for
    // the intake it already handled. (The CTO legitimately works the next step in this tick.)
    const afterResume = await h.harness.run(1);
    expect(
      (afterResume[0]?.turns ?? []).filter((turn) => turn.employeeId === CEO),
    ).toEqual([]);
    expect(afterResume[0]?.turns.length).toBeGreaterThan(0);
  });
});
