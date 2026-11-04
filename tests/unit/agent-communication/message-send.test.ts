import { describe, expect, it } from 'vitest';
import type { CorrelationId, EmployeeId } from '@maoeh/shared-types';
import type { MessageType } from '@maoeh/agent-communication';
import { MESSAGE_TYPES } from '@maoeh/agent-communication';
import type { PermissionPolicy } from '@maoeh/permission-system';
import { channelResource } from '@maoeh/permission-system';
import {
  createCommunicationFixture,
  defaultCommunicationPolicy,
  eid,
  loadMemoryOrganization,
  openDirectChannel,
  openGroupChannel,
  sendDefaultMessage,
  sim,
} from '../../helpers/communication-fixtures';

function restrictionFor(employeeId: EmployeeId): PermissionPolicy {
  return {
    grants: [...defaultCommunicationPolicy.grants],
    denies: [
      {
        subject: { kind: 'employee', employeeId },
        action: 'SendMessage',
        resource: 'channel:*',
      },
    ],
  };
}

describe('M0.7 消息发送（sendMessage）', () => {
  it('发送成功：产出不可变 Message 与 Communication.MessageSent 事件并落盘', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);

    const result = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 'Release plan',
      body: 'Ship M0.7 before Friday.',
      messageType: 'request',
      simTime: sim(12),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { message, event } = result.value;
    expect(message.messageId).toBe('msg-1');
    expect(message.channelId).toBe(channelId);
    expect(message.senderId).toBe('ceo-alex');
    expect(message.senderEmployeeId).toBe('ceo-alex');
    expect(message.recipientIds).toEqual(['cto-john']);
    expect(message.subject).toBe('Release plan');
    expect(message.body).toBe('Ship M0.7 before Friday.');
    expect(message.messageType).toBe('request');
    expect(message.createdAtSim).toBe(12);
    expect(message.correlationId).toBe('corr-ceo');
    expect(message.causationId).toBeNull();
    expect(message.traceId).toBeNull();
    expect(message.replyToMessageId).toBeUndefined();
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.recipientIds)).toBe(true);

    expect(event.type).toBe('Communication.MessageSent');
    expect(event.eventId).toBe('evt-2');
    expect(event.subjectType).toBe('message');
    expect(event.subjectId).toBe('msg-1');
    expect(event.actorId).toBe('ceo-alex');
    expect(event.occurredAtSim).toBe(12);
    expect(event.correlationId).toBe('corr-ceo');
    expect(event.payload).toEqual({
      messageId: 'msg-1',
      channelId,
      senderId: 'ceo-alex',
      recipientIds: ['cto-john'],
      subject: 'Release plan',
      body: 'Ship M0.7 before Friday.',
      messageType: 'request',
    });

    expect(fixture.service.getMessage('msg-1')).toEqual(message);
    expect(fixture.service.getMessages()).toHaveLength(1);
  });

  it('相同序列在两个 fixture 中产生完全一致的消息与事件（确定性）', () => {
    const first = createCommunicationFixture();
    const second = createCommunicationFixture();

    const run = (fixture: ReturnType<typeof createCommunicationFixture>) => {
      const channelId = openDirectChannel(fixture);
      const sent = fixture.service.sendMessage({
        actor: fixture.ceo,
        senderEmployeeId: eid('ceo-alex'),
        channelId,
        recipientIds: [eid('cto-john')],
        subject: 'Release plan',
        body: 'Ship M0.7 before Friday.',
        messageType: 'request',
        simTime: sim(12),
      });
      if (!sent.ok) throw new Error('setup send failed');
      return sent.value;
    };

    expect(run(first)).toEqual(run(second));
  });

  it('correlation/trace 可由调用方显式指定；默认继承 actor.correlationId', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);
    const explicit = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 'Trace',
      body: 'with trace',
      messageType: 'information',
      simTime: sim(20),
      correlationId: 'corr-explicit' as CorrelationId,
      causationId: 'evt-1',
      traceId: 'trace-1',
    });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.value.message.correlationId).toBe('corr-explicit');
    expect(explicit.value.message.causationId).toBe('evt-1');
    expect(explicit.value.message.traceId).toBe('trace-1');
    expect(explicit.value.event.causationId).toBe('evt-1');
    expect(explicit.value.event.traceId).toBe('trace-1');
  });

  it('actor 与 senderEmployeeId 不一致 → sender_mismatch，且不消耗消息 id', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);

    const mismatch = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('cto-john'),
      channelId,
      recipientIds: [eid('engineer-mike')],
      subject: 'Impersonation',
      body: 'I am the CTO.',
      messageType: 'request',
      simTime: sim(12),
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.error.code).toBe('sender_mismatch');
    expect(mismatch.error.issues[0]?.field).toBe('senderEmployeeId');

    const retry = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 'Real message',
      body: 'Now as myself.',
      messageType: 'request',
      simTime: sim(13),
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.value.message.messageId).toBe('msg-1');
    expect(fixture.service.getMessages()).toHaveLength(1);
  });

  it('sender 身份无法解析 → invalid_sender；身份与 actor 上下文不一致 → invalid_sender', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);

    const unknown = fixture.service.sendMessage({
      actor: { ...fixture.ceo, employeeId: eid('ghost-actor') },
      senderEmployeeId: eid('ghost-actor'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 'Ghost',
      body: 'Who am I?',
      messageType: 'request',
      simTime: sim(12),
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('invalid_sender');
    }

    const forgedContext = fixture.service.sendMessage({
      actor: { ...fixture.ceo, positionId: 'cto' as never },
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 'Forged',
      body: 'Wrong position.',
      messageType: 'request',
      simTime: sim(13),
    });
    expect(forgedContext.ok).toBe(false);
    if (!forgedContext.ok) {
      expect(forgedContext.error.code).toBe('invalid_sender');
      expect(forgedContext.error.issues[0]?.reason).toContain('does not match');
    }
  });

  it('草稿校验失败 → invalid_message（subject/body/recipientIds/messageType 逐字段定位）', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);
    const base = {
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      messageType: 'request' as MessageType,
      simTime: sim(12),
    };

    const emptySubject = fixture.service.sendMessage({ ...base, subject: '', body: 'body' });
    expect(emptySubject.ok).toBe(false);
    if (!emptySubject.ok) {
      expect(emptySubject.error.code).toBe('invalid_message');
      expect(emptySubject.error.issues[0]?.field).toBe('subject');
    }

    const oversizedBody = fixture.service.sendMessage({
      ...base,
      subject: 's',
      body: 'x'.repeat(10_001),
    });
    expect(oversizedBody.ok).toBe(false);
    if (!oversizedBody.ok) {
      expect(oversizedBody.error.issues[0]?.field).toBe('body');
    }

    const tooManyRecipients = fixture.service.sendMessage({
      ...base,
      subject: 's',
      body: 'b',
      recipientIds: Array.from({ length: 51 }, (_unused, index) =>
        eid(`employee-${index}`),
      ),
    });
    expect(tooManyRecipients.ok).toBe(false);
    if (!tooManyRecipients.ok) {
      expect(tooManyRecipients.error.code).toBe('invalid_message');
      expect(tooManyRecipients.error.issues[0]?.field).toBe('recipientIds');
    }

    const unknownType = fixture.service.sendMessage({
      ...base,
      subject: 's',
      body: 'b',
      messageType: 'urgent' as MessageType,
    });
    expect(unknownType.ok).toBe(false);
    if (!unknownType.ok) {
      expect(unknownType.error.issues[0]?.field).toBe('messageType');
    }

    expect(MESSAGE_TYPES).toEqual(['request', 'response', 'information']);
    expect(fixture.service.getMessages()).toHaveLength(0);
  });

  it('未知频道 / 发送者非成员 / 未知或非成员收件人 → 对应错误码', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);

    const unknownChannel = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId: 'nope',
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(12),
    });
    expect(unknownChannel.ok).toBe(false);
    if (!unknownChannel.ok) expect(unknownChannel.error.code).toBe('unknown_channel');

    const notMember = fixture.service.sendMessage({
      actor: fixture.engineer,
      senderEmployeeId: eid('engineer-mike'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(12),
    });
    expect(notMember.ok).toBe(false);
    if (!notMember.ok) expect(notMember.error.code).toBe('not_channel_member');

    const unknownRecipient = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('ghost-recipient')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(12),
    });
    expect(unknownRecipient.ok).toBe(false);
    if (!unknownRecipient.ok) {
      expect(unknownRecipient.error.code).toBe('invalid_recipient');
      expect(unknownRecipient.error.issues[0]?.reason).toContain('ghost-recipient');
    }

    const nonMemberRecipient = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('engineer-mike')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(12),
    });
    expect(nonMemberRecipient.ok).toBe(false);
    if (!nonMemberRecipient.ok) {
      expect(nonMemberRecipient.error.code).toBe('recipient_not_channel_member');
    }
  });

  it('收件人重复或包含发送者本人 → invalid_recipient', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);

    const duplicated = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john'), eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(12),
    });
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.error.code).toBe('invalid_recipient');

    const self = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('ceo-alex')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(12),
    });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.code).toBe('invalid_recipient');
  });

  it('回复：未知父消息 → unknown_message；跨频道回复 → invalid_message；非参与方 → not_message_recipient', () => {
    const fixture = createCommunicationFixture();
    const group = openGroupChannel(fixture);
    const other = openDirectChannel(fixture, { channelId: 'dm-other' });
    const parent = sendDefaultMessage(fixture, { channelId: group });

    const unknownParent = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId: group,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'response',
      simTime: sim(14),
      replyToMessageId: 'msg-404',
    });
    expect(unknownParent.ok).toBe(false);
    if (!unknownParent.ok) expect(unknownParent.error.code).toBe('unknown_message');

    const crossChannel = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId: other,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'response',
      simTime: sim(14),
      replyToMessageId: parent.message.messageId,
    });
    expect(crossChannel.ok).toBe(false);
    if (!crossChannel.ok) expect(crossChannel.error.code).toBe('invalid_message');

    const bystander = fixture.service.sendMessage({
      actor: fixture.engineer,
      senderEmployeeId: eid('engineer-mike'),
      channelId: group,
      recipientIds: [eid('ceo-alex')],
      subject: 's',
      body: 'b',
      messageType: 'response',
      simTime: sim(15),
      replyToMessageId: parent.message.messageId,
    });
    expect(bystander.ok).toBe(false);
    if (!bystander.ok) expect(bystander.error.code).toBe('not_message_recipient');

    const validReply = fixture.service.sendMessage({
      actor: fixture.cto,
      senderEmployeeId: eid('cto-john'),
      channelId: group,
      recipientIds: [eid('ceo-alex')],
      subject: 'Re: Release plan',
      body: 'Friday works.',
      messageType: 'response',
      simTime: sim(16),
      replyToMessageId: parent.message.messageId,
    });
    expect(validReply.ok).toBe(true);
    if (validReply.ok) {
      expect(validReply.value.message.replyToMessageId).toBe('msg-1');
    }
  });

  it('权限拒绝 → permission_denied（NO_PERMISSION）且不产生消息', () => {
    const fixture = createCommunicationFixture({
      policy: restrictionFor(eid('engineer-mike')),
    });
    const channelId = openGroupChannel(fixture);

    const denied = fixture.service.sendMessage({
      actor: fixture.engineer,
      senderEmployeeId: eid('engineer-mike'),
      channelId,
      recipientIds: [eid('ceo-alex')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(12),
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('permission_denied');
    expect(denied.error.denial?.reason).toBe('NO_PERMISSION');
    expect(denied.error.issues[0]?.reason).toContain('SendMessage');
    expect(fixture.service.getMessages()).toHaveLength(0);

    const allowed = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('engineer-mike')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(13),
    });
    expect(allowed.ok).toBe(true);
  });

  it('权限需要更高等级 → NEEDS_APPROVAL（requiredAuthority + escalateTo）', () => {
    const organization = loadMemoryOrganization({
      'company.yaml': 'id: acme\nname: Acme\n',
      'departments/engineering.yaml': 'id: engineering\nname: Engineering\n',
      'positions/ceo.yaml': 'id: ceo\ntitle: CEO\ndecision_domains:\n  org: L3\n',
      'positions/cto.yaml': 'id: cto\ntitle: CTO\ndepartment: engineering\nreports_to: ceo\n',
      'positions/engineer.yaml':
        'id: engineer\ntitle: Engineer\ndepartment: engineering\nreports_to: cto\n',
      'employees/ceo-alex.yaml': 'id: ceo-alex\nname: Alex\nposition: ceo\n',
      'employees/cto-john.yaml': 'id: cto-john\nname: John\nposition: cto\n',
      'employees/engineer-mike.yaml': 'id: engineer-mike\nname: Mike\nposition: engineer\n',
    });
    const elevated: PermissionPolicy = {
      grants: [
        ...defaultCommunicationPolicy.grants.filter(
          (grant) => grant.action !== 'SendMessage',
        ),
        {
          subject: { kind: 'any' },
          action: 'SendMessage',
          resource: 'channel:*',
          minAuthority: { domain: 'org', level: 2 },
        },
      ],
      denies: [],
    };
    const fixture = createCommunicationFixture({ policy: elevated, organization });
    const channelId = openDirectChannel(fixture, {
      members: [eid('ceo-alex'), eid('cto-john')],
    });

    const needsApproval = fixture.service.sendMessage({
      actor: fixture.engineer,
      senderEmployeeId: eid('engineer-mike'),
      channelId: openDirectChannel(fixture, {
        actor: fixture.engineer,
        members: [eid('engineer-mike'), eid('cto-john')],
        channelId: 'dm-eng',
      }),
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(12),
    });
    expect(needsApproval.ok).toBe(false);
    if (needsApproval.ok) return;
    expect(needsApproval.error.code).toBe('permission_denied');
    expect(needsApproval.error.denial?.reason).toBe('NEEDS_APPROVAL');
    expect(needsApproval.error.denial?.requiredAuthority).toBe(2);
    expect(needsApproval.error.denial?.escalateTo).toBe('cto-john');
    expect(needsApproval.error.issues[0]?.reason).toContain('escalateTo=cto-john');
    expect(fixture.service.getMessages()).toHaveLength(0);

    const allowed = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(13),
    });
    expect(allowed.ok).toBe(true);
  });
});

describe('M0.7 读侧动作接入 Action Space', () => {
  it('shared-types 提供 channel.read / message.read，权限策略可按资源匹配', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);
    const sendResult = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'information',
      simTime: sim(12),
    });
    expect(sendResult.ok).toBe(true);

    const decision = fixture.authz.can(fixture.ceo, 'channel.read', channelResource(channelId));
    expect(decision.allow).toBe(true);

    const deniedFixture = createCommunicationFixture({
      policy: {
        grants: [
          {
            subject: { kind: 'any' },
            action: 'SendMessage',
            resource: 'channel:*',
          },
        ],
        denies: [],
      },
    });
    const denied = deniedFixture.authz.can(
      deniedFixture.ceo,
      'channel.read',
      channelResource(channelId),
    );
    expect(denied.allow).toBe(false);
    if (!denied.allow) expect(denied.reason).toBe('NO_PERMISSION');
  });
});
