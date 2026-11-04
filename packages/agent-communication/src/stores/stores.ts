import type { EmployeeId } from '@maoeh/shared-types';
import type { Channel } from '../channels/channel.js';
import type { DeliveryRecord } from '../delivery/delivery.js';
import { deliveryIdempotencyKey } from '../delivery/delivery.js';
import type { Message } from '../messages/message.js';

export interface ChannelStore {
  get(channelId: string): Channel | null;
  has(channelId: string): boolean;
  save(channel: Channel): void;
  all(): readonly Channel[];
}

export interface MessageStore {
  get(messageId: string): Message | null;
  has(messageId: string): boolean;
  save(message: Message): void;
  all(): readonly Message[];
}

export interface DeliveryStore {
  find(recipientId: EmployeeId, messageId: string): DeliveryRecord | null;
  save(record: DeliveryRecord): void;
  all(): readonly DeliveryRecord[];
}

export function createInMemoryChannelStore(): ChannelStore {
  const channels = new Map<string, Channel>();
  return {
    get(channelId) {
      return channels.get(channelId) ?? null;
    },
    has(channelId) {
      return channels.has(channelId);
    },
    save(channel) {
      channels.set(channel.channelId, channel);
    },
    all() {
      return Object.freeze([...channels.values()]);
    },
  };
}

export function createInMemoryMessageStore(): MessageStore {
  const messages = new Map<string, Message>();
  return {
    get(messageId) {
      return messages.get(messageId) ?? null;
    },
    has(messageId) {
      return messages.has(messageId);
    },
    save(message) {
      messages.set(message.messageId, message);
    },
    all() {
      return Object.freeze([...messages.values()]);
    },
  };
}

export function createInMemoryDeliveryStore(): DeliveryStore {
  const records = new Map<string, DeliveryRecord>();
  return {
    find(recipientId, messageId) {
      return records.get(deliveryIdempotencyKey(recipientId, messageId)) ?? null;
    },
    save(record) {
      records.set(deliveryIdempotencyKey(record.recipientId, record.messageId), record);
    },
    all() {
      return Object.freeze([...records.values()]);
    },
  };
}
