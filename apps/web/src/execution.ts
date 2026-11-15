import { readNumber, readString, type Row } from './api';

/**
 * M3.5 · execution read model.
 *
 * The API returns the workflow instance's real task states and the agents' real submissions. This
 * module only narrows that document; it never invents a task, a status or an artifact.
 */

export type ExecutionStatus =
  | 'not_started'
  | 'running'
  | 'awaiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ExecutionTaskView {
  readonly taskId: string;
  readonly planNodeId: string | null;
  readonly title: string;
  readonly status: string;
  readonly assigneeEmployeeId: string | null;
  readonly assigneeName: string | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly createdAtSim: number;
  readonly completedAtSim: number | null;
  readonly blockedReason: string | null;
  readonly rejectReason: string | null;
  readonly result: {
    readonly summary: string;
    readonly artifacts: readonly string[];
    readonly data: Readonly<Record<string, unknown>>;
  } | null;
}

export interface ExecutionView {
  readonly executionId: string;
  readonly companyId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly planTitle: string;
  readonly orchestrationId: string;
  readonly requirementId: string;
  readonly requirementVersion: number;
  readonly workflowInstanceId: string;
  readonly workflowId: string;
  readonly status: ExecutionStatus;
  readonly startedAt: string;
  readonly startedBy: string;
  readonly planConfirmedAt: string | null;
  readonly planConfirmedBy: string | null;
  readonly tasks: readonly ExecutionTaskView[];
  readonly summary: {
    readonly taskCount: number;
    readonly completedCount: number;
    readonly failedCount: number;
    readonly activeCount: number;
    readonly allTasksCompleted: boolean;
    readonly artifacts: readonly string[];
  };
  readonly approval: {
    readonly stepId: string;
    readonly status: string;
    readonly requiredCount: number;
    readonly grantedBy: readonly string[];
    readonly decidedBy: string | null;
    readonly requestedAtSim: number | null;
  } | null;
}

function objectOf(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as readonly unknown[]).map((entry) => readString(entry, '')).filter((entry) => entry !== '')
    : [];
}

function statusOf(value: unknown): ExecutionStatus {
  const status = readString(value, 'not_started');
  return [
    'running',
    'awaiting_approval',
    'paused',
    'completed',
    'failed',
    'cancelled',
    'not_started',
  ].includes(status)
    ? (status as ExecutionStatus)
    : 'not_started';
}

export function parseExecution(value: unknown): ExecutionView {
  const row = objectOf(value);
  const summary = objectOf(row['summary']);
  const approval = objectOf(row['approval']);
  const tasks = Array.isArray(row['tasks'])
    ? (row['tasks'] as readonly unknown[]).map((entry) => {
        const task = objectOf(entry);
        const result = task['result'] === null ? null : objectOf(task['result']);
        return {
          taskId: readString(task['taskId'], ''),
          planNodeId: typeof task['planNodeId'] === 'string' ? task['planNodeId'] : null,
          title: readString(task['title'], ''),
          status: readString(task['status'], 'created'),
          assigneeEmployeeId:
            typeof task['assigneeEmployeeId'] === 'string' ? task['assigneeEmployeeId'] : null,
          assigneeName: typeof task['assigneeName'] === 'string' ? task['assigneeName'] : null,
          attempt: readNumber(task['attempt'], 1),
          maxAttempts: readNumber(task['maxAttempts'], 1),
          createdAtSim: readNumber(task['createdAtSim'], 0),
          completedAtSim:
            typeof task['completedAtSim'] === 'number' ? task['completedAtSim'] : null,
          blockedReason: typeof task['blockedReason'] === 'string' ? task['blockedReason'] : null,
          rejectReason: typeof task['rejectReason'] === 'string' ? task['rejectReason'] : null,
          result:
            result === null
              ? null
              : {
                  summary: readString(result['summary'], ''),
                  artifacts: strings(result['artifacts']),
                  data: objectOf(result['data']),
                },
        } satisfies ExecutionTaskView;
      })
    : [];
  return {
    executionId: readString(row['executionId'], ''),
    companyId: readString(row['companyId'], ''),
    planId: readString(row['planId'], ''),
    planVersion: readNumber(row['planVersion'], 1),
    planTitle: readString(row['planTitle'], ''),
    orchestrationId: readString(row['orchestrationId'], ''),
    requirementId: readString(row['requirementId'], ''),
    requirementVersion: readNumber(row['requirementVersion'], 1),
    workflowInstanceId: readString(row['workflowInstanceId'], ''),
    workflowId: readString(row['workflowId'], ''),
    status: statusOf(row['status']),
    startedAt: readString(row['startedAt'], ''),
    startedBy: readString(row['startedBy'], ''),
    planConfirmedAt:
      typeof row['planConfirmedAt'] === 'string' ? row['planConfirmedAt'] : null,
    planConfirmedBy:
      typeof row['planConfirmedBy'] === 'string' ? row['planConfirmedBy'] : null,
    tasks,
    summary: {
      taskCount: readNumber(summary['taskCount'], tasks.length),
      completedCount: readNumber(summary['completedCount'], 0),
      failedCount: readNumber(summary['failedCount'], 0),
      activeCount: readNumber(summary['activeCount'], 0),
      allTasksCompleted: summary['allTasksCompleted'] === true,
      artifacts: strings(summary['artifacts']),
    },
    approval:
      row['approval'] === null || row['approval'] === undefined
        ? null
        : {
            stepId: readString(approval['stepId'], ''),
            status: readString(approval['status'], 'open'),
            requiredCount: readNumber(approval['requiredCount'], 1),
            grantedBy: strings(approval['grantedBy']),
            decidedBy: typeof approval['decidedBy'] === 'string' ? approval['decidedBy'] : null,
            requestedAtSim:
              typeof approval['requestedAtSim'] === 'number'
                ? approval['requestedAtSim']
                : null,
          },
  };
}

export function parseExecutionList(value: unknown): ExecutionView[] {
  const row = objectOf(value);
  return Array.isArray(row['executions'])
    ? (row['executions'] as readonly unknown[]).map(parseExecution).filter((entry) => entry.executionId !== '')
    : [];
}

export function executionStatusTone(status: ExecutionStatus): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (status === 'completed') return 'ok';
  if (status === 'awaiting_approval') return 'warn';
  if (status === 'failed' || status === 'cancelled') return 'bad';
  return status === 'running' ? 'ok' : 'neutral';
}

export function taskStatusTone(status: string): 'ok' | 'warn' | 'bad' | 'neutral' {
  if (status === 'completed') return 'ok';
  if (status === 'rejected' || status === 'cancelled') return 'bad';
  if (status === 'blocked') return 'warn';
  return status === 'started' || status === 'submitted' ? 'ok' : 'neutral';
}
