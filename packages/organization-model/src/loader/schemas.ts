import { z } from 'zod';
import type { AuthorityLevel } from '@maoeh/shared-types';

const identifier = z.string().min(1);

const authorityLevelSchema = z
  .union([z.number().int().min(0).max(5), z.string().regex(/^L[0-5]$/)])
  .transform((value): AuthorityLevel =>
    typeof value === 'number'
      ? (value as AuthorityLevel)
      : (Number(value.slice(1)) as AuthorityLevel),
  );

export const decisionDomainsSchema = z.strictObject({
  engineering: authorityLevelSchema.optional(),
  product: authorityLevelSchema.optional(),
  ops: authorityLevelSchema.optional(),
  marketing: authorityLevelSchema.optional(),
  finance: authorityLevelSchema.optional(),
  org: authorityLevelSchema.optional(),
});

export const companySchema = z.strictObject({
  id: identifier,
  name: identifier,
  mission: z.string().optional(),
  strategy: z.unknown().optional(),
  founded_sim_day: z.number().int().optional(),
});

export const departmentSchema = z.strictObject({
  id: identifier,
  name: identifier,
  key: identifier.optional(),
  parent: identifier.optional(),
  head_position: identifier.optional(),
  budget: z.unknown().optional(),
});

export const positionSchema = z.strictObject({
  id: identifier,
  title: identifier,
  key: identifier.optional(),
  department: identifier.optional(),
  reports_to: identifier.optional(),
  role_code: identifier.optional(),
  authority_level: authorityLevelSchema.optional(),
  responsibilities: z.unknown().optional(),
  required_skills: z.unknown().optional(),
  headcount: z.number().int().min(0).optional(),
  status: z.enum(['open', 'filled', 'frozen', 'closed']).optional(),
  decision_domains: decisionDomainsSchema.optional(),
  /** Capability tags this seat provides for capability → position task routing. */
  capabilities: z.array(z.string().min(1).max(64)).optional(),
});

export const employeeSchema = z.strictObject({
  id: identifier,
  name: identifier,
  position: identifier,
  employee_no: identifier.optional(),
  kind: z.enum(['agent', 'human']).optional(),
  status: z
    .enum([
      'defined',
      'onboarding',
      'active',
      'on_leave',
      'suspended',
      'transferred',
      'offboarded',
    ])
    .optional(),
  attributes: z.unknown().optional(),
  /** Fine-grained specializations of the person (capability matching reads them, M1.6). */
  expertise: z.array(z.string().min(1).max(64)).optional(),
});
