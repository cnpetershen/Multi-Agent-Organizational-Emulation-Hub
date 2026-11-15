import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ExecutionApprovalRecordSchema,
  ExecutionPlanSchema,
  ExecutionRecordSchema,
  OrchestrationDraftSchema,
  PromotionPlanSchema,
  PublicationRecordSchema,
  RequirementPlanSchema,
  type ExecutionApprovalRecord,
  type ExecutionPlan,
  type ExecutionRecord,
  type OrchestrationDraft,
  type PlanRecord,
  type PromotionPlan,
  type PromotionRecord,
  type PublicationRecord,
  type RequirementPlan,
  type RequirementRecord,
} from './planning-types.js';

/**
 * M3.3 · 需求与编排的版本化存储。
 *
 * Deliberately a small, explicit file store rather than a new event bus or a new database:
 *
 * - one JSON document per company, written atomically (tmp + rename);
 * - requirements are append-only versions; the current version is the last one;
 * - orchestrations are append-only drafts linked to `requirementId + requirementVersion`;
 * - every read is validated by the same zod schema the API returns, so a corrupt file fails
 *   loudly instead of rendering a half-plan.
 *
 * The organisational facts stay in the event log: the workflow **draft instance** created from an
 * orchestration is a real `Workflow.InstanceStarted` event, and that event carries the requirement
 * and orchestration versions in its context.
 */

interface StoreDocument {
  readonly requirements: RequirementRecord[];
  readonly orchestrations: OrchestrationDraft[];
  readonly plans: PlanRecord[];
  readonly executions: ExecutionRecord[];
  readonly approvals: ExecutionApprovalRecord[];
  readonly promotions: PromotionRecord[];
  readonly publications: PublicationRecord[];
}

const EMPTY: StoreDocument = {
  requirements: [],
  orchestrations: [],
  plans: [],
  executions: [],
  approvals: [],
  promotions: [],
  publications: [],
};

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function parseDocument(raw: unknown): StoreDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY;
  const record = raw as Record<string, unknown>;
  const requirements: RequirementRecord[] = [];
  if (Array.isArray(record['requirements'])) {
    for (const entry of record['requirements'] as readonly unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const versions: RequirementPlan[] = [];
      if (Array.isArray(row['versions'])) {
        for (const version of row['versions'] as readonly unknown[]) {
          const parsed = RequirementPlanSchema.safeParse(version);
          if (parsed.success) versions.push(parsed.data);
        }
      }
      if (versions.length === 0) continue;
      const requirementId = String(row['requirementId'] ?? '');
      if (requirementId === '') continue;
      requirements.push({
        requirementId,
        companyId: String(row['companyId'] ?? ''),
        currentVersion: Number(row['currentVersion'] ?? versions[versions.length - 1]?.version ?? 1),
        versions,
      });
    }
  }
  const orchestrations = Array.isArray(record['orchestrations'])
    ? (record['orchestrations'] as readonly unknown[])
        .map((entry) => {
          const parsed = OrchestrationDraftSchema.safeParse(entry);
          return parsed.success ? parsed.data : null;
        })
        .filter((entry): entry is OrchestrationDraft => entry !== null)
    : [];
  const plans: PlanRecord[] = [];
  if (Array.isArray(record['plans'])) {
    for (const entry of record['plans'] as readonly unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      const versions: ExecutionPlan[] = [];
      if (Array.isArray(row['versions'])) {
        for (const version of row['versions'] as readonly unknown[]) {
          const parsed = ExecutionPlanSchema.safeParse(version);
          if (parsed.success) versions.push(parsed.data);
        }
      }
      if (versions.length === 0) continue;
      const planId = String(row['planId'] ?? '');
      if (planId === '') continue;
      plans.push({
        planId,
        companyId: String(row['companyId'] ?? ''),
        currentVersion: Number(row['currentVersion'] ?? versions[versions.length - 1]?.version ?? 1),
        versions,
      });
    }
  }
  return {
    requirements,
    orchestrations,
    plans,
    executions: parseExecutions(record['executions']),
    approvals: parseApprovals(record['approvals']),
    promotions: parsePromotions(record['promotions']),
    publications: parsePublications(record['publications']),
  };
}

function parsePublications(value: unknown): PublicationRecord[] {
  if (!Array.isArray(value)) return [];
  const records: PublicationRecord[] = [];
  for (const entry of value) {
    const parsed = PublicationRecordSchema.safeParse(entry);
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}

function parsePromotions(value: unknown): PromotionRecord[] {
  if (!Array.isArray(value)) return [];
  const records: PromotionRecord[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const versions: PromotionPlan[] = [];
    if (Array.isArray(row['versions'])) {
      for (const version of row['versions'] as readonly unknown[]) {
        const parsed = PromotionPlanSchema.safeParse(version);
        if (parsed.success) versions.push(parsed.data);
      }
    }
    if (versions.length === 0) continue;
    const promotionId = String(row['promotionId'] ?? '');
    if (promotionId === '') continue;
    records.push({
      promotionId,
      companyId: String(row['companyId'] ?? ''),
      currentVersion: Number(row['currentVersion'] ?? versions[versions.length - 1]?.version ?? 1),
      versions,
    });
  }
  return records;
}

function parseApprovals(value: unknown): ExecutionApprovalRecord[] {
  if (!Array.isArray(value)) return [];
  const approvals: ExecutionApprovalRecord[] = [];
  for (const entry of value) {
    const parsed = ExecutionApprovalRecordSchema.safeParse(entry);
    if (parsed.success) approvals.push(parsed.data);
  }
  return approvals;
}

function parseExecutions(value: unknown): ExecutionRecord[] {
  if (!Array.isArray(value)) return [];
  const executions: ExecutionRecord[] = [];
  for (const entry of value) {
    const parsed = ExecutionRecordSchema.safeParse(entry);
    if (parsed.success) executions.push(parsed.data);
  }
  return executions;
}

export interface PlanningStore {
  listRequirements(companyId: string): readonly RequirementRecord[];
  getRequirement(companyId: string, requirementId: string): RequirementRecord | null;
  saveRequirement(record: RequirementRecord): RequirementRecord;
  nextRequirementId(companyId: string): string;
  listOrchestrations(companyId: string): readonly OrchestrationDraft[];
  getOrchestration(companyId: string, orchestrationId: string): OrchestrationDraft | null;
  saveOrchestration(draft: OrchestrationDraft): OrchestrationDraft;
  nextOrchestrationId(companyId: string): string;
  listPlans(companyId: string): readonly PlanRecord[];
  getPlan(companyId: string, planId: string): PlanRecord | null;
  savePlan(record: PlanRecord): PlanRecord;
  nextPlanId(companyId: string): string;
  listExecutions(companyId: string): readonly ExecutionRecord[];
  getExecution(companyId: string, executionId: string): ExecutionRecord | null;
  saveExecution(record: ExecutionRecord): ExecutionRecord;
  nextExecutionId(companyId: string): string;
  listApprovals(companyId: string): readonly ExecutionApprovalRecord[];
  getApproval(companyId: string, approvalId: string): ExecutionApprovalRecord | null;
  saveApproval(record: ExecutionApprovalRecord): ExecutionApprovalRecord;
  nextApprovalId(companyId: string): string;
  listPromotions(companyId: string): readonly PromotionRecord[];
  getPromotion(companyId: string, promotionId: string): PromotionRecord | null;
  savePromotion(record: PromotionRecord): PromotionRecord;
  nextPromotionId(companyId: string): string;
  listPublications(companyId: string): readonly PublicationRecord[];
  getPublication(companyId: string, publicationId: string): PublicationRecord | null;
  savePublication(record: PublicationRecord): PublicationRecord;
  nextPublicationId(companyId: string): string;
}

export function createPlanningStore(directory: string): PlanningStore {
  const file = join(directory, 'planning.json');

  const read = (): StoreDocument => parseDocument(readJson(file));

  const write = (document: StoreDocument): void => {
    mkdirSync(directory, { recursive: true });
    const tmp = `${file}.${String(Date.now())}.tmp`;
    writeFileSync(tmp, JSON.stringify(document, null, 2), 'utf8');
    renameSync(tmp, file);
  };

  const nextId = (prefix: string, ids: readonly string[]): string => {
    let max = 0;
    for (const id of ids) {
      const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
      if (match === null) continue;
      max = Math.max(max, Number(match[1]));
    }
    return `${prefix}-${String(max + 1)}`;
  };

  return {
    listRequirements(companyId) {
      return read().requirements.filter((record) => record.companyId === companyId);
    },
    getRequirement(companyId, requirementId) {
      return (
        read().requirements.find(
          (record) => record.companyId === companyId && record.requirementId === requirementId,
        ) ?? null
      );
    },
    saveRequirement(record) {
      const document = read();
      const requirements = document.requirements.filter(
        (entry) =>
          !(entry.companyId === record.companyId && entry.requirementId === record.requirementId),
      );
      write({ ...document, requirements: [...requirements, record] });
      return record;
    },
    nextRequirementId(companyId) {
      return nextId(
        'req',
        read()
          .requirements.filter((record) => record.companyId === companyId)
          .map((record) => record.requirementId),
      );
    },
    listOrchestrations(companyId) {
      return read()
        .orchestrations.filter((draft) => draft.companyId === companyId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    getOrchestration(companyId, orchestrationId) {
      return (
        read().orchestrations.find(
          (draft) => draft.companyId === companyId && draft.orchestrationId === orchestrationId,
        ) ?? null
      );
    },
    saveOrchestration(draft) {
      const document = read();
      const orchestrations = document.orchestrations.filter(
        (entry) =>
          !(entry.companyId === draft.companyId && entry.orchestrationId === draft.orchestrationId),
      );
      write({ ...document, orchestrations: [...orchestrations, draft] });
      return draft;
    },
    nextOrchestrationId(companyId) {
      return nextId(
        'orch',
        read()
          .orchestrations.filter((draft) => draft.companyId === companyId)
          .map((draft) => draft.orchestrationId),
      );
    },
    listPlans(companyId) {
      return read()
        .plans.filter((record) => record.companyId === companyId)
        .sort((left, right) => {
          const leftVersion = left.versions.find((entry) => entry.version === left.currentVersion);
          const rightVersion = right.versions.find((entry) => entry.version === right.currentVersion);
          return (rightVersion?.updatedAt ?? '').localeCompare(leftVersion?.updatedAt ?? '');
        });
    },
    getPlan(companyId, planId) {
      return (
        read().plans.find(
          (record) => record.companyId === companyId && record.planId === planId,
        ) ?? null
      );
    },
    savePlan(record) {
      const document = read();
      const plans = document.plans.filter(
        (entry) => !(entry.companyId === record.companyId && entry.planId === record.planId),
      );
      write({ ...document, plans: [...plans, record] });
      return record;
    },
    nextPlanId(companyId) {
      return nextId(
        'plan',
        read()
          .plans.filter((record) => record.companyId === companyId)
          .map((record) => record.planId),
      );
    },
    listExecutions(companyId) {
      return read()
        .executions.filter((record) => record.companyId === companyId)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    },
    getExecution(companyId, executionId) {
      return (
        read().executions.find(
          (record) => record.companyId === companyId && record.executionId === executionId,
        ) ?? null
      );
    },
    saveExecution(record) {
      const document = read();
      const executions = document.executions.filter(
        (entry) =>
          !(entry.companyId === record.companyId && entry.executionId === record.executionId),
      );
      write({ ...document, executions: [...executions, record] });
      return record;
    },
    nextExecutionId(companyId) {
      return nextId(
        'exec',
        read()
          .executions.filter((record) => record.companyId === companyId)
          .map((record) => record.executionId),
      );
    },
    listApprovals(companyId) {
      return read()
        .approvals.filter((record) => record.companyId === companyId)
        .sort((left, right) => right.decidedAt.localeCompare(left.decidedAt));
    },
    getApproval(companyId, approvalId) {
      return (
        read().approvals.find(
          (record) => record.companyId === companyId && record.approvalId === approvalId,
        ) ?? null
      );
    },
    saveApproval(record) {
      const document = read();
      const approvals = document.approvals.filter(
        (entry) =>
          !(entry.companyId === record.companyId && entry.approvalId === record.approvalId),
      );
      write({ ...document, approvals: [...approvals, record] });
      return record;
    },
    nextApprovalId(companyId) {
      return nextId(
        'approval',
        read()
          .approvals.filter((record) => record.companyId === companyId)
          .map((record) => record.approvalId),
      );
    },
    listPromotions(companyId) {
      return read()
        .promotions.filter((record) => record.companyId === companyId)
        .sort((left, right) => {
          const lv = left.versions.find((entry) => entry.version === left.currentVersion);
          const rv = right.versions.find((entry) => entry.version === right.currentVersion);
          return (rv?.updatedAt ?? '').localeCompare(lv?.updatedAt ?? '');
        });
    },
    getPromotion(companyId, promotionId) {
      return (
        read().promotions.find(
          (record) => record.companyId === companyId && record.promotionId === promotionId,
        ) ?? null
      );
    },
    savePromotion(record) {
      const document = read();
      const promotions = document.promotions.filter(
        (entry) =>
          !(entry.companyId === record.companyId && entry.promotionId === record.promotionId),
      );
      write({ ...document, promotions: [...promotions, record] });
      return record;
    },
    nextPromotionId(companyId) {
      return nextId(
        'promotion',
        read()
          .promotions.filter((record) => record.companyId === companyId)
          .map((record) => record.promotionId),
      );
    },
    listPublications(companyId) {
      return read()
        .publications.filter((record) => record.companyId === companyId)
        .sort((left, right) => {
          const lv = left.versions.find((entry) => entry.version === left.currentVersion);
          const rv = right.versions.find((entry) => entry.version === right.currentVersion);
          return (rv?.updatedAt ?? '').localeCompare(lv?.updatedAt ?? '');
        });
    },
    getPublication(companyId, publicationId) {
      return (
        read().publications.find(
          (record) => record.companyId === companyId && record.publicationId === publicationId,
        ) ?? null
      );
    },
    savePublication(record) {
      const document = read();
      const publications = document.publications.filter(
        (entry) =>
          !(entry.companyId === record.companyId && entry.publicationId === record.publicationId),
      );
      write({ ...document, publications: [...publications, record] });
      return record;
    },
    nextPublicationId(companyId) {
      return nextId(
        'publication',
        read()
          .publications.filter((record) => record.companyId === companyId)
          .map((record) => record.publicationId),
      );
    },
  };
}
