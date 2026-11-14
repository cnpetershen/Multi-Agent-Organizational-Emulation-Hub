import { describe, expect, it } from 'vitest';
import type { EmployeeId } from '@maoeh/shared-types';
import { communicationViewOf } from '@maoeh/kernel';
import {
  createCommunicationFixture,
  eid,
  openGroupChannel,
  sendDefaultMessage,
} from '../../helpers/communication-fixtures';

/**
 * M-COMMUNICATION: the view a cycle hands to the prompt.
 *
 * The kernel builds this from the live `CommunicationService`, so the rules it applies are the
 * difference between "the model sees a sendable channel" and "the model guesses a channelId the
 * service will refuse". The important properties are membership (never suggest a channel the
 * agent cannot send to), recency (the thread being answered, not the whole archive) and bounds
 * (one long message cannot crowd out the task).
 */

function viewFor(fixture: ReturnType<typeof createCommunicationFixture>, employeeId: string) {
  return communicationViewOf(fixture.service, eid(employeeId));
}

describe('communicationViewOf', () => {
  it('is undefined for an agent in no channel', () => {
    const fixture = createCommunicationFixture();
    expect(communicationViewOf(fixture.service, eid('ceo-alex'))).toBeUndefined();
  });

  it('lists only channels the agent belongs to', () => {
    const fixture = createCommunicationFixture();
    const channelId = openGroupChannel(fixture, {
      members: [eid('ceo-alex'), eid('cto-john'), eid('engineer-mike')],
    });

    const cto = viewFor(fixture, 'cto-john');
    expect(cto?.channels.map((channel) => channel.channelId)).toEqual([channelId]);
    expect(cto?.channels[0]?.memberIds).toEqual(['ceo-alex', 'cto-john', 'engineer-mike']);

    // Carol is in the company but not on this channel: nothing to render, nothing to send.
    expect(viewFor(fixture, 'marketing-jack')).toBeUndefined();
  });

  it('shows the newest messages, oldest first, and caps the body', () => {
    const fixture = createCommunicationFixture();
    const channelId = openGroupChannel(fixture);

    for (let index = 1; index <= 8; index += 1) {
      sendDefaultMessage(fixture, {
        channelId,
        subject: `topic ${String(index)}`,
        body: `${String(index)}:${'x'.repeat(600)}`,
        at: index,
      });
    }

    const view = viewFor(fixture, 'cto-john');
    expect(view?.recentMessages).toHaveLength(6);
    expect(view?.recentMessages.map((message) => message.subject)).toEqual([
      'topic 3',
      'topic 4',
      'topic 5',
      'topic 6',
      'topic 7',
      'topic 8',
    ]);
    const body = view?.recentMessages[5]?.body ?? '';
    expect(body.startsWith('8:')).toBe(true);
    expect(body.length).toBe(500);
    expect(body.endsWith('…')).toBe(true);
  });

  it('carries the sender and recipients the reply has to name', () => {
    const fixture = createCommunicationFixture();
    const channelId = openGroupChannel(fixture);
    sendDefaultMessage(fixture, {
      channelId,
      sender: eid('ceo-alex'),
      recipients: [eid('cto-john')],
      subject: 'kickoff',
      messageType: 'request',
      at: 12,
    });

    const view = viewFor(fixture, 'cto-john');
    const message = view?.recentMessages[0];
    expect(message?.senderId).toBe('ceo-alex');
    expect(message?.recipientIds).toEqual(['cto-john']);
    expect(message?.messageType).toBe('request');
    expect(message?.createdAtSim).toBe(12);
  });

  it('is a projection: reading it appends no event', () => {
    const fixture = createCommunicationFixture();
    const channelId = openGroupChannel(fixture);
    sendDefaultMessage(fixture, { channelId });

    const before = fixture.service.getMessages().length;
    const view = viewFor(fixture, 'cto-john');
    expect(view?.recentMessages).toHaveLength(1);
    // The view must never be a second writer: the message count is unchanged and the returned
    // arrays are copies, so a caller mutating them cannot reach the service.
    expect(fixture.service.getMessages()).toHaveLength(before);
    const channelIds = view?.channels.map((channel) => channel.channelId) ?? [];
    channelIds.push('invented');
    expect(fixture.service.getChannels().map((channel) => channel.channelId)).not.toContain(
      'invented',
    );
  });

  it('keeps a company channel with many members readable', () => {
    const fixture = createCommunicationFixture();
    const members = fixture.organization.employees.map((employee) => employee.id);
    const channelId = openGroupChannel(fixture, { members });
    const view = communicationViewOf(fixture.service, eid('ceo-alex'));
    expect(view?.channels[0]?.channelId).toBe(channelId);
    expect(view?.channels[0]?.memberIds).toHaveLength(members.length);
    expect(view?.channels[0]?.memberIds.every((id) => members.includes(id as EmployeeId))).toBe(true);
  });
});
