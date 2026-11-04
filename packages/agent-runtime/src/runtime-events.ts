import type { Result } from '@maoeh/shared-types';
import { PRESENCE_STATES } from '@maoeh/shared-types';
import type { EventContractFailure, EventRegistry } from '@maoeh/event-system';
import { z } from 'zod';

export const RUNTIME_PRESENCE_CHANGED = 'Runtime.PresenceChanged';
export const RUNTIME_CYCLE_STARTED = 'Runtime.CycleStarted';
export const RUNTIME_CYCLE_FINISHED = 'Runtime.CycleFinished';
export const RUNTIME_BUDGET_EXCEEDED = 'Runtime.BudgetExceeded';

export const RUNTIME_EVENT_TYPES = [
  RUNTIME_PRESENCE_CHANGED,
  RUNTIME_CYCLE_STARTED,
  RUNTIME_CYCLE_FINISHED,
  RUNTIME_BUDGET_EXCEEDED,
] as const;

export const CYCLE_OUTCOMES = ['acted', 'noop', 'failed'] as const;

export type CycleOutcome = (typeof CYCLE_OUTCOMES)[number];

const idSchema = z.string().min(1).max(128);

export const runtimePresenceChangedPayloadSchema = z.object({
  employeeId: idSchema,
  presence: z.enum(PRESENCE_STATES),
});

export const runtimeCycleStartedPayloadSchema = z.object({
  cycleId: idSchema,
  employeeId: idSchema,
  sourceEventId: idSchema,
  reason: z.string().min(1).max(64),
});

export const runtimeCycleFinishedPayloadSchema = z.object({
  cycleId: idSchema,
  employeeId: idSchema,
  sourceEventId: idSchema,
  outcome: z.enum(CYCLE_OUTCOMES),
  actionCount: z.number().int().min(0),
  goal: z.string().min(1).nullable(),
  failureCode: z.string().min(1).nullable(),
});

export const runtimeBudgetExceededPayloadSchema = z.object({
  cycleId: idSchema.nullable(),
  employeeId: idSchema,
  sourceEventId: idSchema.nullable(),
  reason: z.string().min(1).max(64),
});

function registerOnce(
  registry: EventRegistry,
  type: string,
  schema: z.ZodType<unknown>,
): Result<void, EventContractFailure> {
  if (registry.isRegistered(type)) return { ok: true, value: undefined };
  return registry.register(type, schema);
}

export function registerRuntimeEvents(
  registry: EventRegistry,
): Result<void, EventContractFailure> {
  const registrations: readonly (readonly [string, z.ZodType<unknown>])[] = [
    [RUNTIME_PRESENCE_CHANGED, runtimePresenceChangedPayloadSchema],
    [RUNTIME_CYCLE_STARTED, runtimeCycleStartedPayloadSchema],
    [RUNTIME_CYCLE_FINISHED, runtimeCycleFinishedPayloadSchema],
    [RUNTIME_BUDGET_EXCEEDED, runtimeBudgetExceededPayloadSchema],
  ];
  for (const [type, schema] of registrations) {
    const result = registerOnce(registry, type, schema);
    if (!result.ok) return result;
  }
  return { ok: true, value: undefined };
}

export function isRuntimeEvent(type: string): boolean {
  return (RUNTIME_EVENT_TYPES as readonly string[]).includes(type);
}
