import type {
  ActorKind,
  CompanyId,
  EmployeeId,
  OrgEvent,
  PositionId,
  SimTime,
} from '@maoeh/shared-types';

export const TASK_STATUSES = [
  'created',
  'assigned',
  'accepted',
  'started',
  'blocked',
  'submitted',
  'completed',
  'rejected',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = [
  'completed',
  'cancelled',
];

export type TaskCommand =
  | 'assign'
  | 'accept'
  | 'start'
  | 'block'
  | 'unblock'
  | 'report'
  | 'submit'
  | 'complete'
  | 'reject'
  | 'fail'
  | 'cancel'
  | 'review';

/**
 * The task state machine, as data: which command each status accepts.
 *
 * It lives beside the statuses because it *is* the status contract, and it is exported because
 * more than the service needs to describe it: the runtime renders each open task's legal next
 * commands into the cognition prompt. A live planner that could not see that `submit` requires
 * `started` planned `AcceptTask` + `SubmitReport`, then burned four retries on
 * `invalid_transition` while the task sat at `accepted` — the state machine is not something a
 * prompt should have to guess.
 */
export const ALLOWED_TASK_COMMANDS: Readonly<Record<TaskStatus, readonly TaskCommand[]>> = {
  created: ['assign', 'cancel'],
  assigned: ['assign', 'accept', 'reject', 'cancel'],
  accepted: ['start', 'reject', 'cancel'],
  started: ['block', 'submit', 'report', 'reject', 'fail', 'cancel'],
  blocked: ['unblock', 'cancel'],
  submitted: ['complete', 'reject', 'fail', 'cancel', 'review'],
  completed: [],
  rejected: ['assign', 'cancel'],
  cancelled: [],
};

/** The commands a task in `status` accepts right now — empty for a terminal status. */
export function allowedTaskCommands(status: TaskStatus): readonly TaskCommand[] {
  return ALLOWED_TASK_COMMANDS[status];
}

export type TaskAssignmentKind = 'employee' | 'position' | 'unassigned';

export type TaskAssignmentInput =
  | { readonly kind: 'employee'; readonly employeeId: EmployeeId }
  | { readonly kind: 'position'; readonly positionId: PositionId }
  | { readonly kind: 'unassigned' };

export interface TaskAssignment {
  readonly kind: TaskAssignmentKind;
  readonly positionId: PositionId | null;
  readonly targetEmployeeId: EmployeeId | null;
  readonly assigneeEmployeeId: EmployeeId | null;
  readonly actingEmployeeId: EmployeeId | null;
}

export const TASK_VERIFICATION_KINDS = ['deterministic', 'review'] as const;

export type TaskVerificationKind = (typeof TASK_VERIFICATION_KINDS)[number];

export interface TaskVerification {
  readonly kind: TaskVerificationKind;
  readonly requiredOutputKeys: readonly string[];
}

export interface TaskResult {
  readonly taskId: string;
  readonly producedBy: EmployeeId;
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly string[];
}

export interface TaskReview {
  readonly reviewerId: EmployeeId;
  readonly verdict: 'approved' | 'rejected';
  readonly reason: string | null;
  readonly reviewedAtSim: SimTime;
}

export interface Task {
  readonly taskId: string;
  readonly companyId: CompanyId;
  readonly title: string;
  readonly goal: string;
  readonly detail: string | null;
  readonly workflowInstanceId: string | null;
  readonly workflowStepId: string | null;
  readonly assignment: TaskAssignment;
  readonly createdByKind: ActorKind;
  readonly createdById: EmployeeId | null;
  readonly status: TaskStatus;
  readonly priority: number;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly rejectReason: string | null;
  readonly blockedReason: string | null;
  readonly blockedFrom: TaskStatus | null;
  readonly requiredSkills: readonly string[];
  /**
   * The *kind of work* this task is, when the work came from a step that declared one
   * (a generated workflow's stage per capability, or a template step with a capability
   * assignment). `null` for work nobody labelled.
   *
   * This exists because the executor's brief and the delivery contract both need to know
   * "am I the backend step?" — a seat with several tags cannot answer that about itself, and
   * the step name is prose. The wake-up event carries it (see `Task.Assigned`), so the agent
   * that shapes the work product reads it from the same event it was woken by.
   */
  readonly capability: string | null;
  /**
   * Why the latest `Task.Assigned` picked its target: the operator's reason, or the
   * capability-match rationale. `null` until the task has been assigned at least once.
   */
  readonly assignmentReason: string | null;
  /**
   * The required capabilities the assignee actually covered when the latest assignment was
   * made — the "why this agent" evidence the console shows next to the assignee.
   */
  readonly matchedCapabilities: readonly string[];
  readonly verification: TaskVerification | null;
  readonly outputs: readonly string[];
  readonly result: TaskResult | null;
  readonly reviews: readonly TaskReview[];
  readonly correlationId: string;
  readonly createdAtSim: SimTime;
  readonly dueAtSim: SimTime | null;
  readonly startedAtSim: SimTime | null;
  readonly submittedAtSim: SimTime | null;
  readonly completedAtSim: SimTime | null;
  readonly sourceEventId: string;
}

export interface TaskSubmissionInput {
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly artifacts?: readonly string[];
}

export interface TaskReviewInput {
  readonly verdict: 'approved' | 'rejected';
  readonly reason?: string | null;
}

export interface TaskOperation {
  readonly task: Task;
  readonly events: readonly OrgEvent[];
}

/**
 * What a deletion leaves behind.
 *
 * There is no `task` field on purpose: the record no longer exists, so handing the caller a
 * snapshot would invite it to treat a deleted task as live state. Only the events, which are
 * on the log forever, survive the call.
 */
export interface TaskDeleteOperation {
  readonly taskId: string;
  readonly events: readonly OrgEvent[];
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return TASK_TERMINAL_STATUSES.includes(status);
}

export function executorIdOf(task: Task): EmployeeId | null {
  return task.assignment.actingEmployeeId ?? task.assignment.assigneeEmployeeId;
}
