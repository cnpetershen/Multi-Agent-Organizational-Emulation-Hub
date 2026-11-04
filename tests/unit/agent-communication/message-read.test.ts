import { describe, expect, it } from 'vitest';
import type { PermissionPolicy } from '@maoeh/permission-system';
import {
  createCommunicationFixture,
  defaultCommunicationPolicy,
  eid,
  openDirectChannel,
  openGroupChannel,
  sendDefaultMessage,
  sim,
} from '../../helpers/communication-fixtures';

function policyWithout(action: 'channel.read' | 'message.read'): PermissionPolicy {
  return {
    grants: defaultCommunicationPolicy.grants.filter((grant) => grant.action !== action),
    denies: [],
  };
}

describe('M0.7 消息读取（readMessage）', () => {
  it('发送者与接收者均可读取自己的消息', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);
    const sent = sendDefaultMessage(fixture, { channelId, at: 12 });

    const bySender = fixture.service.readMessage({
      actor: fixture.ceo,
      messageId: sent.message.messageId,
    });
    expect(bySender.ok).toBe(true);
    if (bySender.ok) {
      expect(bySender.value.message).toEqual(sent.message);
      expect(bySender.value.channel.channelId).toBe(channelId);
    }

    const byRecipient = fixture.service.readMessage({
      actor: fixture.cto,
      messageId: sent.message.messageId,
    });
    expect(byRecipient.ok).toBe(true);
  });

  it('未知消息 → unknown_message；actor 身份无效或与上下文不一致 → invalid_actor', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);
    sendDefaultMessage(fixture, { channelId });

    const unknown = fixture.service.readMessage({
      actor: fixture.ceo,
      messageId: 'msg-404',
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('unknown_message');

    const unknownActor = fixture.service.readMessage({
      actor: { ...fixture.ceo, employeeId: eid('ghost-actor') },
      messageId: 'msg-1',
    });
    expect(unknownActor.ok).toBe(false);
    if (!unknownActor.ok) expect(unknownActor.error.code).toBe('invalid_actor');

    const forgedContext = fixture.service.readMessage({
      actor: { ...fixture.ceo, positionId: 'cto' as never },
      messageId: 'msg-1',
    });
    expect(forgedContext.ok).toBe(false);
    if (!forgedContext.ok) {
      expect(forgedContext.error.code).toBe('invalid_actor');
      expect(forgedContext.error.issues[0]?.reason).toContain('does not match');
    }
  });

  it('频道成员但非消息参与方 → not_message_recipient；非频道成员 → not_channel_member', () => {
    const fixture = createCommunicationFixture();
    const group = openGroupChannel(fixture);
    const direct = openDirectChannel(fixture, { channelId: 'dm-1' });
    const groupMessage = sendDefaultMessage(fixture, { channelId: group });
    sendDefaultMessage(fixture, { channelId: direct });

    const bystander = fixture.service.readMessage({
      actor: fixture.engineer,
      messageId: groupMessage.message.messageId,
    });
    expect(bystander.ok).toBe(false);
    if (!bystander.ok) expect(bystander.error.code).toBe('not_message_recipient');

    const outsider = fixture.service.readMessage({
      actor: fixture.engineer,
      messageId: 'msg-2',
    });
    expect(outsider.ok).toBe(false);
    if (!outsider.ok) expect(outsider.error.code).toBe('not_channel_member');
  });

  it('读权限被拒 → permission_denied（channel.read / message.read 分别裁决）', () => {
    const noChannelRead = createCommunicationFixture({
      policy: policyWithout('channel.read'),
    });
    const channelSetup = openDirectChannel(noChannelRead);
    const channelMessage = sendDefaultMessage(noChannelRead, { channelId: channelSetup });
    const channelDenied = noChannelRead.service.readMessage({
      actor: noChannelRead.cto,
      messageId: channelMessage.message.messageId,
    });
    expect(channelDenied.ok).toBe(false);
    if (!channelDenied.ok) {
      expect(channelDenied.error.code).toBe('permission_denied');
      expect(channelDenied.error.issues[0]?.reason).toContain('channel.read:');
      expect(channelDenied.error.denial?.reason).toBe('NO_PERMISSION');
    }

    const noMessageRead = createCommunicationFixture({
      policy: policyWithout('message.read'),
    });
    const messageSetup = openDirectChannel(noMessageRead);
    const message = sendDefaultMessage(noMessageRead, { channelId: messageSetup });
    const messageDenied = noMessageRead.service.readMessage({
      actor: noMessageRead.cto,
      messageId: message.message.messageId,
    });
    expect(messageDenied.ok).toBe(false);
    if (!messageDenied.ok) {
      expect(messageDenied.error.code).toBe('permission_denied');
      expect(messageDenied.error.issues[0]?.reason).toContain('message.read:');
    }
  });

  it('已关闭频道的历史消息仍可读取（关闭只阻止新的发送与投递）', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);
    const message = sendDefaultMessage(fixture, { channelId, at: 8 });

    const channel = fixture.channels.get(channelId);
    expect(channel).not.toBeNull();
    if (channel === null) return;
    fixture.channels.save({ ...channel, status: 'closed' });

    const read = fixture.service.readMessage({
      actor: fixture.cto,
      messageId: message.message.messageId,
    });
    expect(read.ok).toBe(true);

    const resend = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(9),
    });
    expect(resend.ok).toBe(false);
    if (!resend.ok) expect(resend.error.code).toBe('channel_closed');
  });
});
