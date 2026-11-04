import type {
  Action,
  DecisionDomain,
  EmployeeId,
  OrgEvent,
  PositionId,
  Result,
  SimTime,
} from '@maoeh/shared-types';
import type { Organization } from '@maoeh/organization-model';
import { createOrgGraph, isExecutableEmployment } from '@maoeh/organization-model';
import type { AuthzService, CommandActor } from '@maoeh/permission-system';
import {
  commandActorId,
  commandActorKind,
  commandCorrelationId,
  resourceRef,
  validateActorLegitimacy,
} from '@maoeh/permission-system';
import type { EventRegistry } from '@maoeh/event-system';
import { createOrgEvent } from '@maoeh/event-system';
import type { TaskFailure, TaskIssue } from './task-errors.js';
import {
  taskError,
  taskFailure,
  taskIssue,
  taskPermissionFailure,
} from './task-errors.js';
import type { TaskStore } from './task-store.js';
import { createInMemoryTaskStore } from './task-store.js';
import { applyTaskEvent } from './task-fold.js';
import type {
  Task,
  TaskAssignmentInput,
  TaskCommand,
  TaskDeleteOperation,
  TaskOperation,
  TaskStatus,
  TaskSubmissionInput,
  TaskReviewInput,
  TaskVerification,
} from './task-types.js';
import { executorIdOf } from './task-types.js';import {
  TASK_ACCEPTED,
  TASK_ASSIGNED,
  TASK_BLOCKED,
  TASK_CANCELLED,
  TASK_COMPLETED,
  TASK_CREATED,
  TASK_DELETED,
  TASK_FAILED,
  TASK_PROGRESS_REPORTED,
  TASK_REJECTED,
  TASK_STARTED,
} from './task-events.js';
import { taskSubmissionSchema } from './task-validation.js';

const ALLOWED_COMMANDS: Readonly<Record<TaskStatus, readonly TaskCommand[]>> = {
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

/**
 * Employment states that cannot take work (04-agent-lifecycle §4.1). M1.3 makes this list load
 * bearing at runtime: `Agent.Archive` moves an employee to `offboarded` while the process runs,
 * so "who holds this position" must be re-read from the live organization rather than assumed.
 *
 * The list itself lives in `organization-model`, beside `EmployeeStatus`, because the workflow
 * engine and the seat-holder resolution ask the same question — see
 * `isExecutableEmployment`.
 */

export interface TaskServiceOptions {
  readonly organization: Organization;
  readonly authz: AuthzService;
  readonly registry: EventRegistry;
  readonly store?: TaskStore;
  readonly eventIdGenerator: () => string;
  readonly taskIdGenerator: () => string;
}

export interface CreateTaskInput {
  readonly actor: CommandActor;
  readonly simTime: SimTime;
  readonly taskId?: string;
  readonly title: string;
  readonly goal: string;
  readonly detail?: string | null;
  readonly assignment: TaskAssignmentInput;
  readonly workflowInstanceId?: string | null;
  readonly workflowStepId?: string | null;
  readonly verification?: TaskVerification | null;
  readonly requiredSkills?: readonly string[];
  /**
   * The kind of work this task is, when its step declares one (`capability` on a generated
   * workflow stage, or on a template step whose assignment is capability-based). Left `null`
   * for work no step labelled — the delivery is then shaped from the executor's own tags.
   */
  readonly capability?: string | null;
  readonly priority?: number;
  readonly maxAttempts?: number;
  readonly dueAtSim?: SimTime | null;
}

export interface AssignTaskInput {
  readonly taskId: string;
  readonly actor: CommandActor;
  readonly simTime: SimTime;
  readonly assignment?: TaskAssignmentInput;
  readonly reason?: string | null;
  /** Capabilities the chosen assignee covers — written to the log as the "why this agent" evidence. */
  readonly matchedCapabilities?: readonly string[];
}

/**
 * Objectives held open while a decision is pending (A4 hiring gate).
 *
 * A hire request is not work for a seat — it is the original objectives parked under the
 * requester until the root decides. `holdForApproval` runs the legal create → assign → accept →
 * start → block chain as one domain act, so a caller can hold work without ever writing a task
 * directly (M1.4 acceptance 8 keeps the raw writes inside this package).
 */
export interface HoldTaskInput {
  readonly actor: CommandActor;
  readonly simTime: SimTime;
  readonly taskId: string;
  readonly title: string;
  readonly goal: string;
  readonly detail?: string | null;
  /** The employee who holds the objectives (the requester) while the decision is open. */
  readonly employeeId: EmployeeId;
  /** Why the work waits; a stable prefix callers can key on (e.g. `waiting_for_approval: …`). */
  readonly reason: string;
}

export interface DispatchTaskInput {
  readonly actor: CommandActor;
  readonly simTime: SimTime;
  /** The seat the work goes to. Dispatch granularity is the position, never an employee (ADR-014 P3). */
  readonly positionId: PositionId;
  readonly title: string;
  readonly goal: string;
  readonly detail?: string | null;
  readonly requiredSkills?: readonly string[];
  /** Required in effect (M1.4 A5): work without a verifiable output cannot be judged later. */
  readonly verification?: TaskVerification | null;
  readonly priority?: number;
  readonly dueAtSim?: SimTime | null;
  readonly maxAttempts?: number;
}

export interface ActorTaskInput {
  readonly taskId: string;
  readonly actor: CommandActor;
  readonly simTime: SimTime;
}

export interface ReasonTaskInput extends ActorTaskInput {
  readonly reason: string;
}

export interface ReportTaskInput extends ActorTaskInput {
  readonly summary: string;
}

export interface SubmitTaskInput extends ActorTaskInput {
  readonly submission: TaskSubmissionInput;
}

export interface CompleteTaskInput extends ActorTaskInput {
  readonly verification?: TaskVerification | null;
}

export interface ReviewTaskInput extends ActorTaskInput {
  readonly review: TaskReviewInput;
}

export interface TaskService {
  get(taskId: string): Task | null;
  all(): readonly Task[];
  create(input: CreateTaskInput): Result<TaskOperation, TaskFailure>;
  assign(input: AssignTaskInput): Result<TaskOperation, TaskFailure>;
  /**
   * Atomic create+assign for one position (M1.4 / ADR-014): the only entry an agent may use
   * to bring work into existence. `create`/`assign` stay ungated internals for the kernel
   * binding and `workflow-engine`; the A1–A6 gates live here so no caller can forget them.
   */
  dispatch(input: DispatchTaskInput): Result<TaskOperation, TaskFailure>;
  /**
   * Park the objectives as one recoverable item owned by the requester, blocked with `reason`
   * (A4 hiring gate). The legal chain runs inside the service, so agent-side code never writes a
   * task directly.
   */
  holdForApproval(input: HoldTaskInput): Result<TaskOperation, TaskFailure>;
  accept(input: ActorTaskInput): Result<TaskOperation, TaskFailure>;
  start(input: ActorTaskInput): Result<TaskOperation, TaskFailure>;
  report(input: ReportTaskInput): Result<TaskOperation, TaskFailure>;
  submit(input: SubmitTaskInput): Result<TaskOperation, TaskFailure>;
  block(input: ReasonTaskInput): Result<TaskOperation, TaskFailure>;
  unblock(input: ActorTaskInput): Result<TaskOperation, TaskFailure>;
  complete(input: CompleteTaskInput): Result<TaskOperation, TaskFailure>;
  reject(input: ReasonTaskInput): Result<TaskOperation, TaskFailure>;
  fail(input: ReasonTaskInput): Result<TaskOperation, TaskFailure>;
  cancel(input: ReasonTaskInput): Result<TaskOperation, TaskFailure>;
  review(input: ReviewTaskInput): Result<TaskOperation, TaskFailure>;
  /**
   * Remove the record. Not a status change: the stream folds back to `null` and the store drops
   * the entry, so a recovery rebuilds nothing. Every status is deletable — an operator cleaning
   * up the workspace is not bound by the task state machine.
   */
  delete(input: ReasonTaskInput): Result<TaskDeleteOperation, TaskFailure>;
}

/**
 * How many work items one brief may spawn (M1.4 §5.5 A4). Counted against the task store by
 * `correlationId`, so the cap is a projection of facts already on the log — it survives a
 * restart by replay with no separate counter to drift.
 */
const MAX_DISPATCHES_PER_BRIEF = 8;

export function createTaskService(options: TaskServiceOptions): TaskService {
  const { organization, authz, registry, eventIdGenerator } = options;
  const store = options.store ?? createInMemoryTaskStore();
  const graph = createOrgGraph(organization);
  const companyId = organization.company.id;

  const load = (taskId: string): Result<Task, TaskFailure> => {
    const task = store.get(taskId);
    if (task === null) {
      return {
        ok: false,
        error: taskError('unknown_task', 'taskId', `task "${taskId}" does not exist`),
      };
    }
    return { ok: true, value: task };
  };

  const validateActor = (actor: CommandActor): TaskFailure | null => {
    if (actor.kind === 'system') {
      if (actor.actorId === '') {
        return taskError('invalid_actor', 'actor.actorId', 'system actorId must not be empty');
      }
      if (actor.correlationId === '') {
        return taskError(
          'invalid_actor',
          'actor.correlationId',
          'system actor correlationId must not be empty',
        );
      }
      return null;
    }
    const issues = validateActorLegitimacy(organization, actor.context);
    return issues.length === 0
      ? null
      : taskFailure(
          'invalid_actor',
          issues.map((entry) => taskIssue(entry.field, entry.reason)),
        );
  };

  const authorize = (
    actor: CommandActor,
    action: Action,
    taskId: string,
  ): TaskFailure | null => {
    if (actor.kind === 'system') return null;
    const decision = authz.can(actor.context, action, resourceRef(`task:${taskId}`));
    return decision.allow ? null : taskPermissionFailure(action, decision);
  };

  const requireCommand = (
    task: Task,
    command: TaskCommand,
  ): TaskFailure | null => {
    if (ALLOWED_COMMANDS[task.status].includes(command)) return null;
    return taskError(
      'invalid_transition',
      'status',
      `command "${command}" is not allowed in status "${task.status}"`,
    );
  };

  const requireExecutor = (
    task: Task,
    actor: CommandActor,
  ): TaskFailure | null => {
    if (actor.kind === 'system') return null;
    const executor = executorIdOf(task);
    if (executor === null) {
      return taskError(
        'not_assignee',
        'actor.employeeId',
        `task "${task.taskId}" has no assignee`,
      );
    }
    if (executor !== actor.context.employeeId) {
      return taskError(
        'not_assignee',
        'actor.employeeId',
        `task "${task.taskId}" is assigned to "${executor}", not "${actor.context.employeeId}"`,
      );
    }
    return null;
  };

  const requireNotExecutor = (
    task: Task,
    actor: CommandActor,
  ): TaskFailure | null => {
    if (actor.kind === 'system') return null;
    const executor = executorIdOf(task);
    if (executor === null || executor !== actor.context.employeeId) return null;
    return taskError(
      'self_verification_forbidden',
      'actor.employeeId',
      `employee "${actor.context.employeeId}" executes task "${task.taskId}" and cannot verify it`,
    );
  };

  const emit = (
    type: string,
    payload: unknown,
    taskId: string,
    actor: CommandActor,
    simTime: SimTime,
  ): Result<OrgEvent, TaskFailure> => {
    const created = createOrgEvent(
      registry,
      {
        companyId,
        type,
        occurredAtSim: simTime,
        actorKind: commandActorKind(actor),
        actorId: commandActorId(actor),
        subjectType: 'task',
        subjectId: taskId,
        correlationId: commandCorrelationId(actor),
        payload,
      },
      { eventIdGenerator },
    );
    if (!created.ok) {
      return {
        ok: false,
        error: taskFailure(
          'event_contract_violation',
          created.error.issues.map((entry) => taskIssue(entry.field, entry.reason)),
        ),
      };
    }
    return created;
  };

  const applyAndSave = (
    initial: Task | null,
    events: readonly OrgEvent[],
  ): Result<Task, TaskFailure> => {
    let next = initial;
    for (const event of events) {
      next = applyTaskEvent(next, event);
      if (next === null) {
        return {
          ok: false,
          error: taskError(
            'invalid_input',
            'taskId',
            'event stream did not produce a task',
          ),
        };
      }
    }
    if (next === null) {
      return {
        ok: false,
        error: taskError('invalid_input', 'taskId', 'event stream did not produce a task'),
      };
    }
    store.save(next);
    return { ok: true, value: next };
  };

  const create = (
    input: CreateTaskInput,
  ): Result<TaskOperation, TaskFailure> => {
    const issues: TaskIssue[] = [];
    if (input.title === '') {
      issues.push(taskIssue('title', 'title must not be empty'));
    }
    if (input.title.length > 200) {
      issues.push(taskIssue('title', 'title must be at most 200 characters'));
    }
    if (input.goal === '') {
      issues.push(taskIssue('goal', 'goal must not be empty'));
    }
    const priority = input.priority ?? 5;
    if (!Number.isInteger(priority) || priority < 1 || priority > 9) {
      issues.push(taskIssue('priority', 'priority must be an integer between 1 and 9'));
    }
    const maxAttempts = input.maxAttempts ?? 1;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      issues.push(taskIssue('maxAttempts', 'maxAttempts must be an integer >= 1'));
    }
    if (
      input.verification !== undefined &&
      input.verification !== null &&
      input.verification.requiredOutputKeys.length === 0
    ) {
      issues.push(taskIssue('verification', 'verification must declare at least one key'));
    }
    if (issues.length > 0) return { ok: false, error: taskFailure('invalid_input', issues) };

    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };

    let positionId: PositionId | null = null;
    let targetEmployeeId: EmployeeId | null = null;
    if (input.assignment.kind === 'employee') {
      const employee = graph.getEmployee(input.assignment.employeeId);
      if (employee === null) {
        return {
          ok: false,
          error: taskError(
            'unknown_employee',
            'assignment.employeeId',
            `employee "${input.assignment.employeeId}" does not exist`,
          ),
        };
      }
      positionId = employee.positionId;
      targetEmployeeId = employee.id;
    } else if (input.assignment.kind === 'position') {
      const position = graph.getPosition(input.assignment.positionId);
      if (position === null) {
        return {
          ok: false,
          error: taskError(
            'unknown_position',
            'assignment.positionId',
            `position "${input.assignment.positionId}" does not exist`,
          ),
        };
      }
      positionId = position.id;
    }

    const taskId = input.taskId ?? options.taskIdGenerator();
    if (taskId === '') {
      return {
        ok: false,
        error: taskError('invalid_input', 'taskId', 'taskId must not be empty'),
      };
    }
    if (store.has(taskId)) {
      return {
        ok: false,
        error: taskError('invalid_input', 'taskId', `task "${taskId}" already exists`),
      };
    }

    const created = emit(
      TASK_CREATED,
      {
        taskId,
        title: input.title,
        goal: input.goal,
        detail: input.detail ?? null,
        workflowInstanceId: input.workflowInstanceId ?? null,
        workflowStepId: input.workflowStepId ?? null,
        assignment: {
          kind: input.assignment.kind,
          positionId,
          targetEmployeeId,
          assigneeEmployeeId: null,
          actingEmployeeId: null,
        },
        createdByKind: commandActorKind(input.actor),
        createdById:
          input.actor.kind === 'employee' ? input.actor.context.employeeId : null,
        priority,
        attempt: 1,
        maxAttempts,
        requiredSkills: input.requiredSkills ?? [],
        verification: input.verification ?? null,
        outputs: [],
        dueAtSim: input.dueAtSim ?? null,
        capability: input.capability ?? null,
      },
      taskId,
      input.actor,
      input.simTime,
    );
    if (!created.ok) return created;

    const saved = applyAndSave(null, [created.value]);
    if (!saved.ok) return saved;
    return { ok: true, value: { task: saved.value, events: [created.value] } };
  };

  const assign = (
    input: AssignTaskInput,
  ): Result<TaskOperation, TaskFailure> => {
    const loaded = load(input.taskId);
    if (!loaded.ok) return loaded;
    const task = loaded.value;

    const commandFailure = requireCommand(task, 'assign');
    if (commandFailure !== null) return { ok: false, error: commandFailure };

    if (task.status === 'rejected' && task.attempt > task.maxAttempts) {
      return {
        ok: false,
        error: taskError(
          'retries_exhausted',
          'attempt',
          `task "${task.taskId}" exhausted ${task.maxAttempts} attempt(s)`,
        ),
      };
    }

    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };

    if (input.actor.kind === 'employee') {
      const employeeId = input.actor.context.employeeId;
      const isOwner = task.createdById === employeeId;
      const isExecutor = executorIdOf(task) === employeeId;
      if (!isOwner && !isExecutor) {
        return {
          ok: false,
          error: taskError(
            'not_task_owner',
            'actor.employeeId',
            `employee "${employeeId}" neither created task "${task.taskId}" nor executes it`,
          ),
        };
      }
    }

    const target: TaskAssignmentInput =
      input.assignment ??
      (task.assignment.kind === 'employee' && task.assignment.targetEmployeeId !== null
        ? { kind: 'employee', employeeId: task.assignment.targetEmployeeId }
        : task.assignment.kind === 'position' && task.assignment.positionId !== null
          ? { kind: 'position', positionId: task.assignment.positionId }
          : { kind: 'unassigned' });

    if (target.kind === 'unassigned') {
      return {
        ok: false,
        error: taskError(
          'invalid_input',
          'assignment',
          'cannot assign a task without an assignment target',
        ),
      };
    }

    let nextPositionId: PositionId;
    let nextTargetEmployeeId: EmployeeId | null;
    let assigneeEmployeeId: EmployeeId | null;

    if (target.kind === 'employee') {
      const employee = graph.getEmployee(target.employeeId);
      if (employee === null) {
        return {
          ok: false,
          error: taskError(
            'unknown_employee',
            'assignment.employeeId',
            `employee "${target.employeeId}" does not exist`,
          ),
        };
      }
      if (!isExecutableEmployment(employee.status)) {
        return {
          ok: false,
          error: taskError(
            'employee_not_executable',
            'assignment.employeeId',
            `employee "${target.employeeId}" has employment status "${employee.status}" and cannot receive tasks`,
          ),
        };
      }
      nextPositionId = employee.positionId;
      nextTargetEmployeeId = employee.id;
      assigneeEmployeeId = employee.id;
    } else {
      const position = graph.getPosition(target.positionId);
      if (position === null) {
        return {
          ok: false,
          error: taskError(
            'unknown_position',
            'assignment.positionId',
            `position "${target.positionId}" does not exist`,
          ),
        };
      }
      nextPositionId = position.id;
      nextTargetEmployeeId = null;
      const resolved = graph.resolveByPosition(position.id);
      // An archived (or otherwise non-executable) holder leaves the position effectively open:
      // the task is assigned to the position and waits for someone who can actually do it,
      // instead of being handed to an agent the organization has already retired (M1.3).
      const holder =
        resolved !== null && isExecutableEmployment(resolved.status) ? resolved : null;
      assigneeEmployeeId = holder === null ? null : holder.id;
    }

    const matchedCapabilities = Object.freeze(
      [...new Set((input.matchedCapabilities ?? []).map((entry) => entry.trim()))].filter(
        (entry) => entry !== '',
      ),
    );

    const assigned = emit(
      TASK_ASSIGNED,
      {
        taskId: task.taskId,
        assignment: {
          kind: target.kind,
          positionId: nextPositionId,
          targetEmployeeId: nextTargetEmployeeId,
          assigneeEmployeeId,
          actingEmployeeId: null,
        },
        attempt: task.attempt,
        reason: input.reason ?? null,
        // Restate the work on the wake-up event: this event *is* the assignee's briefing, and
        // the verification rule is what tells it which output keys the step will be judged on.
        title: task.title,
        goal: task.goal,
        ...(task.verification === null || task.verification.requiredOutputKeys.length === 0
          ? {}
          : { requiredOutputKeys: [...task.verification.requiredOutputKeys] }),
        ...(matchedCapabilities.length === 0 ? {} : { matchedCapabilities }),
        // The step's kind of work rides along with the briefing for the same reason the title and
        // the output keys do: `Task.Assigned` *is* what wakes the executor, and its cognition
        // prompt carries this event — not the workflow, not the step definition.
        ...(task.capability === null ? {} : { capability: task.capability }),
      },
      task.taskId,
      input.actor,
      input.simTime,
    );
    if (!assigned.ok) return assigned;

    const saved = applyAndSave(task, [assigned.value]);
    if (!saved.ok) return saved;
    return { ok: true, value: { task: saved.value, events: [assigned.value] } };
  };

  /**
   * A2: the target seat must sit inside the dispatcher's reporting subtree — walk the
   * `reports_to` chain upward from the target until it reaches the actor's own seat, which is
   * what makes dispatching to yourself legal (M1.4 Q5). A cycle in the chain stops the walk
   * instead of hanging it.
   */
  const withinReportingSubtree = (
    actorPositionId: PositionId,
    targetPositionId: PositionId,
  ): boolean => {
    let cursor: PositionId | null = targetPositionId;
    const seen = new Set<PositionId>();
    while (cursor !== null && !seen.has(cursor)) {
      if (cursor === actorPositionId) return true;
      seen.add(cursor);
      const position = graph.getPosition(cursor);
      cursor = position === null ? null : position.reportsToPositionId;
    }
    return false;
  };

  const dispatch = (input: DispatchTaskInput): Result<TaskOperation, TaskFailure> => {
    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };

    // A5 — checked before anything is written: no verifiable output, no task (M1.4 验收 5).
    if (
      input.verification === undefined ||
      input.verification === null ||
      input.verification.requiredOutputKeys.length === 0
    ) {
      return {
        ok: false,
        error: taskError(
          'invalid_input',
          'verification',
          'dispatched work must declare at least one required output key',
        ),
      };
    }

    const target = graph.getPosition(input.positionId);
    if (target === null) {
      return {
        ok: false,
        error: taskError(
          'unknown_position',
          'positionId',
          `position "${input.positionId}" does not exist`,
        ),
      };
    }

    if (input.actor.kind === 'employee') {
      // A1 — the gate lives here, not at the call site (M1.4 D5): `create`/`assign` remain
      // ungated internals, and this is the only entry agent-side code reaches.
      const decision = authz.can(
        input.actor.context,
        'DispatchWork',
        resourceRef(`position:${target.id}`),
      );
      if (!decision.allow) return { ok: false, error: taskPermissionFailure('DispatchWork', decision) };

      // A2 — dispatch reaches downward (and to yourself), never across or upward.
      const actorPositionId = input.actor.context.positionId;
      if (!withinReportingSubtree(actorPositionId, target.id)) {
        return {
          ok: false,
          error: taskError(
            'out_of_scope',
            'positionId',
            `position "${target.id}" lies outside the reporting subtree of "${actorPositionId}"`,
          ),
        };
      }

      // A3 — never dispatch upward: the target must not out-rank the dispatcher in any domain
      // it holds. Read straight off the seats, so task-system gains no authority-engine edge.
      for (const [domain, level] of Object.entries(target.decisionDomains ?? {})) {
        if (level === undefined) continue;
        const actorLevel =
          input.actor.context.authorityByDomain[domain as DecisionDomain] ?? 0;
        if (level > actorLevel) {
          return {
            ok: false,
            error: taskError(
              'insufficient_authority',
              'positionId',
              `position "${target.id}" holds level ${level} in "${domain}" while "${actorPositionId}" holds ${actorLevel}`,
            ),
          };
        }
      }
    }

    const correlationId = commandCorrelationId(input.actor);
    const siblings = store.all().filter((task) => task.correlationId === correlationId);

    // A6 — same seat + same title under the same brief is the same work item: hand it back
    // untouched instead of minting a twin (idempotent re-dispatch produces no events).
    const duplicate = siblings.find(
      (task) => task.assignment.positionId === target.id && task.title === input.title,
    );
    if (duplicate !== undefined) {
      return { ok: true, value: { task: duplicate, events: [] } };
    }

    // A4 — one brief, one budget of work items; the ninth is refused (M1.4 验收 6).
    if (siblings.length >= MAX_DISPATCHES_PER_BRIEF) {
      return {
        ok: false,
        error: taskError(
          'dispatch_quota_exceeded',
          'correlationId',
          `brief "${correlationId}" already dispatched ${siblings.length} item(s), maximum is ${MAX_DISPATCHES_PER_BRIEF}`,
        ),
      };
    }

    const created = create({
      actor: input.actor,
      simTime: input.simTime,
      assignment: { kind: 'position', positionId: target.id },
      title: input.title,
      goal: input.goal,
      detail: input.detail ?? null,
      ...(input.requiredSkills === undefined ? {} : { requiredSkills: input.requiredSkills }),
      verification: input.verification,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.dueAtSim === undefined ? {} : { dueAtSim: input.dueAtSim }),
      ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
    });
    if (!created.ok) return created;

    const assigned = assign({
      taskId: created.value.task.taskId,
      actor: input.actor,
      simTime: input.simTime,
      assignment: { kind: 'position', positionId: target.id },
      reason: `dispatched by ${commandActorId(input.actor)} to ${target.title}`,
    });
    if (!assigned.ok) {
      // Atomicity without transactions: callers persist events only on success, so the
      // half-made record has to leave the store too — otherwise the live projection and a
      // replay of the log would disagree about whether this task ever existed.
      store.delete(created.value.task.taskId);
      return assigned;
    }

    return {
      ok: true,
      value: {
        task: assigned.value.task,
        events: [...created.value.events, ...assigned.value.events],
      },
    };
  };

  const transition = (
    input: ActorTaskInput,
    command: TaskCommand,
    build: (
      task: Task,
    ) => Result<{ readonly type: string; readonly payload: unknown }, TaskFailure>,
  ): Result<TaskOperation, TaskFailure> => {
    const loaded = load(input.taskId);
    if (!loaded.ok) return loaded;
    const task = loaded.value;

    const commandFailure = requireCommand(task, command);
    if (commandFailure !== null) return { ok: false, error: commandFailure };

    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };

    const built = build(task);
    if (!built.ok) return built;

    const emitted = emit(
      built.value.type,
      built.value.payload,
      task.taskId,
      input.actor,
      input.simTime,
    );
    if (!emitted.ok) return emitted;

    const saved = applyAndSave(task, [emitted.value]);
    if (!saved.ok) return saved;
    return { ok: true, value: { task: saved.value, events: [emitted.value] } };
  };

  const accept = (input: ActorTaskInput): Result<TaskOperation, TaskFailure> =>
    transition(input, 'accept', (task) => {
      const executorFailure = requireExecutor(task, input.actor);
      if (executorFailure !== null) return { ok: false, error: executorFailure };
      const permissionFailure = authorize(input.actor, 'AcceptTask', task.taskId);
      if (permissionFailure !== null) return { ok: false, error: permissionFailure };
      return {
        ok: true,
        value: {
          type: TASK_ACCEPTED,
          payload: {
            taskId: task.taskId,
            employeeId: executorIdOf(task),
            attempt: task.attempt,
          },
        },
      };
    });

  const start = (input: ActorTaskInput): Result<TaskOperation, TaskFailure> =>
    transition(input, 'start', (task) => {
      const executorFailure = requireExecutor(task, input.actor);
      if (executorFailure !== null) return { ok: false, error: executorFailure };
      const permissionFailure = authorize(input.actor, 'StartTask', task.taskId);
      if (permissionFailure !== null) return { ok: false, error: permissionFailure };
      return {
        ok: true,
        value: {
          type: TASK_STARTED,
          payload: {
            taskId: task.taskId,
            employeeId: executorIdOf(task),
            attempt: task.attempt,
            reason: null,
          },
        },
      };
    });

  const report = (input: ReportTaskInput): Result<TaskOperation, TaskFailure> =>
    transition(input, 'report', (task) => {
      if (input.summary === '') {
        return {
          ok: false,
          error: taskError('invalid_input', 'summary', 'summary must not be empty'),
        };
      }
      const executorFailure = requireExecutor(task, input.actor);
      if (executorFailure !== null) return { ok: false, error: executorFailure };
      const permissionFailure = authorize(input.actor, 'ProgressReport', task.taskId);
      if (permissionFailure !== null) return { ok: false, error: permissionFailure };
      return {
        ok: true,
        value: {
          type: TASK_PROGRESS_REPORTED,
          payload: {
            taskId: task.taskId,
            employeeId: executorIdOf(task),
            phase: 'progress',
            summary: input.summary,
            result: null,
            review: null,
          },
        },
      };
    });

  const submit = (input: SubmitTaskInput): Result<TaskOperation, TaskFailure> =>
    transition(input, 'submit', (task) => {
      const parsed = taskSubmissionSchema.safeParse(input.submission);
      if (!parsed.success) {
        return {
          ok: false,
          error: taskFailure(
            'invalid_result',
            parsed.error.issues.map((entry) =>
              taskIssue(
                entry.path.length === 0
                  ? 'submission'
                  : `submission.${entry.path.map(String).join('.')}`,
                entry.message,
              ),
            ),
          ),
        };
      }
      const executorFailure = requireExecutor(task, input.actor);
      if (executorFailure !== null) return { ok: false, error: executorFailure };
      const executor = executorIdOf(task);
      if (executor === null) {
        return {
          ok: false,
          error: taskError('invalid_actor', 'actor.employeeId', 'task has no executor'),
        };
      }
      const permissionFailure = authorize(input.actor, 'ProgressReport', task.taskId);
      if (permissionFailure !== null) return { ok: false, error: permissionFailure };
      const submission = parsed.data;
      return {
        ok: true,
        value: {
          type: TASK_PROGRESS_REPORTED,
          payload: {
            taskId: task.taskId,
            employeeId: executor,
            phase: 'submitted',
            summary: submission.summary,
            result: {
              taskId: task.taskId,
              producedBy: executor,
              summary: submission.summary,
              data: submission.data,
              artifacts: submission.artifacts ?? [],
            },
            review: null,
          },
        },
      };
    });

  const block = (input: ReasonTaskInput): Result<TaskOperation, TaskFailure> =>
    transition(input, 'block', (task) => {
      if (input.reason === '') {
        return {
          ok: false,
          error: taskError('invalid_reason', 'reason', 'block reason must not be empty'),
        };
      }
      const executorFailure = requireExecutor(task, input.actor);
      if (executorFailure !== null) return { ok: false, error: executorFailure };
      const permissionFailure = authorize(input.actor, 'BlockTask', task.taskId);
      if (permissionFailure !== null) return { ok: false, error: permissionFailure };
      return {
        ok: true,
        value: {
          type: TASK_BLOCKED,
          payload: {
            taskId: task.taskId,
            employeeId: executorIdOf(task),
            reason: input.reason,
            from: task.status,
          },
        },
      };
    });

  const unblock = (input: ActorTaskInput): Result<TaskOperation, TaskFailure> =>
    transition(input, 'unblock', (task) => {
      const executorFailure = requireExecutor(task, input.actor);
      if (executorFailure !== null) return { ok: false, error: executorFailure };
      const permissionFailure = authorize(input.actor, 'BlockTask', task.taskId);
      if (permissionFailure !== null) return { ok: false, error: permissionFailure };
      return {
        ok: true,
        value: {
          type: TASK_STARTED,
          payload: {
            taskId: task.taskId,
            employeeId: executorIdOf(task),
            attempt: task.attempt,
            reason: 'unblock',
          },
        },
      };
    });

  const complete = (input: CompleteTaskInput): Result<TaskOperation, TaskFailure> =>
    transition(input, 'complete', (task) => {
      const selfFailure = requireNotExecutor(task, input.actor);
      if (selfFailure !== null) return { ok: false, error: selfFailure };
      const permissionFailure = authorize(input.actor, 'CompleteTask', task.taskId);
      if (permissionFailure !== null) return { ok: false, error: permissionFailure };
      if (task.result === null) {
        return {
          ok: false,
          error: taskError(
            'invalid_result',
            'result',
            `task "${task.taskId}" has no submitted result to complete`,
          ),
        };
      }
      return {
        ok: true,
        value: {
          type: TASK_COMPLETED,
          payload: {
            taskId: task.taskId,
            employeeId: executorIdOf(task),
            verification: input.verification ?? task.verification,
            result: task.result,
          },
        },
      };
    });

  const reject = (input: ReasonTaskInput): Result<TaskOperation, TaskFailure> =>
    transition(input, 'reject', (task) => {
      if (input.reason === '') {
        return {
          ok: false,
          error: taskError('invalid_reason', 'reason', 'rejection reason must not be empty'),
        };
      }
      const executorFailure = requireExecutor(task, input.actor);
      if (executorFailure !== null) return { ok: false, error: executorFailure };
      const permissionFailure = authorize(input.actor, 'RejectTask', task.taskId);
      if (permissionFailure !== null) return { ok: false, error: permissionFailure };
      return {
        ok: true,
        value: {
          type: TASK_REJECTED,
          payload: {
            taskId: task.taskId,
            reason: input.reason,
            attempt: task.attempt + 1,
            from: task.status,
            employeeId: executorIdOf(task),
          },
        },
      };
    });

  const fail = (input: ReasonTaskInput): Result<TaskOperation, TaskFailure> =>
    transition(input, 'fail', (task) => {
      if (input.reason === '') {
        return {
          ok: false,
          error: taskError('invalid_reason', 'reason', 'failure reason must not be empty'),
        };
      }
      const executorFailure = requireExecutor(task, input.actor);
      if (executorFailure !== null) return { ok: false, error: executorFailure };
      const permissionFailure = authorize(input.actor, 'ProgressReport', task.taskId);
      if (permissionFailure !== null) return { ok: false, error: permissionFailure };
      return {
        ok: true,
        value: {
          type: TASK_FAILED,
          payload: {
            taskId: task.taskId,
            reason: input.reason,
            attempt: task.attempt + 1,
            from: task.status,
            employeeId: executorIdOf(task),
          },
        },
      };
    });

  const cancel = (input: ReasonTaskInput): Result<TaskOperation, TaskFailure> =>
    transition(input, 'cancel', (task) => {
      if (input.reason === '') {
        return {
          ok: false,
          error: taskError('invalid_reason', 'reason', 'cancellation reason must not be empty'),
        };
      }
      if (input.actor.kind === 'employee') {
        const employeeId = input.actor.context.employeeId;
        const isOwner = task.createdById === employeeId;
        const isExecutor = executorIdOf(task) === employeeId;
        if (!isOwner && !isExecutor) {
          return {
            ok: false,
            error: taskError(
              'not_task_owner',
              'actor.employeeId',
              `employee "${employeeId}" neither created task "${task.taskId}" nor executes it`,
            ),
          };
        }
      }
      const permissionFailure = authorize(input.actor, 'RejectTask', task.taskId);
      if (permissionFailure !== null) return { ok: false, error: permissionFailure };
      return {
        ok: true,
        value: {
          type: TASK_CANCELLED,
          payload: {
            taskId: task.taskId,
            reason: input.reason,
            from: task.status,
          },
        },
      };
    });

  /**
   * Deletion is not a transition: `ALLOWED_COMMANDS` says nothing about it because an operator
   * removing work is not the task state machine speaking. It goes through the same actor
   * legitimacy and permission gates as `cancel`, then writes `Task.Deleted` and drops the record.
   */
  const remove = (input: ReasonTaskInput): Result<TaskDeleteOperation, TaskFailure> => {
    const loaded = load(input.taskId);
    if (!loaded.ok) return loaded;
    const task = loaded.value;

    if (input.reason.trim() === '') {
      return {
        ok: false,
        error: taskError('invalid_reason', 'reason', 'deletion reason must not be empty'),
      };
    }
    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };
    const permissionFailure = authorize(input.actor, 'RejectTask', task.taskId);
    if (permissionFailure !== null) return { ok: false, error: permissionFailure };

    const emitted = emit(
      TASK_DELETED,
      { taskId: task.taskId, reason: input.reason, from: task.status },
      task.taskId,
      input.actor,
      input.simTime,
    );
    if (!emitted.ok) return emitted;

    // The fold is the authority on what the stream means now: it answers `null`, which is the
    // store's cue to let the record go.
    if (applyTaskEvent(task, emitted.value) !== null) {
      return {
        ok: false,
        error: taskError(
          'event_contract_violation',
          'taskId',
          `deleting task "${task.taskId}" did not fold to an empty record`,
        ),
      };
    }
    store.delete(task.taskId);
    return { ok: true, value: { taskId: task.taskId, events: [emitted.value] } };
  };

  /**
   * A4 (`role-agents-cannot-complete-tasks.md` §9): hold the original objectives as one
   * recoverable item owned by the requester while a decision is open. The state machine stays the
   * authority — every step below is an existing command — but the chain lives here so the
   * kernel's agent-side binding never writes a task directly (M1.4 acceptance 8).
   */
  const holdForApproval = (input: HoldTaskInput): Result<TaskOperation, TaskFailure> => {
    const created = create({
      actor: input.actor,
      simTime: input.simTime,
      taskId: input.taskId,
      title: input.title,
      goal: input.goal,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
      assignment: { kind: 'employee', employeeId: input.employeeId },
    });
    if (!created.ok) return created;

    const events: OrgEvent[] = [...created.value.events];
    const steps: readonly (() => Result<TaskOperation, TaskFailure>)[] = [
      () => assign({ taskId: input.taskId, actor: input.actor, simTime: input.simTime }),
      () => accept({ taskId: input.taskId, actor: input.actor, simTime: input.simTime }),
      () => start({ taskId: input.taskId, actor: input.actor, simTime: input.simTime }),
      () =>
        block({
          taskId: input.taskId,
          actor: input.actor,
          simTime: input.simTime,
          reason: input.reason,
        }),
    ];
    let last: TaskOperation = created.value;
    for (const step of steps) {
      const outcome = step();
      if (!outcome.ok) return outcome;
      events.push(...outcome.value.events);
      last = outcome.value;
    }
    return { ok: true, value: { task: last.task, events } };
  };

  const review = (input: ReviewTaskInput): Result<TaskOperation, TaskFailure> =>
    transition(input, 'review', (task) => {
      if (task.verification === null || task.verification.kind !== 'review') {
        return {
          ok: false,
          error: taskError(
            'verification_not_applicable',
            'verification',
            `task "${task.taskId}" does not declare review verification`,
          ),
        };
      }
      const selfFailure = requireNotExecutor(task, input.actor);
      if (selfFailure !== null) return { ok: false, error: selfFailure };
      const permissionFailure = authorize(input.actor, 'ReviewProposal', task.taskId);
      if (permissionFailure !== null) return { ok: false, error: permissionFailure };
      if (input.actor.kind === 'system') {
        return {
          ok: false,
          error: taskError(
            'invalid_actor',
            'actor',
            'a system actor cannot render a human review verdict',
          ),
        };
      }
      return {
        ok: true,
        value: {
          type: TASK_PROGRESS_REPORTED,
          payload: {
            taskId: task.taskId,
            employeeId: input.actor.context.employeeId,
            phase: 'reviewed',
            summary: null,
            result: task.result,
            review: {
              reviewerId: input.actor.context.employeeId,
              verdict: input.review.verdict,
              reason: input.review.reason ?? null,
              reviewedAtSim: input.simTime,
            },
          },
        },
      };
    });

  return {
    get: (taskId) => store.get(taskId),
    all: () => store.all(),
    create,
    assign,
    dispatch,
    holdForApproval,
    accept,
    start,
    report,
    submit,
    block,
    unblock,
    complete,
    reject,
    fail,
    cancel,
    review,
    delete: remove,
  };
}
