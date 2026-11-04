import { z } from 'zod';

export const ID_LIMITS = {
  messageId: { min: 1, max: 128 },
  channelId: { min: 1, max: 64 },
  employeeId: { min: 1, max: 64 },
  collaborationId: { min: 1, max: 64 },
} as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const messageIdSchema = z
  .string()
  .min(ID_LIMITS.messageId.min)
  .max(ID_LIMITS.messageId.max)
  .regex(ID_PATTERN);

export const channelIdSchema = z
  .string()
  .min(ID_LIMITS.channelId.min)
  .max(ID_LIMITS.channelId.max)
  .regex(ID_PATTERN);

export const employeeIdSchema = z
  .string()
  .min(ID_LIMITS.employeeId.min)
  .max(ID_LIMITS.employeeId.max)
  .regex(ID_PATTERN);

export const collaborationIdSchema = z
  .string()
  .min(ID_LIMITS.collaborationId.min)
  .max(ID_LIMITS.collaborationId.max)
  .regex(ID_PATTERN);
