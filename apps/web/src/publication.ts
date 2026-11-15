import { readNumber, readString, type Row } from './api';

/**
 * M3.8 local publication read model. A publication is a real local artifact written by the API;
 * status is read from the server, never derived from a button state.
 */

export type PublicationStatus =
  | 'draft'
  | 'ready'
  | 'publishing'
  | 'published'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface PublicationCheckView {
  readonly checkId: string;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}
export interface PublicationResultView {
  readonly channel: string;
  readonly status: string;
  readonly resourceId: string | null;
  readonly url: string | null;
  readonly error: string | null;
  readonly verifiedAt: string;
}
export interface PublicationAttemptView {
  readonly attempt: number;
  readonly requestedAt: string;
  readonly requestedBy: string;
  readonly results: readonly PublicationResultView[];
}
export interface PublicationContentView {
  readonly title: string;
  readonly body: string;
  readonly channels: readonly string[];
  readonly attachments: readonly string[];
}
export interface PublicationVersionView {
  readonly version: number;
  readonly status: PublicationStatus;
  readonly content: PublicationContentView;
  readonly checks: readonly PublicationCheckView[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAt: string | null;
  readonly confirmedBy: string | null;
  readonly attempts: readonly PublicationAttemptView[];
  readonly publishedAt: string | null;
  readonly publishedBy: string | null;
  readonly publicPath: string | null;
}
export interface PublicationRecordView {
  readonly publicationId: string;
  readonly promotionId: string;
  readonly promotionVersion: number;
  readonly executionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly approvalId: string;
  readonly requirementId: string;
  readonly requirementVersion: number;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly promotionConfirmedBy: string;
  readonly promotionConfirmedAt: string;
  readonly sourceArtifacts: readonly string[];
  readonly taskIds: readonly string[];
  readonly currentVersion: number;
  readonly versions: readonly PublicationVersionView[];
}
export interface PublicationSummaryView {
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

function objectOf(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {};
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? (value as readonly unknown[]).map((entry) => readString(entry, '')).filter((entry) => entry !== '') : [];
}
function statusOf(value: unknown): PublicationStatus {
  const status = readString(value, 'draft');
  return ['draft', 'ready', 'publishing', 'published', 'partial', 'failed', 'cancelled'].includes(status)
    ? status as PublicationStatus
    : 'draft';
}
function checkOf(value: unknown): PublicationCheckView {
  const row = objectOf(value);
  return {
    checkId: readString(row['checkId'], ''),
    label: readString(row['label'], ''),
    ok: row['ok'] === true,
    detail: readString(row['detail'], ''),
  };
}
function resultOf(value: unknown): PublicationResultView {
  const row = objectOf(value);
  return {
    channel: readString(row['channel'], ''),
    status: readString(row['status'], 'failed'),
    resourceId: typeof row['resourceId'] === 'string' ? row['resourceId'] : null,
    url: typeof row['url'] === 'string' ? row['url'] : null,
    error: typeof row['error'] === 'string' ? row['error'] : null,
    verifiedAt: readString(row['verifiedAt'], ''),
  };
}
function attemptOf(value: unknown): PublicationAttemptView {
  const row = objectOf(value);
  return {
    attempt: readNumber(row['attempt'], 1),
    requestedAt: readString(row['requestedAt'], ''),
    requestedBy: readString(row['requestedBy'], ''),
    results: Array.isArray(row['results']) ? (row['results'] as readonly unknown[]).map(resultOf) : [],
  };
}
function contentOf(value: unknown): PublicationContentView {
  const row = objectOf(value);
  return {
    title: readString(row['title'], ''),
    body: readString(row['body'], ''),
    channels: strings(row['channels']),
    attachments: strings(row['attachments']),
  };
}
function versionOf(value: unknown): PublicationVersionView {
  const row = objectOf(value);
  return {
    version: readNumber(row['version'], 1),
    status: statusOf(row['status']),
    content: contentOf(row['content']),
    checks: Array.isArray(row['checks']) ? (row['checks'] as readonly unknown[]).map(checkOf) : [],
    createdAt: readString(row['createdAt'], ''),
    updatedAt: readString(row['updatedAt'], ''),
    confirmedAt: typeof row['confirmedAt'] === 'string' ? row['confirmedAt'] : null,
    confirmedBy: typeof row['confirmedBy'] === 'string' ? row['confirmedBy'] : null,
    attempts: Array.isArray(row['attempts']) ? (row['attempts'] as readonly unknown[]).map(attemptOf) : [],
    publishedAt: typeof row['publishedAt'] === 'string' ? row['publishedAt'] : null,
    publishedBy: typeof row['publishedBy'] === 'string' ? row['publishedBy'] : null,
    publicPath: typeof row['publicPath'] === 'string' ? row['publicPath'] : null,
  };
}

export function parsePublicationRecord(value: unknown): PublicationRecordView | null {
  const row = objectOf(value);
  const publicationId = readString(row['publicationId'], '');
  if (publicationId === '') return null;
  return {
    publicationId,
    promotionId: readString(row['promotionId'], ''),
    promotionVersion: readNumber(row['promotionVersion'], 1),
    executionId: readString(row['executionId'], ''),
    planId: readString(row['planId'], ''),
    planVersion: readNumber(row['planVersion'], 1),
    approvalId: readString(row['approvalId'], ''),
    requirementId: readString(row['requirementId'], ''),
    requirementVersion: readNumber(row['requirementVersion'], 1),
    approvedBy: readString(row['approvedBy'], ''),
    approvedAt: readString(row['approvedAt'], ''),
    promotionConfirmedBy: readString(row['promotionConfirmedBy'], ''),
    promotionConfirmedAt: readString(row['promotionConfirmedAt'], ''),
    sourceArtifacts: strings(row['sourceArtifacts']),
    taskIds: strings(row['taskIds']),
    currentVersion: readNumber(row['currentVersion'], 1),
    versions: Array.isArray(row['versions']) ? (row['versions'] as readonly unknown[]).map(versionOf) : [],
  };
}

export function currentPublicationVersion(record: PublicationRecordView): PublicationVersionView | null {
  return record.versions.find((entry) => entry.version === record.currentVersion) ?? record.versions[record.versions.length - 1] ?? null;
}

export function parsePublications(value: unknown): readonly PublicationSummaryView[] {
  const row = objectOf(value);
  const list = Array.isArray(row['publications']) ? row['publications'] : [];
  return (list as readonly unknown[]).flatMap((entry) => {
    const item = objectOf(entry);
    const publicationId = readString(item['publicationId'], '');
    if (publicationId === '') return [];
    return [{
      publicationId,
      promotionId: readString(item['promotionId'], ''),
      promotionVersion: readNumber(item['promotionVersion'], 1),
      title: readString(item['title'], ''),
      status: statusOf(item['status']),
      version: readNumber(item['version'], 1),
      publishedAt: typeof item['publishedAt'] === 'string' ? item['publishedAt'] : null,
      publicPath: typeof item['publicPath'] === 'string' ? item['publicPath'] : null,
      updatedAt: readString(item['updatedAt'], ''),
    }];
  });
}

export function parseChecks(value: unknown): readonly PublicationCheckView[] {
  const row = objectOf(value);
  return Array.isArray(row['checks']) ? (row['checks'] as readonly unknown[]).map(checkOf) : [];
}
