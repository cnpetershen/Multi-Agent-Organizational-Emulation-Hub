import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M3.8 · real local publication.
 *
 * The fixture is the actual M3.3→M3.7 chain: requirement → confirmed plan → execution → M3.6
 * approval → M3.7 confirmed promotion. The publish operation writes a real local HTML page and
 * manifest and serves the page from the API; it never claims an external platform accepted it.
 */

type Json = Readonly<Record<string, unknown>>;

let server: Awaited<ReturnType<typeof startApiServer>>;
let base = '';
let planningDir = '';

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
const post = (path: string, body: unknown) =>
  json(path, { method: 'POST', body: JSON.stringify(body) });
const put = (path: string, body: unknown) =>
  json(path, { method: 'PUT', body: JSON.stringify(body) });

async function tick(): Promise<void> {
  const response = await fetch(`${base}/tick`, { method: 'POST' });
  expect(response.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 2));
}

const GOAL = '为一家 20 人的设计咨询公司做团队周报生成器：员工每周填写项目进展，系统汇总成管理层周报，并保留历史记录。';

async function createExecution(): Promise<string> {
  const analyzed = await post('/requirements/analyze', { goal: GOAL });
  const requirementId = String(analyzed.body['requirementId']);
  const answers: Record<string, string> = {};
  for (const question of rows(analyzed.body['clarifications'])) {
    if (question['blocking'] === true) answers[String(question['id'])] = '按周报场景执行。';
  }
  const updated = await put(`/requirements/${encodeURIComponent(requirementId)}`, {
    baseVersion: 1,
    patch: {
      title: '周报生成器',
      background: '20 人设计咨询公司。',
      audience: ['管理层'],
      constraints: ['保留历史'],
      inScope: ['周报填写', '自动汇总'],
      outOfScope: ['绩效'],
      deliverables: ['可运行周报生成器', '验收报告'],
      acceptanceCriteria: ['员工可提交周报', '管理层周报生成'],
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
  let status = '';
  for (let index = 0; index < 180; index += 1) {
    const current = await json(`/executions/${encodeURIComponent(executionId)}`);
    status = String(current.body['status']);
    if (status === 'awaiting_approval') break;
    await tick();
  }
  expect(status).toBe('awaiting_approval');
  return executionId;
}

async function confirmedPromotion(confirm = true): Promise<string> {
  const executionId = await createExecution();
  const approved = await post(
    `/execution-approvals/${encodeURIComponent(executionId)}/decide`,
    { action: 'approve', reason: 'M3.8 publication source approval' },
  );
  expect(approved.status).toBe(200);
  const promotion = await post('/promotions', { executionId });
  expect(promotion.status).toBe(200);
  if (confirm) {
    const confirmed = await post(
      `/promotions/${encodeURIComponent(String(promotion.body['promotionId']))}/confirm`,
      { baseVersion: promotion.body['version'], note: 'ready for publication' },
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body['status']).toBe('confirmed');
  }
  return String(promotion.body['promotionId']);
}

beforeAll(async () => {
  planningDir = mkdtempSync(join(tmpdir(), 'maoeh-m38-'));
  server = await startApiServer(0, {
    eventLogPath: null,
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

describe('M3.8 publication · source and confirmation', () => {
  it('refuses an unconfirmed promotion and creates a draft only from confirmed', async () => {
    const draftPromotion = await confirmedPromotion(false);
    const refused = await post('/publications', { promotionId: draftPromotion });
    expect(refused.status).toBe(422);
    expect(refused.body['error']).toBe('publication_invalid');

    const promotionId = await confirmedPromotion(true);
    const created = await post('/publications', { promotionId });
    expect(created.status).toBe(200);
    expect(created.body['status']).toBeUndefined();
    const record = view(created.body);
    const version = rows(record['versions'])[0];
    expect(view(version)['status']).toBe('draft');
    expect(record['promotionId']).toBe(promotionId);
    expect(record['executionId']).toBeTypeOf('string');
    expect(record['planId']).toBeTypeOf('string');
    expect(record['approvalId']).toBeTypeOf('string');
    expect(record['requirementId']).toBeTypeOf('string');
    expect(rows(record['sourceArtifacts']).length).toBeGreaterThan(0);

    const preflight = await json(
      `/publications/${encodeURIComponent(String(record['publicationId']))}/preflight`,
    );
    expect(preflight.status).toBe(200);
    expect(rows(preflight.body['checks']).every((check) => check['ok'] === true)).toBe(true);

    const missingConfirmation = await post(
      `/publications/${encodeURIComponent(String(record['publicationId']))}/confirm`,
      { baseVersion: 1, confirm: false },
    );
    expect(missingConfirmation.status).toBe(422);
  });
});

describe('M3.8 publication · local execution', () => {
  it('writes a real local page, serves it, is idempotent, and keeps traceability', async () => {
    const promotionId = await confirmedPromotion(true);
    const created = await post('/publications', { promotionId });
    const publication = view(created.body);
    const publicationId = String(publication['publicationId']);

    const edited = await put(`/publications/${encodeURIComponent(publicationId)}`, {
      baseVersion: 1,
      patch: {
        title: '管理层周报生成器 · 正式发布',
        body: '员工提交进展，系统汇总为管理层周报，历史记录可查询。\n\n来源：已批准执行与已确认推广方案。',
        attachments: ['technical-design.md', 'qa_report'],
      },
    });
    expect(edited.status).toBe(200);
    expect(edited.body['currentVersion']).toBe(2);
    const editedVersion = rows(edited.body['versions']).find((entry) => entry['version'] === 2);
    expect(view(editedVersion)['status']).toBe('draft');

    const ready = await post(`/publications/${encodeURIComponent(publicationId)}/confirm`, {
      baseVersion: 2,
      confirm: true,
    });
    expect(ready.status).toBe(200);
    expect(rows(ready.body['versions']).find((entry) => entry['version'] === 2)?.['status']).toBe('ready');

    const published = await post(`/publications/${encodeURIComponent(publicationId)}/publish`, {
      baseVersion: 2,
      confirm: true,
    });
    expect(published.status).toBe(200);
    const result = view(published.body['record']);
    const version = rows(result['versions']).find((entry) => entry['version'] === 2);
    expect(view(version)['status']).toBe('published');
    expect(rows(view(version)['attempts'])[0]?.['results']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'local_page', status: 'published' }),
        expect.objectContaining({ channel: 'local_manifest', status: 'published' }),
      ]),
    );
    const publicPath = String(view(version)['publicPath']);
    expect(publicPath).toContain('/api/publications/');
    const page = await fetch(`http://127.0.0.1:${String(server.port)}${publicPath}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('LOCAL PUBLICATION');
    expect(html).toContain('管理层周报生成器 · 正式发布');
    expect(html).toContain('LOCAL PUBLICATION');

    const repeated = await post(`/publications/${encodeURIComponent(publicationId)}/publish`, {
      baseVersion: 2,
      confirm: true,
    });
    expect(repeated.status).toBe(200);
    expect(repeated.body['idempotent']).toBe(true);
    const repeatedVersion = rows(view(repeated.body['record'])['versions']).find(
      (entry) => entry['version'] === 2,
    );
    expect(rows(view(repeatedVersion)['attempts']).length).toBe(1);

    expect(result['executionId']).toBeTypeOf('string');
    expect(result['planId']).toBeTypeOf('string');
    expect(result['approvalId']).toBeTypeOf('string');
    expect(result['requirementId']).toBeTypeOf('string');
    expect(rows(result['sourceArtifacts']).length).toBeGreaterThan(0);
  });

  it('records an external channel as unavailable without faking a URL', async () => {
    const promotionId = await confirmedPromotion(true);
    const created = await post('/publications', { promotionId });
    const publicationId = String(view(created.body)['publicationId']);
    const edited = await put(`/publications/${encodeURIComponent(publicationId)}`, {
      baseVersion: 1,
      patch: { channels: ['local_page', 'external_wechat'] },
    });
    expect(edited.status).toBe(200);
    const ready = await post(`/publications/${encodeURIComponent(publicationId)}/confirm`, {
      baseVersion: 2,
      confirm: true,
    });
    expect(ready.status).toBe(200);
    const published = await post(`/publications/${encodeURIComponent(publicationId)}/publish`, {
      baseVersion: 2,
      confirm: true,
    });
    expect(published.status).toBe(200);
    const version = rows(view(published.body['record'])['versions']).find(
      (entry) => entry['version'] === 2,
    );
    expect(view(version)['status']).toBe('partial');
    const results = rows(view(rows(view(version)['attempts'])[0])['results']);
    const external = results.find((entry) => entry['channel'] === 'external_wechat');
    expect(external?.['status']).toBe('unavailable');
    expect(external?.['url']).toBeNull();
    expect(String(external?.['error'])).toContain('no external connector');
  });

  it('keeps a failed attempt, then retries from a new confirmed version', async () => {
    const promotionId = await confirmedPromotion(true);
    const created = await post('/publications', { promotionId });
    const publicationId = String(view(created.body)['publicationId']);
    const edited = await put(`/publications/${encodeURIComponent(publicationId)}`, {
      baseVersion: 1,
      patch: { channels: ['local_manifest'] },
    });
    expect(edited.status).toBe(200);
    // Create a real filesystem conflict for the v2 manifest path: local manifest cannot be written.
    const manifestPath = join(
      planningDir,
      'publications',
      'publications',
      publicationId,
      'v2',
      'manifest.json',
    );
    mkdirSync(manifestPath, { recursive: true });
    const ready = await post(`/publications/${encodeURIComponent(publicationId)}/confirm`, {
      baseVersion: 2,
      confirm: true,
    });
    expect(ready.status).toBe(200);
    const failed = await post(`/publications/${encodeURIComponent(publicationId)}/publish`, {
      baseVersion: 2,
      confirm: true,
    });
    expect(failed.status).toBe(200);
    const failedVersion = rows(view(failed.body['record'])['versions']).find(
      (entry) => entry['version'] === 2,
    );
    expect(view(failedVersion)['status']).toBe('failed');
    const failedAttempt = view(rows(view(failedVersion)['attempts'])[0]);
    expect(rows(failedAttempt['results'])[0]?.['status']).toBe('failed');
    expect(String(rows(failedAttempt['results'])[0]?.['error'])).not.toBe('');

    // A safe retry is a new, re-confirmed content version: v3 uses the local page instead.
    const retry = await put(`/publications/${encodeURIComponent(publicationId)}`, {
      baseVersion: 2,
      patch: { channels: ['local_page'] },
    });
    expect(retry.status).toBe(200);
    const readyRetry = await post(`/publications/${encodeURIComponent(publicationId)}/confirm`, {
      baseVersion: 3,
      confirm: true,
    });
    expect(readyRetry.status).toBe(200);
    const retried = await post(`/publications/${encodeURIComponent(publicationId)}/publish`, {
      baseVersion: 3,
      confirm: true,
    });
    expect(retried.status).toBe(200);
    const retriedVersion = rows(view(retried.body['record'])['versions']).find(
      (entry) => entry['version'] === 3,
    );
    expect(view(retriedVersion)['status']).toBe('published');
  });

  it('emits real publication events that Theater classifies as release', async () => {
    const promotionId = await confirmedPromotion(true);
    const created = await post('/publications', { promotionId });
    const publicationId = String(view(created.body)['publicationId']);
    const ready = await post(`/publications/${encodeURIComponent(publicationId)}/confirm`, {
      baseVersion: 1,
      confirm: true,
    });
    expect(ready.status).toBe(200);
    const published = await post(`/publications/${encodeURIComponent(publicationId)}/publish`, {
      baseVersion: 1,
      confirm: true,
    });
    expect(published.status).toBe(200);
    const history = await json('/theater/history?limit=200');
    const types = rows(history.body['events']).map((event) => event['type']);
    expect(types).toContain('Document.PublicationDrafted');
    expect(types).toContain('Document.PublicationConfirmed');
    expect(types).toContain('Document.PublicationPublished');
    const publishedEvent = rows(history.body['events']).find(
      (event) => event['type'] === 'Document.PublicationPublished',
    );
    expect(publishedEvent?.['stage']).toBe('release');
    expect(publishedEvent?.['stageBasis']).toBe('event-type');
  });
});
