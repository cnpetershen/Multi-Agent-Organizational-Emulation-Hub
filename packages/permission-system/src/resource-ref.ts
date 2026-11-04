import type { Brand } from '@maoeh/shared-types';

export type ResourceRef = Brand<string, 'ResourceRef'>;

export function resourceRef(value: string): ResourceRef {
  return value as ResourceRef;
}

export function channelResource(channelId: string): ResourceRef {
  return `channel:${channelId}` as ResourceRef;
}

export function messageResource(channelId: string, messageId: string): ResourceRef {
  return `channel:${channelId}/message:${messageId}` as ResourceRef;
}
