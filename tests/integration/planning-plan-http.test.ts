import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M3.4 · editable execution plan over the real HTTP edge and kernel.
 *
 * This test proves the boundary the milestone cares about:
 *   save draft  → new immutable plan version (M3.3 orchestration untouched)
 *   confirm plan → a confirmed version with confirmer/time/summary
 *   but **no** Task is created, no workflow step is entered, no agent starts.
 *
 * It also exercises the full DAG rules: reassignment, dependency edit, cycle detection, optimistic
 * locking and the "edit a confirmed plan creates a new draft" rule.
 */

type Json = Readonly<Record<string, unknown>>;

let server: Awaited<ReturnType<typeof startApiServer>>;
let base = '';
let planningDir = '';
let requirementId = '';
let orchestrationId = '';

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

const GOAL = '为一家 20 人的设计咨询公司做团队周报生成器：员工每周填写项目进展，系统汇总成管理层周报，并保留历史记录。';

beforeAll(async () => {
  planningDir = mkdtempSync(join(tmpdir(), 'maoeh-m34-'));
  server = await startApiServer(0, {
    eventLogPath: null,
    planningDir,
    requirePlanConfirmation: true,
    tick: { activeIntervalMs: 60_000, idleIntervalMs: 60_000, pausedIntervalMs: 60_000 },
  });
  base = `http://127.0.0.1:${String(server.port)}/api`;

  const analyzed = await post('/requirements/analyze', { goal: GOAL });
  requirementId = String(analyzed.body['requirementId']);
  const answers: Record<string, string> = {};
  for (const question of rows(analyzed.body['clarifications'])) {
    if (question['blocking'] === true) answers[String(question['id'])] = '按 20 人设计咨询公司管理层周报场景执行。';
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
  const orchestrated = await post('/orchestrations', {
    requirementId,
    version: confirmed.body['version'],
  });
  orchestrationId = String(orchestrated.body['orchestrationId']);
});

afterAll(async () => {
  await server.close();
  rmSync(planningDir, { recursive: true, force: true });
});

describe('M3.4 plan canvas · versioned editing', () => {
  it('opens an editable plan from the M3.3 draft without touching the orchestration', async () => {
    const created = await post('/plans', { orchestrationId });
    expect(created.status).toBe(200);
    expect(created.body['status']).toBe('draft');
    expect(created.body['version']).toBe(1);
    expect(rows(created.body['nodes'])).toHaveLength(4);
    expect(view(created.body['validation'])['ok']).toBe(true);
    expect(created.body['workflowInstanceId']).toBeTruthy();
    expect(created.body['orchestrationId']).toBe(orchestrationId);
    // Idempotent open: the same real plan, not a second copy.
    const again = await post('/plans', { orchestrationId });
    expect(again.body['planId']).toBe(created.body['planId']);

    const orchestration = await json(`/orchestrations/${encodeURIComponent(orchestrationId)}`);
    expect(rows(orchestration.body['nodes'])).toHaveLength(4);

    // The engine instance is marked as a planning draft so the generic canvas cannot mistake its
    // "confirm" button for M3.4 plan confirmation (which would start execution).
    const workflows = await json('/workflows');
    const instance = rows(workflows.body).find(
      (workflow) => String(workflow['instanceId']) === String(created.body['workflowInstanceId']),
    );
    expect(instance).toBeDefined();
    expect(instance?.['planned']).toBe(true);
    expect(instance?.['planningOrchestrationId']).toBe(orchestrationId);
  });

  it('saves node, employee and dependency edits as a new immutable version', async () => {
    const created = await post('/plans', { orchestrationId });
    const planId = String(created.body['planId']);

    const snapshot = await json('/snapshot');
    const employees = rows(snapshot.body['employees']);
    // The seed has one implementer; choose another *real* employee to prove the capability gate
    // is enforced instead of silently accepting a familiar name.
    const replacement = employees.find((employee) => String(employee['employeeId']) === 'cto-john');
    expect(replacement).toBeDefined();

    const edited = await put(`/plans/${encodeURIComponent(planId)}`, {
      baseVersion: 1,
      nodes: [
        {
          nodeId: 'node-1',
          title: 'Technical Design（人类调整）',
          inputs: ['已确认需求 v3', '公司技术与合规约束'],
        },
        {
          nodeId: 'node-2',
          dependsOn: [],
          employeeId: 'cto-john',
          acceptance: ['可运行交付物通过演示', '员工可提交周报'],
        },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.body['version']).toBe(2);
    expect(edited.body['status']).toBe('draft');
    expect(view(edited.body['validation'])['ok']).toBe(false);
    expect(
      rows(view(edited.body['validation'])['issues']).some(
        (issue) => issue['code'] === 'employee_not_capable',
      ),
    ).toBe(true);
    expect(view(edited.body['change'])).toMatchObject({ renamed: 1, reassigned: 1, dependenciesChanged: 1 });
    expect(rows(edited.body['order'])).toContain('node-2');

    const record = await json(`/plans/${encodeURIComponent(planId)}`);
    const versions = rows(record.body['versions']);
    expect(versions).toHaveLength(2);
    // The original version is untouched.
    const first = versions.find((version) => version['version'] === 1);
    expect(rows(first?.['nodes'])[0]?.['title']).toBe('Technical Design');
  });

  it('rejects a stale baseVersion with 409', async () => {
    const created = await post('/plans', { orchestrationId });
    const planId = String(created.body['planId']);
    const stale = await put(`/plans/${encodeURIComponent(planId)}`, {
      baseVersion: 1,
      nodes: [{ nodeId: 'node-1', title: 'Stale edit' }],
    });
    expect(stale.status).toBe(409);
    expect(String(stale.body['error'])).toBe('version_conflict');
  });

  it('detects a cycle, blocks confirmation, then confirms a clean version with no tasks', async () => {
    const created = await post('/plans', { orchestrationId });
    const planId = String(created.body['planId']);

    const cyclic = await put(`/plans/${encodeURIComponent(planId)}`, {
      baseVersion: 2,
      nodes: [
        { nodeId: 'node-1', dependsOn: ['node-2'] },
        { nodeId: 'node-2', dependsOn: ['node-1'] },
      ],
    });
    expect(cyclic.status).toBe(200);
    expect(cyclic.body['version']).toBe(3);
    expect(view(cyclic.body['validation'])['ok']).toBe(false);
    expect(rows(view(cyclic.body['validation'])['cycleNodeIds'])).toEqual(
      expect.arrayContaining(['node-1', 'node-2']),
    );
    const blocked = await post(`/plans/${encodeURIComponent(planId)}/confirm`, {
      baseVersion: 3,
      note: 'should fail',
    });
    expect(blocked.status).toBe(422);
    expect(String(blocked.body['error'])).toBe('plan_invalid');

    const clean = await put(`/plans/${encodeURIComponent(planId)}`, {
      baseVersion: 3,
      nodes: [
        { nodeId: 'node-1', dependsOn: [] },
        { nodeId: 'node-2', dependsOn: ['node-1'], employeeId: 'engineer-mike' },
      ],
    });
    expect(view(clean.body['validation'])['ok']).toBe(true);
    const confirmed = await post(`/plans/${encodeURIComponent(planId)}/confirm`, {
      baseVersion: 4,
      note: '人类确认执行方案',
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body['status']).toBe('confirmed');
    expect(confirmed.body['version']).toBe(5);
    expect(confirmed.body['confirmedBy']).toBeTruthy();
    expect(confirmed.body['confirmedAt']).toBeTruthy();
    expect(view(confirmed.body['summary'])['workflowInstanceId']).toBeTruthy();

    const confirmedRead = await json(`/plans/${encodeURIComponent(planId)}/confirmed`);
    expect(confirmedRead.status).toBe(200);
    expect(confirmedRead.body['version']).toBe(5);

    // Confirming the plan must not create tasks or enter an execution stage.
    const tasks = await json('/tasks');
    expect(rows(tasks.body)).toEqual([]);
    const history = await json('/theater/history?limit=200');
    const events = rows(history.body['events']);
    expect(events.some((event) => event['type'] === 'Task.Created')).toBe(false);
    expect(events.some((event) => event['type'] === 'Workflow.StepEntered')).toBe(false);
    expect(events.some((event) => event['type'] === 'Workflow.DraftConfirmed')).toBe(false);
  });

  it('editing a confirmed plan creates a new draft and leaves the confirmed version intact', async () => {
    const created = await post('/plans', { orchestrationId });
    const planId = String(created.body['planId']);
    const edit = await put(`/plans/${encodeURIComponent(planId)}`, {
      baseVersion: 5,
      nodes: [{ nodeId: 'node-1', title: 'Post-confirmation adjustment' }],
    });
    expect(edit.status).toBe(200);
    expect(edit.body['version']).toBe(6);
    expect(edit.body['status']).toBe('draft');
    const confirmedRead = await json(`/plans/${encodeURIComponent(planId)}/confirmed`);
    expect(confirmedRead.body['version']).toBe(5);
    expect(confirmedRead.body['status']).toBe('confirmed');
    const record = await json(`/plans/${encodeURIComponent(planId)}`);
    expect(rows(record.body['versions'])).toHaveLength(6);
    expect(rows(record.body['versions']).find((entry) => entry['version'] === 5)?.['status']).toBe('confirmed');
  });
});
