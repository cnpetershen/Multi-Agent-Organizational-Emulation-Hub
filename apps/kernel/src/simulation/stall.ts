import type { CompanyId, EmployeeId, SimTime } from '@maoeh/shared-types';
import type { Task, TaskStatus } from '@maoeh/task-system';

/**
 * Stall watchdog: an open task with no observed activity for too long must not leave the
 * worker half-assigned forever. The runtime observes both task events and explicit
 * heartbeats, so a long-running agent turn (model inference, then tool execution) is not
 * mistaken for a silent task, while a task that nobody is working on still converges.
 *
 * A heartbeat is a fact about *work being attempted* for a task:
 *   - `inference`: the assignee's agent turn is running its cognition call;
 *   - `tool`: a plan step is executing (Accept/Start/Submit/…);
 *   - `idle`: the turn finished; no further activity has been observed since.
 *
 * The watchdog never completes work: it fails (started) or rejects (accepted) with an explicit
 * reason that names itself. The workflow engine then consumes the terminal fact exactly as it
 * would have on the live path — failed branch, rejected branch, retry-or-abort per the
 * definition — so a stalled step converges instead of staying `running` forever.
 */

export const STALL_THRESHOLD_TICKS = 45;

/** Maximum continuation wakeups per task before the watchdog is allowed to act. */
export const MAX_TASK_CONTINUATIONS = 3;

const STALLED_STATUSES: readonly TaskStatus[] = ['accepted', 'started'];

export type TaskActivityPhase = 'inference' | 'tool' | 'idle';

export interface TaskHeartbeat {
  readonly atSim: SimTime;
  readonly phase: TaskActivityPhase;
}

export interface StallOptions {
  /**
   * Instances whose workflow is paused. A paused step's task is intentionally untouched and
   * must not be failed/rejected by wall/clock progress alone.
   */
  readonly pausedWorkflowIds?: ReadonlySet<string>;
}

export interface StallAction {
  readonly taskId: string;
  readonly action: 'reject' | 'fail';
  readonly reason: string;
}

export function noteTaskHeartbeat(
  heartbeats: Map<string, TaskHeartbeat>,
  taskIds: Iterable<string>,
  simTime: SimTime,
  phase: TaskActivityPhase,
): void {
  for (const taskId of taskIds) {
    heartbeats.set(taskId, { atSim: simTime, phase });
  }
}

/**
 * The tick-side event bookkeeping: a Task.* event is the strongest form of activity and
 * records the tool phase. Called with input events, agent-cycle events and watchdog events.
 */
export function noteTaskActivity(
  heartbeats: Map<string, TaskHeartbeat>,
  events: readonly {
    readonly type: string;
    readonly subjectType: string | null;
    readonly subjectId: string | null;
    readonly occurredAtSim: SimTime | number;
  }[],
): void {
  for (const event of events) {
    if (event.subjectType !== 'task') continue;
    const subjectId = event.subjectId;
    if (subjectId === null) continue;
    if (!String(event.type).startsWith('Task.')) continue;
    heartbeats.set(subjectId, {
      atSim: Number(event.occurredAtSim) as SimTime,
      phase: 'tool',
    });
  }
}

function statusOf(task: Task): string {
  return String(task.status);
}

function heartbeatAt(
  heartbeats: ReadonlyMap<string, TaskHeartbeat | SimTime>,
  task: Task,
): SimTime {
  const heartbeat = heartbeats.get(task.taskId);
  if (heartbeat === undefined) return Number(task.createdAtSim) as SimTime;
  if (typeof heartbeat === 'number') return Number(heartbeat) as SimTime;
  return Number(heartbeat.atSim) as SimTime;
}

/**
 * Pure decision. `heartbeats` is the in-memory activity map the tick maintains; tasks the
 * process has never observed fall back to `createdAtSim`, which keeps a restarted watchdog
 * honest about a stall that predates the boot. The tick seeds the map from the log before the
 * first decision, so an old task with a recent event is not a false positive.
 */
export function stalledTasks(
  tasks: readonly Task[],
  heartbeats: ReadonlyMap<string, TaskHeartbeat | SimTime>,
  companyId: string,
  simTime: SimTime,
  thresholdTicks: number = STALL_THRESHOLD_TICKS,
  options: StallOptions = {},
): readonly StallAction[] {
  const actions: StallAction[] = [];
  const seen = new Set<string>();
  const paused = options.pausedWorkflowIds;
  for (const task of tasks) {
    if (seen.has(task.taskId)) continue;
    if (!STALLED_STATUSES.includes(task.status)) continue;
    if (String(task.companyId) !== companyId) continue;
    if (
      paused !== undefined &&
      task.workflowInstanceId !== null &&
      paused.has(task.workflowInstanceId)
    ) {
      continue;
    }
    const last = heartbeatAt(heartbeats, task);
    if (Number(simTime) - Number(last) < thresholdTicks) continue;
    const heartbeat = heartbeats.get(task.taskId);
    const phase =
      heartbeat === undefined || typeof heartbeat === 'number' ? 'unknown' : heartbeat.phase;
    const reason =
      task.status === 'accepted'
        ? `stalled: task was accepted but never started for more than ${String(thresholdTicks)} ticks (last phase ${phase}) — rejected by the watchdog`
        : `stalled: started task saw no activity for more than ${String(thresholdTicks)} ticks (last phase ${phase}) — failed by the watchdog`;
    actions.push({
      taskId: task.taskId,
      action: task.status === 'accepted' ? 'reject' : 'fail',
      reason,
    });
    seen.add(task.taskId);
  }
  return Object.freeze(actions);
}

/**
 * Open tasks that need a deterministic follow-up turn: accepted-but-not-started and
 * started-but-not-submitted. The continuation wakeup is what turns "the model only emitted
 * AcceptTask/StartTask" into a next turn whose prompt says `next=StartTask` / `next=SubmitReport`,
 * instead of waiting for an unrelated event or a watchdog rejection.
 */
export function tasksAwaitingContinuation(
  tasks: readonly Task[],
  employeeId: EmployeeId,
  companyId: CompanyId,
  pausedWorkflowIds: ReadonlySet<string> = new Set(),
): readonly Task[] {
  return tasks.filter(
    (task) =>
      (statusOf(task) === 'accepted' || statusOf(task) === 'started') &&
      String(task.companyId) === String(companyId) &&
      task.assignment.assigneeEmployeeId === employeeId &&
      (task.workflowInstanceId === null || !pausedWorkflowIds.has(task.workflowInstanceId)),
  );
}
