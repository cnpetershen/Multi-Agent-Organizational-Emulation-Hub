import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M3.7 · promotion plans are derived from a real M3.6 approved execution.
 *
 * The fixture runs the actual requirement → plan → execution → approval chain. Promotion is a
 * versioned preparation artifact: it never publishes, never claims a task execution it did not
 * run, and its copy/materials are attributable to the content studio / deterministic fallback.
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

async function createExecution(): Promise<{ executionId: string; planId: string }> {
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
  const plan = await post('/plans', {
    orchestrationId: orchestration.body['orchestrationId'],
  });
  const confirmed = await post(`/plans/${encodeURIComponent(String(plan.body['planId']))}/confirm`, {
    baseVersion: plan.body['version'],
  });
  const started = await post(`/plans/${encodeURIComponent(String(plan.body['planId']))}/start`, {
    baseVersion: confirmed.body['version'],
  });
  expect(started.status).toBe(200);
  const executionId = String(started.body['executionId']);
  let status = '';
  for (let index = 0; index < 180; index += 1) {
    const current = await json(`/executions/${encodeURIComponent(executionId)}`);
    status = String(current.body['status']);
    if (status === 'awaiting_approval') break;
    await tick();
  }
  expect(status).toBe('awaiting_approval');
  return { executionId, planId: String(plan.body['planId']) };
}

async function approvedFixture(): Promise<{ executionId: string; promotion: Json }> {
  const execution = await createExecution();
  const approved = await post(
    `/execution-approvals/${encodeURIComponent(execution.executionId)}/decide`,
    { action: 'approve', reason: 'M3.7 promotion test approval' },
  );
  expect(approved.status).toBe(200);
  const created = await post('/promotions', { executionId: execution.executionId });
  expect(created.status).toBe(200);
  return { executionId: execution.executionId, promotion: created.body };
}

beforeAll(async () => {
  planningDir = mkdtempSync(join(tmpdir(), 'maoeh-m37-'));
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

describe('M3.7 promotion · approved source', () => {
  it('creates a draft only from a completed approved execution', async () => {
    const { promotion } = await approvedFixture();
    expect(promotion['status']).toBe('draft');
    expect(promotion['version']).toBe(1);
    expect(promotion['executionId']).toBeTypeOf('string');
    expect(promotion['approvalId']).toBeTypeOf('string');
    expect(promotion['approvedBy']).toBe('ceo-alex');
    expect(rows(promotion['channels']).length).toBeGreaterThan(0);
    expect(rows(promotion['materials']).length).toBeGreaterThanOrEqual(4);
    expect(rows(view(promotion['contributors']))[0]?.['employeeId']).toBe('marketing-jack');
    expect(view(promotion['provenance'])['mode']).toBe('mock');
    expect(view(promotion['provenance'])['aiFields']).toContain('materials');
    expect(rows(view(promotion['provenance'])['approvedArtifacts']).length).toBeGreaterThan(0);
    expect(promotion['confirmedAt']).toBeNull();
    expect(promotion['publishedAt']).toBeUndefined();
  });

  it('rejects pending and rejected executions as promotion sources', async () => {
    const pending = await createExecution();
    const pendingPromotion = await post('/promotions', { executionId: pending.executionId });
    expect(pendingPromotion.status).toBe(422);
    expect(pendingPromotion.body['error']).toBe('promotion_invalid');

    const rejectedExecution = await createExecution();
    const rejected = await post(
      `/execution-approvals/${encodeURIComponent(rejectedExecution.executionId)}/decide`,
      { action: 'reject', reason: 'not accepted' },
    );
    expect(rejected.status).toBe(200);
    const rejectedPromotion = await post('/promotions', {
      executionId: rejectedExecution.executionId,
    });
    expect(rejectedPromotion.status).toBe(422);
    expect(rejectedPromotion.body['error']).toBe('promotion_invalid');
  });
});

describe('M3.7 promotion · edits and confirmation', () => {
  it('versions edits, enforces baseVersion, and protects confirmed history', async () => {
    const { promotion } = await approvedFixture();
    const promotionId = String(promotion['promotionId']);
    const firstMaterial = rows(promotion['materials'])[0];
    const edited = await put(`/promotions/${encodeURIComponent(promotionId)}`, {
      baseVersion: 1,
      patch: {
        title: '管理层周报 · 推广方案',
        goal: '让 20 人设计咨询公司的管理层看到周报自动汇总价值',
        materials: [
          {
            materialId: String(firstMaterial['materialId']),
            type: 'project-intro',
            platform: 'general',
            title: '人工修改的项目介绍',
            body: '这是人工根据已批准交付修改的介绍。',
            source: 'ai',
            sourceArtifact: String(firstMaterial['sourceArtifact'] ?? ''),
          },
        ],
      },
    });
    expect(edited.status).toBe(200);
    expect(edited.body['version']).toBe(2);
    expect(edited.body['status']).toBe('draft');
    expect(rows(edited.body['materials'])[0]?.['source']).toBe('human');
    expect(view(edited.body['provenance'])['humanEdits']).toContain('materials');

    const stale = await put(`/promotions/${encodeURIComponent(promotionId)}`, {
      baseVersion: 1,
      patch: { title: 'stale write' },
    });
    expect(stale.status).toBe(409);

    const record = await json(`/promotions/${encodeURIComponent(promotionId)}`);
    expect(rows(record.body['versions']).length).toBe(2);
    expect(view(rows(record.body['versions'])[0])['title']).not.toBe('管理层周报 · 推广方案');

    const confirmed = await post(`/promotions/${encodeURIComponent(promotionId)}/confirm`, {
      baseVersion: 2,
      note: '推广准备完成，不发布',
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body['status']).toBe('confirmed');
    expect(confirmed.body['version']).toBe(3);
    expect(confirmed.body['confirmedBy']).toBe('ceo-alex');
    expect(confirmed.body['confirmedAt']).toBeTypeOf('string');
    expect(confirmed.body['publishedAt']).toBeUndefined();

    const nextDraft = await put(`/promotions/${encodeURIComponent(promotionId)}`, {
      baseVersion: 3,
      patch: { title: '管理层周报 · 二次修改' },
    });
    expect(nextDraft.status).toBe(200);
    expect(nextDraft.body['status']).toBe('draft');
    expect(nextDraft.body['version']).toBe(4);
    expect(nextDraft.body['confirmedAt']).toBeNull();

    const confirmedView = await json(
      `/promotions/${encodeURIComponent(promotionId)}/confirmed`,
    );
    expect(confirmedView.status).toBe(200);
    expect(confirmedView.body['version']).toBe(3);
    expect(confirmedView.body['status']).toBe('confirmed');
    expect(confirmedView.body['title']).toBe('管理层周报 · 推广方案');
  });

  it('blocks confirmation when the plan is missing audience or material content', async () => {
    const { promotion } = await approvedFixture();
    const promotionId = String(promotion['promotionId']);
    const edited = await put(`/promotions/${encodeURIComponent(promotionId)}`, {
      baseVersion: 1,
      patch: { audience: [] },
    });
    expect(edited.status).toBe(200);
    const refused = await post(`/promotions/${encodeURIComponent(promotionId)}/confirm`, {
      baseVersion: 2,
    });
    expect(refused.status).toBe(422);
    expect(refused.body['error']).toBe('promotion_invalid');
    expect(rows(view(refused.body['details'])['issues'])).toContain(
      'at least one audience is required',
    );

    const draftHandoff = await json(
      `/promotions/${encodeURIComponent(promotionId)}/confirmed`,
    );
    expect(draftHandoff.status).toBe(404);
  });

  it('exposes the complete M3.8 handoff without publishing anything', async () => {
    const { promotion } = await approvedFixture();
    const promotionId = String(promotion['promotionId']);
    const confirmed = await post(`/promotions/${encodeURIComponent(promotionId)}/confirm`, {
      baseVersion: 1,
    });
    expect(confirmed.status).toBe(200);
    const handoff = await json(`/promotions/${encodeURIComponent(promotionId)}/confirmed`);
    expect(handoff.status).toBe(200);
    expect(handoff.body['promotionId']).toBe(promotionId);
    expect(handoff.body['promotionVersion']).toBe(2);
    expect(handoff.body['version']).toBe(2);
    expect(handoff.body['executionId']).toBe(promotion['executionId']);
    expect(handoff.body['planId']).toBe(promotion['planId']);
    expect(handoff.body['approvalId']).toBe(promotion['approvalId']);
    expect(handoff.body['confirmedBy']).toBe('ceo-alex');
    expect(handoff.body['confirmedAt']).toBeTypeOf('string');
    expect(rows(handoff.body['channels']).length).toBeGreaterThan(0);
    expect(rows(handoff.body['materials']).length).toBeGreaterThan(0);
    expect(handoff.body['status']).toBe('confirmed');
    expect(handoff.body['summaryText']).toContain(promotion['title'] as string);
    expect(handoff.body['publishedAt']).toBeUndefined();
    expect(handoff.body['publishedUrl']).toBeUndefined();
  });
});
