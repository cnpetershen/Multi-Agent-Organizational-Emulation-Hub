import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M3.5 · restart consistency.
 *
 * The execution record is in the planning store, the tasks/instance are rebuilt from the event
 * log, and the plan-derived definition is regenerated from the started event's `executionPlan`
 * context. This test closes the API and boots a fresh one over the same files; the execution
 * must remain the same run, not a new execution or an empty plan.
 */

type Json = Readonly<Record<string, unknown>>;
let dir = '';

function view(value: unknown): Json {
  return (typeof value === 'object' && value !== null ? value : {}) as Json;
}
function rows(value: unknown): readonly Json[] {
  return Array.isArray(value) ? (value as readonly Json[]) : [];
}

describe('M3.5 execution restart consistency', () => {
  it('keeps the same execution, workflow instance and first task across a restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'maoeh-m35-restart-'));
    const eventLogPath = join(dir, 'events.jsonl');
    const planningDir = join(dir, 'planning');
    let server = await startApiServer(0, {
      eventLogPath,
      planningDir,
      requirePlanConfirmation: true,
      tick: { activeIntervalMs: 60_000, idleIntervalMs: 60_000, pausedIntervalMs: 60_000 },
    });
    let base = `http://127.0.0.1:${String(server.port)}/api`;
    const json = async (path: string, init?: RequestInit) => {
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', connection: 'close', ...(init?.headers ?? {}) },
      });
      const text = await response.text();
      return { status: response.status, body: text === '' ? {} : view(JSON.parse(text) as unknown) };
    };
    const post = (path: string, body: unknown) =>
      json(path, { method: 'POST', body: JSON.stringify(body) });
    const put = (path: string, body: unknown) =>
      json(path, { method: 'PUT', body: JSON.stringify(body) });

    try {
      const analyzed = await post('/requirements/analyze', { goal: '做一份周报生成器' });
      const requirementId = String(analyzed.body['requirementId']);
      const answers: Record<string, string> = {};
      for (const question of rows(analyzed.body['clarifications'])) {
        if (question['blocking'] === true) answers[String(question['id'])] = '按周报场景执行。';
      }
      const updated = await put(`/requirements/${encodeURIComponent(requirementId)}`, {
        baseVersion: 1,
        patch: {
          title: '周报生成器',
          deliverables: ['可运行周报生成器'],
          acceptanceCriteria: ['员工可提交周报'],
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
      const executionId = String(started.body['executionId']);
      const instanceId = String(started.body['workflowInstanceId']);
      expect(started.body['status']).toBe('running');

      await server.close();

      server = await startApiServer(0, {
        eventLogPath,
        planningDir,
        requirePlanConfirmation: true,
        tick: { activeIntervalMs: 60_000, idleIntervalMs: 60_000, pausedIntervalMs: 60_000 },
      });
      base = `http://127.0.0.1:${String(server.port)}/api`;
      const restored = await json(`/executions/${encodeURIComponent(executionId)}`);
      expect(restored.status).toBe(200);
      expect(restored.body['executionId']).toBe(executionId);
      expect(restored.body['workflowInstanceId']).toBe(instanceId);
      expect(restored.body['planVersion']).toBe(confirmed.body['version']);
      expect(restored.body['status']).toBe('running');
      expect(rows(restored.body['tasks'])).toHaveLength(1);
      expect(rows(restored.body['tasks'])[0]?.['planNodeId']).toBe('node-1');
      const workflows = await json('/workflows');
      expect(rows(workflows.body).some((entry) => entry['instanceId'] === instanceId)).toBe(true);

      // Finish the recovered execution, approve it, then restart once more: the immutable
      // approval history must survive, not just the workflow instance.
      const tickOnce = async (): Promise<void> => {
        await fetch(`${base}/tick`, { method: 'POST' });
        await new Promise((resolve) => setTimeout(resolve, 2));
      };
      let awaiting = false;
      for (let index = 0; index < 180; index += 1) {
        const current = await json(`/executions/${encodeURIComponent(executionId)}`);
        if (current.body['status'] === 'awaiting_approval') {
          awaiting = true;
          break;
        }
        await tickOnce();
      }
      expect(awaiting).toBe(true);
      const decided = await post(
        `/execution-approvals/${encodeURIComponent(executionId)}/decide`,
        { action: 'approve', reason: 'restart approval persistence' },
      );
      expect(decided.status).toBe(200);
      expect(view(decided.body['decision'])['action']).toBe('approve');

      await server.close();
      server = await startApiServer(0, {
        eventLogPath,
        planningDir,
        requirePlanConfirmation: true,
        tick: { activeIntervalMs: 60_000, idleIntervalMs: 60_000, pausedIntervalMs: 60_000 },
      });
      base = `http://127.0.0.1:${String(server.port)}/api`;
      const restoredReview = await json(
        `/execution-approvals/${encodeURIComponent(executionId)}`,
      );
      expect(restoredReview.status).toBe(200);
      expect(view(restoredReview.body['execution'])['status']).toBe('completed');
      expect(rows(restoredReview.body['history'])).toHaveLength(1);
      expect(rows(restoredReview.body['history'])[0]?.['action']).toBe('approve');
      const lists = await json('/execution-approvals');
      expect(
        rows(lists.body['approved']).some((entry) => entry['executionId'] === executionId),
      ).toBe(true);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
