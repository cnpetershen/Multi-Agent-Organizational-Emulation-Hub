import { describe, expect, it } from 'vitest';
import type { EmployeeId, CorrelationId } from '@maoeh/shared-types';
import { createCommunicationFixture, eid, sim } from '../../helpers/communication-fixtures';

function directMembers(): readonly EmployeeId[] {
  return [eid('ceo-alex'), eid('cto-john')];
}

describe('M0.7 频道创建（createChannel）', () => {
  it('direct 频道创建成功，产出不可变 Channel 与 Communication.ChannelOpened 事件', () => {
    const fixture = createCommunicationFixture();
    const result = fixture.service.createChannel({
      actor: fixture.ceo,
      channelType: 'direct',
      memberIds: directMembers(),
      simTime: sim(10),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { channel, event } = result.value;
    expect(channel.channelId).toBe('chan-1');
    expect(channel.channelType).toBe('direct');
    expect(channel.memberAgentIds).toEqual(['ceo-alex', 'cto-john']);
    expect(channel.createdBy).toBe('ceo-alex');
    expect(channel.createdAtSim).toBe(10);
    expect(channel.status).toBe('active');
    expect(Object.isFrozen(channel)).toBe(true);
    expect(Object.isFrozen(channel.memberAgentIds)).toBe(true);

    expect(event.type).toBe('Communication.ChannelOpened');
    expect(event.eventId).toBe('evt-1');
    expect(event.subjectType).toBe('channel');
    expect(event.subjectId).toBe('chan-1');
    expect(event.actorKind).toBe('employee');
    expect(event.actorId).toBe('ceo-alex');
    expect(event.correlationId).toBe('corr-ceo');
    expect(event.payload).toEqual({
      channelId: 'chan-1',
      channelType: 'direct',
      createdBy: 'ceo-alex',
      memberIds: ['ceo-alex', 'cto-john'],
    });

    expect(fixture.service.getChannel('chan-1')).toEqual(channel);
    expect(fixture.service.getChannels()).toHaveLength(1);
    expect(fixture.registry.isRegistered('Communication.ChannelOpened')).toBe(true);
    expect(fixture.registry.isRegistered('Communication.MessageSent')).toBe(true);
  });

  it('两个独立 fixture 执行相同序列 → 频道与事件 id 完全一致（确定性）', () => {
    const first = createCommunicationFixture();
    const second = createCommunicationFixture();
    const input = {
      channelType: 'direct' as const,
      memberIds: directMembers(),
      simTime: sim(10),
    };
    const a = first.service.createChannel({ actor: first.ceo, ...input });
    const b = second.service.createChannel({ actor: second.ceo, ...input });

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.channel).toEqual(b.value.channel);
    expect(a.value.event).toEqual(b.value.event);
  });

  it('显式 channelId 重复创建 → duplicate_channel，且不产生第二个频道', () => {
    const fixture = createCommunicationFixture();
    const first = fixture.service.createChannel({
      actor: fixture.ceo,
      channelId: 'dm-1',
      channelType: 'direct',
      memberIds: directMembers(),
      simTime: sim(10),
    });
    expect(first.ok).toBe(true);

    const second = fixture.service.createChannel({
      actor: fixture.ceo,
      channelId: 'dm-1',
      channelType: 'direct',
      memberIds: directMembers(),
      simTime: sim(11),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe('duplicate_channel');
    expect(second.error.issues[0]?.field).toBe('channelId');
    expect(fixture.service.getChannels()).toHaveLength(1);
  });

  it('direct 频道成员数不等于 2 → invalid_channel', () => {
    const fixture = createCommunicationFixture();
    const result = fixture.service.createChannel({
      actor: fixture.ceo,
      channelType: 'direct',
      memberIds: [eid('ceo-alex'), eid('cto-john'), eid('engineer-mike')],
      simTime: sim(10),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_channel');
    expect(result.error.issues.some((issue) => issue.field === 'memberIds')).toBe(true);
  });

  it('创建者不在成员列表 → invalid_channel；成员重复 → invalid_channel', () => {
    const fixture = createCommunicationFixture();
    const withoutCreator = fixture.service.createChannel({
      actor: fixture.ceo,
      channelType: 'direct',
      memberIds: [eid('cto-john'), eid('engineer-mike')],
      simTime: sim(10),
    });
    expect(withoutCreator.ok).toBe(false);
    if (!withoutCreator.ok) {
      expect(withoutCreator.error.code).toBe('invalid_channel');
    }

    const duplicated = fixture.service.createChannel({
      actor: fixture.ceo,
      channelType: 'group',
      memberIds: [eid('ceo-alex'), eid('ceo-alex')],
      simTime: sim(10),
    });
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(duplicated.error.code).toBe('invalid_channel');
    }
  });

  it('成员不在组织身份中 → invalid_member；动作不落盘', () => {
    const fixture = createCommunicationFixture();
    const result = fixture.service.createChannel({
      actor: fixture.ceo,
      channelType: 'direct',
      memberIds: [eid('ceo-alex'), eid('ghost-employee')],
      simTime: sim(10),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_member');
    expect(fixture.service.getChannels()).toHaveLength(0);
  });

  it('actor 身份无法解析 → invalid_actor；actor 字段缺失 → invalid_actor', () => {
    const fixture = createCommunicationFixture();
    const unknownActor = fixture.service.createChannel({
      actor: { ...fixture.ceo, employeeId: eid('ghost-actor') },
      channelType: 'direct',
      memberIds: [eid('ghost-actor'), eid('cto-john')],
      simTime: sim(10),
    });
    expect(unknownActor.ok).toBe(false);
    if (!unknownActor.ok) {
      expect(unknownActor.error.code).toBe('invalid_actor');
    }

    const brokenShape = fixture.service.createChannel({
      actor: { ...fixture.ceo, correlationId: '' as CorrelationId },
      channelType: 'direct',
      memberIds: directMembers(),
      simTime: sim(10),
    });
    expect(brokenShape.ok).toBe(false);
    if (!brokenShape.ok) {
      expect(brokenShape.error.code).toBe('invalid_actor');
      expect(brokenShape.error.issues[0]?.field).toBe('correlationId');
    }
    expect(fixture.service.getChannels()).toHaveLength(0);
  });

  it('群聊频道：自动生成 id 并保留全部成员', () => {
    const fixture = createCommunicationFixture();
    const result = fixture.service.createChannel({
      actor: fixture.ceo,
      channelType: 'group',
      memberIds: [eid('ceo-alex'), eid('cto-john'), eid('engineer-mike')],
      simTime: sim(30),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.channel.channelId).toBe('chan-1');
    expect(result.value.channel.memberAgentIds).toHaveLength(3);
    expect(fixture.service.getChannels()).toHaveLength(1);
  });
});
