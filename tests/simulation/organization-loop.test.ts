import { beforeAll, describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import type { SimulationHarness } from '../helpers/simulation-fixtures';
import { createSimulationHarness } from '../helpers/simulation-fixtures';

const TICKS = 6;

function typesOf(events: readonly OrgEvent[]): readonly string[] {
  return events.map((event) => event.type);
}

describe('M0.9 simulation: organization loop', () => {
  let harness: SimulationHarness;
  let instanceId: string;
  let emitted: readonly OrgEvent[];

  beforeAll(async () => {
    harness = await createSimulationHarness();
    instanceId = await harness.startProductAnalysis();
    const results = await harness.run(TICKS);
    emitted = results.flatMap((result) => result.emittedEvents);
  });

  it('advances the simulation clock one tick per call and stamps a tick marker', async () => {
    const fresh = await createSimulationHarness();
    await fresh.startProductAnalysis();
    const results = await fresh.run(3);
    expect(results.map((result) => result.tickNumber)).toEqual([1, 2, 3]);
    expect(results.map((result) => result.simTime)).toEqual([1, 2, 3]);
    expect(results.map((result) => result.deltaSim)).toEqual([1, 1, 1]);
    for (const result of results) {
      const marker = result.emittedEvents.at(-1);
      expect(marker?.type).toBe('System.SimClockTicked');
      expect(marker?.eventId).toMatch(/^evt-/);
      expect((marker?.payload as { readonly tickNumber?: number }).tickNumber).toBe(
        result.tickNumber,
      );
    }
  });

  it('drives CEO -> CTO -> approval -> CTO to workflow completion', () => {
    const instance = harness.simulation.instanceStore.get(instanceId);
    expect(instance).not.toBeNull();
    expect(instance?.status).toBe('completed');
    expect(instance?.activeStepIds).toEqual([]);
    for (const stepId of ['intake-brief', 'design-approach', 'design-gate', 'delivery-synthesize']) {
      expect(instance?.stepStates[stepId]?.status, stepId).toBe('done');
    }
  });

  it('completes every workflow-backed task with a produced result', () => {
    const instance = harness.simulation.instanceStore.get(instanceId);
    for (const stepId of ['intake-brief', 'design-approach', 'delivery-synthesize']) {
      const taskId = instance?.stepStates[stepId]?.taskId ?? '';
      const task = harness.simulation.tasks.get(taskId);
      expect(task, stepId).not.toBeNull();
      expect(task?.status, stepId).toBe('completed');
      expect(task?.result, stepId).not.toBeNull();
    }
  });

  it('emits exactly one InstanceCompleted and one StepCompleted per completed step', async () => {
    const fresh = await createSimulationHarness();
    await fresh.startProductAnalysis();
    const results = await fresh.run(TICKS);
    const events = results.flatMap((result) => result.emittedEvents);
    expect(events.filter((event) => event.type === 'Workflow.InstanceCompleted')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'Workflow.StepCompleted')).toHaveLength(4);
  });

  it('reacts to each task exactly once (no duplicate completion)', () => {
    const completions = emitted.filter((event) => event.type === 'Task.Completed');
    const taskIds = completions.map(
      (event) => (event.payload as { readonly taskId?: string }).taskId,
    );
    expect(taskIds).toHaveLength(3);
    expect(new Set(taskIds).size).toBe(3);
  });

  it('records agent turns for the expected employees and tick statuses', async () => {
    const fresh = await createSimulationHarness();
    await fresh.startProductAnalysis();
    const results = await fresh.run(TICKS);
    expect(results.map((result) => result.status)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'idle',
      'idle',
    ]);
    // 模板任务步声明能力而不是座席：intake/delivery 是 product_requirement（→ pm-bona），
    // design 是 technical_design（→ cto-john），approval 是治理门（required_roles: ceo）。
    expect(results[0]?.turns.map((turn) => turn.employeeId)).toEqual(['pm-bona']);
    expect(results[1]?.turns.map((turn) => turn.employeeId)).toEqual(['cto-john']);
    expect(results[2]?.turns.map((turn) => turn.employeeId)).toEqual(['ceo-alex']);
    expect(results[3]?.turns.map((turn) => turn.employeeId)).toEqual(['pm-bona']);
    expect(results[4]?.turns).toEqual([]);
  });

  it('only invokes cognition once per productive turn', async () => {
    const fresh = await createSimulationHarness();
    await fresh.startProductAnalysis();
    const results = await fresh.run(TICKS);
    const turns = results.flatMap((result) => result.turns);
    expect(fresh.provider.callCount).toBe(4);
    expect(turns).toHaveLength(4);
  });

  it('keeps the simulation cursor monotonic and aligned with input consumption', async () => {
    const fresh = await createSimulationHarness();
    await fresh.startProductAnalysis();
    const results = await fresh.run(TICKS);
    for (const result of results) {
      expect(result.cursor).toBeGreaterThanOrEqual(result.cursorBefore);
    }
    for (let index = 1; index < results.length; index += 1) {
      expect(results[index]?.cursorBefore).toBe(results[index - 1]?.cursor);
    }
  });

  it('stamps every emitted event with the current tick simulation time', async () => {
    const fresh = await createSimulationHarness();
    await fresh.startProductAnalysis();
    const results = await fresh.run(TICKS);
    for (const result of results) {
      for (const event of result.emittedEvents) {
        expect(event.occurredAtSim, event.type).toBe(result.simTime);
      }
    }
    const all = results.flatMap((result) => result.emittedEvents);
    expect(typesOf(all)).toContain('Workflow.ApprovalRequested');
    expect(typesOf(all)).toContain('Workflow.ApprovalGranted');
  });

  it('captures recovery metadata for the booted simulation', () => {
    expect(harness.simulation.recovery.cursor).toBe(0);
    expect(harness.simulation.recovery.tickNumber).toBe(0);
    // A booted company already has exactly one record: its own formation
    // (`Communication.ChannelOpened`, the company channel every fresh simulation boots with),
    // so nothing has been consumed yet and the cursor is still 0.
    expect(harness.simulation.recovery.eventCount).toBe(1);
  });
});
