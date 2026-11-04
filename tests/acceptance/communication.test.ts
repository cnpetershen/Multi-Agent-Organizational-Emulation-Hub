import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '@maoeh/llm-gateway';
import type { OrgEvent } from '@maoeh/shared-types';
import {
  COMPANY_CHANNEL_ID,
  createAcceptanceHarness,
  createObserver,
  renderTickTrace,
  type AcceptanceHarness,
  type TickTrace,
} from './runtime-harness';
import { collectEvents } from '../helpers/control-fixtures';

function log(...parts: readonly unknown[]): void {
  console.log(...parts);
}

function textOf(prompt: string, key: string): string | null {
  return new RegExp(`"${key}":\\s*"([^"]+)"`).exec(prompt)?.[1] ?? null;
}

/** Cognition that answers an instruction by messaging a colleague on the company channel. */
function chattyCognition(channelId: string) {
  return (request: LlmRequest): string => {
    const inputType = textOf(request.prompt, 'type') ?? '';
    const message =
      inputType === 'Communication.MessageSent'
        ? {
            sender: textOf(request.prompt, 'senderId') ?? 'ceo-alex',
            subject: 're: your message',
            body: 'Received and noted.',
            messageType: 'response',
          }
        : {
            sender: 'cto-john',
            subject: 'starting work',
            body: 'I picked up the brief.',
            messageType: 'request',
          };
    return JSON.stringify({
      interpretation: `I am answering ${inputType}.`,
      considerations: ['Communication is how a company coordinates.'],
      conclusion: 'Send a message.',
      confidence: 0.7,
      plan: {
        goal: 'the message is sent',
        doneWhen: 'it is on the channel',
        steps: [
          {
            action: 'SendMessage',
            args: {
              channelId,
              recipientIds: [message.sender],
              subject: message.subject,
              body: message.body,
              messageType: message.messageType,
            },
            reasonRef: 0,
          },
        ],
      },
    });
  };
}

async function step(harness: AcceptanceHarness, traces: TickTrace[]): Promise<TickTrace> {
  const observer = createObserver(harness);
  observer.beforeTick();
  const trace = await observer.observe(await harness.control.simulation.tick());
  traces.push(trace);
  return trace;
}

describe('M1.0 runtime acceptance: communication', () => {
  it('boots with the company channel, so the runtime needs no manual channel setup', async () => {
    const harness = await createAcceptanceHarness();
    const channels = harness.control.simulation.communication.getChannels();
    log('COMM: channels', JSON.stringify(channels.map((channel) => channel.channelId)));
    expect(channels.map((channel) => channel.channelId)).toEqual([COMPANY_CHANNEL_ID]);
    expect(channels[0]?.memberAgentIds).toContain('ceo-alex' as never);
    expect(channels[0]?.memberAgentIds).toContain('cto-john' as never);
  });

  it('delivers a message end-to-end through the runtime, with no setup step', async () => {
    const harness = await createAcceptanceHarness({
      llmText: chattyCognition(COMPANY_CHANNEL_ID),
    });

    const traces: TickTrace[] = [];
    await harness.execute('Agent.Instruct', {
      targetType: 'agent',
      targetId: 'ceo-alex',
      instruction: 'Own the churn problem.',
      reason: 'board directive',
    });
    for (let index = 0; index < 4; index += 1) await step(harness, traces);
    log(traces.map(renderTickTrace).join('\n'));

    const events = await collectEvents(harness.control.simulation.eventStore);
    const sent = events.filter((event: OrgEvent) => event.type === 'Communication.MessageSent');
    const deliveries = harness.control.simulation.communication.getDeliveries();
    log('COMM: sent', sent.length, 'deliveries', JSON.stringify(deliveries));
    log(
      'COMM: turns',
      traces.flatMap((trace) => trace.turns).map((turn) => `${turn.employeeId}:${turn.status}`),
    );

    expect(sent.length).toBeGreaterThan(0);
    // Sent, not merely logged: the delivery ledger proves the recipient received it.
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.map((delivery) => delivery.recipientId)).toContain('cto-john');
    // The recipient was really woken by the message event.
    expect(
      traces.flatMap((trace) => trace.turns).some((turn) => turn.employeeId === 'cto-john'),
    ).toBe(true);
    // Exactly one delivery per (message, recipient): no duplicate delivery.
    const keys = deliveries.map((delivery) => `${delivery.messageId}|${delivery.recipientId}`);
    expect(new Set(keys).size).toBe(keys.length);
    // And the reply came back on the same channel.
    expect(
      harness.control.simulation.communication
        .getMessages()
        .some((message) => message.messageType === 'response'),
    ).toBe(true);
    // No message was refused: every send in this run succeeded.
    expect(traces.flatMap((trace) => trace.turns).filter((turn) => turn.status === 'failed')).toEqual(
      [],
    );
  });
});
