import { describe, expect, it } from 'vitest';
import type { CompanyId, EmployeeId, SimTime } from '@maoeh/shared-types';
import type { ScheduleDefinition } from '@maoeh/runtime-scheduler';
import {
  dueSchedules,
  nextDueSim,
  validateSchedule,
} from '@maoeh/runtime-scheduler';

const companyId = 'future-ai-lab' as CompanyId;
const agentId = 'ceo-alex' as EmployeeId;
const sim = (value: number): SimTime => value as SimTime;

function definition(overrides: Partial<ScheduleDefinition> = {}): ScheduleDefinition {
  return {
    scheduleId: 'heartbeat',
    companyId,
    agentId,
    kind: 'interval',
    everySimMinutes: 10,
    startAtSim: sim(0),
    ...overrides,
  };
}

describe('runtime-scheduler / schedule', () => {
  it('accepts a valid interval schedule and a valid at schedule', () => {
    expect(validateSchedule(definition())).toEqual([]);
    expect(
      validateSchedule(definition({ kind: 'at', atSim: sim(30), everySimMinutes: undefined })),
    ).toEqual([]);
  });

  it('rejects interval schedules without a positive everySimMinutes', () => {
    expect(validateSchedule(definition({ everySimMinutes: 0 }))).toHaveLength(1);
    expect(validateSchedule(definition({ everySimMinutes: undefined }))).toHaveLength(1);
  });

  it('rejects at schedules without a non-negative atSim', () => {
    const issues = validateSchedule(
      definition({ kind: 'at', atSim: undefined, everySimMinutes: undefined }),
    );
    expect(issues.some((issue) => issue.field === 'atSim')).toBe(true);
  });

  it('rejects an endAtSim that precedes startAtSim', () => {
    const issues = validateSchedule(definition({ startAtSim: sim(20), endAtSim: sim(10) }));
    expect(issues.some((issue) => issue.field === 'endAtSim')).toBe(true);
  });

  it('computes the next interval occurrence after a given time', () => {
    const schedule = definition({ everySimMinutes: 10, startAtSim: sim(0) });
    expect(nextDueSim(schedule, sim(0))).toBe(10);
    expect(nextDueSim(schedule, sim(10))).toBe(20);
    expect(nextDueSim(schedule, sim(15))).toBe(20);
    expect(nextDueSim(schedule, sim(0))).not.toBeNull();
  });

  it('returns null for at schedules that are not in the future', () => {
    const schedule = definition({ kind: 'at', atSim: sim(5), everySimMinutes: undefined });
    expect(nextDueSim(schedule, sim(4))).toBe(5);
    expect(nextDueSim(schedule, sim(5))).toBeNull();
    expect(nextDueSim(schedule, sim(6))).toBeNull();
  });

  it('includes an interval occurrence only inside the (windowStart, now] window', () => {
    const schedule = definition({ everySimMinutes: 10, startAtSim: sim(0) });
    expect(dueSchedules([schedule], sim(0), sim(10))).toHaveLength(1);
    expect(dueSchedules([schedule], sim(10), sim(10))).toHaveLength(0);
    expect(dueSchedules([schedule], sim(0), sim(9))).toHaveLength(0);
    const due = dueSchedules([schedule], sim(0), sim(25));
    expect(due).toHaveLength(1);
    expect(due[0]?.dueAtSim).toBe(20);
  });

  it('skips interval schedules before start or after end', () => {
    const schedule = definition({ everySimMinutes: 10, startAtSim: sim(20) });
    expect(dueSchedules([schedule], sim(0), sim(10))).toHaveLength(0);
    const bounded = definition({ everySimMinutes: 10, startAtSim: sim(0), endAtSim: sim(15) });
    expect(dueSchedules([bounded], sim(0), sim(25))).toHaveLength(0);
  });

  it('fires at schedules strictly inside the window', () => {
    const schedule = definition({ kind: 'at', atSim: sim(5), everySimMinutes: undefined });
    expect(dueSchedules([schedule], sim(0), sim(5))).toHaveLength(1);
    expect(dueSchedules([schedule], sim(5), sim(5))).toHaveLength(0);
    expect(dueSchedules([schedule], sim(0), sim(4))).toHaveLength(0);
  });
});
