import { describe, expect, it } from 'vitest';
import {
  approvalActionTone,
  artifactContent,
  parseApprovalLists,
  parseApprovalRecord,
  parseExecutionReview,
} from '../../../apps/web/src/approval';

/**
 * M3.6 · approval read model.
 *
 * The workbench must show the agent's real data and keep a decision's before/after transition.
 * These tests only narrow documents; no decision is inferred by the UI.
 */

const EXECUTION = {
  executionId: 'exec-1',
  planId: 'plan-1',
  planVersion: 2,
  planTitle: 'Weekly report',
  status: 'awaiting_approval',
  startedBy: 'ceo-alex',
  tasks: [
    {
      taskId: 'task-1',
      planNodeId: 'node-1',
      title: 'Design',
      status: 'completed',
      assigneeName: 'John',
      attempt: 1,
      maxAttempts: 1,
      result: {
        summary: 'Delivered design',
        artifacts: ['design.md', 'app.html'],
        data: { 'design.md': '# Design', files: [{ path: 'app.html', content: '<h1>App</h1>' }] },
      },
    },
  ],
  summary: { taskCount: 1, completedCount: 1, failedCount: 0, activeCount: 0, allTasksCompleted: true, artifacts: ['design.md'] },
  approval: { stepId: 'node-approve', status: 'open', requiredCount: 1, grantedBy: [] },
};

const RECORD = {
  approvalId: 'approval-1',
  executionId: 'exec-1',
  planId: 'plan-1',
  planVersion: 2,
  workflowInstanceId: 'execution-plan-1-v2',
  approvalKey: 'instance:node-approve',
  approvalStepId: 'node-approve',
  action: 'request_changes',
  reason: 'Missing history check',
  decidedBy: 'ceo-alex',
  decidedAt: '2026-11-15T00:00:00.000Z',
  taskIds: ['task-1'],
  artifacts: ['design.md'],
  before: { executionStatus: 'awaiting_approval', approvalStatus: 'open', workflowStatus: 'blocked' },
  after: { executionStatus: 'failed', approvalStatus: 'denied', workflowStatus: 'aborted' },
};

describe('M3.6 approval view', () => {
  it('parses a review with real tasks and history', () => {
    const review = parseExecutionReview({
      execution: EXECUTION,
      plan: { planId: 'plan-1', version: 2, nodes: [{ nodeId: 'node-1', title: 'Design', acceptance: ['reviewed'] }] },
      history: [RECORD],
    });
    expect(review.execution.tasks[0]?.result?.artifacts).toEqual(['design.md', 'app.html']);
    expect(review.history[0]).toMatchObject({
      action: 'request_changes',
      reason: 'Missing history check',
      after: { executionStatus: 'failed' },
    });
    expect(review.plan?.version).toBe(2);
  });

  it('parses pending/history/approved lists', () => {
    const lists = parseApprovalLists({
      pending: [{ executionId: 'exec-1', planId: 'plan-1', planVersion: 2, planTitle: 'Weekly report' }],
      history: [RECORD],
      approved: [],
    });
    expect(lists.pending).toHaveLength(1);
    expect(lists.history[0]?.approvalId).toBe('approval-1');
    expect(lists.approved).toEqual([]);
  });

  it('finds inline artifact content in both supported real data shapes', () => {
    expect(artifactContent({ 'design.md': '# Design' }, 'design.md')).toBe('# Design');
    expect(
      artifactContent({ files: [{ path: 'app.html', content: '<h1>App</h1>' }] }, 'app.html'),
    ).toBe('<h1>App</h1>');
    expect(artifactContent({}, 'missing.md')).toBeNull();
    expect(artifactContent({ report: { lines: 2 } }, 'report')).toContain('"lines": 2');
  });

  it('maps decisions to display tones', () => {
    expect(approvalActionTone('approve')).toBe('ok');
    expect(approvalActionTone('reject')).toBe('bad');
    expect(approvalActionTone('request_changes')).toBe('warn');
    expect(parseApprovalRecord({ approvalId: 'a', action: 'unknown' }).action).toBe('approve');
  });
});
