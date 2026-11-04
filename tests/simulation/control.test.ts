import { describe, expect, it } from 'vitest';
import { createSimulationHarness } from '../helpers/simulation-fixtures';

describe('M0.9 simulation: control and budget', () => {
  it('pauses the clock without emitting or consuming events', async () => {
    const harness = await createSimulationHarness();
    await harness.startProductAnalysis();
    harness.simulation.pause();
    expect(harness.simulation.scheduler.paused).toBe(true);
    const paused = await harness.simulation.tick();
    expect(paused.status).toBe('paused');
    expect(paused.emittedEvents).toEqual([]);
    expect(paused.turns).toEqual([]);
    expect(paused.cursor).toBe(0);
    expect(harness.simulation.scheduler.clock.currentTick).toBe(0);
  });

  it('resumes and advances normally after a pause', async () => {
    const harness = await createSimulationHarness();
    await harness.startProductAnalysis();
    harness.simulation.pause();
    await harness.simulation.tick();
    harness.simulation.resume();
    const resumed = await harness.simulation.tick();
    expect(resumed.status).toBe('ok');
    expect(resumed.tickNumber).toBe(1);
    expect(resumed.turns).toHaveLength(1);
  });

  it('halts before any turn when the event budget is exhausted', async () => {
    const harness = await createSimulationHarness({ budget: { maxEvents: 1 } });
    await harness.startProductAnalysis();
    const result = await harness.simulation.tick();
    expect(result.status).toBe('budget_exceeded');
    expect(result.turns).toEqual([]);
    expect(result.budget.exceeded).toContain('max_events');
  });

  it('halts when the llm call budget is exhausted', async () => {
    const harness = await createSimulationHarness({ budget: { maxLlmCalls: 0 } });
    await harness.startProductAnalysis();
    const result = await harness.simulation.tick();
    expect(result.status).toBe('budget_exceeded');
    expect(result.turns).toEqual([]);
    expect(result.budget.exceeded).toContain('max_llm_calls');
  });

  it('halts when the agent turn budget is exhausted', async () => {
    const harness = await createSimulationHarness({ budget: { maxAgentTurns: 0 } });
    await harness.startProductAnalysis();
    const result = await harness.simulation.tick();
    expect(result.status).toBe('budget_exceeded');
    expect(result.turns).toEqual([]);
    expect(result.budget.exceeded).toContain('max_agent_turns');
  });

  it('reports idle once the organization has nothing to do', async () => {
    const harness = await createSimulationHarness();
    await harness.startProductAnalysis();
    const results = await harness.run(8);
    const idle = results.filter((result) => result.status === 'idle');
    expect(idle.length).toBeGreaterThanOrEqual(3);
    for (const result of idle) {
      expect(result.wakeupCount).toBe(0);
      expect(result.turns).toEqual([]);
      expect(result.reactorEventCount).toBe(0);
    }
  });

  it('seek jumps the clock forward to a future tick', async () => {
    const harness = await createSimulationHarness();
    await harness.startProductAnalysis();
    harness.simulation.seek(10);
    expect(harness.simulation.scheduler.clock.currentTick).toBe(10);
    const result = await harness.simulation.tick();
    expect(result.tickNumber).toBe(11);
    expect(result.simTime).toBe(11);
  });
});
