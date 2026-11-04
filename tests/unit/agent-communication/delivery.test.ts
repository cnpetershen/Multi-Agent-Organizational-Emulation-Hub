import { describe, expect, it } from 'vitest';
import type { CorrelationId } from '@maoeh/shared-types';
import { createMessage } from '@maoeh/agent-communication';
import {
  createCommunicationFixture,
  eid,
  openDirectChannel,
  openGroupChannel,
  sendDefaultMessage,
  sim,
} from '../../helpers/communication-fixtures';

describe('M0.7 消息投递（deliverMessage）', () => {
  it('投递成功 → delivered 并写入每收件人幂等记录', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);
    const message = sendDefaultMessage(fixture, { channelId, at: 12 });

    const first = fixture.service.deliverMessage({
      messageId: message.message.messageId,
      recipientId: eid('cto-john'),
      simTime: sim(20),
      sourceEventId: message.event.eventId,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.status).toBe('delivered');
    expect(first.value.recordedAtSim).toBe(20);
    expect(first.value.rejectionCode).toBeUndefined();
    expect(first.value.sourceEventId).toBe(message.event.eventId);

    const records = fixture.service.getDeliveries();
    expect(records).toHaveLength(1);
    expect(records[0]?.recipientId).toBe('cto-john');
    expect(records[0]?.channelId).toBe(channelId);
    expect(records[0]?.sourceEventId).toBe(message.event.eventId);
  });

  it('重复投递同一收件人 → duplicate（保留首次时间，不产生第二条记录）', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);
    const message = sendDefaultMessage(fixture, { channelId, at: 12 });

    const first = fixture.service.deliverMessage({
      messageId: message.message.messageId,
      recipientId: eid('cto-john'),
      simTime: sim(20),
    });
    expect(first.ok && first.value.status === 'delivered').toBe(true);

    const again = fixture.service.deliverMessage({
      messageId: message.message.messageId,
      recipientId: eid('cto-john'),
      simTime: sim(55),
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.status).toBe('duplicate');
    expect(again.value.recordedAtSim).toBe(20);
    expect(fixture.service.getDeliveries()).toHaveLength(1);
  });

  it('不同收件人的投递彼此隔离（幂等键含 recipientId）', () => {
    const fixture = createCommunicationFixture();
    const group = openGroupChannel(fixture);
    const message = sendDefaultMessage(fixture, {
      channelId: group,
      recipients: [eid('cto-john'), eid('engineer-mike')],
    });

    const toCto = fixture.service.deliverMessage({
      messageId: message.message.messageId,
      recipientId: eid('cto-john'),
      simTime: sim(21),
    });
    const toEngineer = fixture.service.deliverMessage({
      messageId: message.message.messageId,
      recipientId: eid('engineer-mike'),
      simTime: sim(22),
    });
    expect(toCto.ok && toCto.value.status === 'delivered').toBe(true);
    expect(toEngineer.ok && toEngineer.value.status === 'delivered').toBe(true);
    expect(fixture.service.getDeliveries()).toHaveLength(2);

    const duplicateForEngineer = fixture.service.deliverMessage({
      messageId: message.message.messageId,
      recipientId: eid('engineer-mike'),
      simTime: sim(30),
    });
    expect(duplicateForEngineer.ok && duplicateForEngineer.value.status).toBe('duplicate');
    expect(fixture.service.getDeliveries()).toHaveLength(2);
  });

  it('未知消息 → unknown_message；非参与收件人 → not_message_recipient', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);
    const message = sendDefaultMessage(fixture, { channelId });

    const unknown = fixture.service.deliverMessage({
      messageId: 'msg-404',
      recipientId: eid('cto-john'),
      simTime: sim(20),
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('unknown_message');

    const outsider = fixture.service.deliverMessage({
      messageId: message.message.messageId,
      recipientId: eid('engineer-mike'),
      simTime: sim(20),
    });
    expect(outsider.ok).toBe(false);
    if (!outsider.ok) expect(outsider.error.code).toBe('not_message_recipient');
  });

  it('频道已关闭 → rejected(channel_closed)；收件人非成员 → rejected(not_channel_member)', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);
    const message = sendDefaultMessage(fixture, { channelId });

    const channel = fixture.channels.get(channelId);
    expect(channel).not.toBeNull();
    if (channel === null) return;
    fixture.channels.save({ ...channel, status: 'closed' });

    const closed = fixture.service.deliverMessage({
      messageId: message.message.messageId,
      recipientId: eid('cto-john'),
      simTime: sim(20),
    });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.status).toBe('rejected');
    expect(closed.value.rejectionCode).toBe('channel_closed');
    expect(fixture.service.getDeliveries()).toHaveLength(0);

    fixture.channels.save({ ...channel, status: 'active' });
    const outsiderMessage = createMessage({
      messageId: 'msg-manual',
      channelId,
      senderEmployeeId: eid('ceo-alex'),
      recipientIds: [eid('engineer-mike')],
      subject: 's',
      body: 'b',
      messageType: 'information',
      createdAtSim: sim(21),
      correlationId: 'corr-manual' as CorrelationId,
    });
    fixture.messages.save(outsiderMessage);

    const notMember = fixture.service.deliverMessage({
      messageId: 'msg-manual',
      recipientId: eid('engineer-mike'),
      simTime: sim(22),
    });
    expect(notMember.ok).toBe(true);
    if (!notMember.ok) return;
    expect(notMember.value.status).toBe('rejected');
    expect(notMember.value.rejectionCode).toBe('not_channel_member');
    expect(fixture.service.getDeliveries()).toHaveLength(0);
  });
});
