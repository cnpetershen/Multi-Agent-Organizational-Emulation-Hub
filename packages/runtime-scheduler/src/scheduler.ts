import type { CompanyId, EmployeeId, SimTime } from '@maoeh/shared-types';
import type { SimulationClock } from './sim-clock.js';
import { createSimulationClock } from './sim-clock.js';
import type { ScheduleDefinition, ScheduleIssue } from './schedule.js';
import { dueSchedules, validateSchedule } from './schedule.js';
import type { AgentWakeup, WakeupReason, WakeupTrigger, WakeupStatus } from './wakeup.js';
import { compareWakeups, priorityForTrigger, wakeupKey } from './wakeup.js';

export interface WakeRequest {
  readonly companyId: CompanyId;
  readonly agentId: EmployeeId;
  readonly reason: WakeupReason;
  readonly trigger: WakeupTrigger;
  readonly sourceEventId?: string | null;
  readonly scheduledAtSim?: SimTime;
  readonly priority?: number;
}

export interface SchedulerOptions {
  readonly companyId: CompanyId;
  readonly clock?: SimulationClock;
  readonly wakeupIdGenerator?: () => string;
  readonly schedules?: readonly ScheduleDefinition[];
}

export interface Scheduler {
  readonly companyId: CompanyId;
  readonly clock: SimulationClock;
  readonly paused: boolean;
  tick(): SimTime;
  seek(simTime: SimTime): void;
  pause(): void;
  resume(): void;
  enqueue(request: WakeRequest): AgentWakeup;
  addSchedule(definition: ScheduleDefinition): readonly ScheduleIssue[];
  removeSchedule(scheduleId: string): boolean;
  schedules(): readonly ScheduleDefinition[];
  resolveDueScheduled(windowStart: SimTime): readonly AgentWakeup[];
  dispatch(limit?: number): readonly AgentWakeup[];
  complete(wakeupId: string, status: Extract<WakeupStatus, 'completed' | 'failed'>): boolean;
  cancel(wakeupId: string): boolean;
  pending(): readonly AgentWakeup[];
  queue(): readonly AgentWakeup[];
  clear(): void;
}

function defaultWakeupIdGenerator(): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `wakeup-${sequence}`;
  };
}

function freezeWakeup(wakeup: AgentWakeup): AgentWakeup {
  return Object.freeze({
    ...wakeup,
    trigger: Object.freeze({ ...wakeup.trigger }),
    mergedWakeupIds: Object.freeze([...wakeup.mergedWakeupIds]),
  });
}

function orderOfStatus(status: WakeupStatus): number {
  switch (status) {
    case 'pending':
      return 0;
    case 'dispatched':
      return 1;
    case 'completed':
      return 2;
    case 'failed':
      return 3;
    default:
      return 4;
  }
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const companyId = options.companyId;
  const clock = options.clock ?? createSimulationClock();
  const nextWakeupId = options.wakeupIdGenerator ?? defaultWakeupIdGenerator();

  const records = new Map<string, AgentWakeup>();
  const scheduleDefinitions = new Map<string, ScheduleDefinition>();
  let paused = false;

  const pendingSorted = (): AgentWakeup[] =>
    [...records.values()]
      .filter((wakeup) => wakeup.status === 'pending')
      .sort(compareWakeups);

  const enqueue = (request: WakeRequest): AgentWakeup => {
    const scheduledAtSim = request.scheduledAtSim ?? clock.simTime;
    const priority = request.priority ?? priorityForTrigger(request.trigger);
    const candidate = freezeWakeup({
      wakeupId: nextWakeupId(),
      companyId: request.companyId,
      agentId: request.agentId,
      reason: request.reason,
      trigger: request.trigger,
      sourceEventId: request.sourceEventId ?? null,
      scheduledAtSim,
      priority,
      status: 'pending',
      mergedWakeupIds: Object.freeze([]),
    });
    const key = wakeupKey(candidate);
    const existing = pendingSorted().find((wakeup) => wakeupKey(wakeup) === key);
    if (existing !== undefined) {
      const merged: AgentWakeup = freezeWakeup({
        ...existing,
        mergedWakeupIds: Object.freeze([...existing.mergedWakeupIds, candidate.wakeupId]),
      });
      records.set(merged.wakeupId, merged);
      return merged;
    }
    records.set(candidate.wakeupId, candidate);
    return candidate;
  };

  for (const definition of options.schedules ?? []) {
    const issues = validateSchedule(definition);
    if (issues.length > 0) {
      throw new Error(
        `invalid schedule "${definition.scheduleId}": ${issues
          .map((issue) => `${issue.field}: ${issue.reason}`)
          .join(', ')}`,
      );
    }
    scheduleDefinitions.set(definition.scheduleId, definition);
  }

  return {
    companyId,
    clock,
    get paused() {
      return paused;
    },
    tick() {
      if (paused) return clock.simTime;
      return clock.advance();
    },
    seek(simTime) {
      clock.seek(simTime);
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    enqueue,
    addSchedule(definition) {
      const issues = validateSchedule(definition);
      if (issues.length > 0) return issues;
      scheduleDefinitions.set(definition.scheduleId, definition);
      return [];
    },
    removeSchedule(scheduleId) {
      return scheduleDefinitions.delete(scheduleId);
    },
    schedules() {
      return Object.freeze([...scheduleDefinitions.values()]);
    },
    resolveDueScheduled(windowStart) {
      if (paused) return Object.freeze([]);
      const due = dueSchedules(
        [...scheduleDefinitions.values()],
        windowStart,
        clock.simTime,
      );
      const created = due.map((entry) =>
        enqueue({
          companyId: entry.definition.companyId,
          agentId: entry.definition.agentId,
          reason: entry.definition.reason ?? 'SCHEDULE',
          trigger: { kind: 'schedule', refId: entry.definition.scheduleId },
          sourceEventId: null,
          scheduledAtSim: entry.dueAtSim,
        }),
      );
      return Object.freeze(created);
    },
    dispatch(limit) {
      if (paused) return Object.freeze([]);
      const now = clock.simTime;
      const ready = pendingSorted().filter((wakeup) => wakeup.scheduledAtSim <= now);
      const selected = limit === undefined ? ready : ready.slice(0, Math.max(0, limit));
      const dispatched = selected.map((wakeup) => {
        const next: AgentWakeup = Object.freeze({ ...wakeup, status: 'dispatched' });
        records.set(wakeup.wakeupId, next);
        return next;
      });
      return Object.freeze(dispatched);
    },
    complete(wakeupId, status) {
      const wakeup = records.get(wakeupId);
      if (wakeup === undefined || wakeup.status !== 'dispatched') return false;
      records.set(wakeupId, Object.freeze({ ...wakeup, status }));
      return true;
    },
    cancel(wakeupId) {
      const wakeup = records.get(wakeupId);
      if (wakeup === undefined || wakeup.status !== 'pending') return false;
      records.set(wakeupId, Object.freeze({ ...wakeup, status: 'cancelled' }));
      return true;
    },
    pending() {
      return Object.freeze(pendingSorted());
    },
    queue() {
      return Object.freeze(
        [...records.values()].sort((left, right) => {
          const byStatus = orderOfStatus(left.status) - orderOfStatus(right.status);
          if (byStatus !== 0) return byStatus;
          return compareWakeups(left, right);
        }),
      );
    },
    clear() {
      records.clear();
    },
  };
}
