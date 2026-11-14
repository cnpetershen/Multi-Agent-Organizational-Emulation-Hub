import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '@maoeh/llm-gateway';
import { collectEvents } from '../helpers/control-fixtures';
import { createSimulationHarness } from '../helpers/simulation-fixtures';

/**
 * M-COMMUNICATION round trip, driven the way a live company drives it.
 *
 * `communication-bootstrap.test.ts` already proves the service can send and deliver. This test
 * covers the half that was missing in production: the *prompt* the runtime hands to cognition now
 * names the channel and the `SendMessage` contract, so a planner can answer a message it received.
 *
 * The cognition double here is a scripted model, on purpose — the assertion is about the runtime
 * wiring (prompt → plan → CommunicationService → delivery → event log), not about model quality.
 * The real-model run is `scripts/verify-collaboration.mjs`.
 */

const CHANNEL_ID = 'company-future-ai-lab';
const KICKOFF_CORRELATION = 'corr-comm-roundtrip';

/**
 * The event that woke the agent, read out of the prompt the way a model reads it.
 *
 * Slicing at `## Input event` matters: the prompt also renders the `SendMessage` contract
 * (`"messageType": "request" | "response"`), and a regex over the whole prompt would match that
 * line and turn every cycle into a reply — which is exactly the kind of accident this test exists
 * to rule out.
 */
function inputEventOf(prompt: string): string {
  const index = prompt.indexOf('## Input event');
  return index === -1 ? '' : prompt.slice(index);
}

/** Answers an incoming request; does nothing for any other wake-up. */
function replyingCognition(prompts: string[]) {
  return (request: LlmRequest): string => {
    prompts.push(request.prompt);
    const inputEvent = inputEventOf(request.prompt);
    const incoming = /"type":\s*"Communication\.MessageSent"/.test(inputEvent)
      && /"messageType":\s*"request"/.test(inputEvent);
    const steps = incoming
      ? [
          {
            action: 'SendMessage',
            args: {
              channelId: CHANNEL_ID,
              recipientIds: ['ceo-alex'],
              subject: 're: kickoff',
              body: 'Session model reviewed: opaque session ids, 15-minute TTL, server-side store.',
              messageType: 'response',
            },
            reasonRef: 0,
          },
        ]
      : [{ action: 'UpdatePresence', args: { presence: 'idle' }, reasonRef: 0 }];
    return JSON.stringify({
      interpretation: incoming
        ? 'A colleague asked me to review the session model.'
        : 'Nothing is addressed to me.',
      considerations: ['A request from a colleague deserves an explicit answer.'],
      conclusion: incoming ? 'Reply with the review.' : 'Stay available.',
      confidence: 0.8,
      plan: { goal: 'answer the request', doneWhen: 'the answer is on the channel', steps },
    });
  };
}

describe('M-COMMUNICATION: the runtime prompt reaches communication', () => {
  it('carries the channel and the message contract to the woken agent, then records the reply', async () => {
    const prompts: string[] = [];
    const harness = await createSimulationHarness({ llmText: replyingCognition(prompts) });

    const sent = harness.simulation.communication.sendMessage({
      actor: harness.identity.actorContext('ceo-alex' as never, KICKOFF_CORRELATION as never),
      senderEmployeeId: 'ceo-alex' as never,
      channelId: CHANNEL_ID,
      recipientIds: ['engineer-mike' as never],
      subject: 'kickoff',
      body: 'Please review the session model for the login page.',
      messageType: 'request',
      simTime: 0 as never,
    });
    expect(sent.ok, sent.ok ? '' : JSON.stringify(sent.error)).toBe(true);
    if (!sent.ok) return;
    const kickoff = sent.value;
    await harness.simulation.inject([kickoff.event]);

    const tick = await harness.simulation.tick();
    expect(tick.turns.map((turn) => turn.employeeId)).toEqual(['engineer-mike']);
    expect(tick.turns[0]?.sourceEventId).toBe(kickoff.event.eventId);
    expect(tick.turns[0]?.status).toBe('acted');

    // 1. The prompt the woken agent's cognition actually received.
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? '';
    expect(prompt).toContain('## Communication');
    expect(prompt).toContain(CHANNEL_ID);
    expect(prompt).toContain('members: ceo-alex, cto-john, engineer-mike');
    expect(prompt).toContain('Please review the session model for the login page.');
    expect(prompt).toContain('SendMessage args:');

    // 2. The reply is a real event from the real service, not a synthesised row.
    const events = await collectEvents(harness.simulation.eventStore);
    const sentEvents = events.filter((event) => event.type === 'Communication.MessageSent');
    expect(sentEvents).toHaveLength(2);
    const reply = sentEvents[1];
    expect(reply?.actorId).toBe('engineer-mike');
    expect(reply?.payload).toMatchObject({
      channelId: CHANNEL_ID,
      senderId: 'engineer-mike',
      recipientIds: ['ceo-alex'],
      messageType: 'response',
      subject: 're: kickoff',
    });

    // 3. The causal chain: same correlation, and the reply is caused by the message it answers.
    expect(reply?.correlationId).toBe(KICKOFF_CORRELATION);
    expect(reply?.causationId).toBe(kickoff.event.eventId);

    // 4. Delivery: both sides got a real delivery record.
    const delivered = harness.simulation.communication
      .getDeliveries()
      .map((record) => `${record.messageId}:${record.recipientId}`);
    expect(delivered).toContain(`${kickoff.message.messageId}:engineer-mike`);
    expect(delivered.some((key) => key.endsWith(':ceo-alex'))).toBe(true);
  });

  it('stops after one response instead of answering forever', async () => {
    const prompts: string[] = [];
    const harness = await createSimulationHarness({ llmText: replyingCognition(prompts) });
    const sent = harness.simulation.communication.sendMessage({
      actor: harness.identity.actorContext('ceo-alex' as never, KICKOFF_CORRELATION as never),
      senderEmployeeId: 'ceo-alex' as never,
      channelId: CHANNEL_ID,
      recipientIds: ['engineer-mike' as never],
      subject: 'kickoff',
      body: 'Review please.',
      messageType: 'request',
      simTime: 0 as never,
    });
    if (!sent.ok) throw new Error('kickoff failed');
    await harness.simulation.inject([sent.value.event]);

    const first = await harness.simulation.tick();
    expect(first.turns.map((turn) => turn.employeeId)).toEqual(['engineer-mike']);

    // The CEO is woken by the response, and a response is not a request: one reply, then quiet.
    const second = await harness.simulation.tick();
    expect(second.turns.map((turn) => turn.employeeId)).toEqual(['ceo-alex']);
    expect(second.turns[0]?.status).toBe('acted');
    const third = await harness.simulation.tick();
    expect(third.turns).toEqual([]);

    const events = await collectEvents(harness.simulation.eventStore);
    expect(events.filter((event) => event.type === 'Communication.MessageSent')).toHaveLength(2);
  });
});
