import { describe, expect, it } from 'vitest';
import type { SimTime } from '@maoeh/shared-types';
import { createSimulationClock } from '@maoeh/runtime-scheduler';

const t = (value: number): SimTime => value as SimTime;

describe('runtime-scheduler / SimulationClock', () => {
  it('starts at startTime and startTick with aligned simTime', () => {
    const clock = createSimulationClock({ startTime: t(10), tickDuration: 5, startTick: 2 });
    expect(clock.startTime).toBe(10);
    expect(clock.tickDuration).toBe(5);
    expect(clock.currentTick).toBe(2);
    expect(clock.simTime).toBe(20);
  });

  it('advance moves one tick and returns the new simTime', () => {
    const clock = createSimulationClock({ tickDuration: 3 });
    expect(clock.advance()).toBe(3);
    expect(clock.currentTick).toBe(1);
    expect(clock.simTime).toBe(3);
    expect(clock.advance()).toBe(6);
    expect(clock.currentTick).toBe(2);
  });

  it('at(tick) computes an aligned simTime without moving the clock', () => {
    const clock = createSimulationClock({ startTime: t(100), tickDuration: 7, startTick: 1 });
    expect(clock.at(4)).toBe(128);
    expect(clock.currentTick).toBe(1);
    expect(clock.simTime).toBe(107);
  });

  it('seek aligns the tick and rejects unaligned or negative targets', () => {
    const clock = createSimulationClock({ tickDuration: 10 });
    clock.seek(50);
    expect(clock.currentTick).toBe(5);
    expect(clock.simTime).toBe(50);
    expect(() => clock.seek(55)).toThrow(/not aligned/);
    expect(() => clock.seek(-10)).toThrow(/non-negative/);
  });

  it('reset returns to the configured startTick', () => {
    const clock = createSimulationClock({ tickDuration: 2, startTick: 3 });
    clock.advance();
    clock.advance();
    expect(clock.currentTick).toBe(5);
    clock.reset();
    expect(clock.currentTick).toBe(3);
    expect(clock.simTime).toBe(6);
  });

  it('rejects an invalid tickDuration or startTick', () => {
    expect(() => createSimulationClock({ tickDuration: 0 })).toThrow(/positive integer/);
    expect(() => createSimulationClock({ tickDuration: 1.5 })).toThrow(/positive integer/);
    expect(() => createSimulationClock({ startTick: -1 })).toThrow(/non-negative/);
  });

  it('advance continues from a seated tick after seek', () => {
    const clock = createSimulationClock({ tickDuration: 4 });
    clock.seek(12);
    expect(clock.advance()).toBe(16);
    expect(clock.currentTick).toBe(4);
  });
});
