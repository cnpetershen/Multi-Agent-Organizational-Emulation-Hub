import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApiServer } from '../../apps/api/src/composition';

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
const post = (path: string, body: unknown) => json(path, { method: 'POST', body: JSON.stringify(body) });
const put = (path: string, body: unknown) => json(path, { method: 'PUT', body: JSON.stringify(body) });
async function tick(): Promise<void> {
  const response = await fetch(`${base}/tick`, { method: 'POST' });
  expect(response.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 2));
}
const GOAL = '为一家 20 人的设计咨询公司做团队周报生成器：员工每周填写项目进展，系统汇总成管理层周报，并保留历史记录。';

async function createApprovedPromotion(): Promise<string> {
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
  const orchestration = await post('/orchestrations', { requirementId, version: requirement.body['version'] });
  const plan = await post('/plans', { orchestrationId: orchestration.body['orchestrationId'] });
  const confirmed = await post(`/plans/${encodeURIComponent(String(plan.body['planId']))}/confirm`, { baseVersion: plan.body['version'] });
  const started = await post(`/plans/${encodeURIComponent(String(plan.body['planId']))}/start`, { baseVersion: confirmed.body['version'] });
  const executionId = String(started.body['executionId']);
  for (let index = 0; index < 180; index += 1) {
    const current = await json(`/executions/${encodeURIComponent(executionId)}`);
    if (current.body['status'] === 'awaiting_approval') break;
    await tick();
  }
  const approved = await post(`/execution-approvals/${encodeURIComponent(executionId)}/decide`, { action: 'approve', reason: 'restart source' });
  expect(approved.status).toBe(200);
  const promotion = await post('/promotions', { executionId });
  const promotionId = String(promotion.body['promotionId']);
  const confirmedPromotion = await post(`/promotions/${encodeURIComponent(promotionId)}/confirm`, { baseVersion: promotion.body['version'] });
  expect(confirmedPromotion.status).toBe(200);
  return promotionId;
}

beforeAll(async () => {
  planningDir = mkdtempSync(join(tmpdir(), 'maoeh-m38-restart-'));
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

describe('M3.8 publication restart consistency', () => {
  it('keeps a published record and its local page after an API restart', async () => {
    const promotionId = await createApprovedPromotion();
    const created = await post('/publications', { promotionId });
    const publicationId = String(view(created.body)['publicationId']);
    const ready = await post(`/publications/${encodeURIComponent(publicationId)}/confirm`, { baseVersion: 1, confirm: true });
    expect(ready.status).toBe(200);
    const published = await post(`/publications/${encodeURIComponent(publicationId)}/publish`, { baseVersion: 1, confirm: true });
    expect(published.status).toBe(200);
    const publicPath = String(rows(view(published.body['record'])['versions'])[0]?.['publicPath']);

    await server.close();
    server = await startApiServer(0, {
      eventLogPath: null,
      planningDir,
      requirePlanConfirmation: true,
      tick: { activeIntervalMs: 60_000, idleIntervalMs: 60_000, pausedIntervalMs: 60_000 },
    });
    base = `http://127.0.0.1:${String(server.port)}/api`;

    const restored = await json(`/publications/${encodeURIComponent(publicationId)}`);
    expect(restored.status).toBe(200);
    const version = rows(restored.body['versions'])[0];
    expect(version?.['status']).toBe('published');
    expect(version?.['publicPath']).toBe(publicPath);
    const page = await fetch(`${base.replace(/\/api$/, '')}${publicPath}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('LOCAL PUBLICATION');
    const promotions = await json(`/promotions/${encodeURIComponent(promotionId)}/confirmed`);
    expect(promotions.status).toBe(200);
    expect(promotions.body['status']).toBe('confirmed');
  });
});
