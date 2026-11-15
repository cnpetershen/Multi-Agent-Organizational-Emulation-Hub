import { describe, expect, it } from 'vitest';
import { currentPublicationVersion, parseChecks, parsePublicationRecord, parsePublications } from '../../../apps/web/src/publication';

const VERSION = {
  version: 2,
  status: 'published',
  content: { title: '正式发布', body: '正文', channels: ['local_page'], attachments: ['qa_report'] },
  checks: [{ checkId: 'source-confirmed', label: 'source', ok: true, detail: 'ok' }],
  createdAt: '2026-11-15T10:00:00.000Z',
  updatedAt: '2026-11-15T10:01:00.000Z',
  confirmedAt: '2026-11-15T10:01:00.000Z',
  confirmedBy: 'ceo-alex',
  attempts: [
    {
      attempt: 1,
      requestedAt: '2026-11-15T10:02:00.000Z',
      requestedBy: 'ceo-alex',
      results: [{ channel: 'local_page', status: 'published', resourceId: 'local:1:2', url: '/api/publications/1/page', error: null, verifiedAt: '2026-11-15T10:02:00.000Z' }],
    },
  ],
  publishedAt: '2026-11-15T10:02:00.000Z',
  publishedBy: 'ceo-alex',
  publicPath: '/api/publications/1/page',
};

const RECORD = {
  publicationId: 'publication-1',
  promotionId: 'promotion-1',
  promotionVersion: 3,
  executionId: 'exec-1',
  planId: 'plan-1',
  planVersion: 2,
  approvalId: 'approval-1',
  requirementId: 'req-1',
  requirementVersion: 3,
  approvedBy: 'ceo-alex',
  approvedAt: '2026-11-15T10:00:00.000Z',
  promotionConfirmedBy: 'ceo-alex',
  promotionConfirmedAt: '2026-11-15T10:00:30.000Z',
  sourceArtifacts: ['qa_report'],
  taskIds: ['task-1'],
  currentVersion: 2,
  versions: [VERSION],
};

describe('M3.8 publication read model', () => {
  it('parses publication trace, content and real channel results', () => {
    const record = parsePublicationRecord(RECORD);
    expect(record?.publicationId).toBe('publication-1');
    expect(record?.requirementId).toBe('req-1');
    expect(record?.sourceArtifacts).toContain('qa_report');
    const version = record === null ? null : currentPublicationVersion(record);
    expect(version?.status).toBe('published');
    expect(version?.content.channels).toContain('local_page');
    expect(version?.attempts[0]?.results[0]?.status).toBe('published');
    expect(version?.publicPath).toContain('/api/publications/');
  });

  it('parses checks and summaries', () => {
    expect(parseChecks({ checks: VERSION.checks })[0]?.ok).toBe(true);
    const summaries = parsePublications({ publications: [{ publicationId: 'publication-1', promotionId: 'promotion-1', promotionVersion: 3, title: 't', status: 'published', version: 2, publishedAt: VERSION.publishedAt, publicPath: VERSION.publicPath, updatedAt: VERSION.updatedAt }] });
    expect(summaries[0]?.status).toBe('published');
    expect(summaries[0]?.publicPath).toContain('/api/publications/');
  });

  it('rejects a payload without a publication id', () => {
    expect(parsePublicationRecord({})).toBeNull();
  });
});
