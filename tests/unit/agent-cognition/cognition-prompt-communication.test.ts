import { describe, expect, it } from 'vitest';
import type { EmployeeId } from '@maoeh/shared-types';
import { buildCognitionPrompt } from '../../../packages/agent-cognition/src/prompts/cognition';
import type { CommunicationView } from '@maoeh/agent-cognition';
import { testContext } from '../../helpers/cognition-fixtures';

/**
 * M-COMMUNICATION: the prompt is where the collaboration gap actually was.
 *
 * `CommunicationService` was implemented, authorized and tested, and the kernel wired it in — yet
 * a live company produced zero `Communication.*` events, because the cognition prompt carried no
 * `channelId` and no `SendMessage` contract. The executor required arguments the model had no way
 * to know, so no live planner could ever emit a sendable step.
 *
 * These assertions pin the fix at the prompt boundary: the channel an agent may name, the people
 * on it, the conversation it is answering, and the exact argument shape — while an agent in no
 * channel still gets no section at all.
 */

const CHANNEL_ID = 'company-future-ai-lab';

const VIEW: CommunicationView = {
  channels: [
    {
      channelId: CHANNEL_ID,
      channelType: 'group',
      memberIds: ['ceo-alex', 'cto-john', 'engineer-mike'] as readonly EmployeeId[],
    },
  ],
  recentMessages: [
    {
      messageId: 'msg-1',
      channelId: CHANNEL_ID,
      senderId: 'cto-john' as EmployeeId,
      recipientIds: ['engineer-mike'] as readonly EmployeeId[],
      subject: 'auth design',
      body: 'Please propose the session model for the login page.',
      messageType: 'request',
      createdAtSim: 42 as never,
    },
  ],
};

describe('cognition prompt: communication surface', () => {
  it('renders the channel, its members, the conversation and the SendMessage contract', () => {
    const prompt = buildCognitionPrompt(testContext({ communication: VIEW }));

    expect(prompt).toContain('## Communication');
    expect(prompt).toContain(CHANNEL_ID);
    expect(prompt).toContain('members: ceo-alex, cto-john, engineer-mike');
    expect(prompt).toContain('cto-john → engineer-mike · request · "auth design"');
    expect(prompt).toContain('Please propose the session model for the login page.');
    expect(prompt).toContain('SendMessage args:');
    expect(prompt).toContain('"messageType": "request" | "response"');
    // The reply rule is what turns an incoming request into a response in the same cycle.
    expect(prompt).toContain('answer it with one SendMessage on the same `channelId`');
  });

  it('renders nothing when the agent belongs to no channel', () => {
    const prompt = buildCognitionPrompt(testContext());
    expect(prompt).not.toContain('## Communication');
    expect(prompt).not.toContain('SendMessage args:');
  });

  it('renders an explicit "no messages yet" line instead of an empty conversation', () => {
    const prompt = buildCognitionPrompt(
      testContext({ communication: { channels: VIEW.channels, recentMessages: [] } }),
    );
    expect(prompt).toContain('(no messages on these channels yet)');
  });

  it('never renders a channel the agent is not a member of', () => {
    // The view is built by the kernel from live channels; this pins the prompt's contract that a
    // channel it is handed is a channel the agent may send on.
    const foreign: CommunicationView = {
      channels: [{ ...VIEW.channels[0]!, memberIds: ['ceo-alex', 'cto-john'] as readonly EmployeeId[] }],
      recentMessages: [],
    };
    const prompt = buildCognitionPrompt(testContext({ communication: foreign }));
    expect(prompt).toContain('members: ceo-alex, cto-john');
    expect(prompt).not.toContain('engineer-mike,');
  });
});
