import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M3.5 · confirmed plan → real workflow/task execution.
 *
 * The isolated API runs the real kernel, workflow engine, TaskSystem and agent scheduler. The
 * model is the deterministic mock in this test (the live-model acceptance run is the separate
 * isolated demo), but the chain is real: HTTP → engine → tasks → agent turns → submissions →
 * approval gate. No task or result is fabricated by this test or by the execution service.
 */

type Json = Readonly<Record<string, unknown>>;

let server: Awaited<ReturnType<typeof startApiServer>>;
let base = '';
let planningDir = '';
let planId = '';

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

async function tick(): Promise<void> {
  const response = await fetch(`${base}/tick`, { method: 'POST' });
  expect(response.status).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 2));
}

const GOAL = '为一家 20 人的设计咨询公司做团队周报生成器：员工每周填写项目进展，系统汇总成管理层周报，并保留历史记录。';

beforeAll(async () => {
  planningDir = mkdtempSync(join(tmpdir(), 'maoeh-m35-'));
  server = await startApiServer(0, {
    eventLogPath: null,
    planningDir,
    requirePlanConfirmation: true,
    tick: { activeIntervalMs: 60_000, idleIntervalMs: 60_000, pausedIntervalMs: 60_000 },
  });
  base = `http://127.0.0.1:${String(server.port)}/api`;

  const analyzed = await post('/requirements/analyze', { goal: GOAL });
  const requirementId = String(analyzed.body['requirementId']);
  const answers: Record<string, string> = {};
  for (const question of rows(analyzed.body['clarifications'])) {
    if (question['blocking'] === true) answers[String(question['id'])] = '按 20 人设计咨询公司周报场景执行。';
  }
  const updated = await put(`/requirements/${encodeURIComponent(requirementId)}`, {
    baseVersion: 1,
    patch: {
      title: '设计咨询公司周报生成器',
      background: '20 人设计咨询公司；管理层每周汇总项目进展。',
      audience: ['管理层'],
      constraints: ['保留历史记录'],
      inScope: ['周报填写', '自动汇总', '历史查询'],
      outOfScope: ['绩效考核'],
      deliverables: ['可运行的周报生成器（前后端）', '验收报告'],
      acceptanceCriteria: ['员工可提交项目进展', '系统生成管理层周报'],
      requiredCapabilities: ['technical_design', 'implementation', 'testing'],
      answers,
    },
  });
  const confirmed = await post(`/requirements/${encodeURIComponent(requirementId)}/confirm`, {
    version: updated.body['version'],
    answers,
    acknowledgeInferred: true,
  });
  const orchestration = await post('/orchestrations', {
    requirementId,
    version: confirmed.body['version'],
  });
  const plan = await post('/plans', { orchestrationId: orchestration.body['orchestrationId'] });
  planId = String(plan.body['planId']);
});

afterAll(async () => {
  await server.close();
  rmSync(planningDir, { recursive: true, force: true });
});

describe('M3.5 confirmed-plan execution', () => {
  it('refuses an unconfirmed plan and a stale baseVersion', async () => {
    const unconfirmed = await post(`/plans/${encodeURIComponent(planId)}/start`, { baseVersion: 1 });
    expect(unconfirmed.status).toBe(409);
    expect(String(unconfirmed.body['error'])).toBe('not_confirmed');

    const confirmed = await post(`/plans/${encodeURIComponent(planId)}/confirm`, {
      baseVersion: 1,
      note: 'M3.5 execution basis',
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body['status']).toBe('confirmed');

    const stale = await post(`/plans/${encodeURIComponent(planId)}/start`, { baseVersion: 1 });
    expect(stale.status).toBe(409);
    expect(String(stale.body['error'])).toBe('version_conflict');
  });

  it('starts one real workflow instance, creates the first task only, and is idempotent', async () => {
    const started = await post(`/plans/${encodeURIComponent(planId)}/start`, { baseVersion: 2 });
    expect(started.status).toBe(200);
    expect(started.body['planId']).toBe(planId);
    expect(started.body['planVersion']).toBe(2);
    expect(started.body['status']).toBe('running');
    const executionId = String(started.body['executionId']);
    expect(executionId).toMatch(/^exec-/u);
    expect(started.body['workflowInstanceId']).toBeTruthy();

    const repeated = await post(`/plans/${encodeURIComponent(planId)}/start`, { baseVersion: 2 });
    expect(repeated.status).toBe(200);
    expect(repeated.body['executionId']).toBe(executionId);

    const tasks = rows((await json('/tasks')).body);
    const executionTasks = tasks.filter(
      (task) => task['workflowInstanceId'] === started.body['workflowInstanceId'],
    );
    // The engine enters one stage at a time: the first node's task only.
    expect(executionTasks).toHaveLength(1);
    expect(executionTasks[0]?.['workflowStepId']).toBe('node-1');
    expect(executionTasks[0]?.['assigneeEmployeeId']).toBe('cto-john');
  });

  it('runs real agent turns, completes all tasks in plan order, and opens the approval gate', async () => {
    const list = rows((await json('/executions')).body['executions']);
    const execution = list[0];
    expect(execution).toBeDefined();
    const executionId = String(execution?.['executionId']);

    let final: Json | null = null;
    for (let index = 0; index < 180; index += 1) {
      const current = await json(`/executions/${encodeURIComponent(executionId)}`);
      if (
        view(current.body['approval'])['status'] === 'open' &&
        current.body['status'] === 'awaiting_approval'
      ) {
        final = current.body;
        break;
      }
      await tick();
    }
    expect(final).not.toBeNull();
    expect(final?.['status']).toBe('awaiting_approval');
    expect(view(final?.['approval'])['status']).toBe('open');
    expect(view(final?.['summary'])['allTasksCompleted']).toBe(true);
    expect(view(final?.['summary'])['taskCount']).toBe(3);
    expect(view(final?.['summary'])['completedCount']).toBe(3);
    expect(rows(final?.['tasks'])).toHaveLength(3);
    for (const task of rows(final?.['tasks'])) {
      expect(task['status']).toBe('completed');
      expect(view(task['result'])['summary']).toBeTruthy();
      expect(rows(view(task['result'])['artifacts']).length).toBeGreaterThan(0);
    }
    const nodeOrder = rows(final?.['tasks']).map((task) => task['planNodeId']);
    expect(nodeOrder).toEqual(['node-1', 'node-2', 'node-3']);
    expect(rows(view(final?.['summary'])['artifacts']).length).toBeGreaterThan(0);

    const workflows = await json('/workflows');
    const executed = rows(workflows.body).find(
      (entry) =>
        entry['instanceId'] === final?.['workflowInstanceId'],
    );
    expect(executed).toBeDefined();
    expect(view(executed?.['approval'])['status']).toBe('open');

    // Real workflow/task events reached the log; no event was synthesized by the API layer.
    const history = await json('/theater/history?limit=400');
    const types = rows(history.body['events']).map((event) => String(event['type']));
    expect(types).toEqual(
      expect.arrayContaining([
        'Task.Created',
        'Task.Assigned',
        'Task.Started',
        'Task.ProgressReported',
        'Task.Completed',
        'Workflow.StepEntered',
        'Workflow.ApprovalRequested',
      ]),
    );
  });

  it('leaves the confirmed plan and its version untouched, and exposes the execution to M3.6', async () => {
    const confirmed = await json(`/plans/${encodeURIComponent(planId)}/confirmed`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body['version']).toBe(2);
    expect(confirmed.body['status']).toBe('confirmed');

    const record = await json(`/plans/${encodeURIComponent(planId)}`);
    expect(rows(record.body['versions'])).toHaveLength(2);
    const list = rows((await json('/executions')).body['executions']);
    expect(list.length).toBe(1);
    const execution = list[0];
    expect(execution?.['planId']).toBe(planId);
    expect(execution?.['planVersion']).toBe(2);
    expect(execution?.['planConfirmedAt']).toBeTruthy();
  });
});
