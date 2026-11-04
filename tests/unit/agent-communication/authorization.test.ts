import { describe, expect, it } from 'vitest';
import type { PermissionPolicy } from '@maoeh/permission-system';
import {
  createCommunicationFixture,
  defaultCommunicationPolicy,
  eid,
  openDirectChannel,
  sendDefaultMessage,
  sim,
} from '../../helpers/communication-fixtures';

describe('M0.7 授权建筑块（authorizeCommunication / resolveRecipients）', () => {
  it('authorizeCommunication 通过后返回频道与已解析收件人，且不写入任何消息', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);

    const result = fixture.service.authorizeCommunication({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(12),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.channel.channelId).toBe(channelId);
    expect(result.value.recipients).toHaveLength(1);
    expect(result.value.recipients[0]?.employeeId).toBe('cto-john');
    expect(result.value.recipients[0]?.positionId).toBe('cto');
    expect(result.value.recipients[0]?.departmentId).toBe('engineering');
    expect(fixture.service.getMessages()).toHaveLength(0);

    const sent = fixture.service.sendMessage({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(12),
    });
    expect(sent.ok).toBe(true);
    if (sent.ok) expect(sent.value.message.messageId).toBe('msg-1');
  });

  it('未知频道 → unknown_channel；权限被拒 → permission_denied（含 denial）', () => {
    const fixture = createCommunicationFixture({
      policy: {
        grants: defaultCommunicationPolicy.grants.filter(
          (grant) => grant.action !== 'SendMessage',
        ),
        denies: [],
      } satisfies PermissionPolicy,
    });
    const channelId = openDirectChannel(fixture);

    const unknownChannel = fixture.service.authorizeCommunication({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId: 'ghost-channel',
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(12),
    });
    expect(unknownChannel.ok).toBe(false);
    if (!unknownChannel.ok) expect(unknownChannel.error.code).toBe('unknown_channel');

    const denied = fixture.service.authorizeCommunication({
      actor: fixture.ceo,
      senderEmployeeId: eid('ceo-alex'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(12),
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe('permission_denied');
      expect(denied.error.denial?.reason).toBe('NO_PERMISSION');
    }
    expect(fixture.service.getMessages()).toHaveLength(0);
  });

  it('resolveRecipients：批量解析身份，未知/空/超限输入被拒绝', () => {
    const fixture = createCommunicationFixture();

    const resolved = fixture.service.resolveRecipients({
      recipientIds: [eid('cto-john'), eid('engineer-mike')],
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.map((identity) => identity.employeeId)).toEqual([
        'cto-john',
        'engineer-mike',
      ]);
      expect(resolved.value.map((identity) => identity.positionId)).toEqual([
        'cto',
        'engineer',
      ]);
    }

    const unknown = fixture.service.resolveRecipients({
      recipientIds: [eid('ghost-recipient')],
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('invalid_recipient');
      expect(unknown.error.issues[0]?.reason).toContain('ghost-recipient');
    }

    const empty = fixture.service.resolveRecipients({ recipientIds: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('invalid_recipient');

    const tooMany = fixture.service.resolveRecipients({
      recipientIds: Array.from({ length: 51 }, (_unused, index) =>
        eid(`employee-${index}`),
      ),
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.code).toBe('invalid_recipient');
  });

  it('授权不通过时后续发送仍以 msg-1 起始（授权阶段不消耗 id）', () => {
    const fixture = createCommunicationFixture();
    const channelId = openDirectChannel(fixture);
    const failed = fixture.service.authorizeCommunication({
      actor: fixture.ceo,
      senderEmployeeId: eid('cto-john'),
      channelId,
      recipientIds: [eid('cto-john')],
      subject: 's',
      body: 'b',
      messageType: 'request',
      simTime: sim(12),
    });
    expect(failed.ok).toBe(false);

    const sent = sendDefaultMessage(fixture, { channelId });
    expect(sent.message.messageId).toBe('msg-1');
    expect(sent.event.eventId).toBe('evt-2');
  });
});
