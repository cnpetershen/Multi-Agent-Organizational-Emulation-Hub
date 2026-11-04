export const MESSAGE_TYPES = ['request', 'response', 'information'] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];
