import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import type { Seq } from '@maoeh/event-store';
import { createInMemoryEventStore } from '@maoeh/event-store';
import { parseEventType } from '@maoeh/event-system';
import {
  COMMUNICATION_CHANNEL_OPENED,
  COMMUNICATION_MESSAGE_SENT,
} from '@maoeh/agent-communication';
import {
  createCommunicationFixture,
  eid,
  sendDefaultMessage,
  sim,
} from '../helpers/communication-fixtures';

async function collect(
  store: ReturnType<typeof createInMemoryEventStore>,
): Promise<OrgEvent[]> {
  const events: OrgEvent[] = [];
  for await (const event of store.replay(1 as Seq)) {
    events.push(event);
  }
  return events;
}

function openDirectChannelFor(fixture: ReturnType<typeof createCommunicationFixture>): string {
  const opened = fixture.service.createChannel({
    actor: fixture.ceo,
    channelType: 'direct',
    memberIds: [eid('ceo-alex'), eid('cto-john')],
    simTime: sim(5),
  });
  if (!opened.ok) throw new Error('channel setup failed');
  return opened.value.channel.channelId;
}

describe('M0.7 垂直切片：发送 → 事件落库 → 回放 → 投递 → 读取', () => {
  it('发送产生事件，事件落库回放后与消息状态一致，投递幂等且接收方可读', async () => {
    const fixture = createCommunicationFixture();
    const opened = fixture.service.createChannel({
      actor: fixture.ceo,
      channelType: 'direct',
      memberIds: [eid('ceo-alex'), eid('cto-john')],
      simTime: sim(5),
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const channelId = opened.value.channel.channelId;

    const sent = sendDefaultMessage(fixture, { channelId, at: 12 });
    const store = createInMemoryEventStore();
    await store.append([opened.value.event, sent.event]);

    const replayed = await collect(store);
    expect(replayed).toHaveLength(2);
    expect(replayed[0]?.type).toBe(COMMUNICATION_CHANNEL_OPENED);
    expect(replayed[0]?.subjectId).toBe(channelId);
    expect(replayed[1]?.type).toBe(COMMUNICATION_MESSAGE_SENT);

    const replayedMessageEvent = replayed[1];
    if (replayedMessageEvent === undefined) return;
    expect(replayedMessageEvent.subjectId).toBe(sent.message.messageId);
    expect(replayedMessageEvent.payload).toEqual({
      messageId: sent.message.messageId,
      channelId,
      senderId: 'ceo-alex',
      recipientIds: ['cto-john'],
      subject: sent.message.subject,
      body: sent.message.body,
      messageType: sent.message.messageType,
    });

    const message = fixture.service.getMessage(sent.message.messageId);
    expect(message).not.toBeNull();
    if (message === null) return;
    const payload = replayedMessageEvent.payload as {
      messageId: string;
      subject: string;
      recipientIds: string[];
    };
    expect(message.messageId).toBe(payload.messageId);
    expect(message.subject).toBe(payload.subject);
    expect(message.recipientIds).toEqual(payload.recipientIds);

    const first = fixture.service.deliverFromEvent(replayedMessageEvent);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value).toHaveLength(1);
    expect(first.value[0]?.status).toBe('delivered');
    expect(first.value[0]?.sourceEventId).toBe(sent.event.eventId);

    const repeat = fixture.service.deliverFromEvent(replayedMessageEvent);
    expect(repeat.ok).toBe(true);
    if (repeat.ok) expect(repeat.value[0]?.status).toBe('duplicate');
    expect(fixture.service.getDeliveries()).toHaveLength(1);

    const readByRecipient = fixture.service.readMessage({
      actor: fixture.cto,
      messageId: sent.message.messageId,
    });
    expect(readByRecipient.ok).toBe(true);
  });

  it('回放保序、seq 递增、事件类型符合命名规范', async () => {
    const fixture = createCommunicationFixture();
    const opened = fixture.service.createChannel({
      actor: fixture.ceo,
      channelType: 'direct',
      memberIds: [eid('ceo-alex'), eid('cto-john')],
      simTime: sim(5),
    });
    if (!opened.ok) throw new Error('channel setup failed');
    const sent = sendDefaultMessage(fixture, {
      channelId: opened.value.channel.channelId,
      at: 12,
    });

    const store = createInMemoryEventStore();
    await store.append([opened.value.event, sent.event]);

    const replayed = await collect(store);
    expect(replayed.map((event) => event.type)).toEqual([
      COMMUNICATION_CHANNEL_OPENED,
      COMMUNICATION_MESSAGE_SENT,
    ]);
    expect(replayed.map((event) => event.seq)).toEqual([1, 2]);
    for (const event of replayed) {
      expect(parseEventType(event.type)).not.toBeNull();
      expect(event.companyId).toBe('future-ai-lab');
      expect(event.actorKind).toBe('employee');
    }
    expect(replayed[1]?.occurredAtSim).toBe(12);
    expect(replayed[1]?.correlationId).toBe('corr-ceo');
    expect(replayed[1]?.occurredAtWall).not.toBe('');
  });

  it('事件消费者按 consumer_key 幂等：不同收件人与不同消费组互不影响', async () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannelFor(fixture);
    const sent = sendDefaultMessage(fixture, { channelId, at: 12 });

    const store = createInMemoryEventStore();
    await store.append([sent.event]);

    const group = 'comm-delivery';
    store.markProcessed(group, sent.event.eventId, 'cto-john');
    expect(store.isProcessed(group, sent.event.eventId, 'cto-john')).toBe(true);
    expect(store.isProcessed(group, sent.event.eventId, 'engineer-mike')).toBe(false);
    expect(store.isProcessed('other-group', sent.event.eventId, 'cto-john')).toBe(false);
  });

  it('相同序列在两个独立 fixture 中产生一致的消息、事件与投递（确定性）', () => {
    const run = () => {
      const fixture = createCommunicationFixture();
      const channelId = openDirectChannelFor(fixture);
      const sent = sendDefaultMessage(fixture, { channelId, at: 12 });
      const delivered = fixture.service.deliverMessage({
        messageId: sent.message.messageId,
        recipientId: eid('cto-john'),
        simTime: sim(20),
      });
      if (!delivered.ok) throw new Error('delivery failed');
      return {
        channel: fixture.service.getChannel(channelId),
        message: fixture.service.getMessage(sent.message.messageId),
        event: sent.event,
        deliveries: fixture.service.getDeliveries(),
      };
    };

    expect(run()).toEqual(run());
  });
});
