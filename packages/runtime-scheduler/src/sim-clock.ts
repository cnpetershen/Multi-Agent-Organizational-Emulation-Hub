import type { SimTime } from '@maoeh/shared-types';

export interface SimulationClockOptions {
  readonly startTime?: SimTime;
  readonly tickDuration?: number;
  readonly startTick?: number;
}

export interface SimulationClock {
  readonly startTime: SimTime;
  readonly tickDuration: number;
  readonly currentTick: number;
  readonly simTime: SimTime;
  advance(): SimTime;
  seek(target: SimTime): void;
  at(tick: number): SimTime;
  reset(): void;
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer, received ${String(value)}`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer, received ${String(value)}`);
  }
}

export function createSimulationClock(
  options?: SimulationClockOptions,
): SimulationClock {
  const startTime = options?.startTime ?? (0 as SimTime);
  const tickDuration = options?.tickDuration ?? 1;
  const startTick = options?.startTick ?? 0;

  assertNonNegativeInteger(startTime, 'startTime');
  assertPositiveInteger(tickDuration, 'tickDuration');
  assertNonNegativeInteger(startTick, 'startTick');

  let currentTick = startTick;

  const simTimeAt = (tick: number): SimTime => (startTime + tick * tickDuration) as SimTime;

  return {
    startTime,
    tickDuration,
    get currentTick() {
      return currentTick;
    },
    get simTime() {
      return simTimeAt(currentTick);
    },
    advance() {
      currentTick += 1;
      return simTimeAt(currentTick);
    },
    seek(target) {
      assertNonNegativeInteger(target, 'target');
      const offset = target - startTime;
      if (offset % tickDuration !== 0) {
        throw new Error(
          `target ${String(target)} is not aligned to tickDuration ${String(tickDuration)}`,
        );
      }
      currentTick = offset / tickDuration;
    },
    at(tick) {
      assertNonNegativeInteger(tick, 'tick');
      return simTimeAt(tick);
    },
    reset() {
      currentTick = startTick;
    },
  };
}
