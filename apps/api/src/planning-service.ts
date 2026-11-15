import { z } from 'zod';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Organization } from '@maoeh/organization-model';
import { capabilityLabel, isExecutableEmployment } from '@maoeh/organization-model';
import type { Simulation } from '@maoeh/kernel';
import { systemActor, employeeActor } from '@maoeh/permission-system';
import {
  executionPlanContext,
  generateExecutionPlanWorkflowDefinition,
  validateWorkflowDefinition,
  type ExecutionPlanSnapshot,
} from '@maoeh/workflow-engine';
import {
  RequirementAnalysisError,
  analysisFromSandbox,
  analyzeRequirementGoal,
  type RequirementAnalyzerDeps,
} from './requirement-analyzer.js';
import { buildOrchestrationDraft } from './orchestrator.js';
import { topologicalOrderOf, validatePlan } from './plan-validator.js';
import {
  generatePromotionStrategy,
  PromotionStrategyError,
  type PromotionStrategyInput,
} from './promotion-strategist.js';
import {
  ensurePublicationEvents,
  publicationEvent,
  PUBLICATION_CONFIRMED,
  PUBLICATION_DRAFTED,
  PUBLICATION_FAILED,
  PUBLICATION_PARTIALLY_PUBLISHED,
  PUBLICATION_PUBLISHED,
  type PublicationEventPayload,
} from './publication-events.js';
import type { PlanningStore } from './planning-store.js';
import {
  ExecutionApprovalRecordSchema,
  ExecutionPlanSchema,
  ExecutionRecordSchema,
  PlanNodeSchema,
  PromotionChannelSchema,
  PromotionMaterialSchema,
  PromotionPlanSchema,
  PublicationRecordSchema,
  RequirementPlanSchema,
  RequirementRiskSchema,
  type ApprovalAction,
  type ExecutionApprovalRecord,
  type ExecutionApprovalSummary,
  type ExecutionPlan,
  type ExecutionRecord,
  type ExecutionReviewView,
  type ExecutionStatus,
  type ExecutionTaskView,
  type ExecutionView,
  type OrchestrationConflict,
  type OrchestrationDraft,
  type PlanChange,
  type PlanNode,
  type PlanRecord,
  type PlanSummaryView,
  type PlanValidation,
  type PromotionMaterial,
  type PromotionPlan,
  type PromotionRecord,
  type PromotionSummary,
  type PublicationChannelResult,
  type PublicationCheck,
  type PublicationContent,
  type PublicationRecord,
  type PublicationStatus,
  type PublicationSummary,
  type PublicationVersion,
  type RequirementPlan,
  type RequirementRecord,
  type RequirementSummary,
} from './planning-types.js';
import type { SandboxSession } from './sandbox-session.js';

/**
 * M3.3 · 需求沙盘 → 智能体编排 的服务层。
 *
 * The state machine of this feature is deliberately explicit:
 *
 *   goal / sandbox session
 *     → requirement plan vN (draft | needs_clarification)
 *     → human answers + confirms  (a *new* version; the confirmed one is immutable)
 *     → orchestration draft (only from a confirmed version)
 *     → a workflow **draft** instance on the canvas (awaitConfirmation: true)
 *
 * The last step creates real events (`Workflow.InstanceStarted`, optional assignment overrides)
 * but **no tasks**: the engine's draft path does not enter the entry stage. Starting the work is
 * M3.4's confirmation, never this service's side effect.
 */

export const RequirementPatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  background: z.string().max(4000).nullable().optional(),
  audience: z.array(z.string().max(200)).max(20).optional(),
  constraints: z.array(z.string().max(500)).max(30).optional(),
  inScope: z.array(z.string().max(500)).max(30).optional(),
  outOfScope: z.array(z.string().max(500)).max(30).optional(),
  deliverables: z.array(z.string().max(500)).max(20).optional(),
  acceptanceCriteria: z.array(z.string().max(500)).max(30).optional(),
  requiredCapabilities: z.array(z.string().min(1).max(64)).max(12).optional(),
  risks: z.array(RequirementRiskSchema).max(20).optional(),
  /** Answers to clarification questions, keyed by clarification id. */
  answers: z.record(z.string(), z.string().max(2000)).optional(),
});

export type RequirementPatch = z.infer<typeof RequirementPatchSchema>;

export const AnalyzeRequirementInputSchema = z.object({
  goal: z.string().max(8000).optional(),
  sourceSessionId: z.string().min(1).max(120).optional(),
});

export const ConfirmRequirementInputSchema = z.object({
  version: z.number().int().min(1).optional(),
  answers: z.record(z.string(), z.string().max(2000)).optional(),
  acknowledgeInferred: z.boolean().optional(),
});

export const OrchestrateInputSchema = z.object({
  requirementId: z.string().min(1).max(64),
  version: z.number().int().min(1).optional(),
});

export const CreatePlanInputSchema = z.object({
  orchestrationId: z.string().min(1).max(64),
});

export const PlanNodePatchSchema = z.object({
  nodeId: z.string().min(1).max(40),
  title: z.string().max(200).optional(),
  goal: z.string().max(2000).optional(),
  inputs: z.array(z.string().max(500)).max(20).optional(),
  outputs: z.array(z.string().max(500)).max(10).optional(),
  acceptance: z.array(z.string().max(500)).max(20).optional(),
  employeeId: z.string().max(64).nullable().optional(),
  dependsOn: z.array(z.string().min(1).max(40)).max(20).optional(),
});

export const UpdatePlanInputSchema = z.object({
  baseVersion: z.number().int().min(1),
  nodes: z.array(PlanNodePatchSchema).min(1).max(30),
});

export const ConfirmPlanInputSchema = z.object({
  baseVersion: z.number().int().min(1),
  note: z.string().max(2000).optional(),
});

export const StartExecutionInputSchema = z.object({
  baseVersion: z.number().int().min(1),
});

export const DecideExecutionInputSchema = z.object({
  action: z.enum(['approve', 'reject', 'request_changes']),
  reason: z.string().max(4000).optional(),
  approvalKey: z.string().max(120).optional(),
});

export const CreatePromotionInputSchema = z.object({
  executionId: z.string().min(1).max(64),
});

export const PromotionPatchSchema = z.object({
  title: z.string().max(200).optional(),
  goal: z.string().max(2000).optional(),
  valueProposition: z.string().max(2000).optional(),
  audience: z.array(z.string().max(500)).max(20).optional(),
  audienceNeeds: z.array(z.string().max(500)).max(20).optional(),
  coreMessages: z.array(z.string().max(500)).max(20).optional(),
  channels: z.array(PromotionChannelSchema).min(1).max(20).optional(),
  materials: z.array(PromotionMaterialSchema).min(1).max(40).optional(),
  schedule: z.array(z.string().max(500)).max(20).optional(),
  metrics: z.array(z.string().max(500)).max(20).optional(),
  risks: z.array(z.string().max(500)).max(30).optional(),
});

export const UpdatePromotionInputSchema = z.object({
  baseVersion: z.number().int().min(1),
  patch: PromotionPatchSchema,
});

export const ConfirmPromotionInputSchema = z.object({
  baseVersion: z.number().int().min(1),
  note: z.string().max(2000).optional(),
});

export const CreatePublicationInputSchema = z.object({
  promotionId: z.string().min(1).max(64),
});

export const PublicationPatchSchema = z.object({
  title: z.string().max(200).optional(),
  body: z.string().max(40000).optional(),
  channels: z.array(z.enum(['local_page', 'local_manifest', 'external_wechat'])).min(1).max(8).optional(),
  attachments: z.array(z.string().max(200)).max(40).optional(),
});

export const UpdatePublicationInputSchema = z.object({
  baseVersion: z.number().int().min(1),
  patch: PublicationPatchSchema,
});

export const ConfirmPublicationInputSchema = z.object({
  baseVersion: z.number().int().min(1),
  confirm: z.boolean(),
});

export const PublishPublicationInputSchema = z.object({
  baseVersion: z.number().int().min(1),
  confirm: z.boolean(),
});

export type PlanningErrorCode =
  | 'not_found'
  | 'version_conflict'
  | 'not_confirmed'
  | 'needs_clarification'
  | 'inferred_not_acknowledged'
  | 'invalid_input'
  | 'provider_failed'
  | 'sandbox_not_ready'
  | 'workflow_refused'
  | 'plan_invalid'
  | 'approval_not_open'
  | 'approval_already_decided'
  | 'approval_stale'
  | 'execution_incomplete'
  | 'approval_refused'
  | 'promotion_invalid'
  | 'promotion_generation_failed'
  | 'publication_invalid'
  | 'publication_not_ready'
  | 'publication_busy'
  | 'publication_unavailable';

export class PlanningError extends Error {
  constructor(
    readonly code: PlanningErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'PlanningError';
  }
}

export interface PlanningRuntime {
  readonly companyId: string;
  readonly organization: Organization;
  readonly simulation: Simulation;
  readonly simTime: number;
}

export interface PlanningServiceDeps {
  readonly store: PlanningStore;
  /** Follows the active runtime, exactly like every other read/write in the API. */
  readonly runtime: () => PlanningRuntime;
  readonly analyzer: RequirementAnalyzerDeps;
  /** The existing 赛博沙盘 service, used as a real source when `sourceSessionId` is given. */
  readonly sandbox?: (sessionId: string) => Promise<SandboxSession | null>;
  /** The human operator whose confirmation is recorded (the console's fixed CEO seat). */
  readonly operatorId: () => string;
  readonly now?: () => string;
  /** Absolute root for local publication artifacts; passed by the API composition. */
  readonly publicationDir?: string;
}

export interface PlanningService {
  analyze(input: unknown): Promise<RequirementPlan>;
  listRequirements(): Promise<readonly RequirementSummary[]>;
  getRequirement(requirementId: string): Promise<RequirementRecord | null>;
  updateRequirement(requirementId: string, input: unknown): Promise<RequirementPlan>;
  confirmRequirement(requirementId: string, input: unknown): Promise<RequirementPlan>;
  orchestrate(input: unknown): Promise<OrchestrationDraft>;
  listOrchestrations(): Promise<readonly OrchestrationDraft[]>;
  getOrchestration(orchestrationId: string): Promise<OrchestrationDraft | null>;
  createPlan(input: unknown): Promise<ExecutionPlan>;
  listPlans(): Promise<readonly PlanSummaryView[]>;
  getPlan(planId: string): Promise<PlanRecord | null>;
  updatePlan(planId: string, input: unknown): Promise<ExecutionPlan>;
  confirmPlan(planId: string, input: unknown): Promise<ExecutionPlan>;
  getConfirmedPlan(planId: string): Promise<ExecutionPlan | null>;
  startExecution(planId: string, input: unknown): Promise<ExecutionView>;
  listExecutions(): Promise<readonly ExecutionView[]>;
  getExecution(executionId: string): Promise<ExecutionView | null>;
  listExecutionApprovals(): Promise<{
    readonly pending: readonly ExecutionApprovalSummary[];
    readonly history: readonly ExecutionApprovalRecord[];
    readonly approved: readonly ExecutionApprovalRecord[];
  }>;
  getExecutionReview(executionId: string): Promise<ExecutionReviewView | null>;
  decideExecution(
    executionId: string,
    input: unknown,
  ): Promise<{
    readonly decision: ExecutionApprovalRecord;
    readonly execution: ExecutionView;
    readonly idempotent: boolean;
  }>;
  createPromotion(input: unknown): Promise<PromotionPlan>;
  listPromotions(): Promise<readonly PromotionSummary[]>;
  getPromotion(promotionId: string): Promise<PromotionRecord | null>;
  updatePromotion(promotionId: string, input: unknown): Promise<PromotionPlan>;
  confirmPromotion(promotionId: string, input: unknown): Promise<PromotionPlan>;
  getConfirmedPromotion(promotionId: string): Promise<PromotionPlan | null>;
  createPublication(input: unknown): Promise<PublicationRecord>;
  listPublications(): Promise<readonly PublicationSummary[]>;
  getPublication(publicationId: string): Promise<PublicationRecord | null>;
  getPublicationPreflight(publicationId: string): Promise<readonly PublicationCheck[]>;
  updatePublication(publicationId: string, input: unknown): Promise<PublicationRecord>;
  confirmPublication(publicationId: string, input: unknown): Promise<PublicationRecord>;
  publishPublication(
    publicationId: string,
    input: unknown,
  ): Promise<{ record: PublicationRecord; idempotent: boolean }>;
  getPublicationPage(publicationId: string): Promise<{ html: string; version: number } | null>;
}

function cleanList(values: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const value of values) {
    const text = value.replace(/\s+/g, ' ').trim();
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    list.push(text.slice(0, 500));
    if (list.length >= max) break;
  }
  return list;
}

function statusOf(plan: RequirementPlan): RequirementPlan['status'] {
  const openBlocking = plan.clarifications.some(
    (clarification) =>
      clarification.blocking &&
      clarification.status === 'open' &&
      (clarification.answer ?? '').trim() === '',
  );
  const incomplete =
    plan.deliverables.length === 0 ||
    plan.acceptanceCriteria.length === 0 ||
    plan.requiredCapabilities.length === 0;
  return openBlocking || incomplete ? 'needs_clarification' : 'draft';
}

function inferredFields(): string[] {
  // The field *set* is inferred even when a field is empty: the UI must be able to say
  // "this section is AI-proposed, confirm it" regardless of whether the model filled it.
  return [
    'title',
    'background',
    'audience',
    'constraints',
    'scope',
    'deliverables',
    'acceptanceCriteria',
    'risks',
    'requiredCapabilities',
    'clarifications',
  ];
}

function buildPlan(input: {
  readonly requirementId: string;
  readonly companyId: string;
  readonly version: number;
  readonly sourceKind: 'goal' | 'sandbox';
  readonly sourceGoal: string;
  readonly sessionId: string | null;
  readonly analysis: Awaited<ReturnType<typeof analyzeRequirementGoal>>['analysis'];
  readonly mode: 'live' | 'sandbox' | 'deterministic';
  readonly provider: string | null;
  readonly model: string | null;
  readonly now: string;
}): RequirementPlan {
  const clarifications = input.analysis.clarifications.map((clarification, index) => ({
    id: `q${String(index + 1)}`,
    question: clarification.question,
    why: clarification.why,
    blocking: clarification.blocking,
    answer: null,
    status: 'open' as const,
  }));
  const plan: RequirementPlan = {
    requirementId: input.requirementId,
    companyId: input.companyId,
    version: input.version,
    status: 'draft',
    source: {
      kind: input.sourceKind,
      sessionId: input.sessionId,
      goal: input.sourceGoal.trim(),
    },
    title: input.analysis.title.trim().slice(0, 200),
    background: input.analysis.background?.trim() || null,
    audience: cleanList(input.analysis.audience, 20),
    constraints: cleanList(input.analysis.constraints, 30),
    scope: {
      inScope: cleanList(input.analysis.inScope, 30),
      outOfScope: cleanList(input.analysis.outOfScope, 30),
    },
    deliverables: cleanList(input.analysis.deliverables, 20),
    acceptanceCriteria: cleanList(input.analysis.acceptanceCriteria, 30),
    risks: input.analysis.risks.slice(0, 20).map((risk) => ({
      risk: risk.risk,
      mitigation: risk.mitigation ?? null,
      severity: risk.severity,
    })),
    requiredCapabilities: cleanList(
      input.analysis.requiredCapabilities.map((capability) => capability.toLowerCase()),
      12,
    ),
    clarifications,
    gaps: input.analysis.gaps.slice(0, 20).map((gap) => ({ ...gap })),
    provenance: {
      mode: input.mode,
      provider: input.provider,
      model: input.model,
      stated: ['source.goal'],
      inferred: [],
    },
    createdAt: input.now,
    updatedAt: input.now,
    confirmedAt: null,
    confirmedBy: null,
  };
  const withStatus: RequirementPlan = {
    ...plan,
    status: statusOf(plan),
    provenance: { ...plan.provenance, inferred: [...inferredFields()] },
  };
  return RequirementPlanSchema.parse(withStatus);
}

function applyAnswers(
  plan: RequirementPlan,
  answers: Readonly<Record<string, string>> | undefined,
  now: string,
): RequirementPlan {
  if (answers === undefined) return plan;
  const clarifications = plan.clarifications.map((clarification) => {
    const answer = answers[clarification.id];
    if (answer === undefined) return clarification;
    const trimmed = answer.trim();
    return {
      ...clarification,
      answer: trimmed === '' ? null : trimmed.slice(0, 2000),
      status: trimmed === '' ? ('open' as const) : ('answered' as const),
    };
  });
  const next: RequirementPlan = { ...plan, clarifications, updatedAt: now };
  return RequirementPlanSchema.parse({ ...next, status: statusOf(next) });
}

function applyPatch(plan: RequirementPlan, patch: RequirementPatch, now: string): RequirementPlan {
  const next: RequirementPlan = {
    ...plan,
    title: patch.title?.trim().slice(0, 200) ?? plan.title,
    background:
      patch.background === undefined ? plan.background : (patch.background?.trim() || null),
    audience: patch.audience === undefined ? plan.audience : cleanList(patch.audience, 20),
    constraints:
      patch.constraints === undefined ? plan.constraints : cleanList(patch.constraints, 30),
    scope: {
      inScope:
        patch.inScope === undefined ? plan.scope.inScope : cleanList(patch.inScope, 30),
      outOfScope:
        patch.outOfScope === undefined
          ? plan.scope.outOfScope
          : cleanList(patch.outOfScope, 30),
    },
    deliverables:
      patch.deliverables === undefined ? plan.deliverables : cleanList(patch.deliverables, 20),
    acceptanceCriteria:
      patch.acceptanceCriteria === undefined
        ? plan.acceptanceCriteria
        : cleanList(patch.acceptanceCriteria, 30),
    requiredCapabilities:
      patch.requiredCapabilities === undefined
        ? plan.requiredCapabilities
        : cleanList(patch.requiredCapabilities.map((entry) => entry.toLowerCase()), 12),
    risks:
      patch.risks === undefined
        ? plan.risks
        : patch.risks.slice(0, 20).map((risk) => ({
            risk: risk.risk,
            mitigation: risk.mitigation ?? null,
            severity: risk.severity,
          })),
    updatedAt: now,
    // An edit after confirmation is a new draft: the confirmed version stays immutable.
    status: 'draft',
    confirmedAt: null,
    confirmedBy: null,
  };
  const withAnswers = applyAnswers(next, patch.answers, now);
  const withStatus: RequirementPlan = { ...withAnswers, status: statusOf(withAnswers) };
  return RequirementPlanSchema.parse({
    ...withStatus,
    provenance: { ...withStatus.provenance, inferred: [...inferredFields()] },
  });
}

function summaryOf(record: RequirementRecord): RequirementSummary {
  const current =
    record.versions.find((version) => version.version === record.currentVersion) ??
    record.versions[record.versions.length - 1];
  if (current === undefined) {
    throw new PlanningError('not_found', `requirement "${record.requirementId}" has no version`);
  }
  return {
    requirementId: current.requirementId,
    title: current.title,
    status: current.status,
    version: current.version,
    sourceKind: current.source.kind,
    updatedAt: current.updatedAt,
    deliverableCount: current.deliverables.length,
    capabilityCount: current.requiredCapabilities.length,
  };
}

interface OverrideOutcome {
  readonly ok: boolean;
  readonly failure: string | null;
}

export function createPlanningService(deps: PlanningServiceDeps): PlanningService {
  const now = deps.now ?? (() => new Date().toISOString());

  const currentRequirement = (requirementId: string): RequirementRecord => {
    const { companyId } = deps.runtime();
    const record = deps.store.getRequirement(companyId, requirementId);
    if (record === null) throw new PlanningError('not_found', `unknown requirement "${requirementId}"`);
    return record;
  };

  const currentVersion = (record: RequirementRecord): RequirementPlan => {
    const version =
      record.versions.find((entry) => entry.version === record.currentVersion) ??
      record.versions[record.versions.length - 1];
    if (version === undefined) {
      throw new PlanningError('not_found', `requirement "${record.requirementId}" has no version`);
    }
    return version;
  };

  const saveNextVersion = (
    record: RequirementRecord,
    plan: RequirementPlan,
  ): RequirementPlan => {
    const nextVersion = record.currentVersion + 1;
    const next: RequirementPlan = RequirementPlanSchema.parse({
      ...plan,
      version: nextVersion,
      updatedAt: now(),
    });
    deps.store.saveRequirement({
      ...record,
      currentVersion: nextVersion,
      versions: [...record.versions, next],
    });
    return next;
  };

  const startCanvasDraft = async (
    plan: RequirementPlan,
    draft: OrchestrationDraft,
    runtime: PlanningRuntime,
  ): Promise<OrchestrationDraft> => {
    const actor = systemActor('planning-orchestrator', draft.orchestrationId);
    const simTime = runtime.simTime;
    const capabilities = draft.nodes
      .filter((node) => node.kind === 'task' && node.capability !== null)
      .map((node) => node.capability as string);
    const started = runtime.simulation.workflow.start({
      capabilities,
      awaitConfirmation: true,
      actor,
      simTime: simTime as never,
      title: `草案：${plan.title}`.slice(0, 200),
      goal: plan.source.goal,
      context: {
        planning: {
          requirementId: plan.requirementId,
          requirementVersion: plan.version,
          orchestrationId: draft.orchestrationId,
          orchestrationVersion: draft.version,
          capabilities,
          nodes: draft.nodes.map((node) => ({
            nodeId: node.nodeId,
            kind: node.kind,
            title: node.title,
            capability: node.capability,
            employeeId: node.employeeId,
            dependsOn: node.dependsOn,
            outputs: node.outputs,
          })),
        },
      },
    });
    if (!started.ok) {
      return {
        ...draft,
        status: 'blocked',
        conflicts: [
          ...draft.conflicts,
          {
            code: 'workflow_draft_failed',
            severity: 'blocking',
            detail: `工作流引擎拒绝创建草案：${started.error.code} ${started.error.issues
              .map((issue) => issue.reason)
              .join('; ')}`,
            nodeIds: [],
          },
        ],
        updatedAt: now(),
      };
    }

    const instance = started.value.instance;
    // The engine builds events but does not append them; the caller owns the log. Without this
    // injection the draft would exist only in memory, invisible to the canvas/theater/recovery.
    await runtime.simulation.inject(started.value.events);
    const taskNodes = draft.nodes.filter((node) => node.kind === 'task');
    const overrides = taskNodes.flatMap((node, index) =>
      node.employeeId === null
        ? []
        : [
            {
              stepId: `step-${String(index + 1)}`,
              employeeId: node.employeeId,
              reason: `M3.3 orchestration ${draft.orchestrationId}`,
            },
          ],
    );
    let override: OverrideOutcome | null = null;
    if (overrides.length > 0) {
      const result = runtime.simulation.workflow.overrideAssignments({
        instanceId: instance.instanceId,
        actor,
        simTime: simTime as never,
        overrides,
        reason: `M3.3: pin the employees chosen by orchestration ${draft.orchestrationId}`,
      });
      override = result.ok
        ? { ok: true, failure: null }
        : {
            ok: false,
            failure: `${result.error.code}: ${result.error.issues
              .map((issue) => issue.reason)
              .join('; ')}`,
          };
      if (result.ok) await runtime.simulation.inject(result.value.events);
    }
    const conflicts: OrchestrationConflict[] = [...draft.conflicts];
    if (override !== null && !override.ok) {
      conflicts.push({
        code: 'assignment_override_failed',
        severity: 'warning',
        detail: `草案已创建，但固定负责人失败（画布会按席位解析）：${override.failure ?? 'unknown'}`,
        nodeIds: taskNodes.map((node) => node.nodeId),
      });
    }
    return {
      ...draft,
      conflicts,
      workflowInstanceId: instance.instanceId,
      workflowId: instance.workflowId,
      workflowVersion: instance.version,
      updatedAt: now(),
    };
  };

  const planNodesFrom = (
    orchestration: OrchestrationDraft,
    requirement: RequirementPlan,
  ): PlanNode[] =>
    orchestration.nodes.map((node) => ({
      nodeId: node.nodeId,
      kind: node.kind,
      title: node.title,
      goal:
        node.kind === 'approval'
          ? '由人类确认最终交付方案后再进入执行。'
          : `交付：${node.outputs.length > 0 ? node.outputs.join('、') : requirement.source.goal}`.slice(0, 2000),
      capability: node.capability,
      employeeId: node.employeeId,
      positionId: node.positionId,
      inputs: [...node.inputs],
      outputs: [...node.outputs],
      acceptance: [...node.acceptance],
      dependsOn: [...node.dependsOn],
    }));

  const planSummary = (plan: ExecutionPlan) => ({
    nodeCount: plan.nodes.length,
    taskCount: plan.nodes.filter((node) => node.kind === 'task').length,
    employeeCount: new Set(
      plan.nodes.flatMap((node) => (node.employeeId === null ? [] : [node.employeeId])),
    ).size,
    capabilities: [
      ...new Set(plan.nodes.flatMap((node) => (node.capability === null ? [] : [node.capability]))),
    ],
    deliverables: plan.nodes.flatMap((node) => [...node.outputs]).slice(0, 30),
    workflowInstanceId: plan.workflowInstanceId,
  });

  const planChangeOf = (base: ExecutionPlan, next: ExecutionPlan): PlanChange => {
    const baseById = new Map(base.nodes.map((node) => [node.nodeId, node]));
    let renamed = 0;
    let reassigned = 0;
    let dependenciesChanged = 0;
    let contentChanged = 0;
    for (const node of next.nodes) {
      const before = baseById.get(node.nodeId);
      if (before === undefined) {
        renamed += 1;
        continue;
      }
      if (before.title !== node.title) renamed += 1;
      if (before.employeeId !== node.employeeId) reassigned += 1;
      if (
        before.dependsOn.length !== node.dependsOn.length ||
        before.dependsOn.some((dependency) => !node.dependsOn.includes(dependency))
      ) {
        dependenciesChanged += 1;
      }
      if (
        before.goal !== node.goal ||
        before.inputs.join('\u0000') !== node.inputs.join('\u0000') ||
        before.outputs.join('\u0000') !== node.outputs.join('\u0000') ||
        before.acceptance.join('\u0000') !== node.acceptance.join('\u0000')
      ) {
        contentChanged += 1;
      }
    }
    return { fromVersion: base.version, renamed, reassigned, dependenciesChanged, contentChanged };
  };

  const nodeWithEmployee = (
    node: PlanNode,
    employeeId: string | null,
    organization: Organization,
  ): PlanNode => {
    if (node.kind === 'approval') return { ...node, employeeId: null, positionId: null };
    if (employeeId === null) return { ...node, employeeId: null, positionId: null };
    const employee = organization.employees.find((entry) => String(entry.id) === employeeId);
    return { ...node, employeeId, positionId: employee === undefined ? null : String(employee.positionId) };
  };

  const applyPlanPatch = (
    base: ExecutionPlan,
    patches: readonly z.infer<typeof PlanNodePatchSchema>[],
    organization: Organization,
  ): PlanNode[] => {
    const baseIds = new Set(base.nodes.map((node) => node.nodeId));
    for (const patch of patches) {
      if (!baseIds.has(patch.nodeId)) {
        throw new PlanningError('invalid_input', `unknown node "${patch.nodeId}"`);
      }
    }
    const byId = new Map(patches.map((patch) => [patch.nodeId, patch]));
    return base.nodes.map((node) => {
      const patch = byId.get(node.nodeId);
      if (patch === undefined) return { ...node };
      const employeeId =
        patch.employeeId === undefined ? node.employeeId : patch.employeeId;
      const next = nodeWithEmployee(
        {
          ...node,
          title: patch.title?.trim() ?? node.title,
          goal: patch.goal?.trim() ?? node.goal,
          inputs: patch.inputs === undefined ? node.inputs : cleanList(patch.inputs, 20),
          outputs: patch.outputs === undefined ? node.outputs : cleanList(patch.outputs, 10),
          acceptance:
            patch.acceptance === undefined ? node.acceptance : cleanList(patch.acceptance, 20),
          dependsOn:
            patch.dependsOn === undefined
              ? node.dependsOn
              : [...new Set(patch.dependsOn.map((entry) => entry.trim()).filter((entry) => entry !== ''))],
        },
        employeeId,
        organization,
      );
      return PlanNodeSchema.parse(next);
    });
  };

  const syncPlanAssignments = async (
    plan: ExecutionPlan,
    runtime: PlanningRuntime,
  ): Promise<PlanValidation> => {
    if (plan.workflowInstanceId === null) return plan.validation;
    const taskNodes = plan.nodes.filter((node) => node.kind === 'task');
    const overrides = taskNodes.flatMap((node, index) =>
      node.employeeId === null
        ? []
        : [
            {
              stepId: `step-${String(index + 1)}`,
              employeeId: node.employeeId,
              reason: `M3.4 plan ${plan.planId} v${String(plan.version)}`,
            },
          ],
    );
    if (overrides.length === 0) return plan.validation;
    const resulted = runtime.simulation.workflow.overrideAssignments({
      instanceId: plan.workflowInstanceId,
      actor: systemActor('planner', plan.planId),
      simTime: runtime.simTime as never,
      overrides,
      reason: `M3.4: apply plan ${plan.planId} v${String(plan.version)} assignments`,
    });
    if (resulted.ok) {
      await runtime.simulation.inject(resulted.value.events);
      return plan.validation;
    }
    return {
      ...plan.validation,
      warningCount: plan.validation.warningCount + 1,
      issues: [
        ...plan.validation.issues,
        {
          code: 'assignment_override_failed',
          severity: 'warning',
          detail: `引擎拒绝部分改派：${resulted.error.code}`,
          nodeIds: taskNodes.map((node) => node.nodeId),
        },
      ],
    };
  };

  const makePlanVersion = (input: {
    readonly planId: string;
    readonly companyId: string;
    readonly version: number;
    readonly status: 'draft' | 'confirmed';
    readonly base: ExecutionPlan;
    readonly nodes: readonly PlanNode[];
    readonly validation: PlanValidation;
    readonly workflowInstanceId: string | null;
    readonly workflowId: string | null;
    readonly now: string;
    readonly confirmedAt?: string | null;
    readonly confirmedBy?: string | null;
    readonly confirmationNote?: string | null;
  }): ExecutionPlan => {
    const order = topologicalOrderOf(input.nodes);
    const orderValue =
      order.length === input.nodes.length ? [...order] : input.nodes.map((node) => node.nodeId);
    const draft: ExecutionPlan = {
      planId: input.planId,
      companyId: input.companyId,
      version: input.version,
      status: input.status,
      orchestrationId: input.base.orchestrationId,
      orchestrationVersion: input.base.orchestrationVersion,
      requirementId: input.base.requirementId,
      requirementVersion: input.base.requirementVersion,
      title: input.base.title,
      goal: input.base.goal,
      nodes: input.nodes.map((node) => ({ ...node })),
      order: orderValue,
      validation: input.validation,
      summary: planSummary({
        ...input.base,
        nodes: [...input.nodes],
        workflowInstanceId: input.workflowInstanceId,
      }),
      change: planChangeOf(input.base, {
        ...input.base,
        nodes: input.nodes.map((node) => ({ ...node })),
      }),
      workflowInstanceId: input.workflowInstanceId,
      workflowId: input.workflowId,
      createdAt: input.base.createdAt,
      updatedAt: input.now,
      confirmedAt: input.confirmedAt ?? null,
      confirmedBy: input.confirmedBy ?? null,
      confirmationNote: input.confirmationNote ?? null,
    };
    return ExecutionPlanSchema.parse(draft);
  };

  const appendPlanVersion = (record: PlanRecord, plan: ExecutionPlan): ExecutionPlan => {
    deps.store.savePlan({
      ...record,
      currentVersion: plan.version,
      versions: [...record.versions, plan],
    });
    return plan;
  };

  const currentPlan = (
    companyId: string,
    planId: string,
  ): { record: PlanRecord; version: ExecutionPlan } => {
    const record = deps.store.getPlan(companyId, planId);
    if (record === null) throw new PlanningError('not_found', `unknown plan "${planId}"`);
    const version =
      record.versions.find((entry) => entry.version === record.currentVersion) ??
      record.versions[record.versions.length - 1];
    if (version === undefined) throw new PlanningError('not_found', `plan "${planId}" has no version`);
    return { record, version };
  };

  const planSummaryView = (plan: ExecutionPlan): PlanSummaryView => ({
    planId: plan.planId,
    title: plan.title,
    status: plan.status,
    version: plan.version,
    orchestrationId: plan.orchestrationId,
    workflowInstanceId: plan.workflowInstanceId,
    updatedAt: plan.updatedAt,
    confirmedAt: plan.confirmedAt,
    blockingCount: plan.validation.blockingCount,
  });

  const executionStatusOf = (
    instance: ReturnType<PlanningRuntime['simulation']['instanceStore']['get']>,
    tasks: readonly ReturnType<PlanningRuntime['simulation']['taskStore']['all']>[number][],
  ): ExecutionStatus => {
    if (instance === null) return 'not_started';
    if (instance.status === 'completed') return 'completed';
    // A cancelled task is a real terminal fact even if the engine has not yet aborted the
    // instance; the execution view must not keep claiming "running".
    if (tasks.some((task) => task.status === 'cancelled')) return 'cancelled';
    if (tasks.some((task) => task.status === 'rejected')) return 'failed';
    if (instance.status === 'aborted') {
      const cancelled = tasks.some((task) => task.status === 'cancelled');
      const rejected = tasks.some((task) => task.status === 'rejected');
      return cancelled && !rejected ? 'cancelled' : 'failed';
    }
    if (instance.approval !== null && instance.approval.status === 'open') {
      return 'awaiting_approval';
    }
    if (instance.status === 'blocked') {
      return instance.blockedReason?.kind === 'manual' ? 'paused' : 'failed';
    }
    return 'running';
  };

  const executionTaskViewOf = (
    task: ReturnType<PlanningRuntime['simulation']['taskStore']['all']>[number],
    organization: Organization,
  ): ExecutionTaskView => {
    const employee =
      task.assignment.assigneeEmployeeId === null
        ? null
        : organization.employees.find(
            (entry) => String(entry.id) === String(task.assignment.assigneeEmployeeId),
          );
    const result = task.result;
    const data = result === null ? {} : { ...result.data };
    const explicitArtifacts = result === null ? [] : [...result.artifacts];
    const dataFiles = Array.isArray(data['files'])
      ? (data['files'] as readonly unknown[])
          .map((entry) =>
            typeof entry === 'object' && entry !== null
              ? String((entry as Record<string, unknown>)['path'] ?? '')
              : '',
          )
          .filter((entry) => entry !== '')
      : [];
    const stringKeys =
      result === null
        ? []
        : Object.entries(data)
            .filter(([key, value]) => typeof value === 'string' && value !== '' && key !== 'summary')
            .map(([key]) => key);
    const artifacts =
      explicitArtifacts.length > 0
        ? explicitArtifacts
        : dataFiles.length > 0
          ? dataFiles
          : stringKeys;
    return {
      taskId: task.taskId,
      planNodeId: task.workflowStepId,
      title: task.title,
      status: task.status,
      assigneeEmployeeId: task.assignment.assigneeEmployeeId,
      assigneeName: employee === undefined || employee === null ? null : employee.name,
      attempt: task.attempt,
      maxAttempts: task.maxAttempts,
      createdAtSim: Number(task.createdAtSim),
      completedAtSim: task.completedAtSim === null ? null : Number(task.completedAtSim),
      blockedReason: task.blockedReason,
      rejectReason: task.rejectReason,
      result:
        result === null
          ? null
          : {
              summary: result.summary,
              artifacts,
              data,
            },
    };
  };

  const executionViewOf = (record: ExecutionRecord): ExecutionView => {
    const runtime = deps.runtime();
    const planRecord = deps.store.getPlan(record.companyId, record.planId);
    const plan =
      planRecord?.versions.find((entry) => entry.version === record.planVersion) ?? null;
    const instance = runtime.simulation.instanceStore.get(record.workflowInstanceId);
    const tasks = runtime.simulation.taskStore
      .all()
      .filter((task) => task.workflowInstanceId === record.workflowInstanceId)
      .sort((left, right) => Number(left.createdAtSim) - Number(right.createdAtSim));
    const taskViews = tasks.map((task) => executionTaskViewOf(task, runtime.organization));
    const taskCount =
      plan?.nodes.filter((node) => node.kind === 'task').length ?? taskViews.length;
    const completedCount = taskViews.filter((task) => task.status === 'completed').length;
    const failedCount = taskViews.filter(
      (task) => task.status === 'rejected' || task.status === 'cancelled',
    ).length;
    const activeCount = taskViews.filter(
      (task) =>
        task.status === 'created' ||
        task.status === 'assigned' ||
        task.status === 'accepted' ||
        task.status === 'started' ||
        task.status === 'submitted' ||
        task.status === 'blocked',
    ).length;
    const artifacts = [
      ...new Set(taskViews.flatMap((task) => (task.result === null ? [] : [...task.result.artifacts]))),
    ];
    return {
      executionId: record.executionId,
      companyId: record.companyId,
      planId: record.planId,
      planVersion: record.planVersion,
      planTitle: plan?.title ?? '',
      orchestrationId: plan?.orchestrationId ?? '',
      requirementId: plan?.requirementId ?? '',
      requirementVersion: plan?.requirementVersion ?? 1,
      workflowInstanceId: record.workflowInstanceId,
      workflowId: record.workflowId,
      status: executionStatusOf(instance, tasks),
      startedAt: record.startedAt,
      startedBy: record.startedBy,
      planConfirmedAt: plan?.confirmedAt ?? null,
      planConfirmedBy: plan?.confirmedBy ?? null,
      tasks: taskViews,
      summary: {
        taskCount,
        completedCount,
        failedCount,
        activeCount,
        allTasksCompleted: taskCount > 0 && completedCount === taskCount,
        artifacts,
      },
      approval:
        instance?.approval === null || instance?.approval === undefined
          ? null
          : {
              stepId: instance.approval.stepId,
              status: instance.approval.status,
              requiredCount: instance.approval.requiredCount,
              grantedBy: [...instance.approval.grantedBy],
              decidedBy: instance.approval.decidedBy,
              requestedAtSim:
                instance.approval.requestedAtSim === undefined
                  ? null
                  : Number(instance.approval.requestedAtSim),
            },
    };
  };

  const planSnapshotOf = (plan: ExecutionPlan): ExecutionPlanSnapshot => ({
    planId: plan.planId,
    planVersion: plan.version,
    requirementId: plan.requirementId,
    requirementVersion: plan.requirementVersion,
    title: plan.title,
    goal: plan.goal,
    nodes: plan.nodes.map((node) => ({
      nodeId: node.nodeId,
      kind: node.kind,
      title: node.title,
      goal: node.goal,
      capability: node.capability,
      employeeId: node.employeeId,
      inputs: [...node.inputs],
      outputs: [...node.outputs],
      acceptance: [...node.acceptance],
      dependsOn: [...node.dependsOn],
    })),
    order: [...plan.order],
  });

  const startActor = (
    runtime: PlanningRuntime,
    correlationId: string,
  ): ReturnType<typeof systemActor> | ReturnType<typeof employeeActor> => {
    const operator = deps.operatorId();
    const employee = runtime.organization.employees.find(
      (entry) => String(entry.id) === operator,
    );
    return employee === undefined
      ? systemActor('planning-executor', correlationId)
      : employeeActor(
          runtime.simulation.identity.actorContext(
            employee.id as never,
            correlationId as never,
          ),
        );
  };

  const humanActor = (runtime: PlanningRuntime, correlationId: string) => {
    const operator = deps.operatorId();
    const employee = runtime.organization.employees.find(
      (entry) => String(entry.id) === operator,
    );
    if (employee === undefined) {
      throw new PlanningError(
        'invalid_input',
        'approval requires the human operator to hold an employee seat',
      );
    }
    return employeeActor(
      runtime.simulation.identity.actorContext(
        employee.id as never,
        correlationId as never,
      ),
    );
  };

  const approvalSummaryOf = (view: ExecutionView): ExecutionApprovalSummary => ({
    executionId: view.executionId,
    planId: view.planId,
    planVersion: view.planVersion,
    planTitle: view.planTitle,
    status: view.status,
    taskCount: view.summary.taskCount,
    completedCount: view.summary.completedCount,
    artifacts: [...view.summary.artifacts],
    startedAt: view.startedAt,
    startedBy: view.startedBy,
    approvalRequestedAtSim: view.approval?.requestedAtSim ?? null,
    approvalStatus: view.approval?.status ?? null,
  });

  const currentPromotion = (
    companyId: string,
    promotionId: string,
  ): { record: PromotionRecord; version: PromotionPlan } => {
    const record = deps.store.getPromotion(companyId, promotionId);
    if (record === null) throw new PlanningError('not_found', `unknown promotion "${promotionId}"`);
    const version =
      record.versions.find((entry) => entry.version === record.currentVersion) ??
      record.versions[record.versions.length - 1];
    if (version === undefined) {
      throw new PlanningError('not_found', `promotion "${promotionId}" has no version`);
    }
    return { record, version };
  };

  const promotionSummaryOf = (plan: PromotionPlan): PromotionSummary => ({
    promotionId: plan.promotionId,
    executionId: plan.executionId,
    title: plan.title,
    status: plan.status,
    version: plan.version,
    materialCount: plan.summary.materialCount,
    channelCount: plan.summary.channelCount,
    updatedAt: plan.updatedAt,
    confirmedAt: plan.confirmedAt,
  });

  const promotionSummaryText = (input: {
    readonly title: string;
    readonly goal: string;
    readonly audience: readonly string[];
    readonly channels: readonly { readonly name: string }[];
    readonly materials: readonly unknown[];
  }): string =>
    `${input.title}：${input.goal}；受众：${input.audience.join('、') || '待确认'}；渠道：${input.channels.map((channel) => channel.name).join('、') || '待确认'}；材料：${String(input.materials.length)} 份。`;

  const employeeCapabilities = (
    organization: Organization,
    employeeId: string,
  ): readonly string[] => {
    const employee = organization.employees.find((entry) => String(entry.id) === employeeId);
    if (employee === undefined) return [];
    const position = organization.positions.find(
      (entry) => String(entry.id) === String(employee.positionId),
    );
    return [...(position?.capabilities ?? []), ...(employee.expertise ?? [])];
  };

  const promotionContributors = (organization: Organization) => {
    const find = (capability: string, role: string) => {
      const employee = organization.employees.find(
        (entry) =>
          isExecutableEmployment(entry.status) &&
          employeeCapabilities(organization, String(entry.id)).includes(capability),
      );
      return employee === undefined
        ? null
        : {
            employeeId: String(employee.id),
            name: employee.name,
            role,
            capability,
            basis: 'capability' as const,
          };
    };
    return [
      find('marketing', '推广策略与内容'),
      find('testing', '内容质量检查'),
    ].filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  };

  const promotionMaterials = (
    strategy: {
      readonly valueProposition: string;
      readonly coreMessages: readonly string[];
    },
    artifacts: readonly string[],
  ): PromotionMaterial[] => {
    const platformNames = [
      { platform: 'xiaohongshu', title: '小红书', type: '图文笔记' },
      { platform: 'douyin', title: '抖音', type: '短视频脚本' },
      { platform: 'bilibili', title: 'B站', type: '视频提纲' },
      { platform: 'wechat', title: '公众号', type: '图文' },
    ] as const;
    const evidenceSummary = strategy.coreMessages.join('\n');
    const materials: PromotionMaterial[] = [
      {
        materialId: 'material-intro',
        type: 'project-intro',
        platform: 'general',
        title: '项目介绍',
        body: strategy.valueProposition.slice(0, 20000),
        source: 'ai',
        sourceArtifact: artifacts[0] ?? null,
      },
      {
        materialId: 'material-selling-points',
        type: 'selling-points',
        platform: 'general',
        title: '核心卖点',
        body: evidenceSummary,
        source: 'ai',
        sourceArtifact: null,
      },
      {
        materialId: 'material-headline',
        type: 'headline',
        platform: 'general',
        title: '宣传标题',
        body: strategy.coreMessages[0] ?? strategy.valueProposition.slice(0, 200),
        source: 'ai',
        sourceArtifact: null,
      },
    ];
    // Materials are deliberately assembled from the approved strategy and artifact names only.
    // The content studio is a separate feature; it is not asked to invent a campaign narrative
    // here, so no user feedback, market numbers or performance claim can enter a promotion.
    for (const [index, item] of platformNames.entries()) {
      materials.push({
        materialId: `material-platform-${String(index + 1)}`,
        type: 'platform-copy',
        platform: item.platform,
        title: item.title,
        body: `${evidenceSummary}\n\n${strategy.valueProposition}\n\n${item.type}`.slice(0, 20000),
        source: 'ai',
        sourceArtifact: artifacts[0] ?? null,
      });
    }
    return materials;
  };


  const publicationContentOf = (promotion: PromotionPlan): PublicationContent => ({
    title: promotion.title,
    body: [
      promotion.summaryText,
      '',
      ...promotion.materials.map((material) => `${material.title}\n${material.body}`),
    ].join('\n\n').slice(0, 40000),
    channels: ['local_page', 'local_manifest'],
    attachments: cleanList(
      promotion.materials.flatMap((material) =>
        material.sourceArtifact === null ? [] : [material.sourceArtifact],
      ),
      40,
    ),
  });

  const publicationChecks = (
    promotion: PromotionPlan,
    approval: ExecutionApprovalRecord | null,
    content: PublicationContent,
  ): PublicationCheck[] => {
    const localSelected = content.channels.some(
      (channel) => channel === 'local_page' || channel === 'local_manifest',
    );
    const externalSelected = content.channels.includes('external_wechat');
    return [
      {
        checkId: 'source-confirmed',
        label: 'M3.7 推广方案已确认',
        ok: promotion.status === 'confirmed',
        detail: promotion.status === 'confirmed'
          ? `promotion v${String(promotion.version)} confirmed by ${promotion.confirmedBy ?? '—'}`
          : 'promotion is not confirmed',
      },
      {
        checkId: 'source-approved',
        label: '来源 execution 已由 M3.6 批准',
        ok: approval !== null && approval.action === 'approve',
        detail: approval === null ? 'approval record not found' : `approval ${approval.approvalId} by ${approval.decidedBy}`,
      },
      {
        checkId: 'content',
        label: '最终发布标题与正文非空',
        ok: content.title.trim() !== '' && content.body.trim() !== '',
        detail: content.title.trim() === '' ? 'title is required' : content.body.trim() === '' ? 'body is required' : 'content is present',
      },
      {
        checkId: 'local-channel',
        label: '至少选择一个本机可执行渠道',
        ok: localSelected,
        detail: localSelected
          ? 'local page / manifest will be written and served by this API'
          : 'only unavailable external channels were selected',
      },
      {
        checkId: 'external-channel',
        label: '外部渠道授权情况',
        ok: true,
        detail: externalSelected
          ? 'no external connector or credentials; this channel will be recorded unavailable, never faked as published'
          : 'no external channel selected',
      },
    ];
  };

  const publicationSummaryOf = (record: PublicationRecord): PublicationSummary => {
    const current =
      record.versions.find((entry) => entry.version === record.currentVersion) ??
      record.versions[record.versions.length - 1];
    return {
      publicationId: record.publicationId,
      promotionId: record.promotionId,
      promotionVersion: record.promotionVersion,
      title: current?.content.title ?? '',
      status: current?.status ?? 'draft',
      version: current?.version ?? 1,
      publishedAt: current?.publishedAt ?? null,
      publicPath: current?.publicPath ?? null,
      updatedAt: current?.updatedAt ?? '',
    };
  };

  const currentPublication = (
    companyId: string,
    publicationId: string,
  ): { record: PublicationRecord; version: PublicationVersion } => {
    const record = deps.store.getPublication(companyId, publicationId);
    if (record === null) throw new PlanningError('not_found', `unknown publication "${publicationId}"`);
    const version =
      record.versions.find((entry) => entry.version === record.currentVersion) ??
      record.versions[record.versions.length - 1];
    if (version === undefined) throw new PlanningError('not_found', `publication "${publicationId}" has no version`);
    return { record, version };
  };

  const publicationRoot = (): string => {
    if (deps.publicationDir === undefined || deps.publicationDir.trim() === '') {
      throw new PlanningError('publication_unavailable', 'local publication storage is not configured');
    }
    return deps.publicationDir;
  };
  const publicationInFlight = new Set<string>();

  const escapeHtml = (value: string): string =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');

  const renderPublicationHtml = (
    record: PublicationRecord,
    version: PublicationVersion,
  ): string => {
    const body = escapeHtml(version.content.body).replaceAll('\n', '<br />');
    const attachments = version.content.attachments
      .map((attachment) => `<li>${escapeHtml(attachment)}</li>`)
      .join('');
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(version.content.title)}</title>
<style>
  :root{--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#25855a;--bg:#f8fafc}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,"Segoe UI",sans-serif;line-height:1.7}
  main{max-width:860px;margin:0 auto;padding:42px 28px 64px;background:#fff;min-height:100vh;border-left:1px solid var(--line);border-right:1px solid var(--line)}
  .badge{display:inline-block;background:#e8f5ed;color:var(--accent);border-radius:999px;padding:4px 10px;font-size:11px;font-weight:700;letter-spacing:.08em}
  h1{font-size:30px;line-height:1.3;margin:18px 0 8px} .meta{color:var(--muted);font-size:12px}
  .body{margin:28px 0;font-size:15px} .source{border-top:1px solid var(--line);margin-top:28px;padding-top:16px;color:var(--muted);font-size:12px}
  .source h2{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--ink)} ul{padding-left:20px}
</style>
</head>
<body><main>
<span class="badge">LOCAL PUBLICATION · 本地正式发布</span>
<h1>${escapeHtml(version.content.title)}</h1>
<div class="meta">publication ${escapeHtml(record.publicationId)} · v${String(version.version)} · ${escapeHtml(version.publishedAt ?? version.updatedAt)}</div>
<div class="body">${body}</div>
<section class="source">
<h2>Traceability</h2>
<p>promotion ${escapeHtml(record.promotionId)} v${String(record.promotionVersion)} · execution ${escapeHtml(record.executionId)} · plan ${escapeHtml(record.planId)} v${String(record.planVersion)} · approval ${escapeHtml(record.approvalId)}</p>
<p>approved by ${escapeHtml(record.approvedBy)} · promotion confirmed by ${escapeHtml(record.promotionConfirmedBy)} · published by ${escapeHtml(version.publishedBy ?? '—')}</p>
<h2>Attachments</h2><ul>${attachments === '' ? '<li>—</li>' : attachments}</ul>
<p>This page is served by MAOEH itself. It is not an external social-platform post.</p>
</section>
</main></body></html>`;
  };

  const writePublicationFiles = (
    record: PublicationRecord,
    version: PublicationVersion,
  ): { publicPath: string; results: readonly PublicationChannelResult[] } => {
    const root = join(publicationRoot(), 'publications', record.publicationId, `v${String(version.version)}`);
    mkdirSync(root, { recursive: true });
    const results: PublicationChannelResult[] = [];
    const publicPath = `/api/publications/${encodeURIComponent(record.publicationId)}/page?v=${String(version.version)}`;
    for (const channel of version.content.channels) {
      const checkedAt = new Date().toISOString();
      if (channel === 'external_wechat') {
        results.push({
          channel,
          status: 'unavailable',
          resourceId: null,
          url: null,
          error: 'no external connector or authorized credentials; external publishing is not configured',
          verifiedAt: checkedAt,
        });
        continue;
      }
      try {
        if (channel === 'local_page') {
          const file = join(root, 'index.html');
          writeFileSync(file, renderPublicationHtml(record, version), 'utf8');
          results.push({
            channel,
            status: 'published',
            resourceId: `local:${record.publicationId}:v${String(version.version)}`,
            url: publicPath,
            error: null,
            verifiedAt: checkedAt,
          });
        } else {
          const file = join(root, 'manifest.json');
          writeFileSync(
            file,
            JSON.stringify(
              {
                publicationId: record.publicationId,
                version: version.version,
                title: version.content.title,
                source: {
                  promotionId: record.promotionId,
                  promotionVersion: record.promotionVersion,
                  executionId: record.executionId,
                  planId: record.planId,
                  planVersion: record.planVersion,
                  approvalId: record.approvalId,
                  requirementId: record.requirementId,
                  requirementVersion: record.requirementVersion,
                },
                artifacts: record.sourceArtifacts,
                channels: version.content.channels,
              },
              null,
              2,
            ),
            'utf8',
          );
          results.push({
            channel,
            status: 'published',
            resourceId: `local-manifest:${record.publicationId}:v${String(version.version)}`,
            url: null,
            error: null,
            verifiedAt: checkedAt,
          });
        }
      } catch (error) {
        results.push({
          channel,
          status: 'failed',
          resourceId: null,
          url: null,
          error: error instanceof Error ? error.message : 'local write failed',
          verifiedAt: checkedAt,
        });
      }
    }
    return { publicPath, results };
  };

  const emitPublication = async (
    record: PublicationRecord,
    version: PublicationVersion,
    type:
      | typeof PUBLICATION_DRAFTED
      | typeof PUBLICATION_CONFIRMED
      | typeof PUBLICATION_PUBLISHED
      | typeof PUBLICATION_PARTIALLY_PUBLISHED
      | typeof PUBLICATION_FAILED,
  ): Promise<void> => {
    const runtime = deps.runtime();
    const registration = ensurePublicationEvents(runtime.simulation.registry);
    if (!registration.ok) {
      throw new PlanningError('publication_invalid', 'publication event registration failed');
    }
    const payload: PublicationEventPayload = {
      publicationId: record.publicationId,
      version: version.version,
      promotionId: record.promotionId,
      promotionVersion: record.promotionVersion,
      executionId: record.executionId,
      planId: record.planId,
      planVersion: record.planVersion,
      approvalId: record.approvalId,
      status: version.status,
      publicPath: version.publicPath,
    };
    const event = publicationEvent({
      registry: runtime.simulation.registry,
      companyId: runtime.companyId,
      type,
      simTime: runtime.simTime,
      actorId: deps.operatorId(),
      payload,
    });
    await runtime.simulation.inject([event]);
  };

  const executionRecordFor = (executionId: string): ExecutionRecord => {
    const { companyId } = deps.runtime();
    const record = deps.store.getExecution(companyId, executionId);
    if (record === null) {
      throw new PlanningError('not_found', `unknown execution "${executionId}"`);
    }
    return record;
  };

  return {
    async analyze(input) {
      const parsed = AnalyzeRequirementInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new PlanningError('invalid_input', parsed.error.issues.map((issue) => issue.message).join('; '));
      }
      const runtime = deps.runtime();
      const sourceSessionId = parsed.data.sourceSessionId;
      if (sourceSessionId !== undefined) {
        if (deps.sandbox === undefined) {
          throw new PlanningError('invalid_input', 'the sandbox service is not available');
        }
        const session = await deps.sandbox(sourceSessionId);
        if (session === null) throw new PlanningError('not_found', `unknown sandbox session "${sourceSessionId}"`);
        if (session.companyId !== undefined && session.companyId !== runtime.companyId) {
          throw new PlanningError('not_found', `sandbox session "${sourceSessionId}" belongs to another company`);
        }
        if (session.turns.length < 2) {
          throw new PlanningError('sandbox_not_ready', 'the sandbox session has too few turns');
        }
        const analysis = analysisFromSandbox(session);
        const requirementId = deps.store.nextRequirementId(runtime.companyId);
        const plan = buildPlan({
          requirementId,
          companyId: runtime.companyId,
          version: 1,
          sourceKind: 'sandbox',
          sourceGoal: session.topic,
          sessionId: session.sessionId,
          analysis,
          mode: 'sandbox',
          provider: session.provider,
          model: session.model,
          now: now(),
        });
        deps.store.saveRequirement({ requirementId, companyId: runtime.companyId, currentVersion: 1, versions: [plan] });
        return plan;
      }

      const goal = parsed.data.goal?.trim() ?? '';
      if (goal === '') throw new PlanningError('invalid_input', 'goal or sourceSessionId is required');
      const result = await analyzeRequirementGoal(deps.analyzer, goal);
      const requirementId = deps.store.nextRequirementId(runtime.companyId);
      const plan = buildPlan({
        requirementId,
        companyId: runtime.companyId,
        version: 1,
        sourceKind: 'goal',
        sourceGoal: goal,
        sessionId: null,
        analysis: result.analysis,
        mode: result.mode,
        provider: result.provider,
        model: result.model,
        now: now(),
      });
      deps.store.saveRequirement({ requirementId, companyId: runtime.companyId, currentVersion: 1, versions: [plan] });
      return plan;
    },

    async listRequirements() {
      const { companyId } = deps.runtime();
      return deps.store.listRequirements(companyId).map(summaryOf);
    },

    async getRequirement(requirementId) {
      return currentRequirement(requirementId);
    },

    async updateRequirement(requirementId, input) {
      const body = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
      const baseVersion = Number(body['baseVersion']);
      const parsed = RequirementPatchSchema.safeParse(body['patch']);
      if (!Number.isInteger(baseVersion) || baseVersion < 1 || !parsed.success) {
        throw new PlanningError('invalid_input', 'baseVersion and a valid patch are required');
      }
      const record = currentRequirement(requirementId);
      if (baseVersion !== record.currentVersion) {
        throw new PlanningError(
          'version_conflict',
          `requirement "${requirementId}" is at v${String(record.currentVersion)}, not v${String(baseVersion)}`,
        );
      }
      const base = currentVersion(record);
      const next = applyPatch(base, parsed.data, now());
      return saveNextVersion(record, next);
    },

    async confirmRequirement(requirementId, input) {
      const parsed = ConfirmRequirementInputSchema.safeParse(input ?? {});
      if (!parsed.success) throw new PlanningError('invalid_input', parsed.error.issues.map((issue) => issue.message).join('; '));
      const record = currentRequirement(requirementId);
      const requested = parsed.data.version ?? record.currentVersion;
      if (requested !== record.currentVersion) {
        throw new PlanningError(
          'version_conflict',
          `requirement "${requirementId}" is at v${String(record.currentVersion)}, not v${String(requested)}`,
        );
      }
      const base = currentVersion(record);
      if (base.status === 'confirmed' && Object.keys(parsed.data.answers ?? {}).length === 0) {
        return base;
      }
      const answered = applyAnswers(base, parsed.data.answers, now());
      const status = statusOf(answered);
      if (status === 'needs_clarification') {
        throw new PlanningError(
          'needs_clarification',
          'the requirement still has blocking questions or missing fields',
          {
            clarifications: answered.clarifications.filter(
              (clarification) => clarification.blocking && clarification.status === 'open',
            ),
            missing: {
              deliverables: answered.deliverables.length === 0,
              acceptanceCriteria: answered.acceptanceCriteria.length === 0,
              requiredCapabilities: answered.requiredCapabilities.length === 0,
            },
          },
        );
      }
      if (answered.provenance.inferred.length > 0 && parsed.data.acknowledgeInferred !== true) {
        throw new PlanningError(
          'inferred_not_acknowledged',
          'inferred fields must be explicitly acknowledged before confirmation',
          { inferred: answered.provenance.inferred },
        );
      }
      const confirmed: RequirementPlan = RequirementPlanSchema.parse({
        ...answered,
        status: 'confirmed',
        confirmedAt: now(),
        confirmedBy: deps.operatorId(),
        updatedAt: now(),
      });
      return saveNextVersion(record, confirmed);
    },

    async orchestrate(input) {
      const parsed = OrchestrateInputSchema.safeParse(input);
      if (!parsed.success) throw new PlanningError('invalid_input', parsed.error.issues.map((issue) => issue.message).join('; '));
      const record = currentRequirement(parsed.data.requirementId);
      const requested = parsed.data.version ?? record.currentVersion;
      const version =
        record.versions.find((entry) => entry.version === requested) ?? null;
      if (version === null) throw new PlanningError('not_found', `requirement version ${String(requested)} not found`);
      if (version.status !== 'confirmed') {
        throw new PlanningError('not_confirmed', 'only a confirmed requirement can be orchestrated');
      }
      const runtime = deps.runtime();
      const orchestrationId = deps.store.nextOrchestrationId(runtime.companyId);
      const built = buildOrchestrationDraft({
        orchestrationId,
        version: 1,
        requirement: version,
        organization: runtime.organization,
        now: now(),
      });
      const saved =
        built.status === 'ready' ? await startCanvasDraft(version, built, runtime) : built;
      deps.store.saveOrchestration(saved);
      return saved;
    },

    async listOrchestrations() {
      return deps.store.listOrchestrations(deps.runtime().companyId);
    },

    async getOrchestration(orchestrationId) {
      const { companyId } = deps.runtime();
      const draft = deps.store.getOrchestration(companyId, orchestrationId);
      if (draft === null) throw new PlanningError('not_found', `unknown orchestration "${orchestrationId}"`);
      return draft;
    },

    async createPlan(input) {
      const parsed = CreatePlanInputSchema.safeParse(input);
      if (!parsed.success) throw new PlanningError('invalid_input', parsed.error.issues.map((issue) => issue.message).join('; '));
      const runtime = deps.runtime();
      const orchestration = deps.store.getOrchestration(runtime.companyId, parsed.data.orchestrationId);
      if (orchestration === null) {
        throw new PlanningError('not_found', `unknown orchestration "${parsed.data.orchestrationId}"`);
      }
      const existing = deps.store
        .listPlans(runtime.companyId)
        .find((record) => {
          const current =
            record.versions.find((entry) => entry.version === record.currentVersion) ??
            record.versions[record.versions.length - 1];
          return current?.orchestrationId === orchestration.orchestrationId;
        });
      if (existing !== undefined) {
        return currentPlan(runtime.companyId, existing.planId).version;
      }
      const requirementRecord = currentRequirement(orchestration.requirementId);
      const requirement =
        requirementRecord.versions.find((entry) => entry.version === orchestration.requirementVersion) ??
        currentVersion(requirementRecord);
      const nodes = planNodesFrom(orchestration, requirement);
      const validation = validatePlan({
        nodes,
        organization: runtime.organization,
        workflowInstanceId: orchestration.workflowInstanceId,
      });
      const order = topologicalOrderOf(nodes);
      const planId = deps.store.nextPlanId(runtime.companyId);
      const timestamp = now();
      const plan: ExecutionPlan = ExecutionPlanSchema.parse({
        planId,
        companyId: runtime.companyId,
        version: 1,
        status: 'draft',
        orchestrationId: orchestration.orchestrationId,
        orchestrationVersion: orchestration.version,
        requirementId: requirement.requirementId,
        requirementVersion: requirement.version,
        title: orchestration.title,
        goal: requirement.source.goal,
        nodes,
        order: order.length === nodes.length ? order : nodes.map((node) => node.nodeId),
        validation,
        summary: {
          nodeCount: nodes.length,
          taskCount: nodes.filter((node) => node.kind === 'task').length,
          employeeCount: new Set(
            nodes.flatMap((node) => (node.employeeId === null ? [] : [node.employeeId])),
          ).size,
          capabilities: [
            ...new Set(nodes.flatMap((node) => (node.capability === null ? [] : [node.capability]))),
          ],
          deliverables: nodes.flatMap((node) => [...node.outputs]).slice(0, 30),
          workflowInstanceId: orchestration.workflowInstanceId,
        },
        change: null,
        workflowInstanceId: orchestration.workflowInstanceId,
        workflowId: orchestration.workflowId,
        createdAt: timestamp,
        updatedAt: timestamp,
        confirmedAt: null,
        confirmedBy: null,
        confirmationNote: null,
      });
      deps.store.savePlan({
        planId,
        companyId: runtime.companyId,
        currentVersion: 1,
        versions: [plan],
      });
      return plan;
    },

    async listPlans() {
      const { companyId } = deps.runtime();
      return deps.store.listPlans(companyId).flatMap((record) => {
        const current =
          record.versions.find((entry) => entry.version === record.currentVersion) ??
          record.versions[record.versions.length - 1];
        return current === undefined ? [] : [planSummaryView(current)];
      });
    },

    async getPlan(planId) {
      const { companyId } = deps.runtime();
      return deps.store.getPlan(companyId, planId);
    },

    async updatePlan(planId, input) {
      const parsed = UpdatePlanInputSchema.safeParse(input);
      if (!parsed.success) throw new PlanningError('invalid_input', parsed.error.issues.map((issue) => issue.message).join('; '));
      const runtime = deps.runtime();
      const { record, version } = currentPlan(runtime.companyId, planId);
      if (parsed.data.baseVersion !== version.version) {
        throw new PlanningError(
          'version_conflict',
          `plan "${planId}" is at v${String(version.version)}, not v${String(parsed.data.baseVersion)}`,
        );
      }
      const nodes = applyPlanPatch(version, parsed.data.nodes, runtime.organization);
      const validation = validatePlan({
        nodes,
        organization: runtime.organization,
        workflowInstanceId: version.workflowInstanceId,
      });
      let next = makePlanVersion({
        planId,
        companyId: runtime.companyId,
        version: version.version + 1,
        status: 'draft',
        base: version,
        nodes,
        validation,
        workflowInstanceId: version.workflowInstanceId,
        workflowId: version.workflowId,
        now: now(),
      });
      // Keep the engine's assignment view in sync; this writes override events only, never tasks.
      const synced = await syncPlanAssignments(next, runtime);
      if (synced !== next.validation) {
        next = ExecutionPlanSchema.parse({
          ...next,
          validation: synced,
          summary: planSummary({ ...next, validation: synced }),
        });
      }
      return appendPlanVersion(record, next);
    },

    async confirmPlan(planId, input) {
      const parsed = ConfirmPlanInputSchema.safeParse(input);
      if (!parsed.success) throw new PlanningError('invalid_input', parsed.error.issues.map((issue) => issue.message).join('; '));
      const runtime = deps.runtime();
      const { record, version } = currentPlan(runtime.companyId, planId);
      if (parsed.data.baseVersion !== version.version) {
        throw new PlanningError(
          'version_conflict',
          `plan "${planId}" is at v${String(version.version)}, not v${String(parsed.data.baseVersion)}`,
        );
      }
      if (version.status === 'confirmed') {
        throw new PlanningError(
          'version_conflict',
          'this plan version is already confirmed; edit it to create a new draft version',
        );
      }
      const validation = validatePlan({
        nodes: version.nodes,
        organization: runtime.organization,
        workflowInstanceId: version.workflowInstanceId,
      });
      if (!validation.ok) {
        throw new PlanningError(
          'plan_invalid',
          'the plan still has blocking issues and cannot be confirmed',
          { validation },
        );
      }
      const confirmed = makePlanVersion({
        planId,
        companyId: runtime.companyId,
        version: version.version + 1,
        status: 'confirmed',
        base: version,
        nodes: version.nodes,
        validation,
        workflowInstanceId: version.workflowInstanceId,
        workflowId: version.workflowId,
        now: now(),
        confirmedAt: now(),
        confirmedBy: deps.operatorId(),
        confirmationNote: parsed.data.note?.trim() || null,
      });
      // Deliberately no workflow.confirm(), no task creation, no agent wake-up: M3.4 confirms the
      // *plan*; M3.5 reads the confirmed version and starts execution.
      return appendPlanVersion(record, confirmed);
    },

    async getConfirmedPlan(planId) {
      const { companyId } = deps.runtime();
      const record = deps.store.getPlan(companyId, planId);
      if (record === null) return null;
      const confirmed = record.versions
        .filter((entry) => entry.status === 'confirmed')
        .sort((left, right) => right.version - left.version)[0];
      return confirmed ?? null;
    },

    async startExecution(planId, input) {
      const parsed = StartExecutionInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new PlanningError('invalid_input', parsed.error.issues.map((issue) => issue.message).join('; '));
      }
      const runtime = deps.runtime();
      const { version } = currentPlan(runtime.companyId, planId);
      if (parsed.data.baseVersion !== version.version) {
        throw new PlanningError(
          'version_conflict',
          `plan "${planId}" is at v${String(version.version)}, not v${String(parsed.data.baseVersion)}`,
        );
      }
      if (version.status !== 'confirmed') {
        throw new PlanningError('not_confirmed', 'only a confirmed plan can be started');
      }
      const validation = validatePlan({
        nodes: version.nodes,
        organization: runtime.organization,
        workflowInstanceId: version.workflowInstanceId,
      });
      if (!validation.ok) {
        throw new PlanningError(
          'plan_invalid',
          'the confirmed plan no longer validates against the live organization',
          { validation },
        );
      }
      if (!version.nodes.some((node) => node.kind === 'approval')) {
        throw new PlanningError(
          'plan_invalid',
          'the confirmed plan has no approval gate for M3.6',
          { validation },
        );
      }
      const existing = deps.store
        .listExecutions(runtime.companyId)
        .find(
          (record) =>
            record.planId === planId && record.planVersion === version.version,
        );
      if (existing !== undefined) return executionViewOf(existing);

      const executionId = deps.store.nextExecutionId(runtime.companyId);
      const instanceId = `execution-${planId}-v${String(version.version)}`;
      const snapshot = planSnapshotOf(version);
      const definition = generateExecutionPlanWorkflowDefinition({
        instanceId,
        title: version.title,
        goal: version.goal,
        plan: snapshot,
        approvalRoles: runtime.organization.positions
          .filter((position) => position.reportsToPositionId === null)
          .map((position) => String(position.id)),
      });
      const issues = validateWorkflowDefinition(definition);
      if (issues.length > 0) {
        throw new PlanningError(
          'workflow_refused',
          'the confirmed plan could not be materialized as a workflow',
          { issues },
        );
      }
      runtime.simulation.definitions.save(definition);
      const correlationId = `m3.5-${planId}-v${String(version.version)}`;
      const started = runtime.simulation.workflow.start({
        workflowId: definition.workflowId,
        instanceId,
        title: version.title,
        goal: version.goal,
        actor: startActor(runtime, correlationId),
        simTime: runtime.simTime as never,
        context: executionPlanContext(snapshot),
      });
      if (!started.ok) {
        throw new PlanningError(
          'workflow_refused',
          'the workflow engine refused to start the confirmed plan',
          { issues: started.error.issues },
        );
      }
      await runtime.simulation.inject(started.value.events);
      const record = ExecutionRecordSchema.parse({
        executionId,
        companyId: runtime.companyId,
        planId,
        planVersion: version.version,
        workflowInstanceId: started.value.instance.instanceId,
        workflowId: definition.workflowId,
        sourceWorkflowInstanceId: version.workflowInstanceId,
        startedAt: now(),
        startedBy: deps.operatorId(),
      });
      deps.store.saveExecution(record);
      return executionViewOf(record);
    },

    async listExecutions() {
      const { companyId } = deps.runtime();
      return deps.store
        .listExecutions(companyId)
        .map((record) => executionViewOf(record))
        .filter((view) => view.planTitle !== '');
    },

    async getExecution(executionId) {
      const { companyId } = deps.runtime();
      const record = deps.store.getExecution(companyId, executionId);
      return record === null ? null : executionViewOf(record);
    },

    async listExecutionApprovals() {
      const { companyId } = deps.runtime();
      const views = deps.store
        .listExecutions(companyId)
        .map((record) => executionViewOf(record))
        .filter((view) => view.planTitle !== '');
      const history = deps.store.listApprovals(companyId);
      return {
        pending: views
          .filter((view) => view.status === 'awaiting_approval')
          .map(approvalSummaryOf),
        history,
        approved: history.filter((record) => record.action === 'approve'),
      };
    },

    async getExecutionReview(executionId) {
      const { companyId } = deps.runtime();
      const record = deps.store.getExecution(companyId, executionId);
      if (record === null) return null;
      const planRecord = deps.store.getPlan(companyId, record.planId);
      const plan =
        planRecord?.versions.find((entry) => entry.version === record.planVersion) ?? null;
      return {
        execution: executionViewOf(record),
        plan,
        history: deps.store
          .listApprovals(companyId)
          .filter((entry) => entry.executionId === executionId),
      };
    },

    async decideExecution(executionId, input) {
      const parsed = DecideExecutionInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new PlanningError(
          'invalid_input',
          parsed.error.issues.map((issue) => issue.message).join('; '),
        );
      }
      const runtime = deps.runtime();
      const record = executionRecordFor(executionId);
      const current = executionViewOf(record);
      const prior = deps.store
        .listApprovals(runtime.companyId)
        .filter((entry) => entry.executionId === executionId);
      if (prior.length > 0) {
        const existing = prior[0];
        if (existing !== undefined && existing.action === parsed.data.action) {
          return {
            decision: existing,
            execution: current,
            idempotent: true,
          };
        }
        throw new PlanningError(
          'approval_already_decided',
          'this execution already has a final approval decision',
          { approval: prior[0] ?? null },
        );
      }

      const instance = runtime.simulation.instanceStore.get(record.workflowInstanceId);
      if (
        current.status !== 'awaiting_approval' ||
        instance === null ||
        instance.approval === null ||
        instance.approval.status !== 'open'
      ) {
        throw new PlanningError(
          'approval_not_open',
          'this execution has no open approval request',
        );
      }
      if (
        parsed.data.approvalKey !== undefined &&
        parsed.data.approvalKey !== instance.approval.approvalKey
      ) {
        throw new PlanningError(
          'approval_stale',
          'the approval request changed; reload before deciding',
        );
      }

      const action: ApprovalAction = parsed.data.action;
      const reason = parsed.data.reason?.trim() ?? '';
      if (action !== 'approve' && reason === '') {
        throw new PlanningError(
          'invalid_input',
          'reject and request_changes require a written reason',
        );
      }

      const planRecord = deps.store.getPlan(runtime.companyId, record.planId);
      const plan =
        planRecord?.versions.find((entry) => entry.version === record.planVersion) ?? null;
      if (plan === null) {
        throw new PlanningError('not_found', 'the execution plan version no longer exists');
      }
      const taskViews = new Map(current.tasks.map((task) => [task.planNodeId, task]));
      const incomplete: string[] = [];
      for (const node of plan.nodes.filter((entry) => entry.kind === 'task')) {
        const task = taskViews.get(node.nodeId);
        if (
          task === undefined ||
          task.status !== 'completed' ||
          task.result === null ||
          task.result.artifacts.length === 0
        ) {
          incomplete.push(node.title);
        }
      }
      if (incomplete.length > 0) {
        throw new PlanningError(
          'execution_incomplete',
          'every task must be completed with a real artifact before approval',
          { incomplete },
        );
      }

      const before = {
        executionStatus: current.status,
        approvalStatus: instance.approval.status,
        workflowStatus: instance.status,
      };
      const actor = humanActor(
        runtime,
        `m3.6-${executionId}-${instance.approval.approvalKey}`,
      );
      const decided = runtime.simulation.workflow.approve({
        instanceId: record.workflowInstanceId,
        actor,
        decision: action === 'approve' ? 'granted' : 'denied',
        simTime: runtime.simTime as never,
        reason:
          reason === ''
            ? action === 'approve'
              ? '交付物通过人类审核'
              : '人类审核未通过'
            : reason,
        humanApproval: true,
      });
      if (!decided.ok) {
        throw new PlanningError(
          'approval_refused',
          'the workflow engine refused the approval decision',
          { issues: decided.error.issues, code: decided.error.code },
        );
      }
      await runtime.simulation.inject(decided.value.events);

      const after = executionViewOf(record);
      const afterInstance = runtime.simulation.instanceStore.get(record.workflowInstanceId);
      const decision = ExecutionApprovalRecordSchema.parse({
        approvalId: deps.store.nextApprovalId(runtime.companyId),
        companyId: runtime.companyId,
        executionId,
        planId: record.planId,
        planVersion: record.planVersion,
        workflowInstanceId: record.workflowInstanceId,
        approvalKey: instance.approval.approvalKey,
        approvalStepId: instance.approval.stepId,
        action,
        reason: reason === '' ? null : reason,
        decidedBy: deps.operatorId(),
        decidedAt: now(),
        taskIds: current.tasks.map((task) => task.taskId),
        artifacts: [...current.summary.artifacts],
        before,
        after: {
          executionStatus: after.status,
          approvalStatus: afterInstance?.approval?.status ?? 'closed',
          workflowStatus: afterInstance?.status ?? 'unknown',
        },
      });
      deps.store.saveApproval(decision);
      return { decision, execution: after, idempotent: false };
    },

    async createPromotion(input) {
      const parsed = CreatePromotionInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new PlanningError(
          'invalid_input',
          parsed.error.issues.map((issue) => issue.message).join('; '),
        );
      }
      const runtime = deps.runtime();
      const approval = deps.store
        .listApprovals(runtime.companyId)
        .find(
          (record) =>
            record.executionId === parsed.data.executionId && record.action === 'approve',
        );
      if (approval === undefined) {
        throw new PlanningError(
          'promotion_invalid',
          'a promotion can only be created from an approved execution',
        );
      }
      const executionRecord = executionRecordFor(parsed.data.executionId);
      const execution = executionViewOf(executionRecord);
      if (execution.status !== 'completed' && approval.after.executionStatus !== 'completed') {
        throw new PlanningError(
          'promotion_invalid',
          'the approved execution is not completed',
        );
      }
      const existing = deps.store
        .listPromotions(runtime.companyId)
        .find((record) => {
          const current =
            record.versions.find((entry) => entry.version === record.currentVersion) ??
            record.versions[record.versions.length - 1];
          return current?.executionId === executionRecord.executionId;
        });
      if (existing !== undefined) {
        return currentPromotion(runtime.companyId, existing.promotionId).version;
      }
      const planRecord = deps.store.getPlan(runtime.companyId, executionRecord.planId);
      const plan =
        planRecord?.versions.find((entry) => entry.version === executionRecord.planVersion) ?? null;
      if (plan === null) {
        throw new PlanningError('not_found', 'the approved execution plan no longer exists');
      }
      const requirementRecord = deps.store.getRequirement(
        runtime.companyId,
        plan.requirementId,
      );
      const requirement =
        requirementRecord?.versions.find((entry) => entry.version === plan.requirementVersion) ?? null;
      const strategyInput: PromotionStrategyInput = {
        title: plan.title,
        goal: plan.goal,
        audience: requirement?.audience ?? [],
        deliverables: plan.summary.deliverables,
        acceptance: plan.nodes.flatMap((node) => [...node.acceptance]).slice(0, 40),
        artifacts: [...approval.artifacts],
        taskSummaries: execution.tasks.flatMap((task) =>
          task.result === null ? [] : [task.result.summary],
        ),
      };
      let strategy;
      try {
        strategy = await generatePromotionStrategy(
          {
            gateway: deps.analyzer.gateway,
            provenance: deps.analyzer.provenance,
            provider: deps.analyzer.provider,
            model: deps.analyzer.model,
            actorContext: deps.analyzer.actorContext,
          },
          strategyInput,
        );
      } catch (error) {
        if (error instanceof PromotionStrategyError) {
          throw new PlanningError(
            error.code === 'provider_failed' ? 'provider_failed' : 'promotion_generation_failed',
            error.message,
          );
        }
        throw error;
      }
      const materials = promotionMaterials(strategy.strategy, approval.artifacts);
      const risks = [...strategy.strategy.risks];
      if (!risks.some((risk) => risk.includes('未验证') || risk.includes('unverified'))) {
        risks.push('市场数据、用户反馈和推广效果未验证，确认前需人工补充或确认。');
      }
      const contributors = promotionContributors(runtime.organization);
      const provenanceMode = strategy.mode === 'live' ? 'live' : 'mock';
      const timestamp = now();
      const promotionId = deps.store.nextPromotionId(runtime.companyId);
      const planValue: PromotionPlan = PromotionPlanSchema.parse({
        promotionId,
        companyId: runtime.companyId,
        version: 1,
        status: 'draft',
        executionId: executionRecord.executionId,
        planId: executionRecord.planId,
        planVersion: executionRecord.planVersion,
        approvalId: approval.approvalId,
        approvedAt: approval.decidedAt,
        approvedBy: approval.decidedBy,
        sourceTitle: plan.title,
        title: plan.title,
        goal: strategy.strategy.goal,
        valueProposition: strategy.strategy.valueProposition,
        audience: strategy.strategy.audience,
        audienceNeeds: strategy.strategy.audienceNeeds,
        coreMessages: strategy.strategy.coreMessages,
        channels: strategy.strategy.channels.map((channel, index) => ({
          channelId: `channel-${String(index + 1)}`,
          name: channel.name,
          reason: channel.reason,
          contentType: channel.contentType,
        })),
        materials,
        schedule: strategy.strategy.schedule,
        metrics: strategy.strategy.metrics,
        risks,
        contributors,
        provenance: {
          mode: provenanceMode,
          provider: strategy.provider,
          model: strategy.model,
          approvedArtifacts: [...approval.artifacts],
          aiFields: [
            'goal',
            'valueProposition',
            'audience',
            'audienceNeeds',
            'coreMessages',
            'channels',
            'schedule',
            'metrics',
            'risks',
            'materials',
          ],
          humanEdits: [],
        },
        summary: {
          materialCount: materials.length,
          channelCount: strategy.strategy.channels.length,
          artifactCount: approval.artifacts.length,
        },
        summaryText: promotionSummaryText({
          title: plan.title,
          goal: strategy.strategy.goal,
          audience: strategy.strategy.audience,
          channels: strategy.strategy.channels,
          materials,
        }),
        createdAt: timestamp,
        updatedAt: timestamp,
        confirmedAt: null,
        confirmedBy: null,
        confirmationNote: null,
      });
      deps.store.savePromotion({
        promotionId,
        companyId: runtime.companyId,
        currentVersion: 1,
        versions: [planValue],
      });
      return planValue;
    },

    async listPromotions() {
      const { companyId } = deps.runtime();
      return deps.store.listPromotions(companyId).flatMap((record) => {
        const current =
          record.versions.find((entry) => entry.version === record.currentVersion) ??
          record.versions[record.versions.length - 1];
        return current === undefined ? [] : [promotionSummaryOf(current)];
      });
    },

    async getPromotion(promotionId) {
      const { companyId } = deps.runtime();
      return deps.store.getPromotion(companyId, promotionId);
    },

    async updatePromotion(promotionId, input) {
      const parsed = UpdatePromotionInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new PlanningError(
          'invalid_input',
          parsed.error.issues.map((issue) => issue.message).join('; '),
        );
      }
      const runtime = deps.runtime();
      const { record, version } = currentPromotion(runtime.companyId, promotionId);
      if (parsed.data.baseVersion !== version.version) {
        throw new PlanningError(
          'version_conflict',
          `promotion "${promotionId}" is at v${String(version.version)}, not v${String(parsed.data.baseVersion)}`,
        );
      }
      const patch = parsed.data.patch;
      const humanEdits = new Set(version.provenance.humanEdits);
      for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
        if (JSON.stringify(patch[key]) !== JSON.stringify(version[key])) humanEdits.add(key);
      }
      const materials =
        patch.materials === undefined
          ? version.materials
          : patch.materials.map((material) => {
              const previous = version.materials.find(
                (entry) => entry.materialId === material.materialId,
              );
              const changed =
                previous === undefined ||
                previous.title !== material.title ||
                previous.body !== material.body ||
                previous.type !== material.type ||
                previous.platform !== material.platform;
              return {
                ...material,
                source: changed ? ('human' as const) : previous.source,
              };
            });
      const channels =
        patch.channels === undefined ? version.channels : patch.channels;
      const next: PromotionPlan = PromotionPlanSchema.parse({
        ...version,
        version: version.version + 1,
        status: 'draft',
        title: patch.title?.trim() ?? version.title,
        goal: patch.goal?.trim() ?? version.goal,
        valueProposition: patch.valueProposition?.trim() ?? version.valueProposition,
        audience: patch.audience === undefined ? version.audience : cleanList(patch.audience, 20),
        audienceNeeds:
          patch.audienceNeeds === undefined ? version.audienceNeeds : cleanList(patch.audienceNeeds, 20),
        coreMessages:
          patch.coreMessages === undefined ? version.coreMessages : cleanList(patch.coreMessages, 20),
        channels,
        materials,
        schedule: patch.schedule === undefined ? version.schedule : cleanList(patch.schedule, 20),
        metrics: patch.metrics === undefined ? version.metrics : cleanList(patch.metrics, 20),
        risks: patch.risks === undefined ? version.risks : cleanList(patch.risks, 30),
        provenance: { ...version.provenance, humanEdits: [...humanEdits] },
        summary: {
          materialCount: materials.length,
          channelCount: channels.length,
          artifactCount: version.provenance.approvedArtifacts.length,
        },
        summaryText: promotionSummaryText({
          title: patch.title?.trim() ?? version.title,
          goal: patch.goal?.trim() ?? version.goal,
          audience: patch.audience === undefined ? version.audience : cleanList(patch.audience, 20),
          channels,
          materials,
        }),
        updatedAt: now(),
        confirmedAt: null,
        confirmedBy: null,
        confirmationNote: null,
      });
      deps.store.savePromotion({
        ...record,
        currentVersion: next.version,
        versions: [...record.versions, next],
      });
      return next;
    },

    async confirmPromotion(promotionId, input) {
      const parsed = ConfirmPromotionInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new PlanningError(
          'invalid_input',
          parsed.error.issues.map((issue) => issue.message).join('; '),
        );
      }
      const runtime = deps.runtime();
      const { record, version } = currentPromotion(runtime.companyId, promotionId);
      if (parsed.data.baseVersion !== version.version) {
        throw new PlanningError(
          'version_conflict',
          `promotion "${promotionId}" is at v${String(version.version)}, not v${String(parsed.data.baseVersion)}`,
        );
      }
      if (version.status === 'confirmed') {
        throw new PlanningError(
          'version_conflict',
          'this promotion version is already confirmed; edit it to create a new draft',
        );
      }
      const approval = deps.store
        .listApprovals(runtime.companyId)
        .find((entry) => entry.approvalId === version.approvalId);
      const issues: string[] = [];
      if (approval === undefined || approval.action !== 'approve') {
        issues.push('the source approval is no longer approved');
      }
      if (version.title.trim() === '') issues.push('title is required');
      if (version.goal.trim() === '') issues.push('promotion goal is required');
      if (version.valueProposition.trim() === '') issues.push('value proposition is required');
      if (version.audience.length === 0) issues.push('at least one audience is required');
      if (version.coreMessages.length === 0) issues.push('at least one core message is required');
      if (version.channels.length === 0) issues.push('at least one channel is required');
      if (version.materials.length === 0) issues.push('at least one material is required');
      for (const material of version.materials) {
        if (material.body.trim() === '') issues.push(`material "${material.title}" has no content`);
      }
      if (issues.length > 0) {
        throw new PlanningError('promotion_invalid', 'promotion is not ready to confirm', {
          issues,
        });
      }
      const confirmed: PromotionPlan = PromotionPlanSchema.parse({
        ...version,
        version: version.version + 1,
        status: 'confirmed',
        confirmedAt: now(),
        confirmedBy: deps.operatorId(),
        confirmationNote: parsed.data.note?.trim() || null,
        updatedAt: now(),
      });
      deps.store.savePromotion({
        ...record,
        currentVersion: confirmed.version,
        versions: [...record.versions, confirmed],
      });
      return confirmed;
    },

    async getConfirmedPromotion(promotionId) {
      const { companyId } = deps.runtime();
      const record = deps.store.getPromotion(companyId, promotionId);
      if (record === null) return null;
      return (
        record.versions
          .filter((entry) => entry.status === 'confirmed')
          .sort((left, right) => right.version - left.version)[0] ?? null
      );
    },

    async createPublication(input) {
      const parsed = CreatePublicationInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new PlanningError('invalid_input', parsed.error.issues.map((issue) => issue.message).join('; '));
      }
      const runtime = deps.runtime();
      const promotionRecord = deps.store.getPromotion(runtime.companyId, parsed.data.promotionId);
      const promotion =
        promotionRecord?.versions
          .filter((entry) => entry.status === 'confirmed')
          .sort((left, right) => right.version - left.version)[0] ?? null;
      if (promotion === null) {
        throw new PlanningError('publication_invalid', 'only a confirmed promotion can be published');
      }
      const existing = deps.store
        .listPublications(runtime.companyId)
        .find((entry) => entry.promotionId === promotion.promotionId);
      if (existing !== undefined) return existing;
      const approval =
        deps.store
          .listApprovals(runtime.companyId)
          .find((entry) => entry.approvalId === promotion.approvalId && entry.action === 'approve') ?? null;
      if (approval === null) {
        throw new PlanningError('publication_invalid', 'the promotion source approval is not approved');
      }
      const planRecord = deps.store.getPlan(runtime.companyId, promotion.planId);
      const plan =
        planRecord?.versions.find((entry) => entry.version === promotion.planVersion) ?? null;
      if (plan === null) throw new PlanningError('not_found', 'the promotion source plan no longer exists');
      const content = publicationContentOf(promotion);
      const checks = publicationChecks(promotion, approval, content);
      const timestamp = now();
      const version: PublicationVersion = {
        version: 1,
        status: 'draft',
        content,
        checks,
        createdAt: timestamp,
        updatedAt: timestamp,
        confirmedAt: null,
        confirmedBy: null,
        attempts: [],
        publishedAt: null,
        publishedBy: null,
        publicPath: null,
      };
      const record = PublicationRecordSchema.parse({
        publicationId: deps.store.nextPublicationId(runtime.companyId),
        companyId: runtime.companyId,
        promotionId: promotion.promotionId,
        promotionVersion: promotion.version,
        executionId: promotion.executionId,
        planId: promotion.planId,
        planVersion: promotion.planVersion,
        approvalId: promotion.approvalId,
        requirementId: plan.requirementId,
        requirementVersion: plan.requirementVersion,
        approvedBy: promotion.approvedBy,
        approvedAt: promotion.approvedAt,
        promotionConfirmedBy: promotion.confirmedBy ?? '—',
        promotionConfirmedAt: promotion.confirmedAt ?? promotion.updatedAt,
        sourceArtifacts: [...approval.artifacts],
        taskIds: [...approval.taskIds],
        currentVersion: 1,
        versions: [version],
      });
      deps.store.savePublication(record);
      await emitPublication(record, version, PUBLICATION_DRAFTED);
      return record;
    },

    async listPublications() {
      const { companyId } = deps.runtime();
      return deps.store.listPublications(companyId).map(publicationSummaryOf);
    },

    async getPublication(publicationId) {
      const { companyId } = deps.runtime();
      return deps.store.getPublication(companyId, publicationId);
    },

    async getPublicationPreflight(publicationId) {
      const { companyId } = deps.runtime();
      const { record, version } = currentPublication(companyId, publicationId);
      const promotion = deps.store.getPromotion(companyId, record.promotionId);
      const promotionVersion = promotion?.versions.find(
        (entry) => entry.version === record.promotionVersion,
      ) ?? null;
      const approval =
        deps.store
          .listApprovals(companyId)
          .find((entry) => entry.approvalId === record.approvalId) ?? null;
      if (promotionVersion === null) {
        return [
          {
            checkId: 'source-confirmed',
            label: 'M3.7 推广方案已确认',
            ok: false,
            detail: 'the source promotion version no longer exists',
          },
        ];
      }
      return publicationChecks(promotionVersion, approval, version.content);
    },

    async updatePublication(publicationId, input) {
      const parsed = UpdatePublicationInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new PlanningError('invalid_input', parsed.error.issues.map((issue) => issue.message).join('; '));
      }
      const runtime = deps.runtime();
      const { record, version } = currentPublication(runtime.companyId, publicationId);
      if (parsed.data.baseVersion !== version.version) {
        throw new PlanningError('version_conflict', `publication "${publicationId}" is at v${String(version.version)}`);
      }
      const content: PublicationContent = {
        title: parsed.data.patch.title?.trim() ?? version.content.title,
        body: parsed.data.patch.body ?? version.content.body,
        channels: parsed.data.patch.channels ?? version.content.channels,
        attachments:
          parsed.data.patch.attachments === undefined
            ? version.content.attachments
            : cleanList(parsed.data.patch.attachments, 40),
      };
      const promotion = deps.store.getPromotion(runtime.companyId, record.promotionId);
      const promotionVersion = promotion?.versions.find(
        (entry) => entry.version === record.promotionVersion,
      ) ?? null;
      const approval =
        deps.store
          .listApprovals(runtime.companyId)
          .find((entry) => entry.approvalId === record.approvalId) ?? null;
      const checks =
        promotionVersion === null
          ? [{ checkId: 'source-confirmed', label: 'M3.7 推广方案已确认', ok: false, detail: 'source promotion missing' }]
          : publicationChecks(promotionVersion, approval, content);
      const timestamp = now();
      const next: PublicationVersion = {
        version: version.version + 1,
        status: 'draft',
        content,
        checks,
        createdAt: timestamp,
        updatedAt: timestamp,
        confirmedAt: null,
        confirmedBy: null,
        attempts: [],
        publishedAt: null,
        publishedBy: null,
        publicPath: null,
      };
      const updated = PublicationRecordSchema.parse({
        ...record,
        currentVersion: next.version,
        versions: [...record.versions, next],
      });
      deps.store.savePublication(updated);
      await emitPublication(updated, next, PUBLICATION_DRAFTED);
      return updated;
    },

    async confirmPublication(publicationId, input) {
      const parsed = ConfirmPublicationInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new PlanningError('invalid_input', parsed.error.issues.map((issue) => issue.message).join('; '));
      }
      if (parsed.data.confirm !== true) {
        throw new PlanningError('publication_invalid', 'explicit human confirmation (confirm: true) is required');
      }
      const runtime = deps.runtime();
      const { record, version } = currentPublication(runtime.companyId, publicationId);
      if (parsed.data.baseVersion !== version.version) {
        throw new PlanningError('version_conflict', `publication "${publicationId}" is at v${String(version.version)}`);
      }
      if (version.status !== 'draft') {
        throw new PlanningError('publication_invalid', 'only a draft publication can be confirmed');
      }
      const failed = version.checks.filter((check) => !check.ok);
      if (failed.length > 0) {
        throw new PlanningError('publication_invalid', 'publication checks failed', {
          issues: failed.map((check) => `${check.checkId}: ${check.detail}`),
        });
      }
      const timestamp = now();
      const confirmed: PublicationVersion = {
        ...version,
        status: 'ready',
        confirmedAt: timestamp,
        confirmedBy: deps.operatorId(),
        updatedAt: timestamp,
      };
      const updated: PublicationRecord = {
        ...record,
        currentVersion: confirmed.version,
        versions: [...record.versions.filter((entry) => entry.version !== confirmed.version), confirmed],
      };
      deps.store.savePublication(updated);
      await emitPublication(updated, confirmed, PUBLICATION_CONFIRMED);
      return updated;
    },

    async publishPublication(publicationId, input) {
      const parsed = PublishPublicationInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new PlanningError('invalid_input', parsed.error.issues.map((issue) => issue.message).join('; '));
      }
      if (parsed.data.confirm !== true) {
        throw new PlanningError('publication_invalid', 'explicit human confirmation (confirm: true) is required');
      }
      const runtime = deps.runtime();
      const { record, version } = currentPublication(runtime.companyId, publicationId);
      if (parsed.data.baseVersion !== version.version) {
        throw new PlanningError('version_conflict', `publication "${publicationId}" is at v${String(version.version)}`);
      }
      if (version.status === 'published') {
        return { record, idempotent: true };
      }
      if (publicationInFlight.has(publicationId)) {
        throw new PlanningError('publication_busy', 'this publication is already being executed');
      }
      if (version.status === 'draft' || version.status === 'cancelled') {
        throw new PlanningError('publication_not_ready', 'publication must be confirmed before publishing');
      }
      publicationInFlight.add(publicationId);
      const timestamp = now();
      const publishing: PublicationVersion = { ...version, status: 'publishing', updatedAt: timestamp };
      let currentRecord: PublicationRecord = {
        ...record,
        versions: [...record.versions.filter((entry) => entry.version !== publishing.version), publishing],
      };
      deps.store.savePublication(currentRecord);
      try {
        const written = writePublicationFiles(currentRecord, publishing);
        const success = written.results.filter((result) => result.status === 'published').length;
        const status: PublicationStatus =
          success === written.results.length
            ? 'published'
            : success > 0
              ? 'partial'
              : 'failed';
        const attempt = {
          attempt: publishing.attempts.length + 1,
          requestedAt: timestamp,
          requestedBy: deps.operatorId(),
          results: [...written.results],
        };
        const finishedAt = now();
        const finished: PublicationVersion = {
          ...publishing,
          status,
          attempts: [...publishing.attempts, attempt],
          updatedAt: finishedAt,
          publishedAt: publishing.publishedAt ?? (success > 0 ? finishedAt : null),
          publishedBy: publishing.publishedBy ?? (success > 0 ? deps.operatorId() : null),
          publicPath:
            written.results.some((result) => result.channel === 'local_page' && result.status === 'published')
              ? written.publicPath
              : publishing.publicPath,
        };
        currentRecord = {
          ...currentRecord,
          currentVersion: finished.version,
          versions: [
            ...currentRecord.versions.filter((entry) => entry.version !== finished.version),
            finished,
          ],
        };
        deps.store.savePublication(currentRecord);
        await emitPublication(
          currentRecord,
          finished,
          status === 'published'
            ? PUBLICATION_PUBLISHED
            : status === 'partial'
              ? PUBLICATION_PARTIALLY_PUBLISHED
              : PUBLICATION_FAILED,
        );
        return { record: currentRecord, idempotent: false };
      } catch (error) {
        const failedAt = now();
        const failure = error instanceof Error ? error.message : 'publication execution failed';
        const failedVersion: PublicationVersion = {
          ...publishing,
          status: 'failed',
          updatedAt: failedAt,
          attempts: [
            ...publishing.attempts,
            {
              attempt: publishing.attempts.length + 1,
              requestedAt: timestamp,
              requestedBy: deps.operatorId(),
              results: publishing.content.channels.map((channel) => ({
                channel,
                status: 'failed' as const,
                resourceId: null,
                url: null,
                error: failure,
                verifiedAt: failedAt,
              })),
            },
          ],
        };
        currentRecord = {
          ...currentRecord,
          versions: [
            ...currentRecord.versions.filter((entry) => entry.version !== failedVersion.version),
            failedVersion,
          ],
        };
        deps.store.savePublication(currentRecord);
        await emitPublication(currentRecord, failedVersion, PUBLICATION_FAILED);
        return { record: currentRecord, idempotent: false };
      } finally {
        publicationInFlight.delete(publicationId);
      }
    },

    async getPublicationPage(publicationId) {
      const { companyId } = deps.runtime();
      const record = deps.store.getPublication(companyId, publicationId);
      if (record === null) return null;
      const version = [...record.versions]
        .reverse()
        .find(
          (entry) =>
            (entry.status === 'published' || entry.status === 'partial') &&
            entry.publicPath !== null,
        );
      if (version === undefined || version.publicPath === null) return null;
      try {
        const file = join(
          publicationRoot(),
          'publications',
          record.publicationId,
          `v${String(version.version)}`,
          'index.html',
        );
        return { html: readFileSync(file, 'utf8'), version: version.version };
      } catch {
        return null;
      }
    },
  };
}

export function capabilityName(capability: string): string {
  return capabilityLabel(capability);
}

export { RequirementAnalysisError };
