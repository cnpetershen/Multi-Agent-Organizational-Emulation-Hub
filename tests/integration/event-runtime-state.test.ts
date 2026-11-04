import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CorrelationId, EmployeeId, OrgEvent, SimTime } from '@maoeh/shared-types';
import { PRESENCE_STATES } from '@maoeh/shared-types';
import { createEventRegistry, createOrgEvent } from '@maoeh/event-system';
import type { Seq } from '@maoeh/event-store';
import { createInMemoryEventStore } from '@maoeh/event-store';
import { createInitialAgentState, createInMemoryStateStore, replayAgentState } from '@maoeh/runtime-state';
import { loadOrganization } from '@maoeh/organization-model';
import { createIdentity } from '@maoeh/identity-system';
import { createNodeFsOrganizationReader } from '../helpers/organization-readers';

const seedRoot = fileURLToPath(new URL('../../agents/future-ai-lab/', import.meta.url));

function loadSeed(): ReturnType<typeof loadOrganization> {
  const result = loadOrganization(createNodeFsOrganizationReader(seedRoot));
  if (!result.ok) throw new Error('seed organization failed to load');
  return result;
}

const registry = (() => {
  const created = createEventRegistry();
  const result = created.register(
    'Runtime.PresenceChanged',
    z.object({ employeeId: z.string().min(1), presence: z.enum(PRESENCE_STATES) }),
  );
  if (!result.ok) throw new Error('registry setup failed');
  return created;
})();

const sim = (minutes: number): SimTime => minutes as SimTime;

async function collect(
  store: ReturnType<typeof createInMemoryEventStore>,
  from: Seq,
  filter?: { readonly correlationId?: string; readonly subjectId?: string },
): Promise<OrgEvent[]> {
  const events: OrgEvent[] = [];
  for await (const event of store.replay(from, undefined, filter)) events.push(event);
  return events;
}

describe('M0.3 端到端切片：ActorContext → Event → InMemoryEventStore → Replay → RuntimeState', () => {
  it('种子组织全链路：创建事件（带 causation 链）→ 落库 → 回放 → 状态恢复 → 乐观锁提交', async () => {
    const seed = loadSeed();
    if (!seed.ok) throw new Error('seed load failed');
    const organization = seed.value;
    const identity = createIdentity(organization);
    const actor = identity.actorContext(
      'engineer-mike' as EmployeeId,
      'corr-m03-1' as CorrelationId,
    );

    const first = createOrgEvent(registry, {
      companyId: organization.company.id,
      type: 'Runtime.PresenceChanged',
      occurredAtSim: sim(10),
      actorKind: 'employee',
      actorId: actor.employeeId,
      subjectType: 'employee',
      subjectId: actor.employeeId,
      correlationId: actor.correlationId,
      payload: { employeeId: 'engineer-mike', presence: 'thinking' },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('event creation failed');
    const mikeThinking = first.value;

    const second = createOrgEvent(registry, {
      companyId: organization.company.id,
      type: 'Runtime.PresenceChanged',
      occurredAtSim: sim(20),
      actorKind: 'employee',
      actorId: actor.employeeId,
      subjectType: 'employee',
      subjectId: actor.employeeId,
      correlationId: actor.correlationId,
      causationId: mikeThinking.eventId,
      payload: { employeeId: 'engineer-mike', presence: 'planning' },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('event creation failed');
    const mikePlanning = second.value;

    const johnEvent = createOrgEvent(registry, {
      companyId: organization.company.id,
      type: 'Runtime.PresenceChanged',
      occurredAtSim: sim(15),
      actorKind: 'employee',
      actorId: 'cto-john',
      subjectType: 'employee',
      subjectId: 'cto-john',
      correlationId: 'corr-m03-2',
      payload: { employeeId: 'cto-john', presence: 'idle' },
    });
    expect(johnEvent.ok).toBe(true);
    if (!johnEvent.ok) throw new Error('event creation failed');
    const johnIdle = johnEvent.value;

    expect(mikeThinking.actorId).toBe('engineer-mike');
    expect(mikeThinking.correlationId).toBe('corr-m03-1');
    expect(mikePlanning.causationId).toBe(mikeThinking.eventId);
    expect(johnIdle.causationId).toBeNull();

    const store = createInMemoryEventStore({ now: () => '2026-10-01T00:00:00.000Z' });
    const watermark = await store.append([mikeThinking, mikePlanning, johnIdle]);
    expect(watermark).toBe(3);

    const all = await collect(store, 1 as Seq);
    expect(all.map((event) => [event.seq, event.eventId])).toEqual([
      [1, mikeThinking.eventId],
      [2, mikePlanning.eventId],
      [3, johnIdle.eventId],
    ]);
    expect(all.every((event) => event.occurredAtWall === '2026-10-01T00:00:00.000Z')).toBe(true);
    expect(all.every((event) => event.seq > 0)).toBe(true);

    const chain = await collect(store, 1 as Seq, { correlationId: 'corr-m03-1' });
    expect(chain.map((event) => event.eventId)).toEqual([
      mikeThinking.eventId,
      mikePlanning.eventId,
    ]);

    const forMike = await collect(store, 1 as Seq, { subjectId: 'engineer-mike' });
    expect(forMike.map((event) => event.eventId)).toEqual([
      mikeThinking.eventId,
      mikePlanning.eventId,
    ]);

    const recovered = replayAgentState(createInitialAgentState('engineer-mike' as EmployeeId), forMike);
    expect(recovered.presence).toBe('planning');
    expect(recovered.version).toBe(2);
    expect(recovered.updatedAtSim).toBe(20);
    expect(recovered.employment).toBe('defined');
    expect(recovered.branchId).toBe('live');

    const stateStore = createInMemoryStateStore();
    const committed = stateStore.commit(recovered, 0);
    expect(committed.ok).toBe(true);
    expect(stateStore.load('engineer-mike' as EmployeeId)).toEqual(recovered);
    expect(stateStore.commit(recovered, 0).ok).toBe(false);

    const johnRecovered = replayAgentState(
      createInitialAgentState('cto-john' as EmployeeId),
      await collect(store, 1 as Seq, { subjectId: 'cto-john' }),
    );
    expect(johnRecovered.presence).toBe('idle');
    expect(johnRecovered.version).toBe(1);
  });
});
