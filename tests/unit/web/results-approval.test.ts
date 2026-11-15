import { describe, expect, it } from 'vitest';
import type { Row } from '../../../apps/web/src/api';
import { resultApprovalOf } from '../../../apps/web/src/result-approval';

function workflow(overrides: Partial<Row> = {}): Row {
  return {
    instanceId: 'instance-1',
    title: 'Ship the dashboard',
    goal: 'Give the team a live SLA board',
    status: 'blocked',
    approval: { stepId: 'step-approve', status: 'open', requiredCount: 1, grantedBy: [] },
    blockedReason: { kind: 'approval', detail: 'awaiting approval on step-approve' },
    activeStepIds: ['step-approve'],
    steps: [
      { stepId: 'step-1', name: 'Product Requirement', kind: 'task', status: 'done', taskId: 'task-1' },
      { stepId: 'step-2', name: 'Implementation', kind: 'task', status: 'done', taskId: 'task-2' },
      { stepId: 'step-approve', name: 'Approve generated delivery', kind: 'approval', status: 'active', taskId: null },
    ],
    ...overrides,
  };
}

describe('M2 Results approval projection', () => {
  it('reads the open gate, its reason and the delivered tasks', () => {
    const view = resultApprovalOf(workflow());
    expect(view).not.toBeNull();
    expect(view?.instanceId).toBe('instance-1');
    expect(view?.stepId).toBe('step-approve');
    expect(view?.stepName).toBe('Approve generated delivery');
    expect(view?.detail).toBe('awaiting approval on step-approve');
    expect(view?.requiredCount).toBe(1);
    expect(view?.grantedCount).toBe(0);
    expect(view?.tasks.map((task) => task.taskId)).toEqual(['task-1', 'task-2']);
  });

  it('is actionable only while the gate is open', () => {
    expect(resultApprovalOf(null)).toBeNull();
    expect(resultApprovalOf(workflow({ approval: null }))).toBeNull();
    expect(
      resultApprovalOf(
        workflow({ approval: { stepId: 'step-approve', status: 'granted', requiredCount: 1, grantedBy: ['ceo'] } }),
      ),
    ).toBeNull();
    expect(resultApprovalOf(workflow({ approval: [] }))).toBeNull();
  });

  it('excludes steps that never handed out a task and caps the list', () => {
    const steps = Array.from({ length: 9 }, (_, index) => ({
      stepId: `step-${String(index + 1)}`,
      name: `Step ${String(index + 1)}`,
      kind: 'task',
      status: 'done',
      taskId: `task-${String(index + 1)}`,
    }));
    const view = resultApprovalOf(workflow({ steps }));
    expect(view?.tasks).toHaveLength(6);
    expect(view?.tasks[0]?.taskId).toBe('task-1');
  });
});
