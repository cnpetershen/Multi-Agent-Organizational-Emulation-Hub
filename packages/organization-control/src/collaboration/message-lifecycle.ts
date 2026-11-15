import type { OrgEvent } from '@maoeh/shared-types';

/**
 * M3.1 · Message lifecycle (send → receive → process).
 *
 * Three different facts decide a message's state, and they live in three different places on
 * purpose (see `docs/architecture/M3.1-collaboration-event-protocol.md`):
 *
 *   - **sent**     — `Communication.MessageSent`, a durable domain fact.
 *   - **delivered**— the communication service's delivery ledger, a runtime read model: being
 *                    handed to a member's inbox is not an organizational state change, so it is
 *                    not an event. The ledger is passed in when the caller has it (the query does);
 *                    without it the lifecycle simply reports "not observed delivered".
 *   - **processed**— `Communication.MessageProcessed`, a durable fact emitted for a recipient
 *                    when the turn that consumed the message settles. A `failed` outcome may be
 *                    upgraded once by a later `handled`; the projection takes `handled` as truth.
 *
 * The projection is read-only and idempotent. `failed` is a real terminal state, not a missing
 * one: a turn that failed without a retry pending leaves `MessageProcessingFailed` evidence.
 */

const MESSAGE_SENT = 'Communication.MessageSent';
const MESSAGE_PROCESSED = 'Communication.MessageProcessed';

/** Structural shape of one delivery-ledger entry (`DeliveryRecord` satisfies it). */
export interface MessageDeliveryLike {
  readonly messageId: string;
  readonly recipientId: string;
  readonly channelId: string;
  readonly deliveredAtSim: number;
  readonly sourceEventId?: string;
}

export type MessageRecipientState = 'sent' | 'delivered' | 'processed' | 'failed';

export interface MessageRecipientLifecycle {
  readonly recipientId: string;
  readonly state: MessageRecipientState;
  readonly deliveredAtSim: number | null;
  readonly deliveredEventId: string | null;
  readonly processedAtSim: number | null;
  readonly processedEventId: string | null;
  readonly outcome: 'handled' | 'failed' | null;
}

export interface MessageLifecycle {
  readonly messageId: string;
  readonly channelId: string;
  readonly senderId: string;
  readonly subject: string;
  readonly messageType: string;
  readonly sentAtSim: number;
  readonly sentEventId: string;
  readonly recipients: readonly MessageRecipientLifecycle[];
}

function payloadOf(event: OrgEvent): Readonly<Record<string, unknown>> {
  return typeof event.payload === 'object' && event.payload !== null
    ? (event.payload as Readonly<Record<string, unknown>>)
    : {};
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readStringArray(record: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

interface ProcessingFact {
  readonly processedAtSim: number;
  readonly eventId: string;
  readonly outcome: 'handled' | 'failed';
}

/**
 * Lifecycle for every message the log knows, oldest message first. Recipients are reported in the
 * order the send named them; a recipient the caller has no delivery fact for is still reported —
 * with `deliveredAtSim: null` — because "we did not see it delivered" is information, not nothing.
 */
export function buildMessageLifecycles(
  events: readonly OrgEvent[],
  deliveries: readonly MessageDeliveryLike[] = [],
): readonly MessageLifecycle[] {
  const delivered = new Map<string, MessageDeliveryLike>();
  for (const delivery of deliveries) {
    delivered.set(`${delivery.messageId} ${delivery.recipientId}`, delivery);
  }
  const processed = new Map<string, ProcessingFact>();
  for (const event of events) {
    if (event.type !== MESSAGE_PROCESSED) continue;
    const payload = payloadOf(event);
    const messageId = readString(payload, 'messageId');
    const recipientId = readString(payload, 'recipientId');
    const outcome = readString(payload, 'outcome');
    if (messageId === null || recipientId === null) continue;
    if (outcome !== 'handled' && outcome !== 'failed') continue;
    const key = `${messageId} ${recipientId}`;
    const previous = processed.get(key);
    // `handled` wins over an earlier `failed`: a retry that eventually worked is the truth.
    if (previous !== undefined && previous.outcome === 'handled') continue;
    processed.set(key, {
      processedAtSim: Number(event.occurredAtSim),
      eventId: event.eventId,
      outcome,
    });
  }

  const lifecycles: MessageLifecycle[] = [];
  for (const event of events) {
    if (event.type !== MESSAGE_SENT) continue;
    const payload = payloadOf(event);
    const messageId = readString(payload, 'messageId');
    const channelId = readString(payload, 'channelId');
    if (messageId === null || channelId === null) continue;
    const recipients = readStringArray(payload, 'recipientIds').map((recipientId) => {
      const delivery = delivered.get(`${messageId} ${recipientId}`);
      const processing = processed.get(`${messageId} ${recipientId}`);
      const state: MessageRecipientState =
        processing === undefined
          ? delivery === undefined
            ? 'sent'
            : 'delivered'
          : processing.outcome === 'handled'
            ? 'processed'
            : 'failed';
      return Object.freeze({
        recipientId,
        state,
        deliveredAtSim: delivery === undefined ? null : Number(delivery.deliveredAtSim),
        deliveredEventId: delivery?.sourceEventId ?? null,
        processedAtSim: processing === undefined ? null : processing.processedAtSim,
        processedEventId: processing === undefined ? null : processing.eventId,
        outcome: processing === undefined ? null : processing.outcome,
      });
    });
    lifecycles.push(
      Object.freeze({
        messageId,
        channelId,
        senderId: readString(payload, 'senderId') ?? event.actorId ?? '',
        subject: readString(payload, 'subject') ?? '',
        messageType: readString(payload, 'messageType') ?? 'request',
        sentAtSim: Number(event.occurredAtSim),
        sentEventId: event.eventId,
        recipients: Object.freeze(recipients),
      }),
    );
  }
  return Object.freeze(lifecycles);
}
