import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M3.9 - Requirement/Promotion observability events on a persistent event log.
 *
 * The fixture drives the real requirement -> plan -> execution -> approval -> promotion ->
 * publication APIs with mock agent turns. The new events must appear only after successful
 * business operations, be idempotent at the business boundary, survive a restart, and classify
 * as sandbox/promotion in Theater.
 */

type Json = Readonly<Record<string, unknown>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
let base = '';
let planningDir = '';
let eventLogPath = '';

function view(value: unknown): Json {
  return (typeof value === 'object' && value !== null ? value : {}) as Json;
}
function rows(value: unknown): readonly Json[] {
  return Array.isArray(value) ? (value as readonly Json[]) : [];
}
async function json(path: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', connection: 'close', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : view(JSON.parse(text) as unknown) };
}
const post = (path: string, body: unknown) => json(path, { method: 'POST', body: JSON.stringify(body) });
const put = (path: string, body: unknown) => json(path, { method: 'PUT', body: JSON.stringify(body) });

async function tick(): Promise<void> {
  const response = await fetch(`${base}/tick`, { method: 'POST' });
  expect(response.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 2));
}

const GOAL = 'Build a team weekly-report generator for a 20-person design consultancy: employees submit weekly project progress, the system aggregates a management report, and history is retained.';

async function fullChain(): Promise<{ requirementId: string; executionId: string; promotionId: string; publicationId: string }> {
  const analyzed = await post('/requirements/analyze', { goal: GOAL });
  const requirementId = String(analyzed.body['requirementId']);
  const answers: Record<string, string> = {};
  for (const question of rows(analyzed.body['clarifications'])) {
    if (question['blocking'] === true) answers[String(question['id'])] = 'Use the weekly-report scenario.';
  }
  const updated = await put(`/requirements/${encodeURIComponent(requirementId)}`, {
    baseVersion: 1,
    patch: {
      title: 'Weekly Report Generator',
      background: '20-person design consultancy.',
      audience: ['Management'],
      constraints: ['Retain history'],
      inScope: ['Weekly entry', 'Automatic aggregation'],
      outOfScope: ['Performance review'],
      deliverables: ['Runnable weekly-report generator', 'Acceptance report'],
      acceptanceCriteria: ['Employees can submit', 'Management report is generated'],
      requiredCapabilities: ['technical_design', 'implementation', 'testing'],
      answers,
    },
  });
  const requirement = await post(`/requirements/${encodeURIComponent(requirementId)}/confirm`, {
    version: updated.body['version'],
    answers,
    acknowledgeInferred: true,
  });
  const orchestration = await post('/orchestrations', {
    requirementId,
    version: requirement.body['version'],
  });
  const plan = await post('/plans', { orchestrationId: orchestration.body['orchestrationId'] });
  const confirmed = await post(`/plans/${encodeURIComponent(String(plan.body['planId']))}/confirm`, {
    baseVersion: plan.body['version'],
  });
  const started = await post(`/plans/${encodeURIComponent(String(plan.body['planId']))}/start`, {
    baseVersion: confirmed.body['version'],
  });
  const executionId = String(started.body['executionId']);
  for (let index = 0; index < 180; index += 1) {
    const current = await json(`/executions/${encodeURIComponent(executionId)}`);
    if (current.body['status'] === 'awaiting_approval') break;
    await tick();
  }
  const approved = await post(`/execution-approvals/${encodeURIComponent(executionId)}/decide`, {
    action: 'approve',
    reason: 'M3.9 observability acceptance',
  });
  expect(approved.status).toBe(200);
  const promotion = await post('/promotions', { executionId });
  const promotionId = String(promotion.body['promotionId']);
  const confirmedPromotion = await post(`/promotions/${encodeURIComponent(promotionId)}/confirm`, {
    baseVersion: promotion.body['version'],
  });
  expect(confirmedPromotion.status).toBe(200);
  const publication = await post('/publications', { promotionId });
  const publicationId = String(publication.body['publicationId']);
  const publicationReady = await post(`/publications/${encodeURIComponent(publicationId)}/confirm`, {
    baseVersion: 1,
    confirm: true,
  });
  expect(publicationReady.status).toBe(200);
  const publicationPublished = await post(`/publications/${encodeURIComponent(publicationId)}/publish`, {
    baseVersion: 1,
    confirm: true,
  });
  expect(publicationPublished.status).toBe(200);
  return { requirementId, executionId, promotionId, publicationId };
}

beforeAll(async () => {
  planningDir = mkdtempSync(join(tmpdir(), 'maoeh-m39-'));
  eventLogPath = join(planningDir, 'events.jsonl');
  server = await startApiServer(0, {
    eventLogPath,
    planningDir,
    requirePlanConfirmation: true,
    tick: { activeIntervalMs: 60_000, idleIntervalMs: 60_000, pausedIntervalMs: 60_000 },
  });
  base = `http://127.0.0.1:${String(server.port)}/api`;
}, 60_000);

afterAll(async () => {
  await server.close();
  rmSync(planningDir, { recursive: true, force: true });
});

describe('M3.9 requirement/promotion observability', () => {
  it('emits real events only after success, is idempotent, survives restart, and classifies stages', async () => {
    const ids = await fullChain();

    let history = await json('/theater/history?limit=500');
    let events = rows(history.body['events']);
    const byType = (type: string) => events.filter((event) => event['type'] === type);
    expect(byType('Document.RequirementAnalyzed')).toHaveLength(1);
    expect(byType('Document.RequirementConfirmed')).toHaveLength(1);
    expect(byType('Document.PromotionGenerated')).toHaveLength(1);
    expect(byType('Document.PromotionConfirmed')).toHaveLength(1);
    expect(byType('Document.RequirementAnalyzed')[0]?.['stage']).toBe('sandbox');
    expect(byType('Document.RequirementConfirmed')[0]?.['stage']).toBe('sandbox');
    expect(byType('Document.PromotionGenerated')[0]?.['stage']).toBe('promotion');
    expect(byType('Document.PromotionConfirmed')[0]?.['stage']).toBe('promotion');

    const requirementEvent = view(byType('Document.RequirementAnalyzed')[0]?.['payload']);
    expect(requirementEvent['requirementId']).toBe(ids.requirementId);
    expect(requirementEvent['version']).toBe(1);
    expect(requirementEvent['analysisMode']).toBeTypeOf('string');
    expect(requirementEvent['analyzedAt']).toBeTypeOf('string');

    const promotionEvent = view(byType('Document.PromotionGenerated')[0]?.['payload']);
    expect(promotionEvent['promotionId']).toBe(ids.promotionId);
    expect(promotionEvent['executionId']).toBe(ids.executionId);
    expect(promotionEvent['approvalId']).toBeTypeOf('string');
    expect(promotionEvent['generatedAt']).toBeTypeOf('string');

    const repeatedConfirm = await post(`/requirements/${encodeURIComponent(ids.requirementId)}/confirm`, {
      version: 3,
      answers: {},
      acknowledgeInferred: true,
    });
    expect(repeatedConfirm.status).toBe(200);
    const repeatedPromotion = await post('/promotions', { executionId: ids.executionId });
    expect(repeatedPromotion.status).toBe(200);

    history = await json('/theater/history?limit=500');
    events = rows(history.body['events']);
    expect(events.filter((event) => event['type'] === 'Document.RequirementConfirmed')).toHaveLength(1);
    expect(events.filter((event) => event['type'] === 'Document.PromotionGenerated')).toHaveLength(1);

    const types = new Set(events.map((event) => event['type']));
    for (const type of [
      'Workflow.InstanceStarted',
      'Task.Completed',
      'Workflow.ApprovalGranted',
      'Document.PublicationPublished',
    ]) {
      expect(types.has(type)).toBe(true);
    }

    await server.close();
    server = await startApiServer(0, {
      eventLogPath,
      planningDir,
      requirePlanConfirmation: true,
      tick: { activeIntervalMs: 60_000, idleIntervalMs: 60_000, pausedIntervalMs: 60_000 },
    });
    base = `http://127.0.0.1:${String(server.port)}/api`;

    const after = await json('/theater/history?limit=500');
    const afterEvents = rows(after.body['events']);
    const afterTypes = afterEvents.map((event) => event['type']);
    expect(afterTypes).toContain('Document.RequirementAnalyzed');
    expect(afterTypes).toContain('Document.RequirementConfirmed');
    expect(afterTypes).toContain('Document.PromotionGenerated');
    expect(afterTypes).toContain('Document.PromotionConfirmed');
    expect(afterTypes).toContain('Document.PublicationPublished');
    expect(afterEvents.find((event) => event['type'] === 'Document.PromotionConfirmed')?.['stage']).toBe('promotion');

    const publication = await json(`/publications/${encodeURIComponent(ids.publicationId)}`);
    expect(publication.status).toBe(200);
    expect(publication.body['executionId']).toBe(ids.executionId);
    expect(publication.body['promotionId']).toBe(ids.promotionId);
    const current = rows(publication.body['versions']).find(
      (version) => version['version'] === publication.body['currentVersion'],
    );
    expect(view(current)['status']).toBe('published');
  });
});
