import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CompanyId, OrgEvent, SimTime } from '@maoeh/shared-types';
import { PRESENCE_STATES } from '@maoeh/shared-types';
import type { OrgEventInput } from '@maoeh/event-system';
import { createEventRegistry, createOrgEvent } from '@maoeh/event-system';
import type { EventFilter, Seq } from '@maoeh/event-store';
import { createInMemoryEventStore, DuplicateEventError } from '@maoeh/event-store';

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

const companyA = 'future-ai-lab' as CompanyId;
const companyB = 'other-lab' as CompanyId;
const sim = (minutes: number): SimTime => minutes as SimTime;

function makeEvent(input: Partial<OrgEventInput> = {}): OrgEvent {
  const result = createOrgEvent(registry, {
    companyId: companyA,
    type: 'Runtime.PresenceChanged',
    occurredAtSim: sim(0),
    actorKind: 'employee',
    correlationId: 'corr-1',
    payload: { employeeId: 'engineer-mike', presence: 'thinking' },
    ...input,
  });
  if (!result.ok) throw new Error(result.error.issues.map((issue) => issue.reason).join('\n'));
  return result.value;
}

async function collect(
  store: ReturnType<typeof createInMemoryEventStore>,
  from: Seq,
  to?: Seq,
  filter?: EventFilter,
): Promise<OrgEvent[]> {
  const events: OrgEvent[] = [];
  for await (const event of store.replay(from, to, filter)) events.push(event);
  return events;
}

function createClock(): () => string {
  let tick = 0;
  return () => {
    tick += 1;
    return `2026-01-01T00:00:${String(tick % 60).padStart(2, '0')}.000Z`;
  };
}

describe('Event Store：append 分配序号与顺序保证', () => {
  it('批量 append：按输入顺序分配连续 seq，返回批次水位，补 occurredAtWall', async () => {
    const store = createInMemoryEventStore({ now: createClock() });
    const first = makeEvent({ eventId: 'evt-1' });
    const second = makeEvent({ eventId: 'evt-2', correlationId: 'corr-1' });
    const watermark = await store.append([first, second]);
    expect(watermark).toBe(2);
    const stored = await collect(store, 1 as Seq);
    expect(stored.map((event) => [event.seq, event.eventId])).toEqual([
      [1, 'evt-1'],
      [2, 'evt-2'],
    ]);
    expect(stored[0]?.occurredAtWall).not.toBe('');
    expect(stored[1]?.occurredAtWall).not.toBe('');
    expect(first.seq).toBe(0);
    expect(first.occurredAtWall).toBe('');
  });

  it('多次 append 续接全局 seq；空 append 不推进水位', async () => {
    const store = createInMemoryEventStore({ now: createClock() });
    expect(await store.append([])).toBe(0);
    expect(await store.append([makeEvent({ eventId: 'evt-1' })])).toBe(1);
    expect(await store.append([makeEvent({ eventId: 'evt-2' }), makeEvent({ eventId: 'evt-3' })])).toBe(3);
    expect(await store.append([])).toBe(3);
    const stored = await collect(store, 1 as Seq);
    expect(stored.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it('append-only：存储事件深冻结，读回对象保持不变；无 update/delete API', async () => {
    const store = createInMemoryEventStore({ now: createClock() });
    await store.append([makeEvent({ eventId: 'evt-1', payload: { employeeId: 'engineer-mike', presence: 'idle' } })]);
    const [stored] = await collect(store, 1 as Seq);
    expect(stored).toBeDefined();
    expect(Object.isFrozen(stored)).toBe(true);
    const mutable = stored as unknown as { seq: number; payload: { presence: string } };
    expect(() => {
      mutable.seq = 42;
    }).toThrow(TypeError);
    expect(() => {
      mutable.payload.presence = 'blocked';
    }).toThrow(TypeError);
    const [reread] = await collect(store, 1 as Seq);
    expect(reread?.seq).toBe(1);
    expect((reread?.payload as { presence: string }).presence).toBe('idle');
    const api = store as unknown as Record<string, unknown>;
    expect(api.update).toBeUndefined();
    expect(api.delete).toBeUndefined();
    expect(api.merge).toBeUndefined();
  });
});

describe('Event Store：幂等与流隔离', () => {
  it('重复 (companyId, eventId) → DuplicateEventError，且整批原子回滚', async () => {
    const store = createInMemoryEventStore({ now: createClock() });
    const duplicate = makeEvent({ eventId: 'evt-1' });
    await expect(store.append([duplicate, duplicate])).rejects.toThrow(DuplicateEventError);
    expect(await collect(store, 1 as Seq)).toEqual([]);
    await expect(
      store.append([makeEvent({ eventId: 'evt-3' }), makeEvent({ eventId: 'evt-3' })]),
    ).rejects.toThrow(DuplicateEventError);
    expect(await collect(store, 1 as Seq)).toEqual([]);
    await expect(store.append([duplicate])).resolves.toBe(1);
    await expect(store.append([duplicate])).rejects.toThrow(DuplicateEventError);
    expect((await collect(store, 1 as Seq)).map((event) => event.eventId)).toEqual(['evt-1']);
    await expect(
      store.append([makeEvent({ eventId: 'evt-4' }), makeEvent({ eventId: 'evt-1' })]),
    ).rejects.toThrow(DuplicateEventError);
    expect((await collect(store, 1 as Seq)).map((event) => event.eventId)).toEqual(['evt-1']);
  });

  it('同 eventId 不同 companyId → 视为不同事件（复合唯一键）', async () => {
    const store = createInMemoryEventStore({ now: createClock() });
    await store.append([
      makeEvent({ eventId: 'evt-1', companyId: companyA }),
      makeEvent({ eventId: 'evt-1', companyId: companyB }),
    ]);
    const stored = await collect(store, 1 as Seq);
    expect(stored.map((event) => event.companyId)).toEqual([companyA, companyB]);
  });
});

describe('Event Store：replay 范围与过滤', () => {
  it('from/to 范围 + type/companyId/correlationId/subjectId 过滤', async () => {
    const store = createInMemoryEventStore({ now: createClock() });
    const events = [
      makeEvent({ eventId: 'evt-1', subjectId: 'engineer-mike', correlationId: 'corr-a' }),
      makeEvent({
        eventId: 'evt-2',
        type: 'Task.Completed',
        payload: { taskId: 'task-1' },
        subjectId: 'cto-john',
        correlationId: 'corr-b',
      }),
      makeEvent({ eventId: 'evt-3', subjectId: 'engineer-mike', correlationId: 'corr-a' }),
      makeEvent({ eventId: 'evt-4', companyId: companyB, subjectId: 'engineer-mike', correlationId: 'corr-a' }),
    ];
    await store.append(events);

    expect((await collect(store, 2 as Seq)).map((event) => event.eventId)).toEqual([
      'evt-2',
      'evt-3',
      'evt-4',
    ]);
    expect((await collect(store, 2 as Seq, 3 as Seq)).map((event) => event.eventId)).toEqual([
      'evt-2',
      'evt-3',
    ]);
    expect((await collect(store, 4 as Seq, 2 as Seq)).map((event) => event.eventId)).toEqual([]);
    expect(
      (await collect(store, 1 as Seq, undefined, { type: 'Task.Completed' })).map(
        (event) => event.eventId,
      ),
    ).toEqual(['evt-2']);
    expect(
      (await collect(store, 1 as Seq, undefined, { companyId: companyA })).map(
        (event) => event.eventId,
      ),
    ).toEqual(['evt-1', 'evt-2', 'evt-3']);
    expect(
      (await collect(store, 1 as Seq, undefined, { correlationId: 'corr-b' })).map(
        (event) => event.eventId,
      ),
    ).toEqual(['evt-2']);
    expect(
      (await collect(store, 1 as Seq, undefined, { subjectId: 'engineer-mike' })).map(
        (event) => event.eventId,
      ),
    ).toEqual(['evt-1', 'evt-3', 'evt-4']);
    expect(
      (
        await collect(store, 1 as Seq, undefined, {
          companyId: companyA,
          subjectId: 'cto-john',
        })
      ).map((event) => event.eventId),
    ).toEqual(['evt-2']);
  });
});

describe('Event Store：outbox 分发（恰好一次成功 + 失败重试）', () => {
  it('append 产生 outbox 条目；成功分发后不再重发', async () => {
    const store = createInMemoryEventStore({ now: createClock() });
    await store.append([
      makeEvent({ eventId: 'evt-1' }),
      makeEvent({ eventId: 'evt-2', type: 'Task.Completed', payload: { taskId: 'task-1' } }),
    ]);
    const seen: string[] = [];
    const report = await store.dispatchOutbox(async (entry) => {
      seen.push(entry.eventId);
      expect(entry.topic).toBe(entry.payload.type);
      expect(entry.attempts).toBe(1);
      expect(entry.dispatchedAt).toBeNull();
      expect(Object.isFrozen(entry)).toBe(true);
    });
    expect(report).toEqual({ dispatched: 2, failed: 0 });
    expect(seen).toEqual(['evt-1', 'evt-2']);
    const repeat = await store.dispatchOutbox(async (entry) => {
      seen.push(entry.eventId);
      expect(entry.dispatchedAt).not.toBeNull();
    });
    expect(repeat).toEqual({ dispatched: 0, failed: 0 });
    expect(seen).toEqual(['evt-1', 'evt-2']);
  });

  it('分发失败 → attempts/lastError 记录，下次重试成功后不再发送', async () => {
    const store = createInMemoryEventStore({ now: createClock() });
    await store.append([makeEvent({ eventId: 'evt-1' })]);
    const first = await store.dispatchOutbox(async () => {
      throw new Error('broker down');
    });
    expect(first).toEqual({ dispatched: 0, failed: 1 });
    const seen: number[] = [];
    const retry = await store.dispatchOutbox(async (entry) => {
      seen.push(entry.attempts);
      expect(entry.lastError).toBe('broker down');
    });
    expect(retry).toEqual({ dispatched: 1, failed: 0 });
    expect(seen).toEqual([2]);
    const settled = await store.dispatchOutbox(async () => {
      seen.push(99);
    });
    expect(settled).toEqual({ dispatched: 0, failed: 0 });
    expect(seen).toEqual([2]);
  });
});

describe('Event Store：消费位点与幂等去重', () => {
  it('commitOffset/loadOffset 按 consumerGroup + companyId 隔离，未提交默认 0', async () => {
    const store = createInMemoryEventStore({ now: createClock() });
    expect(store.loadOffset('projector', companyA)).toBe(0);
    store.commitOffset('projector', companyA, 5 as Seq);
    expect(store.loadOffset('projector', companyA)).toBe(5);
    expect(store.loadOffset('projector', companyB)).toBe(0);
    store.commitOffset('projector', companyB, 2 as Seq);
    store.commitOffset('other', companyA, 1 as Seq);
    expect(store.loadOffset('projector', companyA)).toBe(5);
    expect(store.loadOffset('projector', companyB)).toBe(2);
    expect(store.loadOffset('other', companyA)).toBe(1);
  });

  it('markProcessed/isProcessed 幂等，按 consumerGroup + eventId + consumerKey 判定', async () => {
    const store = createInMemoryEventStore({ now: createClock() });
    expect(store.isProcessed('projector', 'evt-1', 'engineer-mike')).toBe(false);
    store.markProcessed('projector', 'evt-1', 'engineer-mike');
    expect(store.isProcessed('projector', 'evt-1', 'engineer-mike')).toBe(true);
    store.markProcessed('projector', 'evt-1', 'engineer-mike');
    expect(store.isProcessed('projector', 'evt-1', 'engineer-mike')).toBe(true);
    expect(store.isProcessed('projector', 'evt-1', 'cto-john')).toBe(false);
    expect(store.isProcessed('other', 'evt-1', 'engineer-mike')).toBe(false);
    expect(store.isProcessed('projector', 'evt-2', 'engineer-mike')).toBe(false);
  });
});
