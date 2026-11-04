import { describe, expect, it } from 'vitest';
import { ApiError, parseTaskRecord, type Row } from '../../../apps/web/src/api';
import { deliverableState, employeeRole, resultOf } from '../../../apps/web/src/derive';

/**
 * M1.4 Deliverables: the pure logic behind the CEO workspace.
 *
 * The workspace groups work into Running / Need action / Completed, reads a delivery off a task
 * record, and names the role (never the person) that produced it. All three are pure functions
 * over the wire payload, so they are pinned here instead of through a render — and the record
 * parser is held to the console's contract rule: a payload the view cannot render is rejected
 * with the exact path, never silently defaulted.
 */

const employees = [
  { employeeId: 'ceo-alex', name: 'Alex', positionId: 'ceo' },
  { employeeId: 'cto-john', name: 'John', positionId: 'cto' },
];

const positions = [
  { positionId: 'ceo', title: 'Chief Executive Officer' },
  { positionId: 'cto', title: 'Chief Technology Officer' },
];

const recordRow: Row = {
  taskId: 'task-1',
  title: 'Quantify Q3 churn',
  status: 'submitted',
  goal: 'Publish the churn driver table with sources',
  detail: 'Enterprise accounts only',
  positionId: 'cto',
  assigneeEmployeeId: 'cto-john',
  workflowInstanceId: 'instance-1',
  workflowStepId: 'analysis',
  attempt: 1,
  maxAttempts: 3,
  createdAtSim: 4,
  completedAtSim: null,
  blockedReason: null,
  rejectReason: null,
  outputs: ['artifact-churn-table'],
  result: {
    taskId: 'task-1',
    producedBy: 'cto-john',
    summary: 'The churn driver table is published with citations.',
    data: { problem: 'churn is rising', findings: ['onboarding friction'] },
    artifacts: ['artifact-churn-table'],
  },
  reviews: [{ reviewerId: 'ceo-alex', verdict: 'approved', reason: 'meets the brief' }],
  verification: { kind: 'deterministic', requiredOutputKeys: ['problem', 'recommendation'] },
};

describe('deliverable states', () => {
  it('reads running work as running', () => {
    for (const status of ['created', 'assigned', 'accepted', 'started', '']) {
      expect(deliverableState(status, false).kind, status).toBe('running');
    }
  });

  it('reads stopped work as needing the owner', () => {
    for (const status of ['blocked', 'failed', 'rejected']) {
      const state = deliverableState(status, false);
      expect(state.kind, status).toBe('needAction');
      expect(state.tone).toBe('warn');
    }
  });

  it('reads an open approval gate as needing the owner even while the task runs', () => {
    expect(deliverableState('started', true).kind).toBe('needAction');
  });

  it('reads finished work as completed, and keeps cancelled work finished but labelled', () => {
    expect(deliverableState('completed', false)).toEqual({
      kind: 'completed',
      tone: 'ok',
      labelKey: 'deliverables.state.completed',
    });
    const cancelled = deliverableState('cancelled', false);
    expect(cancelled.kind).toBe('completed');
    expect(cancelled.labelKey).toBe('status.cancelled');
  });
});

describe('task record reads', () => {
  it('finds the submitted delivery on a record and nothing on a summary row', () => {
    expect(resultOf(recordRow)?.['summary']).toBe('The churn driver table is published with citations.');
    expect(resultOf({ taskId: 'task-2', status: 'assigned' })).toBeNull();
    expect(resultOf({ result: [] })).toBeNull();
    expect(resultOf({ result: null })).toBeNull();
  });

  it('names the role behind a delivery, never the person', () => {
    expect(employeeRole(employees, positions, 'cto-john')).toBe('Chief Technology Officer');
    expect(employeeRole(employees, positions, 'ghost')).toBe('');
    expect(employeeRole(employees, positions, '')).toBe('');
  });
});

describe('task record contract', () => {
  it('parses the fields the result view renders', () => {
    const record = parseTaskRecord(recordRow, 'GET /api/tasks/task-1');
    expect(record.taskId).toBe('task-1');
    expect(record.goal).toBe('Publish the churn driver table with sources');
    expect(record.detail).toBe('Enterprise accounts only');
    expect(record.blockedReason).toBeNull();
    expect(record.outputs).toEqual(['artifact-churn-table']);
    expect(record.workflowStepId).toBe('analysis');
    expect(record.createdAtSim).toBe(4);
    expect(record.completedAtSim).toBeNull();
    expect(record.result?.data['problem']).toBe('churn is rising');
    expect(record.verification?.requiredOutputKeys).toEqual(['problem', 'recommendation']);
    expect(record.reviews[0]?.verdict).toBe('approved');
  });

  it('accepts a task nobody has delivered into yet', () => {
    const record = parseTaskRecord({ ...recordRow, result: null, reviews: [], verification: null }, 'GET /api/tasks/task-1');
    expect(record.result).toBeNull();
    expect(record.reviews).toEqual([]);
    expect(record.verification).toBeNull();
  });

  it('rejects a payload the view cannot render, naming the field', () => {
    expect(() => parseTaskRecord({ ...recordRow, goal: '' }, 'GET /api/tasks/task-1')).toThrow(ApiError);
    expect(() => parseTaskRecord({ ...recordRow, goal: '' }, 'GET /api/tasks/task-1')).toThrow(/goal/);
    expect(() => parseTaskRecord({ ...recordRow, outputs: 'artifact' }, 'GET /api/tasks/task-1')).toThrow(/outputs/);
    expect(() => parseTaskRecord({ ...recordRow, result: { taskId: 'task-1' } }, 'GET /api/tasks/task-1')).toThrow(/producedBy/);
  });
});
