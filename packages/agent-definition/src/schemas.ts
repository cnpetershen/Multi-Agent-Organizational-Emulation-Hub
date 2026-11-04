import { z } from 'zod';

export const agentIdentitySchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  traits: z.array(z.string().min(1)),
});

export const agentCapabilitiesSchema = z.record(
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
);

export const memoryPolicySchema = z.strictObject({
  retain: z.array(z.string().min(1)).min(1),
});

export const toolPolicySchema = z.strictObject({
  allowed: z.array(z.string().min(1)).min(1),
});

export const agentDefinitionSourceSchema = z.strictObject({
  id: z.string().min(1),
  employee: z.string().min(1),
  position: z.string().min(1),
  department: z.string().min(1).optional(),
  identity: agentIdentitySchema,
  responsibilities: z.array(z.string().min(1)).min(1),
  capabilities: agentCapabilitiesSchema,
  cognition_profile: z.string().min(1),
  memory_policy: memoryPolicySchema,
  tool_policy: toolPolicySchema,
});

export type AgentDefinitionSource = z.infer<typeof agentDefinitionSourceSchema>;
