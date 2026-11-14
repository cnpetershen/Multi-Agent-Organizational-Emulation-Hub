import type { ZodError } from 'zod';
import type { Action, OrgEvent, Result, SimTime } from '@maoeh/shared-types';
import type { AuthzContext, AuthzService, CommandActor } from '@maoeh/permission-system';
import {
  commandActorId,
  commandActorKind,
  commandCorrelationId,
  resourceRef,
  systemActor,
  validateActorLegitimacy,
} from '@maoeh/permission-system';
import type { EventRegistry } from '@maoeh/event-system';
import { createOrgEvent } from '@maoeh/event-system';
import { meetsContextAuthority } from '@maoeh/authority-engine';
import type { AuthorityService } from '@maoeh/authority-engine';
import { createOrgGraph, isExecutableEmployment } from '@maoeh/organization-model';
import { resolveCapabilityAssignments } from '@maoeh/organization-model';
import type { Organization } from '@maoeh/organization-model';
import type { PositionId } from '@maoeh/shared-types';
import type { EmployeeId } from '@maoeh/shared-types';
import type { Task, TaskErrorCode, TaskFailure, TaskService } from '@maoeh/task-system';
import {
  TASK_CANCELLED,
  TASK_COMPLETED,
  TASK_FAILED,
  TASK_PROGRESS_REPORTED,
  TASK_REJECTED,
  executorIdOf,
  isTaskEvent,
  isTerminalStatus,
  taskCancelledPayloadSchema,
  taskCompletedPayloadSchema,
  taskFailedPayloadSchema,
  taskProgressReportedPayloadSchema,
  taskRejectedPayloadSchema,
} from '@maoeh/task-system';
import type { WorkflowFailure } from './workflow-errors.js';
import {
  workflowError,
  workflowFailure,
  workflowIssue,
  workflowPermissionFailure,
} from './workflow-errors.js';
import type { WorkflowIssue } from './workflow-errors.js';
import {
  WORKFLOW_APPROVAL_DENIED,
  WORKFLOW_APPROVAL_GRANTED,
  WORKFLOW_APPROVAL_REQUESTED,
  WORKFLOW_INSTANCE_ABORTED,
  WORKFLOW_INSTANCE_BLOCKED,
  WORKFLOW_INSTANCE_COMPLETED,
  WORKFLOW_INSTANCE_DELETED,
  WORKFLOW_INSTANCE_RESUMED,
  WORKFLOW_DRAFT_CONFIRMED,
  WORKFLOW_INSTANCE_STARTED,
  WORKFLOW_STEP_ASSIGNMENT_OVERRIDDEN,
  WORKFLOW_STEP_COMPLETED,
  WORKFLOW_STEP_ENTERED,
  WORKFLOW_STEP_REJECTED,
} from './workflow-events.js';
import type { InstanceStartedPayload } from './workflow-events.js';
import { DRAFT_CONTEXT_KEY } from './workflow-events.js';
import { assignmentOverridesOf, applyWorkflowEvent } from './workflow-fold.js';
import type {
  AssignmentRule,
  AuthorityRequirement,
  StepKind,
  StepStatus,
  TransitionTarget,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowOperation,
  WorkflowOutcome,
  WorkflowStage,
  WorkflowStep,
} from './workflow-types.js';
import {
  findStage,
  findStep,
  isApprovalLike,
} from './workflow-types.js';
import type { WorkflowDefinitionStore, WorkflowInstanceStore } from './workflow-stores.js';
import { createInMemoryWorkflowInstanceStore } from './workflow-stores.js';
import { selectTransitions } from './workflow-transition.js';
import { evaluateVerification } from './workflow-verification.js';
import { validateWorkflowDefinition } from './workflow-validation.js';
import {
  buildCapabilityPlan,
  capabilityPlanContext,
  generateWorkflowDefinition,
} from './workflow-generation.js';

export interface WorkflowEngineOptions {
  readonly organization: Organization;
  readonly authz: AuthzService;
  readonly registry: EventRegistry;
  readonly tasks: TaskService;
  readonly definitions: WorkflowDefinitionStore;
  /**
   * Required for `overrideAssignments` when a step declares `requiredAuthority`: the engine
   * checks the *assignee's* authority, which is not derivable from the actor's context.
   * Without it, such overrides fail closed.
   */
  readonly authority?: AuthorityService;
  readonly instances?: WorkflowInstanceStore;
  readonly eventIdGenerator: () => string;
  readonly instanceIdGenerator: () => string;
  readonly maxAutoSteps?: number;
}

export interface WorkflowStartInput {
  /** Registered workflow definition to start. Required unless `capabilities` is given. */
  readonly workflowId?: string;
  /**
   * Capability-driven start: generate a fresh definition from these capability ids
   * (resolved against the live organization to seats) instead of a template.
   */
  readonly capabilities?: readonly string[];
  /**
   * M1.9: when set, the instance is created as a *draft* on the canvas — the plan is stored
   * (`context.draft`) with no step entered — until `confirm()` is called on it. Used for
   * capability-generated workflows so a human sees and may adjust the plan before the
   * organization starts executing it.
   */
  readonly awaitConfirmation?: boolean;
  readonly actor: CommandActor;
  readonly simTime: SimTime;
  readonly title: string;
  readonly goal: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly instanceId?: string;
}

/** M1.9: confirm a draft instance on the canvas; the entry stage is then entered normally. */
export type WorkflowConfirmInput = WorkflowInstanceCommandInput;

export interface WorkflowAdvanceInput {
  readonly instanceId: string;
  readonly actor: CommandActor;
  readonly event: OrgEvent;
  readonly simTime: SimTime;
}

export interface WorkflowApproveInput {
  readonly instanceId: string;
  readonly actor: CommandActor;
  readonly decision: 'granted' | 'denied';
  readonly simTime: SimTime;
  readonly reason?: string | null;
  /**
   * True only for an operator command (`ControlActor.kind === 'human'`). The workflow actor type
   * does not carry that distinction, so the control plane passes it explicitly and the generated
   * delivery gate refuses an agent approval.
   */
  readonly humanApproval?: boolean;
}

export interface WorkflowInstanceCommandInput {
  readonly instanceId: string;
  readonly actor: CommandActor;
  readonly simTime: SimTime;
  readonly reason?: string | null;
}

/** M1.8: one executor override request inside `WorkflowOverrideAssignmentsInput`. */
export interface WorkflowOverrideAssignmentEntry {
  readonly stepId: string;
  readonly employeeId: string;
  readonly reason?: string | null;
}

/**
 * M1.8: per-instance, whole-batch executor override for task steps that have not entered
 * yet. Either every entry validates and one `Workflow.StepAssignmentOverridden` event per
 * real change is appended, or the whole command fails with no events at all.
 */
export interface WorkflowOverrideAssignmentsInput extends WorkflowInstanceCommandInput {
  readonly overrides: readonly WorkflowOverrideAssignmentEntry[];
}

export interface WorkflowGateInput {
  readonly instanceId: string;
  readonly stepId: string;
  readonly actor: CommandActor;
  readonly action: Action;
}

export interface WorkflowGateCheck {
  readonly check: string;
  readonly passed: boolean;
  readonly reason: string | null;
}

export interface WorkflowGateVerdict {
  readonly instanceId: string;
  readonly stepId: string;
  readonly kind: StepKind;
  readonly status: StepStatus | null;
  readonly assigneeEmployeeId: string | null;
  readonly requiredAuthority: AuthorityRequirement | null;
  readonly requiredRoles: readonly string[];
  readonly allowed: boolean;
  readonly checks: readonly WorkflowGateCheck[];
}

export interface WorkflowEngine {
  start(input: WorkflowStartInput): Result<WorkflowOperation, WorkflowFailure>;
  advance(input: WorkflowAdvanceInput): Result<WorkflowOperation, WorkflowFailure>;
  approve(input: WorkflowApproveInput): Result<WorkflowOperation, WorkflowFailure>;
  wait(input: WorkflowInstanceCommandInput): Result<WorkflowOperation, WorkflowFailure>;
  resume(input: WorkflowInstanceCommandInput): Result<WorkflowOperation, WorkflowFailure>;
  complete(input: WorkflowInstanceCommandInput): Result<WorkflowOperation, WorkflowFailure>;
  fail(input: WorkflowInstanceCommandInput): Result<WorkflowOperation, WorkflowFailure>;
  cancel(input: WorkflowInstanceCommandInput): Result<WorkflowOperation, WorkflowFailure>;
  /**
   * Remove the instance and every task it owns.
   *
   * Unlike `cancel` this is not a status change: the instance's stream folds back to `null`,
   * each task is deleted through `TaskService`, and the store drops the record — so a recovery
   * rebuilds neither. The events still land on the log, which is why the removal stays
   * explainable after the state it removed is gone.
   */
  delete(input: WorkflowInstanceCommandInput): Result<WorkflowOperation, WorkflowFailure>;
  /**
   * M1.8: re-point not-yet-entered task steps of a single instance at named employees.
   * Whole-batch: one bad entry rejects everything; only real changes emit events.
   */
  overrideAssignments(
    input: WorkflowOverrideAssignmentsInput,
  ): Result<WorkflowOperation, WorkflowFailure>;
  /**
   * M1.9: confirm a draft instance created with `awaitConfirmation` — drops the draft marker
   * and enters the entry stage. Refused with `instance_not_draft` for any other instance.
   */
  confirm(input: WorkflowConfirmInput): Result<WorkflowOperation, WorkflowFailure>;
  gate(input: WorkflowGateInput): Result<WorkflowGateVerdict, WorkflowFailure>;
}

const ENGINE_ACTOR_ID = 'workflow-engine';

const TASK_CODE_MAP: Readonly<Partial<Record<TaskErrorCode, WorkflowFailure['code']>>> = {
  invalid_input: 'invalid_input',
  invalid_reason: 'invalid_input',
  invalid_actor: 'invalid_actor',
  unknown_task: 'task_not_in_instance',
  permission_denied: 'permission_denied',
};

function mapTaskFailure(failure: TaskFailure): WorkflowFailure {
  const code = TASK_CODE_MAP[failure.code] ?? 'task_command_failed';
  const issues: WorkflowIssue[] = failure.issues.map((issue) =>
    workflowIssue(issue.field, issue.reason),
  );
  if (failure.denial !== undefined) return { code, issues, denial: failure.denial };
  return { code, issues };
}

function contractFailure(error: ZodError): WorkflowFailure {
  return workflowFailure(
    'event_contract_violation',
    error.issues.map((issue) =>
      workflowIssue(
        issue.path.length === 0 ? 'payload' : `payload.${issue.path.map(String).join('.')}`,
        issue.message,
      ),
    ),
  );
}

function payloadTaskId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const taskId = (payload as { readonly taskId?: unknown }).taskId;
  return typeof taskId === 'string' && taskId !== '' ? taskId : null;
}

function outcomeFor(instance: WorkflowInstance): WorkflowOutcome {
  if (instance.status === 'completed') return 'completed';
  if (instance.status === 'aborted') return 'aborted';
  return 'transitioned';
}

interface EnterContext {
  readonly definition: WorkflowDefinition;
  readonly instanceId: string;
  readonly correlationId: string;
  readonly title: string;
  readonly goal: string;
  readonly simTime: SimTime;
  readonly buffer: OrgEvent[];
  /** M1.8: `{ [stepId]: employeeId }` folded from `Workflow.StepAssignmentOverridden`. */
  readonly overrides: Readonly<Record<string, string>>;
}

export function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine {
  const { organization, authz, registry, tasks, eventIdGenerator } = options;
  const definitions = options.definitions;
  const store = options.instances ?? createInMemoryWorkflowInstanceStore();
  const graph = createOrgGraph(organization);
  const companyId = organization.company.id;
  const maxAutoSteps = options.maxAutoSteps ?? 32;

  const engineActor = (correlationId: string): CommandActor =>
    systemActor(ENGINE_ACTOR_ID, correlationId);

  const loadInstance = (instanceId: string): WorkflowInstance | null =>
    store.get(instanceId);

  const loadDefinition = (workflowId: string): WorkflowDefinition | null =>
    definitions.get(workflowId);

  const validateActor = (actor: CommandActor): WorkflowFailure | null => {
    if (actor.kind === 'system') {
      if (actor.actorId === '') {
        return workflowError('invalid_actor', 'actor.actorId', 'system actorId must not be empty');
      }
      if (actor.correlationId === '') {
        return workflowError(
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
      : workflowFailure(
          'invalid_actor',
          issues.map((entry) => workflowIssue(entry.field, entry.reason)),
        );
  };

  const authorize = (
    actor: CommandActor,
    action: Action,
    resource: string,
    ctx?: AuthzContext,
  ): WorkflowFailure | null => {
    if (actor.kind === 'system') return null;
    const decision =
      ctx === undefined
        ? authz.can(actor.context, action, resourceRef(resource))
        : authz.can(actor.context, action, resourceRef(resource), ctx);
    return decision.allow ? null : workflowPermissionFailure(action, decision);
  };

  const emitWorkflow = (
    type: string,
    payload: unknown,
    actor: CommandActor,
    instanceId: string,
    correlationId: string,
    simTime: SimTime,
  ): Result<OrgEvent, WorkflowFailure> => {
    const created = createOrgEvent(
      registry,
      {
        companyId,
        type,
        occurredAtSim: simTime,
        actorKind: commandActorKind(actor),
        actorId: commandActorId(actor),
        subjectType: 'workflow',
        subjectId: instanceId,
        correlationId,
        payload,
      },
      { eventIdGenerator },
    );
    if (!created.ok) {
      return {
        ok: false,
        error: workflowFailure(
          'event_contract_violation',
          created.error.issues.map((entry) => workflowIssue(entry.field, entry.reason)),
        ),
      };
    }
    return created;
  };

  /**
   * Whether a seat has anybody who can carry this step. The employment rule itself lives in
   * `organization-model` beside `EmployeeStatus`, so the workflow engine, the task system and
   * the seat-holder resolution cannot disagree about who is still on the job.
   */
  const isBlockedEmployment = (status: string): boolean => !isExecutableEmployment(status);

  /**
   * The seat a step's task is filed against, from any of the three assignment forms.
   *
   * A `capability` assignment asks the *live* chart which seat does this kind of work — the same
   * resolution a generated workflow uses — so a template declares the work and the organization
   * answers with a seat. Pinning a template to a seat instead is how a workflow came to hand its
   * intake and delivery steps to the CEO regardless of who actually does that work.
   *
   * Deliberately resolved *without* `excludeSeatIds`: `startCapabilities` excludes the seat that
   * composed the plan, because nobody executes their own dispatch, but a template is started, not
   * composed. Excluding whoever pressed start would make a one-employee company unable to start
   * any template, and would contradict "the seat is vacant, the boss covers it" — which is the
   * only way the CEO ends up executing anything here, and which stays visible for `Task.Reassign`.
   */
  const assignmentSeat = (
    step: WorkflowStep,
    assignment: AssignmentRule,
  ): PositionId | WorkflowFailure => {
    if (assignment.kind === 'position') return assignment.positionId;
    if (assignment.kind === 'capability') {
      const resolved = resolveCapabilityAssignments(organization, [assignment.capability]);
      const seat = resolved[0];
      if (seat === undefined) {
        return workflowError(
          'invalid_definition',
          `steps.${step.stepId}.assignment`,
          `no seat in this organization provides capability "${assignment.capability}"`,
        );
      }
      return seat.positionId as PositionId;
    }
    return workflowError(
      'invalid_definition',
      `steps.${step.stepId}.assignment`,
      'task step requires an employee, position or capability assignment',
    );
  };

  const preflightStep = (step: WorkflowStep): WorkflowFailure | null => {
    if (step.kind !== 'task') return null;
    if (step.assignment === null || step.assignment.kind === 'unassigned') {
      return workflowError(
        'invalid_definition',
        `steps.${step.stepId}.assignment`,
        'task step requires an employee, position or capability assignment',
      );
    }
    if (step.assignment.kind === 'employee') {
      const employee = graph.getEmployee(step.assignment.employeeId);
      if (employee === null) {
        return workflowError(
          'invalid_definition',
          `steps.${step.stepId}.assignment`,
          `employee "${step.assignment.employeeId}" does not exist`,
        );
      }
      if (isBlockedEmployment(employee.status)) {
        return workflowError(
          'invalid_definition',
          `steps.${step.stepId}.assignment`,
          `employee "${employee.id}" has employment status "${employee.status}"`,
        );
      }
      return null;
    }
    const seat = assignmentSeat(step, step.assignment);
    if (typeof seat !== 'string') return seat;
    const position = graph.getPosition(seat);
    if (position === null) {
      return workflowError(
        'invalid_definition',
        `steps.${step.stepId}.assignment`,
        `position "${seat}" does not exist`,
      );
    }
    const resolved = graph.resolveByPosition(position.id);
    if (resolved === null) {
      return workflowError(
        'invalid_definition',
        `steps.${step.stepId}.assignment`,
        `position "${position.id}" has no assignable employee`,
      );
    }
    if (isBlockedEmployment(resolved.status)) {
      return workflowError(
        'invalid_definition',
        `steps.${step.stepId}.assignment`,
        `employee "${resolved.id}" has employment status "${resolved.status}"`,
      );
    }
    return null;
  };

  const preflightTarget = (ctx: EnterContext, target: TransitionTarget): WorkflowFailure | null => {
    if (target.kind === 'step') {
      const located = findStep(ctx.definition, target.stepId);
      if (located === null) {
        return workflowError('invalid_definition', 'to', `unknown step "${target.stepId}"`);
      }
      return preflightStep(located.step);
    }
    if (target.kind === 'stage') {
      const stage = findStage(ctx.definition, target.stageId);
      if (stage === null) {
        return workflowError('invalid_definition', 'to', `unknown stage "${target.stageId}"`);
      }
      const first = stage.steps[0];
      if (first === undefined) {
        return workflowError('invalid_definition', 'to', `stage "${target.stageId}" has no steps`);
      }
      return preflightStep(first);
    }
    return null;
  };

  const enterStep = (
    ctx: EnterContext,
    stage: WorkflowStage,
    step: WorkflowStep,
    depth: number,
  ): Result<null, WorkflowFailure> => {
    if (depth > maxAutoSteps) {
      return {
        ok: false,
        error: workflowError(
          'auto_step_overflow',
          'depth',
          `automatic step chain exceeded ${maxAutoSteps} steps`,
        ),
      };
    }
    const pre = preflightStep(step);
    if (pre !== null) return { ok: false, error: pre };

    const engine = engineActor(ctx.correlationId);
    let taskId: string | null = null;
    let assigneePositionId: string | null = null;
    let assigneeEmployeeId: string | null = null;

    if (step.kind === 'task' && step.assignment !== null) {
      // M1.8: a per-instance executor override wins over capability resolution — but only
      // while the pinned employee still exists and is executable. When it does not (e.g. it
      // was archived between the human confirmation and this activation), the step falls back
      // to the live capability resolution instead of blocking; the override stays visible on
      // the log and in `context.assignmentOverrides` for audit.
      const overrideId = ctx.overrides[step.stepId];
      const pinned =
        typeof overrideId === 'string' &&
        overrideId !== '' &&
        step.assignment.kind !== 'employee'
          ? graph.getEmployee(overrideId as EmployeeId)
          : null;
      const pinnedExecutable =
        pinned !== null && isExecutableEmployment(pinned.status) ? pinned : null;
      const seat =
        pinnedExecutable !== null
          ? pinnedExecutable.positionId
          : step.assignment.kind === 'position'
            ? step.assignment.positionId
            : assignmentSeat(step, step.assignment);
      if (typeof seat !== 'string') return { ok: false, error: seat };
      const created = tasks.create({
        actor: engine,
        simTime: ctx.simTime,
        title: step.name.slice(0, 200),
        // The task goal *is* the assignee's brief. The executor's cognition prompt carries the
        // wake-up event and the organization slice and nothing else, so a goal that only restates
        // the step name leaves the executor unable to tell what the work is *for*: a "Frontend"
        // step on a snake-game mandate read exactly like a "Frontend" step on anything else, and
        // every step answered with the same placeholder. Keep the instance mandate in the goal
        // (artifacts and previews are generated from it) and carry the capability hand-off as
        // the task's detail, not as a replacement for the goal.
        goal: `Complete step "${step.name}" of workflow "${ctx.title}": ${ctx.goal}`,
        ...(step.description === null ? {} : { detail: step.description }),
        assignment:
          pinnedExecutable !== null
            ? { kind: 'employee', employeeId: pinnedExecutable.id }
            : { kind: 'position', positionId: seat },
        workflowInstanceId: ctx.instanceId,
        workflowStepId: step.stepId,
        // The step's declared kind of work becomes part of the task contract, so the executor's
        // wake-up event can say *what kind of work* this is. Without it a seat that carries several
        // capabilities can only shape every step it holds the same way — which is how a `Backend`
        // stage came to deliver the frontend page it already knew how to build.
        ...(step.capability === undefined || step.capability === null
          ? {}
          : { capability: step.capability }),
        verification: step.verification,
        maxAttempts: step.maxAttempts,
      });
      if (!created.ok) return { ok: false, error: mapTaskFailure(created.error) };
      const assigned = tasks.assign({
        taskId: created.value.task.taskId,
        actor: engine,
        simTime: ctx.simTime,
        ...(pinnedExecutable !== null
          ? {
              assignment: {
                kind: 'employee' as const,
                employeeId: pinnedExecutable.id,
              },
            }
          : {}),
      });
      if (!assigned.ok) return { ok: false, error: mapTaskFailure(assigned.error) };
      ctx.buffer.push(...created.value.events, ...assigned.value.events);
      taskId = assigned.value.task.taskId;
      assigneePositionId = assigned.value.task.assignment.positionId;
      assigneeEmployeeId = assigned.value.task.assignment.assigneeEmployeeId;
      if (assigneeEmployeeId === null) {
        return {
          ok: false,
          error: workflowError(
            'invalid_definition',
            `steps.${step.stepId}.assignment`,
            `assignment for step "${step.stepId}" did not resolve an employee`,
          ),
        };
      }
    }

    const entered = emitWorkflow(
      WORKFLOW_STEP_ENTERED,
      {
        instanceId: ctx.instanceId,
        stageId: stage.stageId,
        stepId: step.stepId,
        kind: step.kind,
        taskId,
        assigneePositionId,
        assigneeEmployeeId,
      },
      engine,
      ctx.instanceId,
      ctx.correlationId,
      ctx.simTime,
    );
    if (!entered.ok) return entered;
    ctx.buffer.push(entered.value);

    if (isApprovalLike(step.kind)) {
      const requested = emitWorkflow(
        WORKFLOW_APPROVAL_REQUESTED,
        {
          instanceId: ctx.instanceId,
          stepId: step.stepId,
          approvalKey: `${ctx.instanceId}:${step.stepId}`,
          policy: step.approvalPolicy,
          requiredCount: step.requiredCount,
          requiredLevel: step.requiredAuthority === null ? 0 : step.requiredAuthority.level,
          requiredRoles: step.requiredRoles,
          requestedBy: ENGINE_ACTOR_ID,
          requestedAtSim: ctx.simTime,
        },
        engine,
        ctx.instanceId,
        ctx.correlationId,
        ctx.simTime,
      );
      if (!requested.ok) return requested;
      ctx.buffer.push(requested.value);
      return { ok: true, value: null };
    }

    if (step.kind === 'automated') {
      const completed = emitWorkflow(
        WORKFLOW_STEP_COMPLETED,
        {
          instanceId: ctx.instanceId,
          stageId: stage.stageId,
          stepId: step.stepId,
          outcome: 'auto',
          taskId: null,
          outputs: null,
        },
        engine,
        ctx.instanceId,
        ctx.correlationId,
        ctx.simTime,
      );
      if (!completed.ok) return completed;
      ctx.buffer.push(completed.value);
      const selected = selectTransitions(ctx.definition, step.stepId, { kind: 'none' });
      if (!selected.ok) return { ok: false, error: selected.error };
      const nextTransition = selected.value[0];
      if (nextTransition === undefined) {
        return {
          ok: false,
          error: workflowError(
            'no_matching_transition',
            'transition',
            `automated step "${step.stepId}" has no always transition`,
          ),
        };
      }
      return followTarget(ctx, nextTransition.to, depth + 1);
    }

    return { ok: true, value: null };
  };

  const followTarget = (
    ctx: EnterContext,
    target: TransitionTarget,
    depth: number,
  ): Result<null, WorkflowFailure> => {
    const engine = engineActor(ctx.correlationId);
    if (target.kind === 'complete') {
      const completed = emitWorkflow(
        WORKFLOW_INSTANCE_COMPLETED,
        { instanceId: ctx.instanceId, reason: 'workflow_complete' },
        engine,
        ctx.instanceId,
        ctx.correlationId,
        ctx.simTime,
      );
      if (!completed.ok) return completed;
      ctx.buffer.push(completed.value);
      return { ok: true, value: null };
    }
    if (target.kind === 'fail') {
      const aborted = emitWorkflow(
        WORKFLOW_INSTANCE_ABORTED,
        { instanceId: ctx.instanceId, reason: 'failed', detail: target.reason },
        engine,
        ctx.instanceId,
        ctx.correlationId,
        ctx.simTime,
      );
      if (!aborted.ok) return aborted;
      ctx.buffer.push(aborted.value);
      return { ok: true, value: null };
    }
    if (target.kind === 'stage') {
      const stage = findStage(ctx.definition, target.stageId);
      if (stage === null) {
        return {
          ok: false,
          error: workflowError('invalid_definition', 'to', `unknown stage "${target.stageId}"`),
        };
      }
      const first = stage.steps[0];
      if (first === undefined) {
        return {
          ok: false,
          error: workflowError(
            'invalid_definition',
            'to',
            `stage "${target.stageId}" has no steps`,
          ),
        };
      }
      const pre = preflightTarget(ctx, target);
      if (pre !== null) return { ok: false, error: pre };
      return enterStep(ctx, stage, first, depth);
    }
    const located = findStep(ctx.definition, target.stepId);
    if (located === null) {
      return {
        ok: false,
        error: workflowError('invalid_definition', 'to', `unknown step "${target.stepId}"`),
      };
    }
    const pre = preflightTarget(ctx, target);
    if (pre !== null) return { ok: false, error: pre };
    return enterStep(ctx, located.stage, located.step, depth);
  };

  const finalize = (
    prior: WorkflowInstance | null,
    buffer: readonly OrgEvent[],
    processedIds: readonly string[],
    outcome: WorkflowOutcome | null,
    task?: Task,
  ): Result<WorkflowOperation, WorkflowFailure> => {
    let next = prior;
    for (const event of buffer) {
      next = applyWorkflowEvent(next, event);
      if (next === null) break;
    }
    if (next === null) {
      return {
        ok: false,
        error: workflowError(
          'event_contract_violation',
          'events',
          'workflow event stream did not produce an instance',
        ),
      };
    }
    const ids = [
      ...new Set([
        ...next.processedEventIds,
        ...processedIds,
        ...buffer.map((event) => event.eventId),
      ]),
    ];
    const committed: WorkflowInstance = {
      ...next,
      processedEventIds: Object.freeze(ids),
    };
    store.save(committed);
    return {
      ok: true,
      value: {
        instance: committed,
        events: buffer,
        outcome: outcome ?? outcomeFor(committed),
        ...(task !== undefined ? { task } : {}),
      },
    };
  };

  const beginInstance = (
    input: WorkflowStartInput,
    definition: WorkflowDefinition,
    instanceId: string,
    context: Readonly<Record<string, unknown>>,
  ): Result<WorkflowOperation, WorkflowFailure> => {
    const correlationId = commandCorrelationId(input.actor);
    const entryStage = findStage(definition, definition.entryStageId);
    if (entryStage === null) {
      return {
        ok: false,
        error: workflowError(
          'invalid_definition',
          'entryStageId',
          `stage "${definition.entryStageId}" does not exist`,
        ),
      };
    }
    const firstStep = entryStage.steps[0];
    if (firstStep === undefined) {
      return {
        ok: false,
        error: workflowError(
          'invalid_definition',
          'entryStageId',
          'entry stage has no steps',
        ),
      };
    }

    const ctx: EnterContext = {
      definition,
      instanceId,
      correlationId,
      title: input.title,
      goal: input.goal,
      simTime: input.simTime,
      buffer: [],
      overrides: Object.freeze({}),
    };

    const draft = input.awaitConfirmation === true;
    const started = emitWorkflow(
      WORKFLOW_INSTANCE_STARTED,
      {
        instanceId,
        workflowId: definition.workflowId,
        version: definition.version,
        title: input.title,
        goal: input.goal,
        // M1.9: a draft marker rides on the instance context; the console's canvas shows the
        // plan before anything executes. `confirm()` removes it via `Workflow.DraftConfirmed`.
        context: draft ? { ...context, [DRAFT_CONTEXT_KEY]: true } : context,
        initiatedBy: commandActorId(input.actor),
        entryStageId: definition.entryStageId,
      } satisfies InstanceStartedPayload,
      input.actor,
      instanceId,
      correlationId,
      input.simTime,
    );
    if (!started.ok) return started;
    ctx.buffer.push(started.value);

    const entered = draft ? ({ ok: true, value: null } as Result<null, WorkflowFailure>) : enterEntryStage(ctx, definition);
    if (!entered.ok) return entered;

    return finalize(null, ctx.buffer, [], null);
  };

  /** Shared by `beginInstance` (normal start) and `confirm` (draft promotion). */
  const enterEntryStage = (
    ctx: EnterContext,
    definition: WorkflowDefinition,
  ): Result<null, WorkflowFailure> => {
    const entryStage = findStage(definition, definition.entryStageId);
    if (entryStage === null) {
      return {
        ok: false,
        error: workflowError(
          'invalid_definition',
          'entryStageId',
          `stage "${definition.entryStageId}" does not exist`,
        ),
      };
    }
    const firstStep = entryStage.steps[0];
    if (firstStep === undefined) {
      return {
        ok: false,
        error: workflowError(
          'invalid_definition',
          'entryStageId',
          `stage "${definition.entryStageId}" has no steps`,
        ),
      };
    }
    return enterStep(ctx, entryStage, firstStep, 0);
  };

  const checkInputIssues = (input: WorkflowStartInput): WorkflowFailure | null => {
    const issues: WorkflowIssue[] = [];
    if (input.title === '') issues.push(workflowIssue('title', 'title must not be empty'));
    if (input.goal === '') issues.push(workflowIssue('goal', 'goal must not be empty'));
    if (issues.length > 0) return workflowFailure('invalid_input', issues);
    return null;
  };

  const checkInstanceId = (input: WorkflowStartInput): string | WorkflowFailure => {
    const instanceId = input.instanceId ?? options.instanceIdGenerator();
    if (instanceId === '') {
      return workflowError('invalid_input', 'instanceId', 'instanceId must not be empty');
    }
    if (store.has(instanceId)) {
      return workflowError(
        'invalid_input',
        'instanceId',
        `instance "${instanceId}" already exists`,
      );
    }
    return instanceId;
  };

  /** Template path: start a registered workflow definition by id. */
  const startTemplate = (
    input: WorkflowStartInput,
  ): Result<WorkflowOperation, WorkflowFailure> => {
    if (input.workflowId === undefined || input.workflowId === '') {
      return {
        ok: false,
        error: workflowError(
          'invalid_input',
          'workflowId',
          'workflowId is required when starting without capabilities',
        ),
      };
    }
    const definition = loadDefinition(input.workflowId);
    if (definition === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_workflow',
          'workflowId',
          `workflow "${input.workflowId}" is not registered`,
        ),
      };
    }
    const issueFailure = checkInputIssues(input);
    if (issueFailure !== null) return { ok: false, error: issueFailure };

    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };

    const authFailure = authorize(
      input.actor,
      'CreateProposal',
      `workflow:${definition.workflowId}`,
    );
    if (authFailure !== null) return { ok: false, error: authFailure };

    const instanceId = checkInstanceId(input);
    if (typeof instanceId !== 'string') return { ok: false, error: instanceId };

    return beginInstance(input, definition, instanceId, input.context ?? {});
  };

  /**
   * Capability path: the CEO's plan says *which kinds of work* this goal needs; the
   * organization answers with seats, and this branch turns that plan into a fresh definition.
   * Nothing here branches on a position title — `buildCapabilityPlan`/`resolveCapabilityAssignments`
   * only read `Position.capabilities` and the reporting chain.
   */
  const startCapabilities = (
    input: WorkflowStartInput,
  ): Result<WorkflowOperation, WorkflowFailure> => {
    const instanceId = checkInstanceId(input);
    if (typeof instanceId !== 'string') return { ok: false, error: instanceId };

    // A seat that decomposes a mandate and dispatches it does not then execute its own dispatch:
    // the composing seat is excluded from the seats this plan may assign work to, which is what
    // keeps "the CEO breaks the task book down and hands it to the seats that execute" a routing
    // rule instead of a promise. A system actor composes on nobody's behalf, so it excludes none.
    const dispatcherSeatId =
      input.actor.kind === 'employee' ? String(input.actor.context.positionId) : null;
    const { plan, issues } = buildCapabilityPlan(
      organization,
      input.capabilities ?? [],
      dispatcherSeatId === null ? {} : { excludeSeatIds: [dispatcherSeatId] },
    );
    if (plan === null) return { ok: false, error: workflowFailure('invalid_input', issues) };

    const definition = generateWorkflowDefinition({
      instanceId,
      title: input.title,
      goal: input.goal,
      plan,
      approvalRoles: organization.positions
        .filter((position) => position.reportsToPositionId === null)
        .map((position) => String(position.id)),
    });
    const definitionIssues = validateWorkflowDefinition(definition);
    if (definitionIssues.length > 0) {
      return { ok: false, error: workflowFailure('invalid_definition', definitionIssues) };
    }
    definitions.save(definition);

    const issueFailure = checkInputIssues(input);
    if (issueFailure !== null) return { ok: false, error: issueFailure };

    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };

    const authFailure = authorize(
      input.actor,
      'CreateProposal',
      `workflow:${definition.workflowId}`,
    );
    if (authFailure !== null) return { ok: false, error: authFailure };

    return beginInstance(input, definition, instanceId, {
      ...(input.context ?? {}),
      ...capabilityPlanContext(plan),
    });
  };

  const start = (
    input: WorkflowStartInput,
  ): Result<WorkflowOperation, WorkflowFailure> =>
    input.capabilities !== undefined
      ? startCapabilities(input)
      : startTemplate(input);

  const settleSubmitted = (
    ctx: EnterContext,
    instance: WorkflowInstance,
    located: { readonly stage: WorkflowStage; readonly step: WorkflowStep },
    task: Task,
    processedIds: readonly string[],
  ): Result<WorkflowOperation, WorkflowFailure> => {
    const engine = engineActor(ctx.correlationId);
    const { stage, step } = located;
    const verdict = evaluateVerification(task, step.verification);

    if (verdict.kind === 'pending') {
      return finalize(instance, [], processedIds, 'verification_pending');
    }

    if (verdict.kind === 'pass') {
      if (step.capability === 'implementation' && !hasRunnableArtifact(task)) {
        return {
          ok: false,
          error: workflowError(
            'verification_not_applicable',
            'task.result',
            'an implementation step cannot pass without a runnable file or declared artifact',
          ),
        };
      }
      const selected = selectTransitions(ctx.definition, step.stepId, {
        kind: 'task',
        status: 'completed',
      });
      if (!selected.ok) return { ok: false, error: selected.error };
      const completedTransition = selected.value[0];
      if (completedTransition === undefined) {
        return {
          ok: false,
          error: workflowError(
            'no_matching_transition',
            'transition',
            `step "${step.stepId}" has no completion transition`,
          ),
        };
      }
      const target = completedTransition.to;
      const pre = preflightTarget(ctx, target);
      if (pre !== null) return { ok: false, error: pre };

      let current = task;
      if (task.status !== 'completed') {
        const completed = tasks.complete({
          taskId: task.taskId,
          actor: engine,
          simTime: ctx.simTime,
          verification: step.verification,
        });
        if (!completed.ok) return { ok: false, error: mapTaskFailure(completed.error) };
        ctx.buffer.push(...completed.value.events);
        current = completed.value.task;
      }

      const stepCompleted = emitWorkflow(
        WORKFLOW_STEP_COMPLETED,
        {
          instanceId: ctx.instanceId,
          stageId: stage.stageId,
          stepId: step.stepId,
          outcome: step.verification === null ? 'completed' : 'verified',
          taskId: current.taskId,
          outputs: current.result === null ? null : current.result.data,
        },
        engine,
        ctx.instanceId,
        ctx.correlationId,
        ctx.simTime,
      );
      if (!stepCompleted.ok) return stepCompleted;
      ctx.buffer.push(stepCompleted.value);

      const followed = followTarget(ctx, target, 1);
      if (!followed.ok) return followed;
      return finalize(instance, ctx.buffer, processedIds, null, current);
    }

    return settleFailed(ctx, instance, located, task, {
      cause: 'rejected',
      reason: verdict.reason,
      alreadyRejected: false,
      processedIds,
    });
  };

  interface FailureInput {
    readonly cause: 'rejected' | 'failed';
    readonly reason: string;
    readonly alreadyRejected: boolean;
    readonly processedIds: readonly string[];
  }

  const settleFailed = (
    ctx: EnterContext,
    instance: WorkflowInstance,
    located: { readonly stage: WorkflowStage; readonly step: WorkflowStep },
    task: Task,
    input: FailureInput,
  ): Result<WorkflowOperation, WorkflowFailure> => {
    const engine = engineActor(ctx.correlationId);
    const { stage, step } = located;
    let current = task;
    const canReject =
      !input.alreadyRejected &&
      current.status !== 'completed' &&
      current.status !== 'cancelled' &&
      current.status !== 'rejected';

    const branch = selectTransitions(ctx.definition, step.stepId, {
      kind: 'task',
      status: input.cause,
    });

    if (branch.ok) {
      const rejectedTransition = branch.value[0];
      if (rejectedTransition === undefined) {
        return {
          ok: false,
          error: workflowError(
            'no_matching_transition',
            'transition',
            `step "${step.stepId}" has no failure transition`,
          ),
        };
      }
      const target = rejectedTransition.to;
      const pre = preflightTarget(ctx, target);
      if (pre !== null) return { ok: false, error: pre };
      if (canReject) {
        const rejected = tasks.reject({
          taskId: current.taskId,
          actor: engine,
          simTime: ctx.simTime,
          reason: input.reason,
        });
        if (!rejected.ok) return { ok: false, error: mapTaskFailure(rejected.error) };
        ctx.buffer.push(...rejected.value.events);
        current = rejected.value.task;
      }
      const stepRejected = emitWorkflow(
        WORKFLOW_STEP_REJECTED,
        {
          instanceId: ctx.instanceId,
          stageId: stage.stageId,
          stepId: step.stepId,
          reason: input.reason,
          taskId: current.taskId,
        },
        engine,
        ctx.instanceId,
        ctx.correlationId,
        ctx.simTime,
      );
      if (!stepRejected.ok) return stepRejected;
      ctx.buffer.push(stepRejected.value);
      const followed = followTarget(ctx, target, 1);
      if (!followed.ok) return followed;
      return finalize(instance, ctx.buffer, input.processedIds, null, current);
    }

    if (canReject) {
      const rejected = tasks.reject({
        taskId: current.taskId,
        actor: engine,
        simTime: ctx.simTime,
        reason: input.reason,
      });
      if (!rejected.ok) return { ok: false, error: mapTaskFailure(rejected.error) };
      ctx.buffer.push(...rejected.value.events);
      current = rejected.value.task;
    }

    if (current.status === 'rejected' && current.attempt <= current.maxAttempts) {
      const reassigned = tasks.assign({
        taskId: current.taskId,
        actor: engine,
        simTime: ctx.simTime,
        reason: 'retry',
      });
      if (!reassigned.ok) return { ok: false, error: mapTaskFailure(reassigned.error) };
      ctx.buffer.push(...reassigned.value.events);
      return finalize(
        instance,
        ctx.buffer,
        input.processedIds,
        'retried',
        reassigned.value.task,
      );
    }

    const stepRejected = emitWorkflow(
      WORKFLOW_STEP_REJECTED,
      {
        instanceId: ctx.instanceId,
        stageId: stage.stageId,
        stepId: step.stepId,
        reason: input.reason,
        taskId: current.taskId,
      },
      engine,
      ctx.instanceId,
      ctx.correlationId,
      ctx.simTime,
    );
    if (!stepRejected.ok) return stepRejected;
    ctx.buffer.push(stepRejected.value);

    const aborted = emitWorkflow(
      WORKFLOW_INSTANCE_ABORTED,
      {
        instanceId: ctx.instanceId,
        reason: input.cause === 'failed' ? 'task_failed' : 'task_rejected',
        detail: input.reason,
      },
      engine,
      ctx.instanceId,
      ctx.correlationId,
      ctx.simTime,
    );
    if (!aborted.ok) return aborted;
    ctx.buffer.push(aborted.value);
    return finalize(instance, ctx.buffer, input.processedIds, 'aborted', current);
  };

  const advance = (
    input: WorkflowAdvanceInput,
  ): Result<WorkflowOperation, WorkflowFailure> => {
    const instance = loadInstance(input.instanceId);
    if (instance === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_instance',
          'instanceId',
          `instance "${input.instanceId}" does not exist`,
        ),
      };
    }
    if (instance.processedEventIds.includes(input.event.eventId)) {
      return {
        ok: true,
        value: { instance, events: [], outcome: 'duplicate' },
      };
    }
    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };
    if (input.event.companyId !== instance.companyId) {
      return {
        ok: false,
        error: workflowError(
          'invalid_input',
          'event.companyId',
          'event belongs to a different company',
        ),
      };
    }
    const definition = loadDefinition(instance.workflowId);
    if (definition === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_workflow',
          'workflowId',
          `workflow "${instance.workflowId}" is not registered`,
        ),
      };
    }

    const processedIds = [input.event.eventId];

    if (!isTaskEvent(input.event.type)) {
      return finalize(instance, [], processedIds, 'ignored');
    }
    if (instance.status === 'completed' || instance.status === 'aborted') {
      return {
        ok: false,
        error: workflowError(
          'instance_terminal',
          'status',
          `instance is already ${instance.status}`,
        ),
      };
    }
    if (instance.status === 'blocked') {
      return {
        ok: false,
        error: workflowError(
          'instance_blocked',
          'status',
          'instance is blocked; resume or decide the pending approval first',
        ),
      };
    }

    const taskId = payloadTaskId(input.event.payload);
    if (taskId === null) {
      return {
        ok: false,
        error: workflowError(
          'event_contract_violation',
          'payload.taskId',
          'task event payload is missing taskId',
        ),
      };
    }
    const stepState = Object.values(instance.stepStates).find(
      (state) => state.taskId === taskId && state.status === 'active',
    );
    if (stepState === undefined) {
      return {
        ok: false,
        error: workflowError(
          'task_not_in_instance',
          'taskId',
          `task "${taskId}" does not belong to an active step of instance "${instance.instanceId}"`,
        ),
      };
    }
    const located = findStep(definition, stepState.stepId);
    if (located === null) {
      return {
        ok: false,
        error: workflowError(
          'invalid_definition',
          'stepId',
          `step "${stepState.stepId}" does not exist in workflow "${definition.workflowId}"`,
        ),
      };
    }
    const task = tasks.get(taskId);
    if (task === null) {
      return {
        ok: false,
        error: workflowError(
          'task_not_in_instance',
          'taskId',
          `task "${taskId}" is unknown to the task system`,
        ),
      };
    }

    const ctx: EnterContext = {
      definition,
      instanceId: instance.instanceId,
      correlationId: instance.correlationId,
      title: instance.title,
      goal: instance.goal,
      simTime: input.simTime,
      buffer: [],
      overrides: assignmentOverridesOf(instance),
    };

    switch (input.event.type) {
      case TASK_PROGRESS_REPORTED: {
        const parsed = taskProgressReportedPayloadSchema.safeParse(input.event.payload);
        if (!parsed.success) return { ok: false, error: contractFailure(parsed.error) };
        if (parsed.data.phase === 'progress') {
          return finalize(instance, [], processedIds, 'ignored');
        }
        return settleSubmitted(ctx, instance, located, task, processedIds);
      }
      case TASK_COMPLETED: {
        const parsed = taskCompletedPayloadSchema.safeParse(input.event.payload);
        if (!parsed.success) return { ok: false, error: contractFailure(parsed.error) };
        return settleSubmitted(ctx, instance, located, task, processedIds);
      }
      case TASK_REJECTED: {
        const parsed = taskRejectedPayloadSchema.safeParse(input.event.payload);
        if (!parsed.success) return { ok: false, error: contractFailure(parsed.error) };
        return settleFailed(ctx, instance, located, task, {
          cause: 'rejected',
          reason: parsed.data.reason,
          alreadyRejected: true,
          processedIds,
        });
      }
      case TASK_FAILED: {
        const parsed = taskFailedPayloadSchema.safeParse(input.event.payload);
        if (!parsed.success) return { ok: false, error: contractFailure(parsed.error) };
        return settleFailed(ctx, instance, located, task, {
          cause: 'failed',
          reason: parsed.data.reason,
          alreadyRejected: true,
          processedIds,
        });
      }
      case TASK_CANCELLED: {
        const parsed = taskCancelledPayloadSchema.safeParse(input.event.payload);
        if (!parsed.success) return { ok: false, error: contractFailure(parsed.error) };
        return settleCancelled(ctx, instance, located, task, parsed.data.reason, processedIds);
      }
      default:
        return finalize(instance, [], processedIds, 'ignored');
    }
  };

  const settleCancelled = (
    ctx: EnterContext,
    instance: WorkflowInstance,
    located: { readonly stage: WorkflowStage; readonly step: WorkflowStep },
    task: Task,
    reason: string,
    processedIds: readonly string[],
  ): Result<WorkflowOperation, WorkflowFailure> => {
    const engine = engineActor(ctx.correlationId);
    const { stage, step } = located;
    const stepRejected = emitWorkflow(
      WORKFLOW_STEP_REJECTED,
      {
        instanceId: ctx.instanceId,
        stageId: stage.stageId,
        stepId: step.stepId,
        reason,
        taskId: task.taskId,
      },
      engine,
      ctx.instanceId,
      ctx.correlationId,
      ctx.simTime,
    );
    if (!stepRejected.ok) return stepRejected;
    ctx.buffer.push(stepRejected.value);

    const aborted = emitWorkflow(
      WORKFLOW_INSTANCE_ABORTED,
      { instanceId: ctx.instanceId, reason: 'task_cancelled', detail: reason },
      engine,
      ctx.instanceId,
      ctx.correlationId,
      ctx.simTime,
    );
    if (!aborted.ok) return aborted;
    ctx.buffer.push(aborted.value);
    return finalize(instance, ctx.buffer, processedIds, 'aborted', task);
  };

  const approve = (
    input: WorkflowApproveInput,
  ): Result<WorkflowOperation, WorkflowFailure> => {
    const instance = loadInstance(input.instanceId);
    if (instance === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_instance',
          'instanceId',
          `instance "${input.instanceId}" does not exist`,
        ),
      };
    }
    if (instance.status === 'completed' || instance.status === 'aborted') {
      return {
        ok: false,
        error: workflowError(
          'instance_terminal',
          'status',
          `instance is already ${instance.status}`,
        ),
      };
    }
    if (input.actor.kind === 'system') {
      return {
        ok: false,
        error: workflowError(
          'invalid_actor',
          'actor',
          'a system actor cannot decide a workflow approval',
        ),
      };
    }
    if (
      instance.status !== 'blocked' ||
      instance.approval === null ||
      instance.approval.status !== 'open'
    ) {
      return {
        ok: false,
        error: workflowError(
          'approval_not_open',
          'status',
          'instance has no open approval to decide',
        ),
      };
    }
    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };

    const definition = loadDefinition(instance.workflowId);
    if (definition === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_workflow',
          'workflowId',
          `workflow "${instance.workflowId}" is not registered`,
        ),
      };
    }
    const located = findStep(definition, instance.approval.stepId);
    if (located === null) {
      return {
        ok: false,
        error: workflowError(
          'invalid_definition',
          'stepId',
          `approval step "${instance.approval.stepId}" does not exist`,
        ),
      };
    }
    const { stage, step } = located;
    const actorId = input.actor.context.employeeId;
    const approval = instance.approval;

    if (step.humanOnly === true && input.humanApproval !== true) {
      return {
        ok: false,
        error: workflowError(
          'human_approval_required',
          'actor',
          'a generated delivery must be accepted by the human operator, not by an agent',
        ),
      };
    }

    if (step.requiredAuthority !== null) {
      const meets = meetsContextAuthority(input.actor.context, step.requiredAuthority);
      if (!meets) {
        return {
          ok: false,
          error: workflowFailure('authority_insufficient', [
            workflowIssue(
              'authority',
              `employee "${actorId}" lacks level ${step.requiredAuthority.level} in domain "${step.requiredAuthority.domain}"`,
            ),
          ]),
        };
      }
    }

    const authCtx: AuthzContext | undefined =
      step.requiredRoles.length > 0 ? { requiredRoles: step.requiredRoles } : undefined;
    const authFailure = authorize(
      input.actor,
      'ApproveStep',
      `workflow:${instance.instanceId}/step:${step.stepId}`,
      authCtx,
    );
    if (authFailure !== null) return { ok: false, error: authFailure };

    if (approval.grantedBy.includes(actorId)) {
      return {
        ok: false,
        error: workflowError(
          'approval_already_decided',
          'actor',
          `employee "${actorId}" already decided approval "${approval.approvalKey}"`,
        ),
      };
    }

    const ctx: EnterContext = {
      definition,
      instanceId: instance.instanceId,
      correlationId: instance.correlationId,
      title: instance.title,
      goal: instance.goal,
      simTime: input.simTime,
      buffer: [],
      overrides: assignmentOverridesOf(instance),
    };
    const engine = engineActor(ctx.correlationId);
    const reason = input.reason ?? null;

    if (input.decision === 'granted') {
      const grantedCount = approval.grantedBy.length + 1;
      const granted = emitWorkflow(
        WORKFLOW_APPROVAL_GRANTED,
        {
          instanceId: instance.instanceId,
          stepId: step.stepId,
          approvalKey: approval.approvalKey,
          decidedBy: actorId,
          grantedCount,
          reason,
        },
        input.actor,
        instance.instanceId,
        ctx.correlationId,
        input.simTime,
      );
      if (!granted.ok) return granted;
      ctx.buffer.push(granted.value);

      if (grantedCount < approval.requiredCount) {
        return finalize(instance, ctx.buffer, [], 'awaiting_approval');
      }

      const selected = selectTransitions(definition, step.stepId, {
        kind: 'approval',
        decision: 'granted',
      });
      if (!selected.ok) return { ok: false, error: selected.error };
      const grantedTransition = selected.value[0];
      if (grantedTransition === undefined) {
        return {
          ok: false,
          error: workflowError(
            'no_matching_transition',
            'transition',
            `step "${step.stepId}" has no granted transition`,
          ),
        };
      }
      const target = grantedTransition.to;
      const pre = preflightTarget(ctx, target);
      if (pre !== null) return { ok: false, error: pre };

      const state = instance.stepStates[step.stepId];
      const stepCompleted = emitWorkflow(
        WORKFLOW_STEP_COMPLETED,
        {
          instanceId: instance.instanceId,
          stageId: stage.stageId,
          stepId: step.stepId,
          outcome: 'granted',
          taskId: state?.taskId ?? null,
          outputs: null,
        },
        engine,
        instance.instanceId,
        ctx.correlationId,
        input.simTime,
      );
      if (!stepCompleted.ok) return stepCompleted;
      ctx.buffer.push(stepCompleted.value);

      const followed = followTarget(ctx, target, 1);
      if (!followed.ok) return followed;
      return finalize(instance, ctx.buffer, [], null);
    }

    const denied = emitWorkflow(
      WORKFLOW_APPROVAL_DENIED,
      {
        instanceId: instance.instanceId,
        stepId: step.stepId,
        approvalKey: approval.approvalKey,
        decidedBy: actorId,
        reason,
      },
      input.actor,
      instance.instanceId,
      ctx.correlationId,
      input.simTime,
    );
    if (!denied.ok) return denied;
    ctx.buffer.push(denied.value);

    const branch = selectTransitions(definition, step.stepId, {
      kind: 'approval',
      decision: 'denied',
    });
    const denyReason = reason ?? 'approval denied';
    const state = instance.stepStates[step.stepId];

    if (!branch.ok) {
      const stepRejected = emitWorkflow(
        WORKFLOW_STEP_REJECTED,
        {
          instanceId: instance.instanceId,
          stageId: stage.stageId,
          stepId: step.stepId,
          reason: denyReason,
          taskId: state?.taskId ?? null,
        },
        engine,
        instance.instanceId,
        ctx.correlationId,
        input.simTime,
      );
      if (!stepRejected.ok) return stepRejected;
      ctx.buffer.push(stepRejected.value);
      const aborted = emitWorkflow(
        WORKFLOW_INSTANCE_ABORTED,
        {
          instanceId: instance.instanceId,
          reason: 'approval_denied',
          detail: denyReason,
        },
        engine,
        instance.instanceId,
        ctx.correlationId,
        input.simTime,
      );
      if (!aborted.ok) return aborted;
      ctx.buffer.push(aborted.value);
      return finalize(instance, ctx.buffer, [], 'aborted');
    }

    const deniedTransition = branch.value[0];
    if (deniedTransition === undefined) {
      return {
        ok: false,
        error: workflowError(
          'no_matching_transition',
          'transition',
          `step "${step.stepId}" has no denied transition`,
        ),
      };
    }
    const target = deniedTransition.to;
    const pre = preflightTarget(ctx, target);
    if (pre !== null) return { ok: false, error: pre };
    const stepRejected = emitWorkflow(
      WORKFLOW_STEP_REJECTED,
      {
        instanceId: instance.instanceId,
        stageId: stage.stageId,
        stepId: step.stepId,
        reason: denyReason,
        taskId: state?.taskId ?? null,
      },
      engine,
      instance.instanceId,
      ctx.correlationId,
      input.simTime,
    );
    if (!stepRejected.ok) return stepRejected;
    ctx.buffer.push(stepRejected.value);
    const followed = followTarget(ctx, target, 1);
    if (!followed.ok) return followed;
    return finalize(instance, ctx.buffer, [], null);
  };

  const cancelActiveTasks = (
    instance: WorkflowInstance,
    ctx: EnterContext,
    engine: CommandActor,
    reason: string,
  ): Result<null, WorkflowFailure> => {
    for (const state of Object.values(instance.stepStates)) {
      if (state.status !== 'active' || state.taskId === null) continue;
      const task = tasks.get(state.taskId);
      if (task === null || isTerminalStatus(task.status)) continue;
      const cancelled = tasks.cancel({
        taskId: task.taskId,
        actor: engine,
        simTime: ctx.simTime,
        reason,
      });
      if (!cancelled.ok) return { ok: false, error: mapTaskFailure(cancelled.error) };
      ctx.buffer.push(...cancelled.value.events);
    }
    return { ok: true, value: null };
  };

  const manualCommand = (
    input: WorkflowInstanceCommandInput,
    mode: 'complete' | 'fail' | 'cancel',
  ): Result<WorkflowOperation, WorkflowFailure> => {
    const instance = loadInstance(input.instanceId);
    if (instance === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_instance',
          'instanceId',
          `instance "${input.instanceId}" does not exist`,
        ),
      };
    }
    if (instance.status === 'completed' || instance.status === 'aborted') {
      return {
        ok: false,
        error: workflowError(
          'instance_terminal',
          'status',
          `instance is already ${instance.status}`,
        ),
      };
    }
    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };

    const definition = loadDefinition(instance.workflowId);
    if (definition === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_workflow',
          'workflowId',
          `workflow "${instance.workflowId}" is not registered`,
        ),
      };
    }

    const action: Action =
      mode === 'complete' ? 'FinalizeDecision' : 'RejectStep';
    const authFailure = authorize(
      input.actor,
      action,
      `workflow:${instance.instanceId}`,
    );
    if (authFailure !== null) return { ok: false, error: authFailure };

    const reason =
      input.reason ?? (mode === 'complete' ? 'manual complete' : `manual ${mode}`);
    const ctx: EnterContext = {
      definition,
      instanceId: instance.instanceId,
      correlationId: instance.correlationId,
      title: instance.title,
      goal: instance.goal,
      simTime: input.simTime,
      buffer: [],
      overrides: assignmentOverridesOf(instance),
    };
    const engine = engineActor(ctx.correlationId);
    const cancelResult = cancelActiveTasks(instance, ctx, engine, `workflow_${mode}`);
    if (!cancelResult.ok) return cancelResult;

    for (const stepId of instance.activeStepIds) {
      const located = findStep(definition, stepId);
      if (located === null) continue;
      const state = instance.stepStates[stepId];
      const taskId = state?.taskId ?? null;
      if (mode === 'complete') {
        const stepCompleted = emitWorkflow(
          WORKFLOW_STEP_COMPLETED,
          {
            instanceId: instance.instanceId,
            stageId: located.stage.stageId,
            stepId,
            outcome: 'manual',
            taskId,
            outputs: null,
          },
          input.actor,
          instance.instanceId,
          ctx.correlationId,
          input.simTime,
        );
        if (!stepCompleted.ok) return stepCompleted;
        ctx.buffer.push(stepCompleted.value);
      } else {
        const stepRejected = emitWorkflow(
          WORKFLOW_STEP_REJECTED,
          {
            instanceId: instance.instanceId,
            stageId: located.stage.stageId,
            stepId,
            reason,
            taskId,
          },
          input.actor,
          instance.instanceId,
          ctx.correlationId,
          input.simTime,
        );
        if (!stepRejected.ok) return stepRejected;
        ctx.buffer.push(stepRejected.value);
      }
    }

    if (mode === 'complete') {
      const completed = emitWorkflow(
        WORKFLOW_INSTANCE_COMPLETED,
        { instanceId: instance.instanceId, reason },
        input.actor,
        instance.instanceId,
        ctx.correlationId,
        input.simTime,
      );
      if (!completed.ok) return completed;
      ctx.buffer.push(completed.value);
      return finalize(instance, ctx.buffer, [], 'completed');
    }

    const aborted = emitWorkflow(
      WORKFLOW_INSTANCE_ABORTED,
      {
        instanceId: instance.instanceId,
        reason: mode === 'fail' ? 'failed' : 'cancelled',
        detail: reason,
      },
      input.actor,
      instance.instanceId,
      ctx.correlationId,
      input.simTime,
    );
    if (!aborted.ok) return aborted;
    ctx.buffer.push(aborted.value);
    return finalize(instance, ctx.buffer, [], 'aborted');
  };

  const wait = (
    input: WorkflowInstanceCommandInput,
  ): Result<WorkflowOperation, WorkflowFailure> => {
    const instance = loadInstance(input.instanceId);
    if (instance === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_instance',
          'instanceId',
          `instance "${input.instanceId}" does not exist`,
        ),
      };
    }
    if (instance.status === 'completed' || instance.status === 'aborted') {
      return {
        ok: false,
        error: workflowError(
          'instance_terminal',
          'status',
          `instance is already ${instance.status}`,
        ),
      };
    }
    if (instance.status !== 'running') {
      return {
        ok: false,
        error: workflowError(
          'instance_blocked',
          'status',
          `instance is ${instance.status} and cannot be paused again`,
        ),
      };
    }
    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };
    const authFailure = authorize(
      input.actor,
      'RequestDeviation',
      `workflow:${instance.instanceId}`,
    );
    if (authFailure !== null) return { ok: false, error: authFailure };

    const waitDefinition = loadDefinition(instance.workflowId);
    if (waitDefinition === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_workflow',
          'workflowId',
          `workflow "${instance.workflowId}" is not registered`,
        ),
      };
    }
    const ctx: EnterContext = {
      definition: waitDefinition,
      instanceId: instance.instanceId,
      correlationId: instance.correlationId,
      title: instance.title,
      goal: instance.goal,
      simTime: input.simTime,
      buffer: [],
      overrides: assignmentOverridesOf(instance),
    };
    const blocked = emitWorkflow(
      WORKFLOW_INSTANCE_BLOCKED,
      {
        instanceId: instance.instanceId,
        kind: 'manual',
        detail: input.reason ?? 'paused by operator',
        stepId: instance.activeStepIds[0] ?? null,
      },
      input.actor,
      instance.instanceId,
      ctx.correlationId,
      input.simTime,
    );
    if (!blocked.ok) return blocked;
    ctx.buffer.push(blocked.value);
    return finalize(instance, ctx.buffer, [], 'paused');
  };

  const resume = (
    input: WorkflowInstanceCommandInput,
  ): Result<WorkflowOperation, WorkflowFailure> => {
    const instance = loadInstance(input.instanceId);
    if (instance === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_instance',
          'instanceId',
          `instance "${input.instanceId}" does not exist`,
        ),
      };
    }
    if (instance.status === 'completed' || instance.status === 'aborted') {
      return {
        ok: false,
        error: workflowError(
          'instance_terminal',
          'status',
          `instance is already ${instance.status}`,
        ),
      };
    }
    if (instance.status === 'running') {
      return {
        ok: false,
        error: workflowError(
          'instance_not_running',
          'status',
          'instance is not blocked',
        ),
      };
    }
    if (instance.blockedReason === null || instance.blockedReason.kind !== 'manual') {
      return {
        ok: false,
        error: workflowError(
          'approval_not_open',
          'status',
          'instance is blocked on an approval, not on a manual pause',
        ),
      };
    }
    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };
    const authFailure = authorize(
      input.actor,
      'ApproveStep',
      `workflow:${instance.instanceId}`,
    );
    if (authFailure !== null) return { ok: false, error: authFailure };

    const resumeDefinition = loadDefinition(instance.workflowId);
    if (resumeDefinition === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_workflow',
          'workflowId',
          `workflow "${instance.workflowId}" is not registered`,
        ),
      };
    }
    const ctx: EnterContext = {
      definition: resumeDefinition,
      instanceId: instance.instanceId,
      correlationId: instance.correlationId,
      title: instance.title,
      goal: instance.goal,
      simTime: input.simTime,
      buffer: [],
      overrides: assignmentOverridesOf(instance),
    };
    const resumed = emitWorkflow(
      WORKFLOW_INSTANCE_RESUMED,
      { instanceId: instance.instanceId, resumedBy: commandActorId(input.actor) },
      input.actor,
      instance.instanceId,
      ctx.correlationId,
      input.simTime,
    );
    if (!resumed.ok) return resumed;
    ctx.buffer.push(resumed.value);
    return finalize(instance, ctx.buffer, [], 'resumed');
  };

  /**
   * Deletion takes the instance and everything filed under it. The tasks go first, so their
   * `Task.Deleted` facts are on the log before the instance's own removal says what they were.
   */
  const removeInstance = (
    input: WorkflowInstanceCommandInput,
  ): Result<WorkflowOperation, WorkflowFailure> => {
    const instance = loadInstance(input.instanceId);
    if (instance === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_instance',
          'instanceId',
          `instance "${input.instanceId}" does not exist`,
        ),
      };
    }
    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };
    // The same gate `Workflow.Cancel` goes through: refusing a removal is refusing a step.
    const authFailure = authorize(
      input.actor,
      'RejectStep',
      `workflow:${instance.instanceId}`,
    );
    if (authFailure !== null) return { ok: false, error: authFailure };

    const reason =
      input.reason === undefined || input.reason === null || input.reason.trim() === ''
        ? 'deleted by the operator'
        : input.reason;
    const buffer: OrgEvent[] = [];
    const deletedTaskIds: string[] = [];
    const owned = tasks.all().filter((task) => task.workflowInstanceId === instance.instanceId);

    // Authorize the whole cascade before the first record goes. `TaskService.delete` checks
    // `RejectTask` per task id, so a policy that grants it narrowly could refuse the third task —
    // by then two `Task.Deleted` facts are already on the log while the instance survives, and the
    // stores and a replay would disagree about which tasks exist. The instance gate (`RejectStep`)
    // above is not that check: it answers for `workflow:<id>`, never for `task:<id>`.
    for (const task of owned) {
      const denied = authorize(input.actor, 'RejectTask', `task:${task.taskId}`);
      if (denied !== null) return { ok: false, error: denied };
    }

    for (const task of owned) {
      const deleted = tasks.delete({
        taskId: task.taskId,
        actor: input.actor,
        simTime: input.simTime,
        reason,
      });
      if (!deleted.ok) return { ok: false, error: mapTaskFailure(deleted.error) };
      buffer.push(...deleted.value.events);
      deletedTaskIds.push(task.taskId);
    }

    const removed = emitWorkflow(
      WORKFLOW_INSTANCE_DELETED,
      { instanceId: instance.instanceId, reason, taskIds: Object.freeze(deletedTaskIds) },
      input.actor,
      instance.instanceId,
      instance.correlationId,
      input.simTime,
    );
    if (!removed.ok) return removed;
    buffer.push(removed.value);

    // The log answers the same question the store does: if folding this buffer does not empty
    // the instance, something other than a deletion was written and nothing may be dropped.
    let folded: WorkflowInstance | null = instance;
    for (const event of buffer) folded = applyWorkflowEvent(folded, event);
    if (folded !== null) {
      return {
        ok: false,
        error: workflowError(
          'event_contract_violation',
          'events',
          'deletion event stream did not empty the instance',
        ),
      };
    }
    store.delete(instance.instanceId);

    return {
      ok: true,
      value: { instance, events: buffer, outcome: 'deleted' },
    };
  };

  /**
   * M1.8: per-instance, whole-batch executor override for task steps that have not entered
   * yet. Atomic: every entry is validated up front; one bad entry fails the command with no
   * events at all. Entries identical to the folded override state emit no events (accepted
   * no-op). Authorization is the Control Plane's concern; here we re-check the actor's
   * legitimacy only, mirroring `resume`.
   */
  const overrideAssignments = (
    input: WorkflowOverrideAssignmentsInput,
  ): Result<WorkflowOperation, WorkflowFailure> => {
    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };
    const instance = loadInstance(input.instanceId);
    if (instance === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_instance',
          'instanceId',
          `instance "${input.instanceId}" does not exist`,
        ),
      };
    }
    if (instance.status === 'completed' || instance.status === 'aborted') {
      return {
        ok: false,
        error: workflowError(
          'instance_terminal',
          'status',
          `instance is already ${instance.status}`,
        ),
      };
    }
    if (!Array.isArray(input.overrides) || input.overrides.length === 0) {
      return {
        ok: false,
        error: workflowError(
          'invalid_input',
          'overrides',
          'overrides must be a non-empty list',
        ),
      };
    }
    const definition = loadDefinition(instance.workflowId);
    if (definition === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_workflow',
          'workflowId',
          `workflow "${instance.workflowId}" is not registered`,
        ),
      };
    }
    const current = assignmentOverridesOf(instance);
    const seen = new Set<string>();
    const issues: WorkflowIssue[] = [];
    const normalized: { stepId: string; employeeId: string; reason: string | null }[] = [];
    for (let index = 0; index < input.overrides.length; index += 1) {
      const entry = input.overrides[index];
      const field = `overrides.${String(index)}`;
      const stepId = typeof entry?.stepId === 'string' ? entry.stepId.trim() : '';
      const employeeId = typeof entry?.employeeId === 'string' ? entry.employeeId.trim() : '';
      const reason =
        typeof entry?.reason === 'string' && entry.reason.trim() !== '' ? entry.reason.trim() : null;
      if (stepId === '') {
        issues.push(workflowIssue(`${field}.stepId`, 'stepId must not be empty'));
        continue;
      }
      if (employeeId === '') {
        issues.push(workflowIssue(`${field}.employeeId`, 'employeeId must not be empty'));
        continue;
      }
      if (seen.has(stepId)) {
        issues.push(workflowIssue(`${field}.stepId`, `duplicate override for step "${stepId}"`));
        continue;
      }
      seen.add(stepId);
      const located = findStep(definition, stepId);
      if (located === null) {
        issues.push(
          workflowIssue(
            `${field}.stepId`,
            `step "${stepId}" does not exist in workflow "${definition.workflowId}"`,
          ),
        );
        continue;
      }
      if (located.step.kind !== 'task') {
        issues.push(
          workflowIssue(
            `${field}.stepId`,
            `step "${stepId}" is a ${located.step.kind} step; only task steps can be overridden`,
          ),
        );
        continue;
      }
      const state = instance.stepStates[stepId];
      if (state !== undefined) {
        issues.push(
          workflowIssue(
            `${field}.stepId`,
            `step "${stepId}" already entered (status ${state.status}); only not-yet-entered steps can be overridden`,
          ),
        );
        continue;
      }
      const employee = graph.getEmployee(employeeId as EmployeeId);
      if (employee === null) {
        issues.push(
          workflowIssue(`${field}.employeeId`, `employee "${employeeId}" does not exist`),
        );
        continue;
      }
      if (!isExecutableEmployment(employee.status)) {
        issues.push(
          workflowIssue(
            `${field}.employeeId`,
            `employee "${employee.id}" has employment status "${employee.status}" and cannot be assigned steps`,
          ),
        );
        continue;
      }
      const position = graph.getPosition(employee.positionId);
      if (located.step.requiredRoles.length > 0) {
        const matched =
          position !== null &&
          located.step.requiredRoles.some(
            (role) => role === position.id || role === position.key || role === position.roleCode,
          );
        if (!matched) {
          issues.push(
            workflowIssue(
              `${field}.employeeId`,
              `employee "${employee.id}" does not hold any of the required roles of step "${stepId}"`,
            ),
          );
        }
      }
      if (located.step.requiredAuthority !== null) {
        const meets =
          options.authority !== undefined &&
          options.authority.meets(employee.id, located.step.requiredAuthority);
        if (!meets) {
          issues.push(
            workflowIssue(
              `${field}.employeeId`,
              `employee "${employee.id}" does not meet the required authority of step "${stepId}"`,
            ),
          );
        }
      }
      normalized.push({ stepId, employeeId: employee.id, reason });
    }
    if (issues.length > 0) {
      return { ok: false, error: { code: 'invalid_input' as const, issues } };
    }
    const changed = normalized.filter((entry) => current[entry.stepId] !== entry.employeeId);
    if (changed.length === 0) {
      // Accepted no-op: nothing new to fold, so the projection is untouched.
      return finalize(instance, [], [], null);
    }
    const actorId = commandActorId(input.actor);
    const buffer: OrgEvent[] = [];
    for (const entry of changed) {
      const emitted = emitWorkflow(
        WORKFLOW_STEP_ASSIGNMENT_OVERRIDDEN,
        {
          instanceId: instance.instanceId,
          stepId: entry.stepId,
          employeeId: entry.employeeId,
          actorId,
          previousEmployeeId: current[entry.stepId] ?? null,
          reason: entry.reason ?? input.reason ?? null,
        },
        input.actor,
        instance.instanceId,
        instance.correlationId,
        input.simTime,
      );
      if (!emitted.ok) return emitted;
      buffer.push(emitted.value);
    }
    return finalize(instance, buffer, [], null);
  };

  /**
   * M1.9: promote a draft instance (`context.draft === true`, created with
   * `awaitConfirmation`) to a running workflow. Drops the marker via
   * `Workflow.DraftConfirmed`, then enters the entry stage — with the same per-instance
   * overrides the canvas staged onto it.
   */
  const confirm = (
    input: WorkflowConfirmInput,
  ): Result<WorkflowOperation, WorkflowFailure> => {
    const actorFailure = validateActor(input.actor);
    if (actorFailure !== null) return { ok: false, error: actorFailure };
    const instance = loadInstance(input.instanceId);
    if (instance === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_instance',
          'instanceId',
          `instance "${input.instanceId}" does not exist`,
        ),
      };
    }
    if (instance.status === 'completed' || instance.status === 'aborted') {
      return {
        ok: false,
        error: workflowError(
          'instance_terminal',
          'status',
          `instance is already ${instance.status}`,
        ),
      };
    }
    if (instance.context[DRAFT_CONTEXT_KEY] !== true) {
      return {
        ok: false,
        error: workflowError(
          'instance_not_draft',
          'status',
          `instance "${instance.instanceId}" is not a draft awaiting confirmation`,
        ),
      };
    }
    const definition = loadDefinition(instance.workflowId);
    if (definition === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_workflow',
          'workflowId',
          `workflow "${instance.workflowId}" is not registered`,
        ),
      };
    }
    const ctx: EnterContext = {
      definition,
      instanceId: instance.instanceId,
      correlationId: instance.correlationId,
      title: instance.title,
      goal: instance.goal,
      simTime: input.simTime,
      buffer: [],
      overrides: assignmentOverridesOf(instance),
    };
    const confirmed = emitWorkflow(
      WORKFLOW_DRAFT_CONFIRMED,
      {
        instanceId: instance.instanceId,
        confirmedBy: commandActorId(input.actor),
        reason: input.reason ?? null,
      },
      input.actor,
      instance.instanceId,
      instance.correlationId,
      input.simTime,
    );
    if (!confirmed.ok) return confirmed;
    ctx.buffer.push(confirmed.value);

    const entered = enterEntryStage(ctx, definition);
    if (!entered.ok) return entered;
    return finalize(instance, ctx.buffer, [], null);
  };

  const gate = (
    input: WorkflowGateInput,
  ): Result<WorkflowGateVerdict, WorkflowFailure> => {
    const instance = loadInstance(input.instanceId);
    if (instance === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_instance',
          'instanceId',
          `instance "${input.instanceId}" does not exist`,
        ),
      };
    }
    const definition = loadDefinition(instance.workflowId);
    if (definition === null) {
      return {
        ok: false,
        error: workflowError(
          'unknown_workflow',
          'workflowId',
          `workflow "${instance.workflowId}" is not registered`,
        ),
      };
    }
    const located = findStep(definition, input.stepId);
    if (located === null) {
      return {
        ok: false,
        error: workflowError(
          'invalid_definition',
          'stepId',
          `step "${input.stepId}" does not exist in workflow "${instance.workflowId}"`,
        ),
      };
    }
    const { step } = located;
    const state = instance.stepStates[input.stepId] ?? null;
    const checks: WorkflowGateCheck[] = [];
    const stateTaskId = state?.taskId ?? null;
    const task = stateTaskId === null ? null : tasks.get(stateTaskId);
    const executor = task === null ? null : executorIdOf(task);

    const instanceOk = instance.status !== 'completed' && instance.status !== 'aborted';
    checks.push({
      check: 'instance_active',
      passed: instanceOk,
      reason: instanceOk ? null : `instance is ${instance.status}`,
    });

    const stepOk = state !== null && state.status === 'active';
    checks.push({
      check: 'step_active',
      passed: stepOk,
      reason: stepOk ? null : `step is ${state === null ? 'not entered' : state.status}`,
    });

    const actorFailure = validateActor(input.actor);
    checks.push({
      check: 'actor_legitimacy',
      passed: actorFailure === null,
      reason: actorFailure === null ? null : actorFailure.issues[0]?.reason ?? null,
    });

    if (step.kind === 'task') {
      if (input.actor.kind === 'system') {
        checks.push({ check: 'assignment', passed: true, reason: null });
      } else if (executor === null) {
        checks.push({
          check: 'assignment',
          passed: false,
          reason: 'step task has no executor',
        });
      } else {
        const matches = executor === input.actor.context.employeeId;
        checks.push({
          check: 'assignment',
          passed: matches,
          reason: matches ? null : `task executes as "${executor}"`,
        });
      }
    } else {
      checks.push({ check: 'assignment', passed: true, reason: null });
    }

    if (step.requiredAuthority !== null && input.actor.kind === 'employee') {
      const meets = meetsContextAuthority(input.actor.context, step.requiredAuthority);
      checks.push({
        check: 'authority',
        passed: meets,
        reason: meets
          ? null
          : `lacks level ${step.requiredAuthority.level} in "${step.requiredAuthority.domain}"`,
      });
    } else {
      checks.push({ check: 'authority', passed: true, reason: null });
    }

    const authCtx: AuthzContext | undefined =
      step.requiredRoles.length > 0 ? { requiredRoles: step.requiredRoles } : undefined;
    const authFailure = authorize(
      input.actor,
      input.action,
      `workflow:${instance.instanceId}/step:${step.stepId}`,
      authCtx,
    );
    checks.push({
      check: 'permission',
      passed: authFailure === null,
      reason: authFailure === null ? null : authFailure.issues[0]?.reason ?? null,
    });

    const allowed = checks.every((check) => check.passed);
    return {
      ok: true,
      value: {
        instanceId: instance.instanceId,
        stepId: step.stepId,
        kind: step.kind,
        status: state?.status ?? null,
        assigneeEmployeeId: executor,
        requiredAuthority: step.requiredAuthority,
        requiredRoles: step.requiredRoles,
        allowed,
        checks,
      },
    };
  };

  return { start, advance, approve, wait, resume, complete: (i) => manualCommand(i, 'complete'), fail: (i) => manualCommand(i, 'fail'), cancel: (i) => manualCommand(i, 'cancel'), delete: removeInstance, overrideAssignments, confirm, gate };
}


/** A workflow implementation step is only complete when it handed over executable material. */
export function hasRunnableArtifact(task: Task): boolean {
  const result = task.result;
  if (result === null) return false;
  if (result.artifacts.length > 0) return true;
  const data = result.data;
  return Object.keys(data).some((key) =>
    /\.(?:html?|css|js|mjs|cjs|tsx?|jsx|py|json|ya?ml|sh|sql|vue|svelte)$/i.test(key));
}
