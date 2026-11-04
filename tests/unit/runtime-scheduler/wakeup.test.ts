import { describe, expect, it } from 'vitest';
import type { CompanyId, EmployeeId, SimTime } from '@maoeh/shared-types';
import type { AgentWakeup } from '@maoeh/runtime-scheduler';
import {
  WAKEUP_PRIORITY,
  compareWakeups,
  dedupeWakeups,
  priorityForTrigger,
  wakeupKey,
} from '@maoeh/runtime-scheduler';

const companyId = 'future-ai-lab' as CompanyId;
const sim = (value: number): SimTime => value as SimTime;
const eid = (value: string): EmployeeId => value as EmployeeId;

function wakeup(overrides: Partial<AgentWakeup> = {}): AgentWakeup {
  return {
    wakeupId: 'wakeup-1',
    companyId,
    agentId: eid('ceo-alex'),
    reason: 'EVENT',
    trigger: { kind: 'task', eventTypeId: 'Task.Assigned', refId: 'task-1' },
    sourceEventId: 'evt-1',
    scheduledAtSim: sim(0),
    priority: WAKEUP_PRIORITY.task,
    status: 'pending',
    mergedWakeupIds: [],
    ...overrides,
  };
}

describe('runtime-scheduler / wakeup', () => {
  it('derives priority from the trigger kind', () => {
    expect(priorityForTrigger({ kind: 'workflow' })).toBe(8);
    expect(priorityForTrigger({ kind: 'task' })).toBe(7);
    expect(priorityForTrigger({ kind: 'communication' })).toBe(6);
    expect(priorityForTrigger({ kind: 'schedule' })).toBe(5);
    expect(priorityForTrigger({ kind: 'agenda' })).toBe(4);
    expect(priorityForTrigger({ kind: 'system' })).toBe(9);
    expect(priorityForTrigger({ kind: 'manual' })).toBe(5);
  });

  it('orders by priority descending then scheduled time ascending', () => {
    const high = wakeup({ wakeupId: 'a', priority: 8, scheduledAtSim: sim(5) });
    const low = wakeup({ wakeupId: 'b', priority: 3, scheduledAtSim: sim(0) });
    const lowLater = wakeup({ wakeupId: 'c', priority: 3, scheduledAtSim: sim(9) });
    expect(compareWakeups(high, low)).toBeLessThan(0);
    expect(compareWakeups(low, lowLater)).toBeLessThan(0);
  });

  it('breaks ties deterministically by agentId then wakeupId', () => {
    const a = wakeup({ wakeupId: 'z', agentId: eid('alice') });
    const b = wakeup({ wakeupId: 'a', agentId: eid('bob') });
    expect(compareWakeups(a, b)).toBeLessThan(0);
    const c = wakeup({ wakeupId: 'a', agentId: eid('alice') });
    expect(compareWakeups(a, c)).toBeGreaterThan(0);
  });

  it('wakeupKey ignores the generated wakeupId (dedupe identity)', () => {
    const a = wakeup({ wakeupId: 'wakeup-1' });
    const b = wakeup({ wakeupId: 'wakeup-2' });
    expect(wakeupKey(a)).toBe(wakeupKey(b));
  });

  it('wakeupKey changes when source, reason or trigger change', () => {
    const base = wakeup();
    expect(wakeupKey(wakeup({ sourceEventId: 'evt-2' }))).not.toBe(wakeupKey(base));
    expect(wakeupKey(wakeup({ reason: 'RETRY' }))).not.toBe(wakeupKey(base));
    expect(wakeupKey(wakeup({ trigger: { kind: 'workflow' } }))).not.toBe(wakeupKey(base));
  });

  it('dedupes by wakeupKey, keeps one, and records merged ids', () => {
    const first = wakeup({ wakeupId: 'wakeup-1' });
    const second = wakeup({ wakeupId: 'wakeup-2' });
    const third = wakeup({ wakeupId: 'wakeup-3', reason: 'RETRY' });
    const merged = dedupeWakeups([first, second, third]);
    expect(merged).toHaveLength(2);
    const kept = merged.find((entry) => entry.reason === 'EVENT');
    expect(kept?.wakeupId).toBe('wakeup-1');
    expect(kept?.mergedWakeupIds).toEqual(['wakeup-2']);
  });

  it('returns deduped wakeups sorted by priority', () => {
    const low = wakeup({ wakeupId: 'l', priority: 3, agentId: eid('a') });
    const high = wakeup({ wakeupId: 'h', priority: 9, agentId: eid('b') });
    const merged = dedupeWakeups([low, high]);
    expect(merged.map((entry) => entry.wakeupId)).toEqual(['h', 'l']);
  });
});
