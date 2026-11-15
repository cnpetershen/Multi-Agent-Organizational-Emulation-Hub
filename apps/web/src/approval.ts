import { readNumber, readString, type Row } from './api';
import { parseExecution, type ExecutionView } from './execution';
import { parsePlan, type PlanView } from './plan';

/**
 * M3.6 · approval read model.
 *
 * The workbench renders the execution's real tasks/results and the plan's acceptance criteria.
 * Approval records are immutable decisions read from the API; this module does not infer them.
 */

export type ApprovalAction = 'approve' | 'reject' | 'request_changes';

export interface ApprovalRecordView {
  readonly approvalId: string;
  readonly executionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly workflowInstanceId: string;
  readonly approvalKey: string;
  readonly approvalStepId: string;
  readonly action: ApprovalAction;
  readonly reason: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly taskIds: readonly string[];
  readonly artifacts: readonly string[];
  readonly before: { readonly executionStatus: string; readonly approvalStatus: string; readonly workflowStatus: string };
  readonly after: { readonly executionStatus: string; readonly approvalStatus: string; readonly workflowStatus: string };
}

export interface ApprovalSummaryView {
  readonly executionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly planTitle: string;
  readonly status: string;
  readonly taskCount: number;
  readonly completedCount: number;
  readonly artifacts: readonly string[];
  readonly startedAt: string;
  readonly startedBy: string;
  readonly approvalRequestedAtSim: number | null;
  readonly approvalStatus: string | null;
}

export interface ExecutionReviewView {
  readonly execution: ExecutionView;
  readonly plan: PlanView | null;
  readonly history: readonly ApprovalRecordView[];
}

function objectOf(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as readonly unknown[]).map((entry) => readString(entry, '')).filter((entry) => entry !== '')
    : [];
}

function actionOf(value: unknown): ApprovalAction {
  return value === 'reject' || value === 'request_changes' ? value : 'approve';
}

export function parseApprovalRecord(value: unknown): ApprovalRecordView {
  const row = objectOf(value);
  const before = objectOf(row['before']);
  const after = objectOf(row['after']);
  return {
    approvalId: readString(row['approvalId'], ''),
    executionId: readString(row['executionId'], ''),
    planId: readString(row['planId'], ''),
    planVersion: readNumber(row['planVersion'], 1),
    workflowInstanceId: readString(row['workflowInstanceId'], ''),
    approvalKey: readString(row['approvalKey'], ''),
    approvalStepId: readString(row['approvalStepId'], ''),
    action: actionOf(row['action']),
    reason: typeof row['reason'] === 'string' ? row['reason'] : null,
    decidedBy: readString(row['decidedBy'], ''),
    decidedAt: readString(row['decidedAt'], ''),
    taskIds: strings(row['taskIds']),
    artifacts: strings(row['artifacts']),
    before: {
      executionStatus: readString(before['executionStatus'], ''),
      approvalStatus: readString(before['approvalStatus'], ''),
      workflowStatus: readString(before['workflowStatus'], ''),
    },
    after: {
      executionStatus: readString(after['executionStatus'], ''),
      approvalStatus: readString(after['approvalStatus'], ''),
      workflowStatus: readString(after['workflowStatus'], ''),
    },
  };
}

export function parseApprovalSummary(value: unknown): ApprovalSummaryView {
  const row = objectOf(value);
  return {
    executionId: readString(row['executionId'], ''),
    planId: readString(row['planId'], ''),
    planVersion: readNumber(row['planVersion'], 1),
    planTitle: readString(row['planTitle'], ''),
    status: readString(row['status'], ''),
    taskCount: readNumber(row['taskCount'], 0),
    completedCount: readNumber(row['completedCount'], 0),
    artifacts: strings(row['artifacts']),
    startedAt: readString(row['startedAt'], ''),
    startedBy: readString(row['startedBy'], ''),
    approvalRequestedAtSim:
      typeof row['approvalRequestedAtSim'] === 'number' ? row['approvalRequestedAtSim'] : null,
    approvalStatus: typeof row['approvalStatus'] === 'string' ? row['approvalStatus'] : null,
  };
}

export function parseExecutionReview(value: unknown): ExecutionReviewView {
  const row = objectOf(value);
  return {
    execution: parseExecution(row['execution']),
    plan: row['plan'] === null || row['plan'] === undefined ? null : parsePlan(row['plan']),
    history: Array.isArray(row['history'])
      ? (row['history'] as readonly unknown[]).map(parseApprovalRecord).filter((entry) => entry.approvalId !== '')
      : [],
  };
}

export interface ApprovalLists {
  readonly pending: readonly ApprovalSummaryView[];
  readonly history: readonly ApprovalRecordView[];
  readonly approved: readonly ApprovalRecordView[];
}

export function parseApprovalLists(value: unknown): ApprovalLists {
  const row = objectOf(value);
  return {
    pending: Array.isArray(row['pending'])
      ? (row['pending'] as readonly unknown[]).map(parseApprovalSummary).filter((entry) => entry.executionId !== '')
      : [],
    history: Array.isArray(row['history'])
      ? (row['history'] as readonly unknown[]).map(parseApprovalRecord).filter((entry) => entry.approvalId !== '')
      : [],
    approved: Array.isArray(row['approved'])
      ? (row['approved'] as readonly unknown[]).map(parseApprovalRecord).filter((entry) => entry.approvalId !== '')
      : [],
  };
}

/** Locate the content for one artifact in the agent's real result data. */
export function artifactContent(
  data: Readonly<Record<string, unknown>>,
  artifact: string,
): string | null {
  const direct = data[artifact];
  if (typeof direct === 'string') return direct;
  const files = data['files'];
  if (Array.isArray(files)) {
    for (const entry of files) {
      if (typeof entry !== 'object' || entry === null) continue;
      const file = entry as Row;
      if (readString(file['path'], '') === artifact && typeof file['content'] === 'string') {
        return file['content'];
      }
    }
  }
  if (typeof data['content'] === 'string' && artifact.toLowerCase().endsWith('.html')) {
    return data['content'];
  }
  if (direct !== undefined) return JSON.stringify(direct, null, 2).slice(0, 4000);
  return null;
}

export function approvalActionTone(action: ApprovalAction): 'ok' | 'bad' | 'warn' {
  return action === 'approve' ? 'ok' : action === 'reject' ? 'bad' : 'warn';
}
