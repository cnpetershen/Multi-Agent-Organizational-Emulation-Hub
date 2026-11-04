import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Result } from '@maoeh/shared-types';
import type { AuthorityLevel, EmployeeId, PositionId } from '@maoeh/shared-types';
import { DECISION_DOMAINS } from '@maoeh/shared-types';
import { workflowIssue } from './workflow-errors.js';
import type { WorkflowIssue } from './workflow-errors.js';
import type {
  ApprovalPolicy,
  AssignmentRule,
  CyclePolicy,
  TransitionCondition,
  TransitionTarget,
  WorkflowDefinition,
  WorkflowStage,
  WorkflowStep,
  WorkflowTransition,
} from './workflow-types.js';
import {
  APPROVAL_POLICIES,
  CYCLE_POLICIES,
  STEP_KINDS,
} from './workflow-types.js';
import { validateWorkflowDefinition } from './workflow-validation.js';

export interface WorkflowSourceReader {
  list(relativeDirectory: string): readonly string[];
  read(relativePath: string): string | null;
}

const id = z.string().min(1).max(64);

const assignmentSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('employee'), employee_id: id }),
  z.object({ kind: z.literal('position'), position_id: id }),
  // Declares the kind of work, not the seat: the live chart decides who does it, so a template
  // survives a roster change instead of pinning execution to a title.
  z.object({ kind: z.literal('capability'), capability: id }),
  z.object({ kind: z.literal('unassigned') }),
]);

const verificationSource = z.object({
  kind: z.enum(['deterministic', 'review']),
  required_output_keys: z.array(id),
});

const authoritySource = z.object({
  domain: z.enum(DECISION_DOMAINS),
  level: z.number().int().min(0).max(5),
});

const conditionSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('always') }),
  z.object({
    kind: z.literal('task_status'),
    status: z.enum(['completed', 'rejected', 'failed']),
  }),
  z.object({
    kind: z.literal('approval_decision'),
    decision: z.enum(['granted', 'denied']),
  }),
]);

const targetSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('step'), step_id: id, stage_id: id.nullable().optional() }),
  z.object({ kind: z.literal('stage'), stage_id: id }),
  z.object({ kind: z.literal('complete') }),
  z.object({ kind: z.literal('fail'), reason: z.string().nullable().optional() }),
]);

const stepSource = z.object({
  step_id: id,
  name: z.string().min(1),
  kind: z.enum(STEP_KINDS),
  description: z.string().nullable().optional(),
  // The kind of work the step declares (see `WorkflowStep.capability`). Declared in the
  // template rather than inferred from the assignment, so a step pinned to a seat can still
  // tell its executor what the work is.
  capability: id.optional(),
  assignment: assignmentSource.nullable().optional(),
  verification: verificationSource.nullable().optional(),
  max_attempts: z.number().int().min(1).optional(),
  required_authority: authoritySource.nullable().optional(),
  required_roles: z.array(z.string().min(1)).optional(),
  approval_policy: z.enum(APPROVAL_POLICIES).optional(),
  required_count: z.number().int().min(1).optional(),
});

const transitionSource = z.object({
  transition_id: id,
  from_step_id: id,
  when: conditionSource,
  to: targetSource,
});

const stageSource = z.object({
  stage_id: id,
  name: z.string().min(1),
  steps: z.array(stepSource).min(1),
  transitions: z.array(transitionSource).min(1),
});

const workflowSource = z.object({
  workflow_id: id,
  version: z.number().int().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  cycle_policy: z.enum(CYCLE_POLICIES).optional(),
  entry_stage: id,
  terminal_stages: z.array(id).min(1),
  stages: z.array(stageSource).min(1),
});

type WorkflowSource = z.infer<typeof workflowSource>;

function toAssignment(
  raw: z.infer<typeof assignmentSource> | null | undefined,
): AssignmentRule | null {
  if (raw === null || raw === undefined) return null;
  if (raw.kind === 'employee') {
    return { kind: 'employee', employeeId: raw.employee_id as EmployeeId };
  }
  if (raw.kind === 'position') {
    return { kind: 'position', positionId: raw.position_id as PositionId };
  }
  if (raw.kind === 'capability') {
    return { kind: 'capability', capability: raw.capability };
  }
  return { kind: 'unassigned' };
}

function toCondition(raw: z.infer<typeof conditionSource>): TransitionCondition {
  if (raw.kind === 'always') return { kind: 'always' };
  if (raw.kind === 'task_status') {
    return { kind: 'task_status', status: raw.status };
  }
  return { kind: 'approval_decision', decision: raw.decision };
}

function toTarget(raw: z.infer<typeof targetSource>): TransitionTarget {
  if (raw.kind === 'step') {
    return { kind: 'step', stageId: raw.stage_id ?? null, stepId: raw.step_id };
  }
  if (raw.kind === 'stage') return { kind: 'stage', stageId: raw.stage_id };
  if (raw.kind === 'fail') return { kind: 'fail', reason: raw.reason ?? null };
  return { kind: 'complete' };
}

function defaultRequiredCount(
  policy: ApprovalPolicy,
  requiredRoles: readonly string[],
): number {
  if (policy === 'all') return requiredRoles.length;
  return 1;
}

function toStep(raw: z.infer<typeof stepSource>): WorkflowStep {
  const roles = raw.required_roles ?? [];
  const policy: ApprovalPolicy = raw.approval_policy ?? 'single';
  const assignment = toAssignment(raw.assignment);
  // A capability assignment *is* a declaration of the kind of work, so the step does not have to
  // say it twice. An explicit `capability:` wins, because a step may be pinned to a seat while
  // still owning a kind of work (e.g. the CEO's step that drafts the requirements).
  const declared =
    raw.capability ?? (assignment !== null && assignment.kind === 'capability' ? assignment.capability : undefined);
  return {
    stepId: raw.step_id,
    name: raw.name,
    kind: raw.kind,
    ...(declared === undefined ? {} : { capability: declared }),
    description: raw.description ?? null,
    assignment,
    verification:
      raw.verification === null || raw.verification === undefined
        ? null
        : {
            kind: raw.verification.kind,
            requiredOutputKeys: [...raw.verification.required_output_keys],
          },
    maxAttempts: raw.max_attempts ?? 1,
    requiredAuthority:
      raw.required_authority === null || raw.required_authority === undefined
        ? null
        : {
            domain: raw.required_authority.domain,
            level: raw.required_authority.level as AuthorityLevel,
          },
    requiredRoles: [...roles],
    approvalPolicy: policy,
    requiredCount: raw.required_count ?? defaultRequiredCount(policy, roles),
  };
}

function toTransition(raw: z.infer<typeof transitionSource>): WorkflowTransition {
  return {
    transitionId: raw.transition_id,
    fromStepId: raw.from_step_id,
    when: toCondition(raw.when),
    to: toTarget(raw.to),
  };
}

function toStage(raw: z.infer<typeof stageSource>): WorkflowStage {
  return {
    stageId: raw.stage_id,
    name: raw.name,
    steps: raw.steps.map(toStep),
    transitions: raw.transitions.map(toTransition),
  };
}

function zodIssues(error: z.ZodError, sourceName: string): readonly WorkflowIssue[] {
  return error.issues.map((issue) =>
    workflowIssue(
      issue.path.length === 0 ? sourceName : `${sourceName}.${issue.path.map(String).join('.')}`,
      issue.message,
    ),
  );
}

export function parseWorkflowDefinition(
  source: string,
  sourceName = 'workflow',
): Result<WorkflowDefinition, { readonly issues: readonly WorkflowIssue[] }> {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: { issues: [workflowIssue(sourceName, `yaml parse error: ${message}`)] },
    };
  }
  const parsed = workflowSource.safeParse(document);
  if (!parsed.success) {
    return { ok: false, error: { issues: zodIssues(parsed.error, sourceName) } };
  }
  const raw: WorkflowSource = parsed.data;
  const definition: WorkflowDefinition = {
    workflowId: raw.workflow_id,
    version: raw.version,
    name: raw.name,
    description: raw.description ?? null,
    cyclePolicy: (raw.cycle_policy ?? 'forbid') as CyclePolicy,
    entryStageId: raw.entry_stage,
    terminalStageIds: [...raw.terminal_stages],
    stages: raw.stages.map(toStage),
  };
  const issues = validateWorkflowDefinition(definition);
  if (issues.length > 0) return { ok: false, error: { issues } };
  return { ok: true, value: definition };
}

export function loadWorkflowDefinition(
  reader: WorkflowSourceReader,
  relativePath: string,
): Result<WorkflowDefinition, { readonly issues: readonly WorkflowIssue[] }> {
  const content = reader.read(relativePath);
  if (content === null) {
    return {
      ok: false,
      error: { issues: [workflowIssue(relativePath, 'workflow file not found')] },
    };
  }
  return parseWorkflowDefinition(content, relativePath);
}

export function loadWorkflowDefinitions(
  reader: WorkflowSourceReader,
  relativeDirectory: string,
): Result<readonly WorkflowDefinition[], { readonly issues: readonly WorkflowIssue[] }> {
  const paths = reader.list(relativeDirectory);
  const definitions: WorkflowDefinition[] = [];
  const issues: WorkflowIssue[] = [];
  for (const path of paths) {
    const loaded = loadWorkflowDefinition(reader, path);
    if (loaded.ok) {
      definitions.push(loaded.value);
    } else {
      issues.push(...loaded.error.issues);
    }
  }
  if (issues.length > 0) return { ok: false, error: { issues } };
  return { ok: true, value: definitions };
}
