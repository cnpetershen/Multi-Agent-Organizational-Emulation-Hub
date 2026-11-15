import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M3.3 · 需求沙盘 → 智能体编排，over the real HTTP edge and the real kernel.
 *
 * The chain under test is the one the milestone asks for:
 *
 *   natural-language goal
 *     → structured requirement (blocking questions, inferred fields marked)
 *     → human answers + confirmation (a new immutable version)
 *     → orchestration from the real organization (employees chosen by capability)
 *     → a workflow **draft** on the canvas
 *
 * The negative assertions matter as much as the positive ones: the draft creates **no** task,
 * an unconfirmed requirement cannot be orchestrated, and a capability without a seat is reported
 * instead of being handed to someone who cannot do it.
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

async function post(path: string, body: unknown): Promise<{ status: number; body: Json }> {
  return json(path, { method: 'POST', body: JSON.stringify(body) });
}

async function put(path: string, body: unknown): Promise<{ status: number; body: Json }> {
  return json(path, { method: 'PUT', body: JSON.stringify(body) });
}

const GOAL = '为一家 20 人的设计咨询公司做一个团队周报生成器：员工每周填写项目进展，系统汇总成管理层周报，并保留历史记录。';

beforeAll(async () => {
  planningDir = mkdtempSync(join(tmpdir(), 'maoeh-m33-'));
  server = await startApiServer(0, {
    eventLogPath: null,
    planningDir,
    requirePlanConfirmation: true,
    tick: { activeIntervalMs: 60_000, idleIntervalMs: 60_000, pausedIntervalMs: 60_000 },
  });
  base = `http://127.0.0.1:${String(server.port)}/api`;
});

afterAll(async () => {
  await server.close();
  rmSync(planningDir, { recursive: true, force: true });
});

describe('M3.3 requirements sandbox', () => {
  it('turns a goal into a structured plan, asks blocking questions and keeps provenance honest', async () => {
    const analyzed = await post('/requirements/analyze', { goal: GOAL });
    expect(analyzed.status).toBe(200);
    const plan = analyzed.body;
    expect(plan['status']).toBe('needs_clarification');
    expect(view(plan['source'])).toMatchObject({ kind: 'goal', goal: GOAL });
    expect(rows(plan['clarifications']).length).toBeGreaterThan(0);
    expect(
      rows(plan['clarifications']).some((question) => question['blocking'] === true),
    ).toBe(true);
    // The user's goal is the only stated field; everything else is marked inferred.
    expect(rows(view(plan['provenance'])['stated'])).toEqual(['source.goal']);
    expect(rows(view(plan['provenance'])['inferred'])).toContain('deliverables');
    expect(rows(plan['deliverables'])).toEqual([]);
  });

  it('refuses confirmation while blocking questions are open', async () => {
    const analyzed = await post('/requirements/analyze', { goal: '做一个品牌官网' });
    const id = String(analyzed.body['requirementId']);
    const confirmed = await post(`/requirements/${encodeURIComponent(id)}/confirm`, {
      acknowledgeInferred: true,
    });
    expect(confirmed.status).toBe(422);
    expect(String(confirmed.body['error'])).toBe('needs_clarification');
  });
});

describe('M3.3 orchestration draft', () => {
  let requirementId = '';
  let confirmedVersion = 0;
  let workflowInstanceId = '';

  it('edits, answers and confirms a new immutable version', async () => {
    const analyzed = await post('/requirements/analyze', { goal: GOAL });
    requirementId = String(analyzed.body['requirementId']);
    const questions = rows(analyzed.body['clarifications']);
    const answers: Record<string, string> = {};
    for (const question of questions) {
      if (question['blocking'] === true) {
        answers[String(question['id'])] = '已确认：按 20 人设计咨询公司的管理层周报场景执行。';
      }
    }
    const updated = await put(`/requirements/${encodeURIComponent(requirementId)}`, {
      baseVersion: 1,
      patch: {
        title: '设计咨询公司周报生成器',
        background: '20 人设计咨询公司，管理层需要每周汇总项目进展。',
        audience: ['管理层', '项目负责人'],
        constraints: ['保留历史记录', '员工每周填写一次'],
        inScope: ['周报填写', '自动汇总', '历史查询'],
        outOfScope: ['绩效考核', '财务结算'],
        deliverables: ['可运行的周报生成器（前后端）', '使用说明与验收报告'],
        acceptanceCriteria: ['员工可提交项目进展', '系统生成管理层周报', '历史周报可查询'],
        requiredCapabilities: ['technical_design', 'implementation', 'testing'],
        answers,
      },
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body['status']).toBe('draft');
    expect(updated.body['version']).toBe(2);

    const confirmed = await post(`/requirements/${encodeURIComponent(requirementId)}/confirm`, {
      version: 2,
      acknowledgeInferred: true,
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body['status']).toBe('confirmed');
    confirmedVersion = Number(confirmed.body['version']);
    expect(confirmedVersion).toBe(3);
    expect(confirmed.body['confirmedBy']).not.toBe('');

    const stale = await put(`/requirements/${encodeURIComponent(requirementId)}`, {
      baseVersion: 1,
      patch: { title: 'stale write' },
    });
    expect(stale.status).toBe(409);
  });

  it('refuses to orchestrate an unconfirmed requirement', async () => {
    const analyzed = await post('/requirements/analyze', { goal: '做一个没人确认过的需求' });
    const id = String(analyzed.body['requirementId']);
    const orchestrated = await post('/orchestrations', { requirementId: id });
    expect(orchestrated.status).toBe(409);
    expect(String(orchestrated.body['error'])).toBe('not_confirmed');
  });

  it('builds a real-employee draft with dependencies and starts no task', async () => {
    const orchestrated = await post('/orchestrations', {
      requirementId,
      version: confirmedVersion,
    });
    expect(orchestrated.status, JSON.stringify(orchestrated.body)).toBe(200);
    const draft = orchestrated.body;
    expect(draft['status']).toBe('ready');
    expect(draft['requirementId']).toBe(requirementId);
    expect(draft['requirementVersion']).toBe(confirmedVersion);
    const nodes = rows(draft['nodes']);
    const taskNodes = nodes.filter((node) => node['kind'] === 'task');
    expect(taskNodes.length).toBe(3);
    for (const node of taskNodes) {
      expect(node['employeeId']).not.toBeNull();
      expect(rows(node['outputs']).length).toBeGreaterThan(0);
      expect(rows(node['acceptance']).length).toBeGreaterThan(0);
    }
    // Dependencies are real: design first, then implementation, then testing, then approval.
    expect(rows(taskNodes[0]?.['dependsOn'])).toEqual([]);
    expect(rows(taskNodes[1]?.['dependsOn'])).toContain(taskNodes[0]?.['nodeId']);
    expect(rows(taskNodes[2]?.['dependsOn'])).toContain(taskNodes[1]?.['nodeId']);
    const approval = nodes.find((node) => node['kind'] === 'approval');
    expect(approval).toBeDefined();
    expect(rows(approval?.['dependsOn'])).toEqual(expect.arrayContaining(taskNodes.map((node) => node['nodeId'])));

    workflowInstanceId = String(draft['workflowInstanceId']);
    expect(workflowInstanceId).not.toBe('');
    expect(draft['workflowId']).not.toBeNull();

    // The draft is a canvas draft: the instance exists, but no task was created.
    const workflows = rows((await json('/workflows')).body);
    const instance = workflows.find((entry) => entry['instanceId'] === workflowInstanceId);
    expect(instance).toBeDefined();
    expect(instance?.['status']).toBe('running');
    const tasks = rows((await json('/tasks')).body);
    expect(tasks).toEqual([]);

    const history = view((await json('/theater/history?limit=200')).body);
    const events = rows(history['events']);
    expect(events.some((event) => event['type'] === 'Task.Created')).toBe(false);
    const started = events.find(
      (event) => event['type'] === 'Workflow.InstanceStarted' && view(event['payload'])['instanceId'] === workflowInstanceId,
    );
    expect(started).toBeDefined();
    // The draft belongs to the orchestration stage, not to execution.
    expect(started?.['stage']).toBe('orchestration');
    expect(view(view(started?.['payload'])['context'])['draft']).toBe(true);
    expect(view(view(started?.['payload'])['context'])['planning']).toMatchObject({
      requirementId,
      requirementVersion: confirmedVersion,
      orchestrationId: draft['orchestrationId'],
    });

    const listed = await json('/orchestrations');
    expect(rows(listed.body['orchestrations']).some((entry) => entry['orchestrationId'] === draft['orchestrationId'])).toBe(true);
    const fetched = await json(`/orchestrations/${String(draft['orchestrationId'])}`);
    expect(fetched.body).toMatchObject({ orchestrationId: draft['orchestrationId'], workflowInstanceId });
  });

  it('reports a capability with no real seat instead of assigning it silently', async () => {
    const analyzed = await post('/requirements/analyze', { goal: '需要量子芯片设计能力' });
    const id = String(analyzed.body['requirementId']);
    const answers: Record<string, string> = {};
    for (const question of rows(analyzed.body['clarifications'])) {
      if (question['blocking'] === true) answers[String(question['id'])] = '已确认。';
    }
    const updated = await put(`/requirements/${encodeURIComponent(id)}`, {
      baseVersion: 1,
      patch: {
        title: '量子芯片设计',
        deliverables: ['量子芯片设计图'],
        acceptanceCriteria: ['设计图通过评审'],
        requiredCapabilities: ['quantum_chip_design', 'implementation'],
        answers,
      },
    });
    expect(updated.status).toBe(200);
    const confirmed = await post(`/requirements/${encodeURIComponent(id)}/confirm`, {
      version: 2,
      acknowledgeInferred: true,
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const orchestrated = await post('/orchestrations', { requirementId: id, version: 3 });
    expect(orchestrated.status).toBe(200);
    expect(orchestrated.body['status']).toBe('blocked');
    expect(rows(orchestrated.body['missingCapabilities'])).toContain('quantum_chip_design');
    expect(orchestrated.body['workflowInstanceId']).toBeNull();
    expect(rows(orchestrated.body['unassignedNodeIds']).length).toBeGreaterThan(0);
  });
});
