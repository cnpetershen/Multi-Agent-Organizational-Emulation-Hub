import type { CompanyId, EmployeeId, SimTime } from '@maoeh/shared-types';
import type { WakeupReason } from './wakeup.js';

export type ScheduleKind = 'interval' | 'at';

export interface ScheduleDefinition {
  readonly scheduleId: string;
  readonly companyId: CompanyId;
  readonly agentId: EmployeeId;
  readonly kind: ScheduleKind;
  readonly everySimMinutes?: number;
  readonly atSim?: SimTime;
  readonly startAtSim?: SimTime;
  readonly endAtSim?: SimTime | null;
  readonly reason?: WakeupReason;
}

export interface ScheduleIssue {
  readonly scheduleId: string;
  readonly field: string;
  readonly reason: string;
}

export interface DueSchedule {
  readonly definition: ScheduleDefinition;
  readonly dueAtSim: SimTime;
}

function fail(scheduleId: string, field: string, reason: string): ScheduleIssue[] {
  return [{ scheduleId, field, reason }];
}

export function validateSchedule(
  definition: ScheduleDefinition,
): readonly ScheduleIssue[] {
  const issues: ScheduleIssue[] = [];
  if (definition.scheduleId === '') {
    issues.push(...fail(definition.scheduleId, 'scheduleId', 'scheduleId must not be empty'));
  }
  if (definition.agentId === '') {
    issues.push(...fail(definition.scheduleId, 'agentId', 'agentId must not be empty'));
  }
  if (definition.companyId === '') {
    issues.push(...fail(definition.scheduleId, 'companyId', 'companyId must not be empty'));
  }
  if (definition.kind === 'interval') {
    const every = definition.everySimMinutes;
    if (every === undefined || !Number.isInteger(every) || every <= 0) {
      issues.push(
        ...fail(
          definition.scheduleId,
          'everySimMinutes',
          'interval schedules require a positive integer everySimMinutes',
        ),
      );
    }
  } else if (definition.kind === 'at') {
    const atSim = definition.atSim;
    if (atSim === undefined || !Number.isInteger(atSim) || atSim < 0) {
      issues.push(
        ...fail(
          definition.scheduleId,
          'atSim',
          'at schedules require a non-negative integer atSim',
        ),
      );
    }
  } else {
    issues.push(
      ...fail(definition.scheduleId, 'kind', `unknown schedule kind "${String(definition.kind)}"`),
    );
  }

  const startAtSim = definition.startAtSim ?? 0;
  if (!Number.isInteger(startAtSim) || startAtSim < 0) {
    issues.push(
      ...fail(definition.scheduleId, 'startAtSim', 'startAtSim must be a non-negative integer'),
    );
  }
  const endAtSim = definition.endAtSim;
  if (endAtSim !== undefined && endAtSim !== null && (!Number.isInteger(endAtSim) || endAtSim < 0)) {
    issues.push(
      ...fail(definition.scheduleId, 'endAtSim', 'endAtSim must be a non-negative integer'),
    );
  }
  if (
    endAtSim !== undefined &&
    endAtSim !== null &&
    Number.isInteger(startAtSim) &&
    endAtSim < startAtSim
  ) {
    issues.push(...fail(definition.scheduleId, 'endAtSim', 'endAtSim precedes startAtSim'));
  }
  return issues;
}

export function firstDueSim(definition: ScheduleDefinition): SimTime | null {
  if (definition.kind === 'at') {
    const atSim = definition.atSim;
    if (atSim === undefined) return null;
    const startAtSim = definition.startAtSim ?? 0;
    return atSim < startAtSim ? null : atSim;
  }
  const startAtSim = definition.startAtSim ?? 0;
  return startAtSim as SimTime;
}

export function nextDueSim(
  definition: ScheduleDefinition,
  afterSim: SimTime,
): SimTime | null {
  const endAtSim = definition.endAtSim ?? null;
  if (endAtSim !== null && afterSim >= endAtSim) return null;

  if (definition.kind === 'at') {
    const atSim = definition.atSim;
    if (atSim === undefined) return null;
    if (atSim <= afterSim) return null;
    if (endAtSim !== null && atSim > endAtSim) return null;
    return atSim;
  }

  const every = definition.everySimMinutes;
  if (every === undefined || !Number.isInteger(every) || every <= 0) return null;
  const startAtSim = definition.startAtSim ?? 0;
  if (afterSim < startAtSim) return startAtSim as SimTime;
  const elapsed = afterSim - startAtSim;
  const periods = Math.floor(elapsed / every) + 1;
  const candidate = startAtSim + periods * every;
  if (endAtSim !== null && candidate > endAtSim) return null;
  return candidate as SimTime;
}

export function dueSchedules(
  definitions: readonly ScheduleDefinition[],
  windowStart: SimTime,
  now: SimTime,
): readonly DueSchedule[] {
  const due: DueSchedule[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'interval') {
      const every = definition.everySimMinutes;
      if (every === undefined || !Number.isInteger(every) || every <= 0) continue;
      const startAtSim = definition.startAtSim ?? 0;
      const endAtSim = definition.endAtSim ?? null;
      if (now < startAtSim) continue;
      if (endAtSim !== null && now > endAtSim) continue;
      const elapsed = now - startAtSim;
      const periods = Math.floor(elapsed / every);
      const lastDue = startAtSim + periods * every;
      if (lastDue > windowStart && lastDue <= now) {
        due.push({ definition, dueAtSim: lastDue as SimTime });
      }
      continue;
    }
    const atSim = definition.atSim;
    if (atSim === undefined) continue;
    if (atSim > windowStart && atSim <= now) {
      due.push({ definition, dueAtSim: atSim });
    }
  }
  due.sort((left, right) => {
    if (left.dueAtSim !== right.dueAtSim) return left.dueAtSim - right.dueAtSim;
    if (left.definition.scheduleId !== right.definition.scheduleId) {
      return left.definition.scheduleId < right.definition.scheduleId ? -1 : 1;
    }
    return 0;
  });
  return due;
}
