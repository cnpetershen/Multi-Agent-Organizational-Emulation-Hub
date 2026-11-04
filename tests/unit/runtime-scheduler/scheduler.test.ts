import { describe, expect, it } from 'vitest';
import type { CompanyId, EmployeeId, SimTime } from '@maoeh/shared-types';
import type { ScheduleDefinition, WakeRequest } from '@maoeh/runtime-scheduler';
import { createScheduler } from '@maoeh/runtime-scheduler';

const companyId = 'future-ai-lab' as CompanyId;
const sim = (value: number): SimTime => value as SimTime;
const eid = (value: string): EmployeeId => value as EmployeeId;

function request(overrides: Partial<WakeRequest> = {}): WakeRequest {
  return {
    companyId,
    agentId: eid('ceo-alex'),
    reason: 'EVENT',
    trigger: { kind: 'task', eventTypeId: 'Task.Assigned', refId: 'task-1' },
    sourceEventId: 'evt-1',
    ...overrides,
  };
}

const heartbeat: ScheduleDefinition = {
  scheduleId: 'heartbeat',
  companyId,
  agentId: eid('cto-john'),
  kind: 'interval',
  everySimMinutes: 5,
  startAtSim: sim(0),
};

describe('runtime-scheduler / Scheduler', () => {
  it('assigns a priority derived from the trigger kind', () => {
    const scheduler = createScheduler({ companyId });
    const wakeup = scheduler.enqueue(request({ trigger: { kind: 'workflow' } }));
    expect(wakeup.priority).toBe(8);
    expect(wakeup.status).toBe('pending');
  });

  it('dedupes identical pending requests and records merged ids', () => {
    const scheduler = createScheduler({ companyId });
    const first = scheduler.enqueue(request());
    const second = scheduler.enqueue(request());
    expect(second.wakeupId).toBe(first.wakeupId);
    expect(second.mergedWakeupIds).toEqual(['wakeup-2']);
    expect(scheduler.pending()).toHaveLength(1);
  });

  it('returns pending wakeups ordered by priority', () => {
    const scheduler = createScheduler({ companyId });
    scheduler.enqueue(request({ agentId: eid('a'), trigger: { kind: 'agenda' } }));
    scheduler.enqueue(request({ agentId: eid('b'), trigger: { kind: 'workflow' } }));
    expect(scheduler.pending().map((wakeup) => wakeup.agentId)).toEqual(['b', 'a']);
  });

  it('dispatches only ready wakeups, up to the limit, and marks them dispatched', () => {
    const scheduler = createScheduler({ companyId });
    scheduler.enqueue(request({ agentId: eid('a'), scheduledAtSim: sim(0) }));
    scheduler.enqueue(request({ agentId: eid('b'), scheduledAtSim: sim(0) }));
    scheduler.enqueue(request({ agentId: eid('c'), scheduledAtSim: sim(3) }));
    const dispatched = scheduler.dispatch(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.status).toBe('dispatched');
    expect(scheduler.pending()).toHaveLength(2);
  });

  it('completes only dispatched wakeups and cancels only pending ones', () => {
    const scheduler = createScheduler({ companyId });
    const wakeup = scheduler.enqueue(request());
    expect(scheduler.complete(wakeup.wakeupId, 'completed')).toBe(false);
    expect(scheduler.cancel(wakeup.wakeupId)).toBe(true);
    expect(scheduler.cancel(wakeup.wakeupId)).toBe(false);
    expect(scheduler.pending()).toHaveLength(0);
  });

  it('pause freezes the clock, dispatch and scheduled resolution', () => {
    const scheduler = createScheduler({ companyId, schedules: [heartbeat] });
    scheduler.pause();
    expect(scheduler.tick()).toBe(0);
    expect(scheduler.clock.currentTick).toBe(0);
    expect(scheduler.resolveDueScheduled(sim(0))).toHaveLength(0);
    expect(scheduler.dispatch()).toHaveLength(0);
    scheduler.resume();
    scheduler.tick();
    expect(scheduler.clock.currentTick).toBe(1);
  });

  it('resolves due schedules into SCHEDULE wakeups inside the window', () => {
    const scheduler = createScheduler({ companyId, schedules: [heartbeat] });
    for (let index = 0; index < 5; index += 1) scheduler.tick();
    const created = scheduler.resolveDueScheduled(sim(0));
    expect(created).toHaveLength(1);
    expect(created[0]?.reason).toBe('SCHEDULE');
    expect(created[0]?.trigger).toEqual({ kind: 'schedule', refId: 'heartbeat' });
    expect(scheduler.resolveDueScheduled(sim(5))).toHaveLength(0);
  });

  it('seek aligns the clock so scheduled wakeups become ready', () => {
    const scheduler = createScheduler({ companyId });
    scheduler.enqueue(request({ scheduledAtSim: sim(10) }));
    expect(scheduler.dispatch()).toHaveLength(0);
    scheduler.seek(sim(10));
    expect(scheduler.dispatch()).toHaveLength(1);
  });

  it('adds and removes schedules, rejecting invalid ones', () => {
    const scheduler = createScheduler({ companyId });
    expect(scheduler.addSchedule(heartbeat)).toEqual([]);
    expect(scheduler.schedules()).toHaveLength(1);
    const issues = scheduler.addSchedule({
      ...heartbeat,
      scheduleId: 'broken',
      everySimMinutes: 0,
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(scheduler.removeSchedule('heartbeat')).toBe(true);
    expect(scheduler.schedules()).toHaveLength(0);
  });

  it('rejects invalid schedules at construction time', () => {
    expect(() =>
      createScheduler({ companyId, schedules: [{ ...heartbeat, everySimMinutes: -1 }] }),
    ).toThrow(/invalid schedule/);
  });
});
