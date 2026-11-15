import { describe, expect, it } from 'vitest';
import type { EmployeeId } from '@maoeh/shared-types';
import {
  createCommunicationFixture,
  eid,
  openGroupChannel,
  sim,
} from '../../helpers/communication-fixtures';

/**
 * M3.1 · message idempotency and the processed half of the lifecycle.
 *
 * `Communication.MessageSent` is the only message fact that changes the organization; delivery is
 * a runtime ledger entry and `Communication.MessageProcessed` is the durable "the recipient
 * consumed it" fact. These tests pin the service-level rules:
 *
 *   - same sender + dedupeKey = same message (no second event, no second wakeup);
 *   - processed is idempotent, and a real failure can be upgraded by a later handling;
 *   - only a real recipient can be marked processed;
 *   - both the dedupe index and the processed marks survive a rebuild from the log.
 */

describe('M3.1 message lifecycle · idempotent send', () => {
  it('replays the original message for the same sender + dedupeKey', () => {
    const fixture = createCommunicationFixture();
    const channelId = openGroupChannel(fixture);

    const first = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 'take the release checklist',
      body: 'please take it',
      messageType: 'request',
      simTime: sim(10),
      dedupeKey: 'handoff:task-1',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.duplicate).toBe(false);

    const second = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 'take the release checklist',
      body: 'please take it (retry)',
      messageType: 'request',
      simTime: sim(11),
      dedupeKey: 'handoff:task-1',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.duplicate).toBe(true);
    expect(second.value.message.messageId).toBe(first.value.message.messageId);
    // The returned event is the original fact, already on the log — callers must not re-append it.
    expect(second.value.event.eventId).toBe(first.value.event.eventId);
    expect(fixture.service.getMessages()).toHaveLength(1);
  });

  it('keeps different senders or different keys apart', () => {
    const fixture = createCommunicationFixture();
    const channelId = openGroupChannel(fixture);
    const base = {
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request' as const,
      simTime: sim(10),
    };
    const ceo = fixture.service.sendMessage({
      ...base,
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      dedupeKey: 'k',
    });
    expect(ceo.ok).toBe(true);
    const engineer = fixture.service.sendMessage({
      ...base,
      actor: fixture.engineer,
      senderEmployeeId: eid('engineer-mike'),
      dedupeKey: 'k',
    });
    expect(engineer.ok).toBe(true);
    if (engineer.ok) expect(engineer.value.duplicate).toBe(false);
    expect(fixture.service.getMessages()).toHaveLength(2);
  });
});

describe('M3.1 message lifecycle · processed state', () => {
  it('records one processed fact per recipient, idempotently', () => {
    const fixture = createCommunicationFixture();
    const channelId = openGroupChannel(fixture);
    const sent = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(10),
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const messageId = sent.value.message.messageId;

    const handled = fixture.service.markProcessed({
      messageId,
      recipientId: eid('cto-john'),
      outcome: 'handled',
      simTime: sim(11),
      correlationId: 'corr-process' as never,
      causationId: sent.value.event.eventId,
    });
    expect(handled.ok).toBe(true);
    if (!handled.ok || handled.value === null) throw new Error('expected a processing fact');
    expect(handled.value.processing).toMatchObject({
      messageId,
      recipientId: 'cto-john',
      outcome: 'handled',
      processedAtSim: 11,
    });
    expect(handled.value.event.type).toBe('Communication.MessageProcessed');
    expect(handled.value.event.causationId).toBe(sent.value.event.eventId);

    // Same outcome twice: no second event.
    const repeat = fixture.service.markProcessed({
      messageId,
      recipientId: eid('cto-john'),
      outcome: 'handled',
      simTime: sim(12),
      correlationId: 'corr-process' as never,
    });
    expect(repeat.ok).toBe(true);
    if (repeat.ok) expect(repeat.value).toBeNull();
    // `handled` cannot be downgraded to `failed`.
    const downgrade = fixture.service.markProcessed({
      messageId,
      recipientId: eid('cto-john'),
      outcome: 'failed',
      simTime: sim(13),
      correlationId: 'corr-process' as never,
    });
    expect(downgrade.ok).toBe(true);
    if (downgrade.ok) expect(downgrade.value).toBeNull();
    expect(fixture.service.getProcessing()).toHaveLength(1);
  });

  it('lets a later handling upgrade an earlier failure', () => {
    const fixture = createCommunicationFixture();
    const channelId = openGroupChannel(fixture);
    const sent = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(10),
    });
    if (!sent.ok) throw new Error('send failed');
    const messageId = sent.value.message.messageId;

    const failed = fixture.service.markProcessed({
      messageId,
      recipientId: eid('cto-john'),
      outcome: 'failed',
      simTime: sim(11),
      correlationId: 'corr-process' as never,
    });
    expect(failed.ok && failed.value !== null).toBe(true);
    const handled = fixture.service.markProcessed({
      messageId,
      recipientId: eid('cto-john'),
      outcome: 'handled',
      simTime: sim(12),
      correlationId: 'corr-process' as never,
    });
    expect(handled.ok).toBe(true);
    if (!handled.ok || handled.value === null) throw new Error('expected an upgrade fact');
    expect(fixture.service.getProcessing()[0]?.outcome).toBe('handled');
  });

  it('refuses to mark a non-recipient as a processor', () => {
    const fixture = createCommunicationFixture();
    const channelId = openGroupChannel(fixture);
    const sent = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(10),
    });
    if (!sent.ok) throw new Error('send failed');
    const outcome = fixture.service.markProcessed({
      messageId: sent.value.message.messageId,
      recipientId: eid('marketing-jack') as EmployeeId,
      outcome: 'handled',
      simTime: sim(11),
      correlationId: 'corr-process' as never,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('not_message_recipient');
  });
});

describe('M3.1 message lifecycle · rebuild from the log', () => {
  it('restores messages, dedupe keys and processed marks without emitting events', () => {
    const fixture = createCommunicationFixture();
    const channelId = openGroupChannel(fixture);
    const sent = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(10),
      dedupeKey: 'k-1',
    });
    if (!sent.ok) throw new Error('send failed');
    const processed = fixture.service.markProcessed({
      messageId: sent.value.message.messageId,
      recipientId: eid('cto-john'),
      outcome: 'handled',
      simTime: sim(11),
      correlationId: 'corr-process' as never,
    });
    if (!processed.ok || processed.value === null) throw new Error('processing failed');

    // A second service over fresh stores is what recovery does: replay the channel, the message
    // fact and the processing fact — no new events, only projections.
    const restarted = createCommunicationFixture();
    const channel = restarted.service.createChannel({
      actor: restarted.ceo,
      channelId,
      channelType: 'group',
      memberIds: [eid('ceo-alex'), eid('cto-john'), eid('engineer-mike')],
      simTime: sim(5),
    });
    expect(channel.ok).toBe(true);
    const restored = restarted.service.restoreMessage(sent.value.event);
    expect(restored.ok).toBe(true);
    restarted.service.restoreProcessing(processed.value.event);
    expect(restarted.service.getMessages()).toHaveLength(1);
    expect(restarted.service.getProcessing()[0]).toMatchObject({ outcome: 'handled' });

    // The restored service knows the dedupe key, so a retried send is still a no-op.
    const duplicate = restarted.service.sendMessage({
      actor: restarted.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(12),
      dedupeKey: 'k-1',
    });
    expect(duplicate.ok).toBe(true);
    if (duplicate.ok) {
      expect(duplicate.value.duplicate).toBe(true);
      expect(duplicate.value.event.eventId).toBe(sent.value.event.eventId);
    }
  });
});
