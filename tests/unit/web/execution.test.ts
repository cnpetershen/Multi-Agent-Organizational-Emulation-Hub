import { describe, expect, it } from 'vitest';
import {
  executionStatusTone,
  parseExecution,
  parseExecutionList,
  taskStatusTone,
} from '../../../apps/web/src/execution';

/**
 * M3.5 · execution read model.
 *
 * The console renders only what the API reported. A missing task/result/artifact must stay
 * missing, and the existing TaskSystem status vocabulary is passed through unchanged.
 */

const EXECUTION = {
  executionId: 'exec-1',
  companyId: 'future-ai-lab',
  planId: 'plan-1',
  planVersion: 2,
  planTitle: 'Weekly report',
  orchestrationId: 'orch-1',
  requirementId: 'req-1',
  requirementVersion: 3,
  workflowInstanceId: 'execution-plan-1-v2',
  workflowId: 'generated-execution-plan-1-v2',
  status: 'awaiting_approval',
  startedAt: '2026-11-15T00:00:00.000Z',
  startedBy: 'ceo-alex',
  planConfirmedAt: '2026-11-15T00:00:00.000Z',
  planConfirmedBy: 'ceo-alex',
  tasks: [
    {
      taskId: 'task-1',
      planNodeId: 'node-1',
      title: 'Design',
      status: 'completed',
      assigneeEmployeeId: 'cto-john',
      assigneeName: 'John',
      attempt: 1,
      maxAttempts: 1,
      createdAtSim: 1,
      completedAtSim: 10,
      blockedReason: null,
      rejectReason: null,
      result: {
        summary: 'Delivered design',
        artifacts: ['design.md'],
        data: { 'design.md': '# Design' },
      },
    },
  ],
  summary: {
    taskCount: 3,
    completedCount: 3,
    failedCount: 0,
    activeCount: 0,
    allTasksCompleted: true,
    artifacts: ['design.md'],
  },
  approval: {
    stepId: 'node-approve',
    status: 'open',
    requiredCount: 1,
    grantedBy: [],
    decidedBy: null,
    requestedAtSim: 12,
  },
};

describe('M3.5 execution view', () => {
  it('parses real task states and artifacts without inventing fields', () => {
    const execution = parseExecution(EXECUTION);
    expect(execution.status).toBe('awaiting_approval');
    expect(execution.tasks).toHaveLength(1);
    expect(execution.tasks[0]).toMatchObject({
      status: 'completed',
      assigneeName: 'John',
      result: { summary: 'Delivered design', artifacts: ['design.md'] },
    });
    expect(execution.approval?.status).toBe('open');
    expect(execution.summary.allTasksCompleted).toBe(true);

    const minimal = parseExecution({ executionId: 'exec-2', status: 'running' });
    expect(minimal.tasks).toEqual([]);
    expect(minimal.summary.taskCount).toBe(0);
    expect(minimal.approval).toBeNull();
  });

  it('parses the list envelope', () => {
    expect(parseExecutionList({ executions: [EXECUTION] })).toHaveLength(1);
    expect(parseExecutionList({ executions: [] })).toEqual([]);
    expect(parseExecutionList({})).toEqual([]);
  });

  it('maps the existing task status vocabulary to tones', () => {
    expect(executionStatusTone('awaiting_approval')).toBe('warn');
    expect(executionStatusTone('completed')).toBe('ok');
    expect(executionStatusTone('failed')).toBe('bad');
    expect(taskStatusTone('rejected')).toBe('bad');
    expect(taskStatusTone('blocked')).toBe('warn');
    expect(taskStatusTone('completed')).toBe('ok');
  });
});
