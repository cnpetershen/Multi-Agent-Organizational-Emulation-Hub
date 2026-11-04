import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  CompanyId,
  EmployeeId,
  EventType,
  OrgEvent,
  PresenceState,
  SimTime,
} from '@maoeh/shared-types';
import { PRESENCE_STATES } from '@maoeh/shared-types';
import type { OrgEventInput } from '@maoeh/event-system';
import { createEventRegistry, createOrgEvent } from '@maoeh/event-system';
import {
  agentStateTransition,
  createInitialAgentState,
  createInMemoryStateStore,
  replayAgentState,
} from '@maoeh/runtime-state';

const registry = (() => {
  const created = createEventRegistry();
  const presence = created.register(
    'Runtime.PresenceChanged',
    z.object({ employeeId: z.string().min(1), presence: z.enum(PRESENCE_STATES) }),
  );
  const completed = created.register('Task.Completed', z.object({ taskId: z.string() }));
  if (!presence.ok || !completed.ok) throw new Error('registry setup failed');
  return created;
})();

const mike = 'engineer-mike' as EmployeeId;
const sim = (minutes: number): SimTime => minutes as SimTime;

function presenceEvent(
  employeeId: string,
  presence: PresenceState,
  at: number,
  input: Partial<OrgEventInput> = {},
): OrgEvent {
  const result = createOrgEvent(registry, {
    companyId: 'future-ai-lab' as CompanyId,
    type: 'Runtime.PresenceChanged',
    occurredAtSim: sim(at),
    actorKind: 'employee',
    correlationId: 'corr-state',
    subjectType: 'employee',
    subjectId: employeeId,
    payload: { employeeId, presence },
    ...input,
  });
  if (!result.ok) throw new Error(result.error.issues.map((issue) => issue.reason).join('\n'));
  return result.value;
}

const initialState = createInitialAgentState(mike);

describe('Runtime State：AgentState 初始值（05-runtime 5.4.1）', () => {
  it('createInitialAgentState：version 0、presence idle、branchId live、全量字段就位', () => {
    expect(initialState).toEqual({
      employeeId: 'engineer-mike',
      version: 0,
      employment: 'defined',
      presence: 'idle',
      currentCycleId: null,
      suspendedAt: null,
      agenda: [],
      focus: null,
      budget: { simDay: 0, tokensUsed: 0, usdUsed: 0, cyclesRun: 0 },
      reflection: { accumulator: 0, lastReflectedAtSim: 0, episodesSinceReflect: 0 },
      permissionSnapshot: null,
      branchId: 'live',
      health: { consecutiveFailures: 0 },
      updatedAtSim: 0,
    });
  });

  it('employment 可由调用方覆盖（其余字段固定）', () => {
    const active = createInitialAgentState(mike, { employment: 'active' });
    expect(active.employment).toBe('active');
    expect(active.presence).toBe('idle');
    expect(active.version).toBe(0);
    expect(active.branchId).toBe('live');
  });
});

describe('Runtime State：转移与回放', () => {
  it('subjectId 过滤 + presence 转移 + version/updatedAtSim 推进', () => {
    const events = [
      presenceEvent(mike, 'thinking', 10),
      presenceEvent('cto-john', 'blocked', 11),
      presenceEvent(mike, 'in_meeting', 12),
    ];
    const afterFirst = replayAgentState(initialState, [events[0] as OrgEvent]);
    expect(afterFirst.presence).toBe('thinking');
    expect(afterFirst.version).toBe(1);
    expect(afterFirst.updatedAtSim).toBe(10);
    const final = replayAgentState(initialState, events);
    expect(final.presence).toBe('in_meeting');
    expect(final.version).toBe(2);
    expect(final.updatedAtSim).toBe(12);
    expect(final.currentCycleId).toBeNull();
    expect(final.branchId).toBe('live');
  });

  it('非 subject 事件 / 非 Runtime.PresenceChanged 类型 / payload 非法 → 状态对象不变', () => {
    const otherEvent = presenceEvent('cto-john', 'blocked', 10);
    expect(agentStateTransition(initialState, otherEvent)).toBe(initialState);
    const taskEvent = createOrgEvent(registry, {
      companyId: 'future-ai-lab' as CompanyId,
      type: 'Task.Completed',
      occurredAtSim: sim(10),
      actorKind: 'employee',
      correlationId: 'corr-state',
      subjectType: 'employee',
      subjectId: mike,
      payload: { taskId: 'task-1' },
    });
    expect(taskEvent.ok).toBe(true);
    if (taskEvent.ok) expect(agentStateTransition(initialState, taskEvent.value)).toBe(initialState);
    const invalidPresence: OrgEvent = {
      seq: 0,
      eventId: 'raw-invalid-1',
      companyId: 'future-ai-lab' as CompanyId,
      type: 'Runtime.PresenceChanged' as EventType,
      version: 1,
      occurredAtSim: sim(10),
      occurredAtWall: '',
      actorKind: 'employee',
      actorId: null,
      subjectType: 'employee',
      subjectId: mike,
      payload: { employeeId: mike, presence: 'floating' },
      causationId: null,
      correlationId: 'corr-state',
      traceId: null,
    };
    expect(agentStateTransition(initialState, invalidPresence)).toBe(initialState);
    const nullSubject = presenceEvent(mike, 'thinking', 10, { subjectId: null });
    expect(agentStateTransition(initialState, nullSubject)).toBe(initialState);
  });

  it('确定性：同一事件序列两次回放深等（结构化等价）', () => {
    const events = [
      presenceEvent(mike, 'planning', 5),
      presenceEvent('cto-john', 'idle', 6),
      presenceEvent(mike, 'reflecting', 7),
      presenceEvent(mike, 'idle', 8),
    ];
    const first = replayAgentState(initialState, events);
    const second = replayAgentState(initialState, events);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.presence).toBe('idle');
    expect(first.version).toBe(3);
  });
});

describe('Runtime State：StateStore（load/commit 乐观锁）', () => {
  it('load 未提交员工 → 初始状态；commit(expected 0) 成功后可读回', () => {
    const store = createInMemoryStateStore();
    expect(store.load(mike).version).toBe(0);
    const next = replayAgentState(initialState, [presenceEvent(mike, 'thinking', 10)]);
    const committed = store.commit(next, 0);
    expect(committed.ok).toBe(true);
    expect(store.load(mike)).toEqual(next);
  });

  it('stale expectedVersion → VERSION_CONFLICT（携带 actualVersion）', () => {
    const store = createInMemoryStateStore();
    const v1 = replayAgentState(initialState, [presenceEvent(mike, 'thinking', 10)]);
    expect(store.commit(v1, 0).ok).toBe(true);
    const stale = replayAgentState(initialState, [presenceEvent(mike, 'planning', 11)]);
    expect(store.commit(stale, 0)).toEqual({
      ok: false,
      error: { code: 'VERSION_CONFLICT', actualVersion: 1 },
    });
    expect(store.load(mike).presence).toBe('thinking');
    expect(store.commit(stale, 1).ok).toBe(true);
    expect(store.load(mike).presence).toBe('planning');
    expect(store.load(mike).version).toBe(1);
  });

  it('并发提交：同一 load 出发的两个分支仅一个胜出', () => {
    const store = createInMemoryStateStore();
    const branchA = replayAgentState(initialState, [presenceEvent(mike, 'thinking', 10)]);
    const branchB = replayAgentState(initialState, [presenceEvent(mike, 'blocked', 11)]);
    expect(store.commit(branchA, 0).ok).toBe(true);
    expect(store.commit(branchB, 0)).toEqual({
      ok: false,
      error: { code: 'VERSION_CONFLICT', actualVersion: 1 },
    });
    expect(store.load(mike)).toEqual(branchA);
  });

  it('恢复：事件回放出的状态可直接提交到全新 store（expected 0），load 深等', () => {
    const store = createInMemoryStateStore();
    const recovered = replayAgentState(initialState, [
      presenceEvent(mike, 'thinking', 10),
      presenceEvent(mike, 'planning', 20),
    ]);
    expect(store.commit(recovered, 0).ok).toBe(true);
    expect(store.load(mike)).toEqual(recovered);
    expect(store.load(mike).version).toBe(2);
  });
});

describe('Runtime State：cycle_checkpoints', () => {
  const plan = {
    goal: 'ship the release',
    steps: [
      { index: 0, action: 'SendMessage' as const, args: { to: 'cto-john' }, reasonRef: 0 },
      { index: 1, action: 'CompleteTask' as const, args: {}, reasonRef: 1, doneWhen: 'green build' },
    ],
    doneWhen: 'release tagged',
  };

  it('checkpoint upsert：按 (cycleId, stepIndex) 覆盖，loadLatest 返回最大步', () => {
    const store = createInMemoryStateStore();
    expect(store.loadLatestCheckpoint('cycle-1')).toBeNull();
    store.checkpoint('cycle-1', {
      stepIndex: 0,
      employeeId: mike,
      plan,
      authorizedPlan: plan,
      stepResults: [{ ok: true }],
      idempotencyKeys: ['step-0'],
    });
    store.checkpoint('cycle-1', {
      stepIndex: 1,
      employeeId: mike,
      plan,
      authorizedPlan: plan,
      stepResults: [{ ok: true }, { ok: false }],
      idempotencyKeys: ['step-0', 'step-1'],
    });
    const latest = store.loadLatestCheckpoint('cycle-1');
    expect(latest?.stepIndex).toBe(1);
    expect(latest?.cycleId).toBe('cycle-1');
    expect(latest?.employeeId).toBe(mike);
    expect(latest?.idempotencyKeys).toEqual(['step-0', 'step-1']);
    store.checkpoint('cycle-1', {
      stepIndex: 1,
      employeeId: mike,
      plan,
      authorizedPlan: plan,
      stepResults: [{ ok: 'retried' }],
      idempotencyKeys: ['step-1'],
    });
    const replaced = store.loadLatestCheckpoint('cycle-1');
    expect(replaced?.stepResults).toEqual([{ ok: 'retried' }]);
    expect(replaced?.idempotencyKeys).toEqual(['step-1']);
    expect(store.loadLatestCheckpoint('cycle-unknown')).toBeNull();
  });

  it('cycle 隔离：不同 cycleId 的 checkpoint 互不可见', () => {
    const store = createInMemoryStateStore();
    store.checkpoint('cycle-a', {
      stepIndex: 0,
      employeeId: mike,
      plan,
      authorizedPlan: plan,
      stepResults: [],
      idempotencyKeys: [],
    });
    expect(store.loadLatestCheckpoint('cycle-b')).toBeNull();
    expect(store.loadLatestCheckpoint('cycle-a')?.cycleId).toBe('cycle-a');
  });
});
