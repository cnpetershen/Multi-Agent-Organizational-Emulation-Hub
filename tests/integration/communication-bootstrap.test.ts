import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '@maoeh/llm-gateway';
import { createInMemoryEventStore } from '@maoeh/event-store';
import { collectEvents } from '../helpers/control-fixtures';
import { createSimulationHarness } from '../helpers/simulation-fixtures';

const CHANNEL_ID = 'company-future-ai-lab';

/** Cognition that answers a request with a response and everything else with a no-op. */
function replyingCognition(channelId: string) {
  return (request: LlmRequest): string => {
    const isRequest = /"messageType":\s*"request"/.test(request.prompt);
    const steps = isRequest
      ? [
          {
            action: 'SendMessage',
            args: {
              channelId,
              recipientIds: ['ceo-alex'],
              subject: 're: kickoff',
              body: 'Drafting the technical approach.',
              messageType: 'response',
            },
            reasonRef: 0,
          },
        ]
      : [{ action: 'UpdatePresence', args: { presence: 'idle' }, reasonRef: 0 }];
    return JSON.stringify({
      interpretation: 'A message arrived.',
      considerations: ['Colleagues answer each other.'],
      conclusion: 'Reply or stay available.',
      confidence: 0.7,
      plan: { goal: 'handle the message', doneWhen: 'the channel shows it', steps },
    });
  };
}

function sendKickoff(harness: Awaited<ReturnType<typeof createSimulationHarness>>, channelId: string) {
  return harness.simulation.communication.sendMessage({
    actor: harness.identity.actorContext('ceo-alex' as never, 'corr-k1-boot' as never),
    senderEmployeeId: 'ceo-alex' as never,
    channelId,
    recipientIds: ['cto-john' as never],
    subject: 'kickoff',
    body: 'Please draft the technical approach.',
    messageType: 'request',
    simTime: 0 as never,
  });
}

/**
 * Regression for M1.0.1 K1 (report K1): a fresh simulation had no Communication channel at all,
 * so every agent `SendMessage` failed with `unknown_channel` until a deployment opened one by
 * hand. Company formation now opens the company channel through the existing `Comm.openChannel`
 * primitive and records it as `Communication.ChannelOpened`, so the channel is replayable.
 */
describe('M1.0.1 K1: a fresh simulation boots with a company channel', () => {
  it('opens exactly one company channel through the existing channel + event-store mechanism', async () => {
    const harness = await createSimulationHarness();

    const channels = harness.simulation.communication.getChannels();
    expect(channels).toHaveLength(1);
    const channel = channels[0];
    expect(channel?.channelId).toBe(CHANNEL_ID);
    expect(channel?.channelType).toBe('group');
    expect(channel?.status).toBe('active');
    expect([...channel?.memberAgentIds ?? []]).toEqual([
      'ceo-alex',
      'cto-john',
      'engineer-mike',
      'marketing-jack',
      'pm-bona',
      'qa-peter',
    ]);

    // Recorded as an event, not as hidden in-memory setup.
    const events = await collectEvents(harness.simulation.eventStore);
    expect(events.map((event) => event.type)).toEqual(['Communication.ChannelOpened']);
    const opened = events[0];
    expect(opened?.subjectId).toBe(CHANNEL_ID);
    expect(opened?.actorKind).toBe('employee');
    // The company-level position holder (the CEO: the only position without a department).
    expect(opened?.actorId).toBe('ceo-alex');
    expect(opened?.occurredAtSim).toBe(0);
  });

  it('sends, delivers and wakes a colleague without any manual channel setup', async () => {
    const harness = await createSimulationHarness({
      llmText: replyingCognition(CHANNEL_ID),
    });

    const sent = sendKickoff(harness, CHANNEL_ID);
    expect(sent.ok, sent.ok ? '' : JSON.stringify(sent.error)).toBe(true);
    if (!sent.ok) return;
    await harness.simulation.inject([sent.value.event]);

    const results = await harness.simulation.tick();
    // The recipient was woken by the message itself …
    expect(results.turns.map((turn) => turn.employeeId)).toEqual(['cto-john']);
    expect(results.turns[0]?.sourceEventId).toBe(sent.value.event.eventId);
    expect(results.turns[0]?.status).toBe('acted');

    const deliveryKeys = (): readonly string[] =>
      harness.simulation.communication
        .getDeliveries()
        .map((delivery) => `${delivery.messageId}:${delivery.recipientId}`);

    // … the kickoff was delivered to the CTO …
    expect(deliveryKeys()).toContain(`${sent.value.message.messageId}:cto-john`);
    // … and the reply came back on the same channel and reached the CEO in the same tick.
    expect(deliveryKeys()).toHaveLength(2);
    expect(deliveryKeys().some((key) => key.endsWith(':ceo-alex'))).toBe(true);

    // The exchange is bounded: the response is acknowledged, not answered with another message.
    const next = await harness.simulation.tick();
    expect(next.turns.map((turn) => turn.employeeId)).toEqual(['ceo-alex']);
    expect(deliveryKeys()).toHaveLength(2);
    const after = await harness.simulation.tick();
    expect(after.turns).toEqual([]);
    expect(after.status).toBe('idle');
  });

  it('rebuilds the channel from the log after a restart without duplicating it', async () => {
    const store = createInMemoryEventStore();
    const first = await createSimulationHarness({ eventStore: store });
    expect(first.simulation.communication.getChannels()).toHaveLength(1);

    // A restarted kernel: channels are in-memory state, so they are rebuilt from their events.
    const second = await createSimulationHarness({ eventStore: store });
    expect(second.simulation.communication.getChannels()).toHaveLength(1);
    expect(second.simulation.communication.getChannel(CHANNEL_ID)?.memberAgentIds).toContain(
      'cto-john' as never,
    );
    const openedEvents = (await collectEvents(store)).filter(
      (event) => event.type === 'Communication.ChannelOpened',
    );
    // Idempotent: the restart did not append a second formation record.
    expect(openedEvents).toHaveLength(1);

    // And the restarted kernel can send on the rebuilt channel immediately.
    const sent = sendKickoff(second, CHANNEL_ID);
    expect(sent.ok, sent.ok ? '' : JSON.stringify(sent.error)).toBe(true);
  });
});
