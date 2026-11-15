import { readNumber, readString, type Row } from './api';

/**
 * M3.7 promotion read model. A promotion plan is prepared from an approved execution and is
 * versioned; confirmed means "ready for M3.8", never "published".
 */

export interface PromotionChannelView {
  readonly channelId: string;
  readonly name: string;
  readonly reason: string;
  readonly contentType: string;
}
export interface PromotionMaterialView {
  readonly materialId: string;
  readonly type: string;
  readonly platform: string;
  readonly title: string;
  readonly body: string;
  readonly source: 'ai' | 'human';
  readonly sourceArtifact: string | null;
}
export interface PromotionContributorView {
  readonly employeeId: string;
  readonly name: string;
  readonly role: string;
  readonly capability: string;
}
export interface PromotionPlanView {
  readonly promotionId: string;
  readonly version: number;
  readonly status: 'draft' | 'confirmed';
  readonly executionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly approvalId: string;
  readonly approvedAt: string;
  readonly approvedBy: string;
  readonly sourceTitle: string;
  readonly title: string;
  readonly goal: string;
  readonly valueProposition: string;
  readonly audience: readonly string[];
  readonly audienceNeeds: readonly string[];
  readonly coreMessages: readonly string[];
  readonly channels: readonly PromotionChannelView[];
  readonly materials: readonly PromotionMaterialView[];
  readonly schedule: readonly string[];
  readonly metrics: readonly string[];
  readonly risks: readonly string[];
  readonly contributors: readonly PromotionContributorView[];
  readonly provenance: {
    readonly mode: string;
    readonly provider: string | null;
    readonly model: string | null;
    readonly approvedArtifacts: readonly string[];
    readonly aiFields: readonly string[];
    readonly humanEdits: readonly string[];
  };
  readonly summary: {
    readonly materialCount: number;
    readonly channelCount: number;
    readonly artifactCount: number;
  };
  readonly summaryText: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAt: string | null;
  readonly confirmedBy: string | null;
  readonly confirmationNote: string | null;
}
export interface PromotionSummaryView {
  readonly promotionId: string;
  readonly executionId: string;
  readonly title: string;
  readonly status: 'draft' | 'confirmed';
  readonly version: number;
  readonly materialCount: number;
  readonly channelCount: number;
  readonly updatedAt: string;
  readonly confirmedAt: string | null;
}
export interface PromotionRecordView {
  readonly promotionId: string;
  readonly currentVersion: number;
  readonly versions: readonly PromotionPlanView[];
}

function objectOf(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as readonly unknown[]).map((entry) => readString(entry, '')).filter((entry) => entry !== '')
    : [];
}
function channelOf(value: unknown): PromotionChannelView {
  const row = objectOf(value);
  return {
    channelId: readString(row['channelId'], ''),
    name: readString(row['name'], ''),
    reason: readString(row['reason'], ''),
    contentType: readString(row['contentType'], ''),
  };
}
function materialOf(value: unknown): PromotionMaterialView {
  const row = objectOf(value);
  return {
    materialId: readString(row['materialId'], ''),
    type: readString(row['type'], ''),
    platform: readString(row['platform'], ''),
    title: readString(row['title'], ''),
    body: readString(row['body'], ''),
    source: readString(row['source'], 'ai') === 'human' ? 'human' : 'ai',
    sourceArtifact:
      typeof row['sourceArtifact'] === 'string' && row['sourceArtifact'] !== ''
        ? row['sourceArtifact']
        : null,
  };
}

export function parsePromotion(value: unknown): PromotionPlanView | null {
  const row = objectOf(value);
  const promotionId = readString(row['promotionId'], '');
  if (promotionId === '') return null;
  const provenance = objectOf(row['provenance']);
  const summary = objectOf(row['summary']);
  return {
    promotionId,
    version: readNumber(row['version'], 1),
    status: readString(row['status'], 'draft') === 'confirmed' ? 'confirmed' : 'draft',
    executionId: readString(row['executionId'], ''),
    planId: readString(row['planId'], ''),
    planVersion: readNumber(row['planVersion'], 1),
    approvalId: readString(row['approvalId'], ''),
    approvedAt: readString(row['approvedAt'], ''),
    approvedBy: readString(row['approvedBy'], ''),
    sourceTitle: readString(row['sourceTitle'], ''),
    title: readString(row['title'], ''),
    goal: readString(row['goal'], ''),
    valueProposition: readString(row['valueProposition'], ''),
    audience: strings(row['audience']),
    audienceNeeds: strings(row['audienceNeeds']),
    coreMessages: strings(row['coreMessages']),
    channels: Array.isArray(row['channels']) ? (row['channels'] as readonly unknown[]).map(channelOf) : [],
    materials: Array.isArray(row['materials']) ? (row['materials'] as readonly unknown[]).map(materialOf) : [],
    schedule: strings(row['schedule']),
    metrics: strings(row['metrics']),
    risks: strings(row['risks']),
    contributors: Array.isArray(row['contributors'])
      ? (row['contributors'] as readonly unknown[]).map((entry) => {
          const item = objectOf(entry);
          return {
            employeeId: readString(item['employeeId'], ''),
            name: readString(item['name'], ''),
            role: readString(item['role'], ''),
            capability: readString(item['capability'], ''),
          };
        })
      : [],
    provenance: {
      mode: readString(provenance['mode'], 'unknown'),
      provider:
        typeof provenance['provider'] === 'string' ? provenance['provider'] : null,
      model: typeof provenance['model'] === 'string' ? provenance['model'] : null,
      approvedArtifacts: strings(provenance['approvedArtifacts']),
      aiFields: strings(provenance['aiFields']),
      humanEdits: strings(provenance['humanEdits']),
    },
    summary: {
      materialCount: readNumber(summary['materialCount'], 0),
      channelCount: readNumber(summary['channelCount'], 0),
      artifactCount: readNumber(summary['artifactCount'], 0),
    },
    summaryText: readString(row['summaryText'], ''),
    createdAt: readString(row['createdAt'], ''),
    updatedAt: readString(row['updatedAt'], ''),
    confirmedAt:
      typeof row['confirmedAt'] === 'string' && row['confirmedAt'] !== '' ? row['confirmedAt'] : null,
    confirmedBy:
      typeof row['confirmedBy'] === 'string' && row['confirmedBy'] !== '' ? row['confirmedBy'] : null,
    confirmationNote:
      typeof row['confirmationNote'] === 'string' && row['confirmationNote'] !== ''
        ? row['confirmationNote']
        : null,
  };
}

export function parsePromotionRecord(value: unknown): PromotionRecordView | null {
  const row = objectOf(value);
  const promotionId = readString(row['promotionId'], '');
  if (promotionId === '') return null;
  const versions = Array.isArray(row['versions'])
    ? (row['versions'] as readonly unknown[])
        .map(parsePromotion)
        .filter((entry): entry is PromotionPlanView => entry !== null)
    : [];
  return { promotionId, currentVersion: readNumber(row['currentVersion'], 1), versions };
}

export function parsePromotions(value: unknown): readonly PromotionSummaryView[] {
  const row = objectOf(value);
  const list = Array.isArray(row['promotions']) ? row['promotions'] : [];
  return (list as readonly unknown[]).flatMap((entry) => {
    const item = objectOf(entry);
    const promotionId = readString(item['promotionId'], '');
    if (promotionId === '') return [];
    return [{
      promotionId,
      executionId: readString(item['executionId'], ''),
      title: readString(item['title'], ''),
      status: readString(item['status'], 'draft') === 'confirmed' ? 'confirmed' as const : 'draft' as const,
      version: readNumber(item['version'], 1),
      materialCount: readNumber(item['materialCount'], 0),
      channelCount: readNumber(item['channelCount'], 0),
      updatedAt: readString(item['updatedAt'], ''),
      confirmedAt: typeof item['confirmedAt'] === 'string' ? item['confirmedAt'] : null,
    }];
  });
}
