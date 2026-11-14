import { describe, expect, it } from 'vitest';
import type { Seq } from '@maoeh/event-store';
import { createAcceptanceHarness, ACCEPTANCE_POLICY } from './runtime-harness';
import { loadSeedWorkflows } from '../helpers/simulation-fixtures';

function log(...parts: readonly unknown[]): void {
  console.log(...parts);
}

/**
 * STEP 2 of the runtime acceptance: record the state the company is in *before* anything runs,
 * so every later observation has a baseline to be compared against.
 */
describe('M1.0 runtime acceptance: start state', () => {
  it('captures the initial organization, runtime and log state', async () => {
    const harness = await createAcceptanceHarness();
    const simulation = harness.control.simulation;
    const organization = harness.organization;

    const storedEvents = [];
    for await (const event of simulation.eventStore.replay(1 as Seq)) storedEvents.push(event);

    const baseline = {
      company: organization.company.id,
      departments: organization.departments.map((department) => department.id),
      positions: organization.positions.map((position) => position.id),
      employees: organization.employees.map((employee) => `${employee.id}:${employee.kind}:${employee.status}`),
      aiAgents: [...simulation.agents.keys()],
      workflows: loadSeedWorkflows().map((definition) => definition.workflowId),
      workflowInstances: simulation.instanceStore.all().length,
      tasks: simulation.taskStore.all().length,
      events: storedEvents.map((event) => `${String(event.seq)}:${event.type}`),
      tick: simulation.scheduler.clock.currentTick,
      simTime: Number(simulation.scheduler.clock.simTime),
      tickDuration: simulation.config.tickDuration,
      budget: simulation.config.budget,
      scheduler: {
        paused: simulation.scheduler.paused,
        pendingWakeups: simulation.scheduler.pending().length,
        schedules: simulation.scheduler.schedules().length,
      },
      llmCalls: harness.control.harness.provider.callCount,
      audits: harness.control.audit.recent(100).length,
      channels: simulation.communication.getChannels().length,
      channelIds: simulation.communication.getChannels().map((channel) => channel.channelId),
      messages: simulation.communication.getMessages().length,
      deliveries: simulation.communication.getDeliveries().length,
      recovery: simulation.recovery,
      policyGrants: ACCEPTANCE_POLICY.grants.length,
    };
    log('START STATE\n' + JSON.stringify(baseline, null, 2));

    // The seed company is fully assembled before the first tick.
    expect(baseline.departments.length).toBe(5);
    expect(baseline.positions.length).toBeGreaterThanOrEqual(4);
    expect(baseline.employees).toHaveLength(8);
    expect(baseline.aiAgents).toEqual([
      'ceo-alex',
      'cto-john',
      'engineer-mike',
      'marketing-jack',
      'pm-bona',
      'qa-peter',
    ]);
    expect(baseline.workflows).toHaveLength(4);
    expect(baseline.tasks).toBe(0);
    expect(baseline.workflowInstances).toBe(0);
    expect(baseline.tick).toBe(0);
    expect(baseline.simTime).toBe(0);
    expect(baseline.llmCalls).toBe(0);
    expect(baseline.audits).toBe(0);

    // M1.0.1 K1: a fresh company is not mute — it boots with its company-wide channel, recorded
    // as the first event of the log, without any out-of-band setup step.
    expect(baseline.channelIds).toEqual(['company-future-ai-lab']);
    expect(baseline.messages).toBe(0);
    expect(baseline.events).toEqual(['1:Communication.ChannelOpened']);

    // Tick 0's own marker is still virtual: it exists in memory as `lastTickMarker` but is not
    // appended until the first tick writes its batch, so the recovered cursor stays at 0.
    expect(baseline.recovery.tickNumber).toBe(0);
    // Nothing was replayed on a first boot: recover() now runs before company formation, and the
    // channel is recorded by that formation (asserted above as the first event of the log).
    expect(baseline.recovery.eventCount).toBe(0);
    expect(baseline.recovery.cursor).toBe(0);
  });
});
