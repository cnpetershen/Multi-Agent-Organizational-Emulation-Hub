import { z } from 'zod';
import type { Result } from '@maoeh/shared-types';
import type { EventContractFailure, EventRegistry } from '@maoeh/event-system';
import { SIMULATION_TICK_STATUSES } from './types.js';

export const SYSTEM_SIM_CLOCK_TICKED = 'System.SimClockTicked';

export const simClockTickedPayloadSchema = z.object({
  tickNumber: z.number().int().min(0),
  simTime: z.number().int().min(0),
  windowStartSim: z.number().int().min(0),
  deltaSim: z.number().int().min(1),
  status: z.enum(SIMULATION_TICK_STATUSES),
  cursorSeq: z.number().int().min(0),
  inputEventCount: z.number().int().min(0),
  wakeupCount: z.number().int().min(0),
  turnCount: z.number().int().min(0),
  emittedCount: z.number().int().min(0),
});

export type SimClockTickedPayload = z.infer<typeof simClockTickedPayloadSchema>;

export function registerSystemEvents(
  registry: EventRegistry,
): Result<void, EventContractFailure> {
  if (registry.isRegistered(SYSTEM_SIM_CLOCK_TICKED)) {
    return { ok: true, value: undefined };
  }
  return registry.register(SYSTEM_SIM_CLOCK_TICKED, simClockTickedPayloadSchema);
}
