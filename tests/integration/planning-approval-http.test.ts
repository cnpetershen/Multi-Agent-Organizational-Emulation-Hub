import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M3.6 · human approval over three real, independent executions.
 *
 * Each execution is produced by the M3.5 chain (confirmed plan → real tasks → mock agent turns)
 * before a decision, so the workbench is reviewing actual Task.result/artifacts. Approve, reject
 * and request_changes each drive the existing workflow approval gate; none of them is a UI-only
 * flag.
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

async function createExecution(): Promise<{ executionId: string; planId: string; planVersion: number }> {
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
  return {
    executionId,
    planId: String(plan.body['planId']),
    planVersion: Number(confirmed.body['version']),
  };
}

beforeAll(async () => {
  planningDir = mkdtempSync(join(tmpdir(), 'maoeh-m36-'));
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

describe('M3.6 execution approval · workbench', () => {
  it('lists only real awaiting executions and exposes review evidence', async () => {
    const execution = await createExecution();
    const list = await json('/execution-approvals');
    expect(list.status).toBe(200);
    expect(rows(list.body['pending']).length).toBeGreaterThan(0);
    const pending = rows(list.body['pending']).find(
      (entry) => entry['executionId'] === execution.executionId,
    );
    expect(pending).toBeDefined();
    expect(pending?.['planVersion']).toBe(execution.planVersion);
    expect(pending?.['approvalStatus']).toBe('open');

    const review = await json(
      `/execution-approvals/${encodeURIComponent(execution.executionId)}`,
    );
    expect(review.status).toBe(200);
    expect(view(review.body['execution'])['status']).toBe('awaiting_approval');
    expect(view(review.body['plan'])['version']).toBe(execution.planVersion);
    const tasks = rows(view(review.body['execution'])['tasks']);
    expect(tasks).toHaveLength(3);
    for (const task of tasks) {
      expect(task['status']).toBe('completed');
      expect(view(task['result'])['summary']).toBeTruthy();
      expect(rows(view(task['result'])['artifacts']).length).toBeGreaterThan(0);
    }
    // The plan carries the acceptance criteria the human compares against.
    const nodes = rows(view(review.body['plan'])['nodes']);
    expect(nodes.every((node) => rows(node['acceptance']).length > 0)).toBe(true);

    const workflows = await json('/workflows');
    const executionInstance = String(view(review.body['execution'])['workflowInstanceId']);
    const executed = rows(workflows.body).find(
      (entry) => entry['instanceId'] === executionInstance,
    );
    expect(executed?.['executionPlan']).toBe(true);
  });
});

describe('M3.6 execution approval · decisions', () => {
  it('approves only a completed delivery, advances the gate, and is idempotent', async () => {
    const execution = await createExecution();
    const before = await json(`/executions/${encodeURIComponent(execution.executionId)}`);
    const beforeStatus = String(before.body['status']);

    const approved = await post(
      `/execution-approvals/${encodeURIComponent(execution.executionId)}/decide`,
      { action: 'approve', reason: '交付物符合验收标准' },
    );
    expect(approved.status).toBe(200);
    expect(view(approved.body['decision'])).toMatchObject({
      action: 'approve',
      executionId: execution.executionId,
      planId: execution.planId,
      planVersion: execution.planVersion,
    });
    const after = view(approved.body['execution']);
    expect(beforeStatus).toBe('awaiting_approval');
    expect(after['status']).toBe('completed');
    expect(view(after['approval'])['status']).toBe('granted');
    expect(rows(view(after['summary'])['artifacts']).length).toBeGreaterThan(0);

    const repeated = await post(
      `/execution-approvals/${encodeURIComponent(execution.executionId)}/decide`,
      { action: 'approve', reason: '重复请求' },
    );
    expect(repeated.status).toBe(200);
    expect(repeated.body['idempotent']).toBe(true);
    expect(view(repeated.body['decision'])['approvalId']).toBe(
      view(approved.body['decision'])['approvalId'],
    );

    const changed = await post(
      `/execution-approvals/${encodeURIComponent(execution.executionId)}/decide`,
      { action: 'reject', reason: '不应覆盖已批准结果' },
    );
    expect(changed.status).toBe(409);
    expect(String(changed.body['error'])).toBe('approval_already_decided');

    const history = await json('/execution-approvals');
    const record = rows(history.body['approved']).find(
      (entry) => entry['executionId'] === execution.executionId,
    );
    expect(record).toBeDefined();
    expect(record?.['decidedBy']).toBe('ceo-alex');
    expect(rows(record?.['artifacts']).length).toBeGreaterThan(0);
    expect(view(record?.['after'])['executionStatus']).toBe('completed');
  });

  it('rejects with a reason, fails the workflow, and never enters the approved handoff', async () => {
    const execution = await createExecution();
    const missingReason = await post(
      `/execution-approvals/${encodeURIComponent(execution.executionId)}/decide`,
      { action: 'reject' },
    );
    expect(missingReason.status).toBe(400);

    const rejected = await post(
      `/execution-approvals/${encodeURIComponent(execution.executionId)}/decide`,
      { action: 'reject', reason: '验收证据不足，拒绝当前交付' },
    );
    expect(rejected.status).toBe(200);
    const decision = view(rejected.body['decision']);
    expect(decision['action']).toBe('reject');
    expect(decision['reason']).toContain('验收证据不足');
    expect(view(decision['before'])['executionStatus']).toBe('awaiting_approval');
    expect(view(decision['after'])['executionStatus']).toBe('failed');
    expect(view(rejected.body['execution'])['status']).toBe('failed');

    const history = await json('/execution-approvals');
    expect(
      rows(history.body['approved']).some(
        (entry) => entry['executionId'] === execution.executionId,
      ),
    ).toBe(false);
  });

  it('records request_changes as a distinct rework decision and does not approve it', async () => {
    const execution = await createExecution();
    const changes = await post(
      `/execution-approvals/${encodeURIComponent(execution.executionId)}/decide`,
      {
        action: 'request_changes',
        reason: '实现缺少历史查询验收，请补充并重新提交',
      },
    );
    expect(changes.status).toBe(200);
    const decision = view(changes.body['decision']);
    expect(decision['action']).toBe('request_changes');
    expect(decision['reason']).toContain('历史查询');
    expect(view(decision['after'])['executionStatus']).toBe('failed');
    expect(rows(decision['taskIds'])).toHaveLength(3);
    expect(rows(decision['artifacts']).length).toBeGreaterThan(0);

    const history = await json('/execution-approvals');
    expect(
      rows(history.body['approved']).some(
        (entry) => entry['executionId'] === execution.executionId,
      ),
    ).toBe(false);
    const stored = rows(history.body['history']).find(
      (entry) => entry['executionId'] === execution.executionId,
    );
    expect(stored?.['action']).toBe('request_changes');

    // A rework loop is human-driven: revise the confirmed plan (M3.4), confirm it, then start a
    // new M3.5 execution. The original rejected execution and its artifacts stay untouched.
    const revised = await put(`/plans/${encodeURIComponent(execution.planId)}`, {
      baseVersion: 2,
      nodes: [{ nodeId: 'node-1', title: 'Technical Design v2' }],
    });
    expect(revised.status).toBe(200);
    expect(revised.body['status']).toBe('draft');
    expect(revised.body['version']).toBe(3);
    const reconfirmed = await post(`/plans/${encodeURIComponent(execution.planId)}/confirm`, {
      baseVersion: 3,
      note: 'rework after request_changes',
    });
    expect(reconfirmed.status).toBe(200);
    expect(reconfirmed.body['status']).toBe('confirmed');
    expect(reconfirmed.body['version']).toBe(4);
    const restarted = await post(`/plans/${encodeURIComponent(execution.planId)}/start`, {
      baseVersion: 4,
    });
    expect(restarted.status).toBe(200);
    expect(restarted.body['executionId']).not.toBe(execution.executionId);
    expect(restarted.body['planVersion']).toBe(4);
    expect(restarted.body['status']).toBe('running');
    const original = await json(`/executions/${encodeURIComponent(execution.executionId)}`);
    expect(original.body['status']).toBe('failed');
  });

  it('refuses the generic Workflow.Approve command for an execution delivery', async () => {
    const execution = await createExecution();
    const detail = await json(`/executions/${encodeURIComponent(execution.executionId)}`);
    const instanceId = String(detail.body['workflowInstanceId']);
    const command = await json('/command', {
      method: 'POST',
      body: JSON.stringify({
        commandId: 'cmd-m36-generic-approve',
        commandType: 'Workflow.Approve',
        actor: {
          operatorId: 'ceo-alex',
          displayName: 'Alex',
          positionId: 'ceo',
          kind: 'human',
        },
        target: { targetType: 'workflow', targetId: instanceId },
        reason: 'attempt to bypass the delivery workbench',
        correlationId: 'corr-m36-generic-approve',
        causationId: null,
        createdAtSim: 0,
      }),
    });
    expect(command.status).toBe(200);
    expect(String(command.body['status'])).toBe('rejected');
    expect(view(command.body['failure'])['code']).toBe('INVALID_STATE');
    const current = await json(`/executions/${encodeURIComponent(execution.executionId)}`);
    expect(current.body['status']).toBe('awaiting_approval');
  });

  it('refuses approval before the real approval gate is open', async () => {
    const analyzed = await post('/requirements/analyze', { goal: GOAL });
    const requirementId = String(analyzed.body['requirementId']);
    const answers: Record<string, string> = {};
    for (const question of rows(analyzed.body['clarifications'])) {
      if (question['blocking'] === true) answers[String(question['id'])] = '按周报场景执行。';
    }
    const updated = await put(`/requirements/${encodeURIComponent(requirementId)}`, {
      baseVersion: 1,
      patch: {
        title: '未完成执行',
        deliverables: ['可运行交付物'],
        acceptanceCriteria: ['可验收'],
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
    const tooEarly = await post(`/execution-approvals/${encodeURIComponent(executionId)}/decide`, {
      action: 'approve',
    });
    expect(tooEarly.status).toBe(409);
    expect(String(tooEarly.body['error'])).toBe('approval_not_open');
  });

  it('keeps exactly one decision under concurrent approval requests', async () => {
    const execution = await createExecution();
    const [left, right] = await Promise.all([
      post(`/execution-approvals/${encodeURIComponent(execution.executionId)}/decide`, {
        action: 'approve',
        reason: 'concurrent approval A',
      }),
      post(`/execution-approvals/${encodeURIComponent(execution.executionId)}/decide`, {
        action: 'approve',
        reason: 'concurrent approval B',
      }),
    ]);
    expect([200, 409]).toContain(left.status);
    expect([200, 409]).toContain(right.status);
    expect(left.status).toBe(200);
    const lists = await json('/execution-approvals');
    const decisions = rows(lists.body['history']).filter(
      (entry) => entry['executionId'] === execution.executionId,
    );
    expect(decisions).toHaveLength(1);
    const current = await json(`/executions/${encodeURIComponent(execution.executionId)}`);
    expect(current.body['status']).toBe('completed');
  });
});

describe('M3.6 execution approval · real events', () => {
  it('writes real Workflow approval events for approval and rejection', async () => {
    const history = await json('/theater/history?limit=800');
    const types = rows(history.body['events']).map((event) => String(event['type']));
    expect(types).toContain('Workflow.ApprovalRequested');
    expect(types).toContain('Workflow.ApprovalGranted');
    expect(types).toContain('Workflow.ApprovalDenied');
  });
});
