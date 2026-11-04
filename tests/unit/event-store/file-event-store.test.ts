import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CompanyId, OrgEvent, SimTime } from '@maoeh/shared-types';
import { PRESENCE_STATES } from '@maoeh/shared-types';
import type { OrgEventInput } from '@maoeh/event-system';
import { createEventRegistry, createOrgEvent } from '@maoeh/event-system';
import type { EventFilter, Seq } from '@maoeh/event-store';
import { createFileEventStore, DuplicateEventError } from '@maoeh/event-store';

/**
 * The durable log behind the console: everything the operator creates is a fact on this file, so
 * the two properties that matter are (1) a *second* store over the same file sees the same events
 * with the same seq and (2) a torn tail is survivable. Both are asserted here; the end-to-end
 * "created agent comes back" case lives in `tests/integration/agent-create-restart.test.ts`.
 */

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

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'maoeh-event-log-')), 'events.jsonl');
}

async function collect(
  store: { replay: (from: Seq, to?: Seq, filter?: EventFilter) => AsyncIterable<OrgEvent> },
  from: Seq,
  to?: Seq,
  filter?: EventFilter,
): Promise<OrgEvent[]> {
  const events: OrgEvent[] = [];
  for await (const event of store.replay(from, to, filter)) events.push(event);
  return events;
}

describe('FileEventStore：可跨进程重启的事件日志', () => {
  it('append 后落盘；用同一个文件新建 store 能重放同样的 seq 与内容', async () => {
    const path = logPath();
    const first = createFileEventStore({ path });
    expect(first.recovered).toEqual({ events: 0, skipped: 0 });

    const watermark = await first.append([makeEvent(), makeEvent({ correlationId: 'corr-2' })]);
    expect(watermark).toBe(2);

    const second = createFileEventStore({ path });
    expect(second.recovered).toEqual({ events: 2, skipped: 0 });
    expect(second.path).toBe(path);
    const replayed = await collect(second, 1 as Seq);
    expect(replayed.map((event) => event.seq)).toEqual([1, 2]);
    expect(replayed.map((event) => event.correlationId)).toEqual(['corr-1', 'corr-2']);
  });

  it('重启后继续追加：seq 从日志续号，不从头再来', async () => {
    const path = logPath();
    await createFileEventStore({ path }).append([makeEvent()]);

    const restarted = createFileEventStore({ path });
    const watermark = await restarted.append([makeEvent({ correlationId: 'corr-after-restart' })]);
    expect(watermark).toBe(2);

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ seq: 2, correlationId: 'corr-after-restart' });
  });

  it('重启后仍然拒绝重复 eventId（幂等键跨进程有效）', async () => {
    const path = logPath();
    const event = makeEvent();
    await createFileEventStore({ path }).append([event]);

    const restarted = createFileEventStore({ path });
    await expect(restarted.append([event])).rejects.toBeInstanceOf(DuplicateEventError);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('被截断的尾部行不会让日志无法启动（硬杀进程的半条写入）', async () => {
    const path = logPath();
    await createFileEventStore({ path }).append([makeEvent()]);
    // A process killed mid-append leaves a partial JSON line behind.
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"eventId":"evt-tor`, 'utf8');

    const restarted = createFileEventStore({ path });
    expect(restarted.recovered).toEqual({ events: 1, skipped: 1 });
    const replayed = await collect(restarted, 1 as Seq);
    expect(replayed).toHaveLength(1);
    // The log keeps working: the next append is number 2.
    expect(await restarted.append([makeEvent({ correlationId: 'corr-recovered' })])).toBe(2);
  });

  it('companyId / type / subjectId / correlationId 过滤与内存实现一致', async () => {
    const path = logPath();
    const store = createFileEventStore({ path });
    await store.append([
      makeEvent({ correlationId: 'corr-1', subjectId: 'engineer-mike' as OrgEvent['subjectId'] }),
      makeEvent({ type: 'Task.Completed', correlationId: 'corr-2', payload: { taskId: 'task-1' } }),
      makeEvent({ companyId: companyB, correlationId: 'corr-3' }),
    ]);

    expect((await collect(store, 1 as Seq, undefined, { companyId: companyB })).map((e) => e.seq)).toEqual([3]);
    expect((await collect(store, 1 as Seq, undefined, { type: 'Task.Completed' })).map((e) => e.seq)).toEqual([2]);
    expect((await collect(store, 1 as Seq, undefined, { subjectId: 'engineer-mike' })).map((e) => e.seq)).toEqual([1]);
    expect((await collect(store, 1 as Seq, undefined, { correlationId: 'corr-3' })).map((e) => e.seq)).toEqual([3]);
    expect((await collect(store, 2 as Seq, 3 as Seq)).map((e) => e.seq)).toEqual([2, 3]);
  });

  it('写盘前就完成重复校验：一批里出现两次同一 eventId 不会留下半批数据', async () => {
    const path = logPath();
    const store = createFileEventStore({ path });
    const event = makeEvent();
    await expect(store.append([event, event])).rejects.toBeInstanceOf(DuplicateEventError);
    expect(existsSync(path) ? readFileSync(path, 'utf8').trim() : '').toBe('');
    expect((await collect(store, 1 as Seq))).toHaveLength(0);
  });
});
