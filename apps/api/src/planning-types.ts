import { z } from 'zod';

/**
 * M3.3 · 需求沙盘与智能体编排的数据契约。
 *
 * These schemas are the contract between the requirements sandbox, the orchestrator, the
 * persistence layer, the HTTP edge and the console. They are deliberately strict:
 *
 * - the user's own words are kept verbatim in `source.goal`, and every field the model inferred is
 *   listed in `provenance.inferred` — an inference is never presented as an explicit requirement;
 * - a plan with open blocking questions, no deliverable, no acceptance criterion or no capability
 *   is `needs_clarification`; it cannot be confirmed and cannot be orchestrated;
 * - an orchestration is a *draft*: it carries real employees and dependencies, but it never starts
 *   a task. The workflow instance it creates is a canvas draft awaiting human confirmation (M3.4).
 */

export const REQUIREMENT_STATUSES = ['draft', 'needs_clarification', 'confirmed'] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

export const PLAN_MODES = ['live', 'sandbox', 'deterministic'] as const;
export type PlanMode = (typeof PLAN_MODES)[number];

export const RISK_SEVERITIES = ['low', 'medium', 'high'] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

const boundedText = (max: number) => z.string().min(1).max(max);
const textList = (max: number, maxItem = 500) =>
  z.array(boundedText(maxItem)).max(max);

export const RequirementClarificationSchema = z.object({
  id: z.string().min(1).max(40),
  question: boundedText(500),
  why: boundedText(500),
  blocking: z.boolean(),
  answer: z.string().max(2000).nullable(),
  status: z.enum(['open', 'answered']),
});

export const RequirementGapSchema = z.object({
  area: boundedText(120),
  detail: boundedText(500),
  blocking: z.boolean(),
});

export const RequirementRiskSchema = z.object({
  risk: boundedText(500),
  mitigation: z.string().max(500).nullable(),
  severity: z.enum(RISK_SEVERITIES),
});

export const RequirementPlanSchema = z.object({
  requirementId: z.string().min(1).max(64),
  companyId: z.string().min(1).max(64),
  version: z.number().int().min(1),
  status: z.enum(REQUIREMENT_STATUSES),
  source: z.object({
    kind: z.enum(['goal', 'sandbox']),
    sessionId: z.string().max(120).nullable(),
    /** The user's exact input, trimmed — never a model rewrite. */
    goal: boundedText(8000),
  }),
  title: boundedText(200),
  background: z.string().max(4000).nullable(),
  audience: textList(20, 200),
  constraints: textList(30),
  scope: z.object({
    inScope: textList(30),
    outOfScope: textList(30),
  }),
  deliverables: textList(20),
  acceptanceCriteria: textList(30),
  risks: z.array(RequirementRiskSchema).max(20),
  requiredCapabilities: z.array(z.string().min(1).max(64)).max(12),
  clarifications: z.array(RequirementClarificationSchema).max(20),
  gaps: z.array(RequirementGapSchema).max(20),
  provenance: z.object({
    mode: z.enum(PLAN_MODES),
    provider: z.string().max(120).nullable(),
    model: z.string().max(120).nullable(),
    /** Fields the user actually stated. Only `source.goal` is guaranteed here. */
    stated: z.array(z.string().max(120)),
    /** Fields the model/derivation produced and a human must confirm before orchestration. */
    inferred: z.array(z.string().max(120)),
  }),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  confirmedAt: z.string().nullable(),
  confirmedBy: z.string().nullable(),
});

export type RequirementPlan = z.infer<typeof RequirementPlanSchema>;

/** What the model (or the deterministic fallback) may produce; ids/status are server-owned. */
export const RequirementAnalysisSchema = z.object({
  title: boundedText(200),
  background: z.string().max(4000).nullable(),
  audience: textList(20, 200),
  constraints: textList(30),
  inScope: textList(30),
  outOfScope: textList(30),
  deliverables: textList(20),
  acceptanceCriteria: textList(30),
  risks: z
    .array(
      z.object({
        risk: boundedText(500),
        mitigation: z.string().max(500).nullable().optional(),
        severity: z.enum(RISK_SEVERITIES),
      }),
    )
    .max(20),
  requiredCapabilities: z.array(z.string().min(1).max(64)).max(12),
  clarifications: z
    .array(
      z.object({
        question: boundedText(500),
        why: boundedText(500),
        blocking: z.boolean(),
      }),
    )
    .max(20),
  gaps: z
    .array(
      z.object({
        area: boundedText(120),
        detail: boundedText(500),
        blocking: z.boolean(),
      }),
    )
    .max(20),
});

export type RequirementAnalysis = z.infer<typeof RequirementAnalysisSchema>;

export const ORCHESTRATION_STATUSES = ['ready', 'blocked'] as const;
export type OrchestrationStatus = (typeof ORCHESTRATION_STATUSES)[number];

export const OrchestrationNodeSchema = z.object({
  nodeId: z.string().min(1).max(40),
  kind: z.enum(['task', 'approval']),
  title: boundedText(200),
  capability: z.string().max(64).nullable(),
  employeeId: z.string().max(64).nullable(),
  positionId: z.string().max(64).nullable(),
  inputs: textList(20),
  outputs: textList(10),
  acceptance: textList(20),
  dependsOn: z.array(z.string().min(1).max(40)).max(20),
  order: z.number().int().min(0),
  status: z.enum(['planned', 'unassigned', 'human-gate']),
});

export type OrchestrationNode = z.infer<typeof OrchestrationNodeSchema>;

export const OrchestrationConflictSchema = z.object({
  code: z.enum([
    'missing_capability',
    'unassigned_task',
    'resource_contention',
    'missing_deliverable',
    'missing_acceptance',
    'dependency_cycle',
    'workflow_draft_failed',
    'assignment_override_failed',
  ]),
  severity: z.enum(['warning', 'blocking']),
  detail: boundedText(500),
  nodeIds: z.array(z.string().min(1).max(40)).max(20),
});

export type OrchestrationConflict = z.infer<typeof OrchestrationConflictSchema>;

export const OrchestrationDraftSchema = z.object({
  orchestrationId: z.string().min(1).max(64),
  companyId: z.string().min(1).max(64),
  version: z.number().int().min(1),
  status: z.enum(ORCHESTRATION_STATUSES),
  requirementId: z.string().min(1).max(64),
  requirementVersion: z.number().int().min(1),
  title: boundedText(200),
  goal: boundedText(8000),
  nodes: z.array(OrchestrationNodeSchema).min(1).max(30),
  /** Execution order of node ids; must be a topological order of `dependsOn`. */
  order: z.array(z.string().min(1).max(40)).max(30),
  conflicts: z.array(OrchestrationConflictSchema).max(40),
  missingCapabilities: z.array(z.string().min(1).max(64)).max(20),
  unassignedNodeIds: z.array(z.string().min(1).max(40)).max(30),
  /** Why this plan exists: requirement version, capabilities, employees, rules. */
  basis: z.object({
    requirementId: z.string().min(1).max(64),
    requirementVersion: z.number().int().min(1),
    capabilities: z.array(z.string().min(1).max(64)).max(20),
    employees: z.array(z.string().min(1).max(64)).max(30),
    rule: z.string().min(1).max(200),
  }),
  /** The canvas instance, only when the plan is ready and the engine accepted the draft. */
  workflowInstanceId: z.string().max(64).nullable(),
  workflowId: z.string().max(64).nullable(),
  workflowVersion: z.number().int().min(1).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type OrchestrationDraft = z.infer<typeof OrchestrationDraftSchema>;

export interface RequirementVersionSummary {
  readonly version: number;
  readonly status: RequirementStatus;
  readonly updatedAt: string;
  readonly confirmedAt: string | null;
}

export interface RequirementRecord {
  readonly requirementId: string;
  readonly companyId: string;
  readonly currentVersion: number;
  readonly versions: readonly RequirementPlan[];
}

export interface RequirementSummary {
  readonly requirementId: string;
  readonly title: string;
  readonly status: RequirementStatus;
  readonly version: number;
  readonly sourceKind: 'goal' | 'sandbox';
  readonly updatedAt: string;
  readonly deliverableCount: number;
  readonly capabilityCount: number;
}

// -------------------------------------------------------------------------------------------------
// M3.4 · the human-edited execution plan
// -------------------------------------------------------------------------------------------------

export const PLAN_STATUSES = ['draft', 'confirmed'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PlanNodeSchema = z.object({
  nodeId: z.string().min(1).max(40),
  kind: z.enum(['task', 'approval']),
  title: boundedText(200),
  goal: boundedText(2000),
  capability: z.string().max(64).nullable(),
  employeeId: z.string().max(64).nullable(),
  positionId: z.string().max(64).nullable(),
  inputs: textList(20),
  outputs: textList(10),
  acceptance: textList(20),
  dependsOn: z.array(z.string().min(1).max(40)).max(20),
});

export type PlanNode = z.infer<typeof PlanNodeSchema>;

export const PLAN_ISSUE_CODES = [
  'missing_title',
  'missing_goal',
  'missing_input',
  'missing_output',
  'missing_acceptance',
  'missing_employee',
  'employee_not_capable',
  'unknown_dependency',
  'self_dependency',
  'dependency_cycle',
  'missing_workflow_draft',
  'employee_conflict',
  'assignment_override_failed',
] as const;

export type PlanIssueCode = (typeof PLAN_ISSUE_CODES)[number];

export const PlanIssueSchema = z.object({
  code: z.enum(PLAN_ISSUE_CODES),
  severity: z.enum(['blocking', 'warning']),
  detail: boundedText(500),
  nodeIds: z.array(z.string().min(1).max(40)).max(20),
});

export type PlanIssue = z.infer<typeof PlanIssueSchema>;

export const PlanValidationSchema = z.object({
  ok: z.boolean(),
  blockingCount: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  issues: z.array(PlanIssueSchema).max(80),
  cycleNodeIds: z.array(z.string().min(1).max(40)).max(30),
  missingCapabilities: z.array(z.string().min(1).max(64)).max(20),
  unassignedNodeIds: z.array(z.string().min(1).max(40)).max(30),
});

export type PlanValidation = z.infer<typeof PlanValidationSchema>;

export const PlanSummarySchema = z.object({
  nodeCount: z.number().int().min(0),
  taskCount: z.number().int().min(0),
  employeeCount: z.number().int().min(0),
  capabilities: z.array(z.string().min(1).max(64)).max(20),
  deliverables: z.array(z.string().min(1).max(500)).max(30),
  workflowInstanceId: z.string().max(64).nullable(),
});

export type PlanSummary = z.infer<typeof PlanSummarySchema>;

export const PlanChangeSchema = z.object({
  fromVersion: z.number().int().min(1),
  renamed: z.number().int().min(0),
  reassigned: z.number().int().min(0),
  dependenciesChanged: z.number().int().min(0),
  contentChanged: z.number().int().min(0),
});

export type PlanChange = z.infer<typeof PlanChangeSchema>;

export const ExecutionPlanSchema = z.object({
  planId: z.string().min(1).max(64),
  companyId: z.string().min(1).max(64),
  version: z.number().int().min(1),
  status: z.enum(PLAN_STATUSES),
  orchestrationId: z.string().min(1).max(64),
  orchestrationVersion: z.number().int().min(1),
  requirementId: z.string().min(1).max(64),
  requirementVersion: z.number().int().min(1),
  title: boundedText(200),
  goal: boundedText(8000),
  nodes: z.array(PlanNodeSchema).min(1).max(30),
  /** Topological order recomputed from the DAG; never hand-edited. */
  order: z.array(z.string().min(1).max(40)).min(1).max(30),
  validation: PlanValidationSchema,
  summary: PlanSummarySchema,
  change: PlanChangeSchema.nullable(),
  workflowInstanceId: z.string().max(64).nullable(),
  workflowId: z.string().max(64).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  confirmedAt: z.string().nullable(),
  confirmedBy: z.string().nullable(),
  confirmationNote: z.string().max(2000).nullable(),
});

export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

export interface PlanRecord {
  readonly planId: string;
  readonly companyId: string;
  readonly currentVersion: number;
  readonly versions: readonly ExecutionPlan[];
}

export interface PlanSummaryView {
  readonly planId: string;
  readonly title: string;
  readonly status: PlanStatus;
  readonly version: number;
  readonly orchestrationId: string;
  readonly workflowInstanceId: string | null;
  readonly updatedAt: string;
  readonly confirmedAt: string | null;
  readonly blockingCount: number;
}

// -------------------------------------------------------------------------------------------------
// M3.5 · execution of a confirmed plan
// -------------------------------------------------------------------------------------------------

export const ExecutionRecordSchema = z.object({
  executionId: z.string().min(1).max(64),
  companyId: z.string().min(1).max(64),
  planId: z.string().min(1).max(64),
  planVersion: z.number().int().min(1),
  workflowInstanceId: z.string().min(1).max(64),
  workflowId: z.string().min(1).max(64),
  sourceWorkflowInstanceId: z.string().max(64).nullable(),
  startedAt: z.string().min(1),
  startedBy: z.string().min(1),
});

export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

export type ExecutionStatus =
  | 'not_started'
  | 'running'
  | 'awaiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ExecutionTaskView {
  readonly taskId: string;
  readonly planNodeId: string | null;
  readonly title: string;
  readonly status: string;
  readonly assigneeEmployeeId: string | null;
  readonly assigneeName: string | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly createdAtSim: number;
  readonly completedAtSim: number | null;
  readonly blockedReason: string | null;
  readonly rejectReason: string | null;
  readonly result: {
    readonly summary: string;
    readonly artifacts: readonly string[];
    readonly data: Readonly<Record<string, unknown>>;
  } | null;
}

export interface ExecutionView {
  readonly executionId: string;
  readonly companyId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly planTitle: string;
  readonly orchestrationId: string;
  readonly requirementId: string;
  readonly requirementVersion: number;
  readonly workflowInstanceId: string;
  readonly workflowId: string;
  readonly status: ExecutionStatus;
  readonly startedAt: string;
  readonly startedBy: string;
  readonly planConfirmedAt: string | null;
  readonly planConfirmedBy: string | null;
  readonly tasks: readonly ExecutionTaskView[];
  readonly summary: {
    readonly taskCount: number;
    readonly completedCount: number;
    readonly failedCount: number;
    readonly activeCount: number;
    readonly allTasksCompleted: boolean;
    readonly artifacts: readonly string[];
  };
  readonly approval: {
    readonly stepId: string;
    readonly status: string;
    readonly requiredCount: number;
    readonly grantedBy: readonly string[];
    readonly decidedBy: string | null;
    readonly requestedAtSim: number | null;
  } | null;
}

// -------------------------------------------------------------------------------------------------
// M3.6 · human approval of a real execution
// -------------------------------------------------------------------------------------------------

export const APPROVAL_ACTIONS = ['approve', 'reject', 'request_changes'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const ExecutionApprovalRecordSchema = z.object({
  approvalId: z.string().min(1).max(64),
  companyId: z.string().min(1).max(64),
  executionId: z.string().min(1).max(64),
  planId: z.string().min(1).max(64),
  planVersion: z.number().int().min(1),
  workflowInstanceId: z.string().min(1).max(64),
  approvalKey: z.string().min(1).max(120),
  approvalStepId: z.string().min(1).max(64),
  action: z.enum(APPROVAL_ACTIONS),
  reason: z.string().max(4000).nullable(),
  decidedBy: z.string().min(1).max(64),
  decidedAt: z.string().min(1),
  taskIds: z.array(z.string().min(1).max(64)).max(40),
  artifacts: z.array(z.string().min(1).max(200)).max(100),
  before: z.object({
    executionStatus: z.string().min(1),
    approvalStatus: z.string().min(1),
    workflowStatus: z.string().min(1),
  }),
  after: z.object({
    executionStatus: z.string().min(1),
    approvalStatus: z.string().min(1),
    workflowStatus: z.string().min(1),
  }),
});

export type ExecutionApprovalRecord = z.infer<typeof ExecutionApprovalRecordSchema>;

export interface ExecutionReviewView {
  readonly execution: ExecutionView;
  readonly plan: ExecutionPlan | null;
  readonly history: readonly ExecutionApprovalRecord[];
}

export interface ExecutionApprovalSummary {
  readonly executionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly planTitle: string;
  readonly status: ExecutionStatus;
  readonly taskCount: number;
  readonly completedCount: number;
  readonly artifacts: readonly string[];
  readonly startedAt: string;
  readonly startedBy: string;
  readonly approvalRequestedAtSim: number | null;
  readonly approvalStatus: string | null;
}

// -------------------------------------------------------------------------------------------------
// M3.7 · promotion plans derived from an approved execution
// -------------------------------------------------------------------------------------------------

export const PROMOTION_STATUSES = ['draft', 'confirmed'] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

export const PromotionChannelSchema = z.object({
  channelId: z.string().min(1).max(40),
  name: boundedText(120),
  reason: boundedText(1000),
  contentType: boundedText(120),
});
export type PromotionChannel = z.infer<typeof PromotionChannelSchema>;

export const PromotionMaterialSchema = z.object({
  materialId: z.string().min(1).max(40),
  type: boundedText(80),
  platform: boundedText(40),
  title: boundedText(200),
  body: z.string().max(20000),
  source: z.enum(['ai', 'human']),
  sourceArtifact: z.string().max(200).nullable(),
});
export type PromotionMaterial = z.infer<typeof PromotionMaterialSchema>;

export const PromotionContributorSchema = z.object({
  employeeId: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  role: boundedText(80),
  capability: z.string().min(1).max(64),
  /** `capability` = matched by the live organization; no fake execution is implied. */
  basis: z.literal('capability'),
});
export type PromotionContributor = z.infer<typeof PromotionContributorSchema>;

export const PromotionPlanSchema = z.object({
  promotionId: z.string().min(1).max(64),
  companyId: z.string().min(1).max(64),
  version: z.number().int().min(1),
  status: z.enum(PROMOTION_STATUSES),
  executionId: z.string().min(1).max(64),
  planId: z.string().min(1).max(64),
  planVersion: z.number().int().min(1),
  approvalId: z.string().min(1).max(64),
  approvedAt: z.string().min(1),
  approvedBy: z.string().min(1),
  sourceTitle: boundedText(200),
  title: boundedText(200),
  goal: boundedText(2000),
  valueProposition: boundedText(2000),  audience: textList(20),
  audienceNeeds: textList(20),
  coreMessages: textList(20),
  channels: z.array(PromotionChannelSchema).min(1).max(20),
  materials: z.array(PromotionMaterialSchema).min(1).max(40),
  schedule: textList(20),
  metrics: textList(20),
  risks: textList(30),
  contributors: z.array(PromotionContributorSchema).max(10),
  provenance: z.object({
    mode: z.string().min(1),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    approvedArtifacts: textList(40),
    aiFields: textList(40),
    humanEdits: textList(40),
  }),
  summary: z.object({
    materialCount: z.number().int().min(0),
    channelCount: z.number().int().min(0),
    artifactCount: z.number().int().min(0),
  }),
  summaryText: boundedText(4000),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  confirmedAt: z.string().nullable(),
  confirmedBy: z.string().nullable(),
  confirmationNote: z.string().max(2000).nullable(),
});
export type PromotionPlan = z.infer<typeof PromotionPlanSchema>;

export interface PromotionRecord {
  readonly promotionId: string;
  readonly companyId: string;
  readonly currentVersion: number;
  readonly versions: readonly PromotionPlan[];
}

export interface PromotionSummary {
  readonly promotionId: string;
  readonly executionId: string;
  readonly title: string;
  readonly status: PromotionStatus;
  readonly version: number;
  readonly materialCount: number;
  readonly channelCount: number;
  readonly updatedAt: string;
  readonly confirmedAt: string | null;
}

// -------------------------------------------------------------------------------------------------
// M3.8 · publication of a confirmed promotion (local, real artifact + real URL only)
// -------------------------------------------------------------------------------------------------

export const PUBLICATION_STATUSES = [
  'draft',
  'ready',
  'publishing',
  'published',
  'partial',
  'failed',
  'cancelled',
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/** `local_*` channels are actually served by this installation; external has no connector. */
export const PUBLICATION_CHANNEL_IDS = ['local_page', 'local_manifest', 'external_wechat'] as const;
export type PublicationChannelId = (typeof PUBLICATION_CHANNEL_IDS)[number];

export const PublicationContentSchema = z.object({
  title: boundedText(200),
  body: z.string().max(40000),
  channels: z.array(z.enum(PUBLICATION_CHANNEL_IDS)).min(1).max(8),
  attachments: textList(40),
});
export type PublicationContent = z.infer<typeof PublicationContentSchema>;

export const PublicationCheckSchema = z.object({
  checkId: z.string().min(1).max(80),
  label: boundedText(200),
  ok: z.boolean(),
  detail: boundedText(1000),
});
export type PublicationCheck = z.infer<typeof PublicationCheckSchema>;

export const PublicationChannelResultSchema = z.object({
  channel: z.enum(PUBLICATION_CHANNEL_IDS),
  status: z.enum(['published', 'failed', 'unavailable']),
  resourceId: z.string().max(300).nullable(),
  url: z.string().max(1000).nullable(),
  error: z.string().max(2000).nullable(),
  verifiedAt: z.string().min(1),
});
export type PublicationChannelResult = z.infer<typeof PublicationChannelResultSchema>;

export const PublicationAttemptSchema = z.object({
  attempt: z.number().int().min(1),
  requestedAt: z.string().min(1),
  requestedBy: z.string().min(1),
  results: z.array(PublicationChannelResultSchema).max(8),
});
export type PublicationAttempt = z.infer<typeof PublicationAttemptSchema>;

export const PublicationVersionSchema = z.object({
  version: z.number().int().min(1),
  status: z.enum(PUBLICATION_STATUSES),
  content: PublicationContentSchema,
  checks: z.array(PublicationCheckSchema).max(40),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  confirmedAt: z.string().nullable(),
  confirmedBy: z.string().nullable(),
  attempts: z.array(PublicationAttemptSchema).max(40),
  publishedAt: z.string().nullable(),
  publishedBy: z.string().nullable(),
  publicPath: z.string().max(500).nullable(),
});
export type PublicationVersion = z.infer<typeof PublicationVersionSchema>;

export const PublicationRecordSchema = z.object({
  publicationId: z.string().min(1).max(64),
  companyId: z.string().min(1).max(64),
  promotionId: z.string().min(1).max(64),
  promotionVersion: z.number().int().min(1),
  executionId: z.string().min(1).max(64),
  planId: z.string().min(1).max(64),
  planVersion: z.number().int().min(1),
  approvalId: z.string().min(1).max(64),
  requirementId: z.string().min(1).max(64),
  requirementVersion: z.number().int().min(1),
  approvedBy: z.string().min(1),
  approvedAt: z.string().min(1),
  promotionConfirmedBy: z.string().min(1),
  promotionConfirmedAt: z.string().min(1),
  sourceArtifacts: textList(40),
  taskIds: textList(80),
  currentVersion: z.number().int().min(1),
  versions: z.array(PublicationVersionSchema).min(1),
});
export type PublicationRecord = z.infer<typeof PublicationRecordSchema>;

export interface PublicationSummary {
  readonly publicationId: string;
  readonly promotionId: string;
  readonly promotionVersion: number;
  readonly title: string;
  readonly status: PublicationStatus;
  readonly version: number;
  readonly publishedAt: string | null;
  readonly publicPath: string | null;
  readonly updatedAt: string;
}

