import { readNumber, readString, type Row } from './api';

/**
 * M2: what the Results page needs to show a real approval: the gate, the task(s) whose work is
 * being accepted, and the execution result the operator is judging. It is a pure projection of
 * `/api/workflows` rows — the page never keeps an "approved" boolean of its own.
 */
export interface ResultApprovalTask {
  readonly taskId: string;
  readonly stepId: string;
  readonly stepName: string;
  readonly status: string;
}

export interface ResultApprovalView {
  readonly instanceId: string;
  readonly title: string;
  readonly goal: string;
  readonly stepId: string;
  readonly stepName: string;
  readonly detail: string;
  readonly requiredCount: number;
  readonly grantedCount: number;
  readonly tasks: readonly ResultApprovalTask[];
}

function rowsOf(value: unknown): readonly Row[] {
  return Array.isArray(value) ? (value as readonly Row[]) : [];
}

function recordOf(value: unknown): Row | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : null;
}

/**
 * The open gate for one workflow, or `null`. Only an `open` approval is an actionable item;
 * a granted/denied gate stays in the workflow history, not in the Results inbox.
 */
export function resultApprovalOf(workflow: Row | null): ResultApprovalView | null {
  if (workflow === null) return null;
  const approval = recordOf(workflow['approval']);
  if (approval === null) return null;
  if (readString(approval['status'], '') !== 'open') return null;
  const instanceId = readString(workflow['instanceId'], '');
  const stepId = readString(approval['stepId'], '');
  if (instanceId === '' || stepId === '') return null;
  const steps = rowsOf(workflow['steps']);
  const step = steps.find((row) => readString(row['stepId'], '') === stepId) ?? null;
  const grantedBy = Array.isArray(approval['grantedBy']) ? approval['grantedBy'] : [];
  const tasks = steps
    .map((row): ResultApprovalTask | null => {
      const taskId = readString(row['taskId'], '');
      if (taskId === '') return null;
      const status = readString(row['status'], '');
      if (status !== 'done' && status !== 'active' && status !== 'rejected') return null;
      return {
        taskId,
        stepId: readString(row['stepId'], ''),
        stepName: readString(row['name'], readString(row['stepId'], '')),
        status,
      };
    })
    .filter((entry): entry is ResultApprovalTask => entry !== null)
    .slice(0, 6);
  const blocked = recordOf(workflow['blockedReason']);
  return {
    instanceId,
    title: readString(workflow['title'], instanceId),
    goal: readString(workflow['goal'], ''),
    stepId,
    stepName: step === null ? stepId : readString(step['name'], stepId),
    detail: blocked === null ? '' : readString(blocked['detail'], ''),
    requiredCount: Math.max(1, Math.trunc(readNumber(approval['requiredCount'], 1))),
    grantedCount: grantedBy.length,
    tasks,
  };
}
