import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  ActorKind,
  CompanyId,
  CorrelationId,
  EmployeeId,
  OrgEvent,
  SimTime,
} from '@maoeh/shared-types';
import { PRESENCE_STATES } from '@maoeh/shared-types';
import type { OrgEventInput } from '@maoeh/event-system';
import {
  createEventRegistry,
  createOrgEvent,
  EVENT_AGGREGATES,
  parseEventType,
} from '@maoeh/event-system';
import { loadOrganization } from '@maoeh/organization-model';
import { createIdentity } from '@maoeh/identity-system';
import { createNodeFsOrganizationReader } from '../../helpers/organization-readers';

const seedRoot = fileURLToPath(new URL('../../../agents/future-ai-lab/', import.meta.url));
const company = 'future-ai-lab' as CompanyId;
const sim = (minutes: number): SimTime => minutes as SimTime;

const presenceRegistry = (() => {
  const registry = createEventRegistry();
  const result = registry.register(
    'Runtime.PresenceChanged',
    z.object({
      employeeId: z.string().min(1),
      presence: z.enum(PRESENCE_STATES),
    }),
  );
  if (!result.ok) throw new Error('registry setup failed');
  return registry;
})();

function makeEvent(input: Partial<OrgEventInput> = {}): OrgEvent {
  const result = createOrgEvent(presenceRegistry, {
    companyId: company,
    type: 'Runtime.PresenceChanged',
    occurredAtSim: sim(100),
    actorKind: 'employee',
    correlationId: 'corr-1',
    payload: { employeeId: 'engineer-mike', presence: 'thinking' },
    ...input,
  });
  if (!result.ok) {
    throw new Error(result.error.issues.map((issue) => issue.reason).join('\n'));
  }
  return result.value;
}

describe('Event System：事件类型体系（03-data-model 3.6.2 taxonomy）', () => {
  it('聚合集合与文档一致（14 个聚合，Runtime 含 PresenceChanged 所属聚合，Control 于 ADR-013 加入）', () => {
    expect(EVENT_AGGREGATES).toEqual([
      'Organization',
      'Employee',
      'Relationship',
      'Communication',
      'Meeting',
      'Task',
      'Workflow',
      'Decision',
      'Memory',
      'Document',
      'Tool',
      'Runtime',
      'System',
      'Control',
    ]);
  });

  it('parseEventType：<Aggregate>.<过去式动词> 解析成功，聚合非法/格式非法 → null', () => {
    expect(parseEventType('Runtime.PresenceChanged')).toEqual({
      aggregate: 'Runtime',
      event: 'PresenceChanged',
    });
    expect(parseEventType('Employee.Hired')).toEqual({
      aggregate: 'Employee',
      event: 'Hired',
    });
    expect(parseEventType('Goal.Created')).toBeNull();
    expect(parseEventType('runtime.PresenceChanged')).toBeNull();
    expect(parseEventType('Runtime.presenceChanged')).toBeNull();
    expect(parseEventType('PresenceChanged')).toBeNull();
    expect(parseEventType('Runtime.Foo.Bar')).toBeNull();
  });
});

describe('Event System：注册表', () => {
  it('register 合法类型成功；重复注册被拒绝', () => {
    const registry = createEventRegistry();
    const first = registry.register('Task.Completed', z.object({ taskId: z.string() }));
    expect(first.ok).toBe(true);
    expect(registry.isRegistered('Task.Completed')).toBe(true);
    expect(registry.register('Task.Completed', z.object({ taskId: z.string() }))).toEqual({
      ok: false,
      error: {
        issues: [
          { field: 'type', reason: 'event type "Task.Completed" is already registered' },
        ],
      },
    });
    expect(registry.registeredTypes()).toEqual(['Task.Completed']);
  });

  it('register 聚合非法（如 04 引用的 Goal.*）或格式非法 → 被拒绝，且不落表', () => {
    const registry = createEventRegistry();
    for (const type of ['Goal.Created', 'task.Completed', '']) {
      const result = registry.register(type, z.object({}));
      expect(result.ok).toBe(false);
      expect(registry.isRegistered(type)).toBe(false);
    }
  });

  it('schemaFor：未注册类型 → null', () => {
    expect(presenceRegistry.schemaFor('Memory.Recorded')).toBeNull();
    expect(presenceRegistry.schemaFor('Runtime.PresenceChanged')).not.toBeNull();
  });

  it('Runtime.AgentInstantiated：04 引用但不在 03 taxonomy 中 → 可注册（按文档注册表语义校验，不设事件名白名单）', () => {
    const registry = createEventRegistry();
    expect(registry.register('Runtime.AgentInstantiated', z.object({})).ok).toBe(true);
  });
});

describe('Event System：创建有效事件', () => {
  it('信封默认值：seq 0、occurredAtWall 空、version 1、默认 UUID eventId、可空字段 null', () => {
    const event = makeEvent();
    expect(event.seq).toBe(0);
    expect(event.occurredAtWall).toBe('');
    expect(event.version).toBe(1);
    expect(event.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(event.actorId).toBeNull();
    expect(event.subjectType).toBeNull();
    expect(event.subjectId).toBeNull();
    expect(event.causationId).toBeNull();
    expect(event.traceId).toBeNull();
    expect(event.companyId).toBe(company);
    expect(event.type).toBe('Runtime.PresenceChanged');
    expect(event.occurredAtSim).toBe(100);
    expect(event.payload).toEqual({ employeeId: 'engineer-mike', presence: 'thinking' });
  });

  it('事件身份唯一：默认生成器两次创建 eventId 不同；注入生成器按序取号', () => {
    expect(makeEvent().eventId).not.toBe(makeEvent().eventId);
    let counter = 0;
    const generator = { eventIdGenerator: (): string => `evt-${(counter += 1)}` };
    const first = createOrgEvent(presenceRegistry, {
      companyId: company,
      type: 'Runtime.PresenceChanged',
      occurredAtSim: sim(1),
      actorKind: 'system',
      correlationId: 'corr-2',
      payload: { employeeId: 'engineer-mike', presence: 'idle' },
    }, generator);
    const second = createOrgEvent(presenceRegistry, {
      companyId: company,
      type: 'Runtime.PresenceChanged',
      occurredAtSim: sim(2),
      actorKind: 'system',
      correlationId: 'corr-2',
      payload: { employeeId: 'engineer-mike', presence: 'idle' },
    }, generator);
    expect(first.ok && first.value.eventId).toBe('evt-1');
    expect(second.ok && second.value.eventId).toBe('evt-2');
  });

  it('事件创建后不可变：外层与 payload 深冻结，运行时写入不生效', () => {
    const event = makeEvent();
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
    const mutable = event as unknown as { seq: number; payload: { presence: string } };
    expect(() => {
      mutable.seq = 99;
    }).toThrow(TypeError);
    expect(() => {
      mutable.payload.presence = 'idle';
    }).toThrow(TypeError);
    expect(event.seq).toBe(0);
    expect((event.payload as { presence: string }).presence).toBe('thinking');
  });

  it('correlation / causation：链上 correlationId 不变，causationId 指向前一事件', () => {
    const first = makeEvent({ correlationId: 'corr-chain' });
    const second = makeEvent({ correlationId: 'corr-chain', causationId: first.eventId });
    const third = makeEvent({ correlationId: 'corr-chain', causationId: second.eventId });
    expect(first.causationId).toBeNull();
    expect(second.causationId).toBe(first.eventId);
    expect(third.causationId).toBe(second.eventId);
    expect(first.correlationId).toBe('corr-chain');
    expect(second.correlationId).toBe('corr-chain');
    expect(third.correlationId).toBe('corr-chain');
  });

  it('ActorContext 作为事件 actor 字段：seed 组织的 context → actorId/correlationId', () => {
    const load = loadOrganization(createNodeFsOrganizationReader(seedRoot));
    if (!load.ok) throw new Error('seed load failed');
    const identity = createIdentity(load.value);
    const context = identity.actorContext('engineer-mike' as EmployeeId, 'corr-actor' as CorrelationId);
    const result = createOrgEvent(presenceRegistry, {
      companyId: load.value.company.id,
      type: 'Runtime.PresenceChanged',
      occurredAtSim: sim(5),
      actorKind: 'employee',
      actorId: context.employeeId,
      subjectType: 'employee',
      subjectId: context.employeeId,
      correlationId: context.correlationId,
      payload: { employeeId: 'engineer-mike', presence: 'planning' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actorId).toBe('engineer-mike');
    expect(result.value.correlationId).toBe('corr-actor');
    expect(result.value.subjectId).toBe('engineer-mike');
    expect(result.value.subjectType).toBe('employee');
  });
});

describe('Event System：创建失败（invalid event）与 payload 校验', () => {
  const expectIssues = (result: ReturnType<typeof createOrgEvent>, fields: string[]): void => {
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const actual = result.error.issues.map((issue) => issue.field);
    for (const field of fields) expect(actual).toContain(field);
  };

  it('信封非法：空 correlationId / 非法 actorKind / 负 occurredAtSim / 非法 version / 空 eventId', () => {
    expectIssues(
      createOrgEvent(presenceRegistry, { ...baseInput(), correlationId: '' }),
      ['correlationId'],
    );
    expectIssues(
      createOrgEvent(presenceRegistry, {
        ...baseInput(),
        actorKind: 'bot' as unknown as ActorKind,
      }),
      ['actorKind'],
    );
    expectIssues(
      createOrgEvent(presenceRegistry, { ...baseInput(), occurredAtSim: -1 as SimTime }),
      ['occurredAtSim'],
    );
    expectIssues(
      createOrgEvent(presenceRegistry, { ...baseInput(), version: 0 }),
      ['version'],
    );
    expectIssues(
      createOrgEvent(presenceRegistry, { ...baseInput(), eventId: '' }),
      ['eventId'],
    );
  });

  it('类型非法：格式不符 <Aggregate>.<过去式动词> / 聚合未知 → type issue', () => {
    expectIssues(
      createOrgEvent(presenceRegistry, { ...baseInput(), type: 'runtime.presenceChanged' }),
      ['type'],
    );
    expectIssues(
      createOrgEvent(presenceRegistry, { ...baseInput(), type: 'Goal.Created' }),
      ['type'],
    );
  });

  it('类型合法但未注册 → type issue（创建依赖注册表）', () => {
    const registry = createEventRegistry();
    expectIssues(createOrgEvent(registry, baseInput()), ['type']);
  });

  it('payload 校验：字段缺失/枚举非法 → 精确到 payload.<path>；payload 非对象 → payload', () => {
    expectIssues(
      createOrgEvent(presenceRegistry, {
        ...baseInput(),
        payload: { employeeId: 'engineer-mike', presence: 'floating' },
      }),
      ['payload.presence'],
    );
    expectIssues(
      createOrgEvent(presenceRegistry, { ...baseInput(), payload: { presence: 'idle' } }),
      ['payload.employeeId'],
    );
    expectIssues(createOrgEvent(presenceRegistry, { ...baseInput(), payload: 'nope' }), [
      'payload',
    ]);
  });

  it('payload 按注册 schema 的解析结果落入事件（transform 生效）', () => {
    const registry = createEventRegistry();
    const registered = registry.register(
      'Task.Completed',
      z.object({ taskId: z.string() }).transform((value) => ({ ...value, normalized: true })),
    );
    expect(registered.ok).toBe(true);
    const result = createOrgEvent(registry, {
      companyId: company,
      type: 'Task.Completed',
      occurredAtSim: sim(10),
      actorKind: 'employee',
      correlationId: 'corr-3',
      payload: { taskId: 'task-1' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payload).toEqual({ taskId: 'task-1', normalized: true });
  });
});

function baseInput(): OrgEventInput {
  return {
    companyId: company,
    type: 'Runtime.PresenceChanged',
    occurredAtSim: sim(100),
    actorKind: 'employee',
    correlationId: 'corr-1',
    payload: { employeeId: 'engineer-mike', presence: 'thinking' },
  };
}
