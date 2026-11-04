import type {
  CorrelationId,
  EmployeeId,
  OrgEvent,
  PositionId,
  Result,
  SimTime,
  Step,
} from '@maoeh/shared-types';
import { PRESENCE_STATES } from '@maoeh/shared-types';
import type {
  PlanExecutionContext,
  PlanExecutionFailure,
  PlanExecutor,
} from '@maoeh/agent-runtime';
import { RUNTIME_PRESENCE_CHANGED } from '@maoeh/agent-runtime';
import type { CollaborationService, CommunicationService } from '@maoeh/agent-communication';
import { createOrgEvent } from '@maoeh/event-system';
import type { BudgetTracker } from '@maoeh/runtime-scheduler';
import type { AuthzService } from '@maoeh/permission-system';
import { employeeActor, resourceRef } from '@maoeh/permission-system';
import type { Organization } from '@maoeh/organization-model';
import type { TaskService } from '@maoeh/task-system';
import { HIRING_WORKFLOW_ID } from '@maoeh/workflow-engine';
import type { WorkflowEngine, WorkflowInstanceStore } from '@maoeh/workflow-engine';

export const PLAN_ACTION_BINDINGS: Readonly<Record<string, string>> = Object.freeze({
  CreateProposal: 'workflow.start',
  DispatchWork: 'tasks.dispatch',
  AcceptTask: 'tasks.accept',
  StartTask: 'tasks.start',
  ProgressReport: 'tasks.submit',
  SubmitReport: 'tasks.submit',
  CompleteTask: 'tasks.complete',
  RejectTask: 'tasks.reject',
  BlockTask: 'tasks.block',
  CastVote: 'workflow.approve',
  ApproveStep: 'workflow.approve',
  RejectStep: 'workflow.approve',
  SendMessage: 'communication.sendMessage',
  RequestCollaboration: 'collaboration.request',
  UpdatePresence: 'runtime.presenceChanged',
  RecommendHire: 'agents.create',
  Reflect: 'noop',
});

export interface KernelPlanExecutorDeps {
  readonly tasks: TaskService;
  readonly workflow: WorkflowEngine;
  readonly communication: CommunicationService | null;
  readonly collaboration: CollaborationService | null;
  readonly budget: BudgetTracker;
  /**
   * Hiring (route A, `role-agents-cannot-complete-tasks.md` §9 A1/A2/A4): the binding authorizes
   * through the kernel's own `AuthzService`; since A4 the plan never writes the roster — it
   * opens the root approval gate with `workflow` and reads `instances` to keep a repeated
   * recommendation idempotent.
   */
  readonly authz: AuthzService;
  readonly organization: Organization;
  readonly instances: WorkflowInstanceStore;
}

interface OperationError {
  readonly code: string;
  readonly issues: readonly { readonly field: string; readonly reason: string }[];
}

function planFailure(code: string, field: string, reason: string): PlanExecutionFailure {
  return { code, issues: [{ field, reason }] };
}

function toPlanFailure(error: OperationError): PlanExecutionFailure {
  return {
    code: error.code,
    issues: error.issues.map((issue) => ({ field: issue.field, reason: issue.reason })),
  };
}

function readString(args: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

const MISSING_TASK_ID = planFailure(
  'invalid_args',
  'args.taskId',
  'taskId is required',
);

function readRecord(args: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  const value = args[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function readStringArray(
  args: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = args[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

function requireTaskId(args: Readonly<Record<string, unknown>>): string | PlanExecutionFailure {
  return readString(args, 'taskId') ?? MISSING_TASK_ID;
}

/**
 * The seat a `hire-gate` instance is about, read off its context. The gate is the live record of
 * every hiring request for a seat — pending or already decided — so the binding uses this to keep
 * a repeated recommendation idempotent (A4, R9).
 */
function hirePositionOf(instance: {
  readonly context: Readonly<Record<string, unknown>>;
}): string | null {
  const hire = instance.context['hire'];
  if (typeof hire !== 'object' || hire === null || Array.isArray(hire)) return null;
  return readString(hire as Readonly<Record<string, unknown>>, 'positionId');
}

/**
 * A1's scope gate, the same walk `TaskService.dispatch` uses for `DispatchWork` (A2): hiring
 * reaches downward — and into your own seat — never across or upward. A cycle in the
 * `reports_to` chain stops the walk instead of hanging it.
 */
function withinReportingSubtree(
  organization: Organization,
  actorPositionId: PositionId,
  targetPositionId: PositionId,
): boolean {
  let cursor: PositionId | null = targetPositionId;
  const seen = new Set<PositionId>();
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === actorPositionId) return true;
    seen.add(cursor);
    const position = organization.positions.find((entry) => entry.id === cursor);
    cursor = position === undefined ? null : position.reportsToPositionId;
  }
  return false;
}

function isFailure(
  value: unknown,
): value is PlanExecutionFailure {
  return typeof value === 'object' && value !== null && 'issues' in value && 'code' in value;
}

export function createKernelPlanExecutor(
  deps: KernelPlanExecutorDeps,
): PlanExecutor {
  const execute = async (
    step: Step,
    context: PlanExecutionContext,
  ): Promise<Result<readonly OrgEvent[], PlanExecutionFailure>> => {
    const actor = employeeActor(context.actorContext);
    const simTime: SimTime = context.simTime;
    const args = step.args;
    const binding = PLAN_ACTION_BINDINGS[step.action];

    if (binding === undefined) {
      return {
        ok: false,
        error: planFailure(
          'unsupported_action',
          'step.action',
          `action "${step.action}" is not executable by the kernel plan executor`,
        ),
      };
    }

    const taskCommand = (
      run: () => Result<{ readonly events: readonly OrgEvent[] }, OperationError>,
    ): Result<readonly OrgEvent[], PlanExecutionFailure> => {
      if (!deps.budget.tryTask()) {
        return { ok: false, error: planFailure('budget_exceeded', 'budget.maxTasks', 'task budget exhausted') };
      }
      const outcome = run();
      if (!outcome.ok) return { ok: false, error: toPlanFailure(outcome.error) };
      return { ok: true, value: outcome.value.events };
    };

    const workflowCommand = (
      run: () => Result<{ readonly events: readonly OrgEvent[] }, OperationError>,
    ): Result<readonly OrgEvent[], PlanExecutionFailure> => {
      if (!deps.budget.tryWorkflowTransition()) {
        return {
          ok: false,
          error: planFailure(
            'budget_exceeded',
            'budget.maxWorkflowTransitions',
            'workflow transition budget exhausted',
          ),
        };
      }
      const outcome = run();
      if (!outcome.ok) return { ok: false, error: toPlanFailure(outcome.error) };
      return { ok: true, value: outcome.value.events };
    };

    switch (binding) {
      case 'noop':
        return { ok: true, value: Object.freeze([]) as readonly OrgEvent[] };

      case 'runtime.presenceChanged': {
        const presence = readString(args, 'presence');
        if (presence === null || !(PRESENCE_STATES as readonly string[]).includes(presence)) {
          return {
            ok: false,
            error: planFailure('invalid_args', 'args.presence', 'presence must be a valid presence state'),
          };
        }
        const created = createOrgEvent(
          context.registry,
          {
            companyId: context.companyId,
            type: RUNTIME_PRESENCE_CHANGED,
            occurredAtSim: simTime,
            actorKind: 'employee',
            actorId: context.actorContext.employeeId,
            subjectType: 'employee',
            subjectId: context.actorContext.employeeId,
            correlationId: context.correlationId,
            causationId: context.causationId,
            ...(context.traceId === null ? {} : { traceId: context.traceId }),
            payload: { employeeId: context.actorContext.employeeId, presence },
          },
          { eventIdGenerator: () => context.nextEventId() },
        );
        if (!created.ok) {
          return {
            ok: false,
            error: toPlanFailure({ code: 'event_contract_violation', issues: created.error.issues }),
          };
        }
        return { ok: true, value: Object.freeze([created.value]) };
      }

      case 'tasks.dispatch': {
        const positionId = readString(args, 'positionId');
        const title = readString(args, 'title');
        if (positionId === null || title === null) {
          return {
            ok: false,
            error: planFailure(
              'invalid_args',
              'args',
              'positionId and title are required to dispatch work',
            ),
          };
        }
        const goal = readString(args, 'goal') ?? title;
        const detail = readString(args, 'detail');
        const requiredSkills = readStringArray(args, 'requiredSkills');
        const requiredOutputKeys = readStringArray(args, 'requiredOutputKeys');
        const verificationKind = readString(args, 'verificationKind') === 'review' ? 'review' : 'deterministic';
        const priority = typeof args['priority'] === 'number' ? args['priority'] : undefined;
        const dueAtSim =
          typeof args['dueAtSim'] === 'number' ? (args['dueAtSim'] as SimTime) : undefined;
        const maxAttempts =
          typeof args['maxAttempts'] === 'number' ? args['maxAttempts'] : undefined;
        // A5 stays in the domain: hand the keys over as given and let `dispatch()` refuse
        // work nobody can verify — a binding-level shortcut would bypass the gate.
        return taskCommand(() =>
          deps.tasks.dispatch({
            actor,
            simTime,
            positionId: positionId as PositionId,
            title,
            goal,
            ...(detail === null ? {} : { detail }),
            ...(requiredSkills.length === 0 ? {} : { requiredSkills }),
            ...(requiredOutputKeys.length === 0
              ? {}
              : { verification: { kind: verificationKind, requiredOutputKeys } }),
            ...(priority === undefined ? {} : { priority }),
            ...(dueAtSim === undefined ? {} : { dueAtSim }),
            ...(maxAttempts === undefined ? {} : { maxAttempts }),
          }),
        );
      }

      case 'tasks.accept': {
        const taskId = requireTaskId(args);
        if (isFailure(taskId)) return { ok: false, error: taskId };
        return taskCommand(() =>
          deps.tasks.accept({ taskId, actor, simTime }),
        );
      }

      case 'tasks.start': {
        const taskId = requireTaskId(args);
        if (isFailure(taskId)) return { ok: false, error: taskId };
        return taskCommand(() => deps.tasks.start({ taskId, actor, simTime }));
      }

      case 'tasks.submit': {
        const taskId = requireTaskId(args);
        if (isFailure(taskId)) return { ok: false, error: taskId };
        const summary = readString(args, 'summary');
        if (summary === null) {
          return { ok: false, error: planFailure('invalid_args', 'args.summary', 'summary is required') };
        }
        const artifacts = readStringArray(args, 'artifacts');
        return taskCommand(() =>
          deps.tasks.submit({
            taskId,
            actor,
            simTime,
            submission: {
              summary,
              data: readRecord(args, 'data'),
              ...(artifacts.length === 0 ? {} : { artifacts }),
            },
          }),
        );
      }

      case 'tasks.complete': {
        const taskId = requireTaskId(args);
        if (isFailure(taskId)) return { ok: false, error: taskId };
        return taskCommand(() => deps.tasks.complete({ taskId, actor, simTime }));
      }

      case 'tasks.reject': {
        const taskId = requireTaskId(args);
        if (isFailure(taskId)) return { ok: false, error: taskId };
        const reason = readString(args, 'reason') ?? 'rejected by agent plan';
        return taskCommand(() => deps.tasks.reject({ taskId, actor, simTime, reason }));
      }

      case 'tasks.block': {
        const taskId = requireTaskId(args);
        if (isFailure(taskId)) return { ok: false, error: taskId };
        const reason = readString(args, 'reason') ?? 'blocked by agent plan';
        return taskCommand(() => deps.tasks.block({ taskId, actor, simTime, reason }));
      }

      case 'workflow.start': {
        const workflowId = readString(args, 'workflowId');
        const capabilities = readStringArray(args, 'capabilities');
        if (workflowId === null && capabilities.length === 0) {
          return {
            ok: false,
            error: planFailure(
              'invalid_args',
              'args',
              'workflowId or capabilities is required',
            ),
          };
        }
        const title = readString(args, 'title') ?? readString(args, 'goal') ?? 'Proposal';
        const goal = readString(args, 'goal') ?? title;
        const instanceId = readString(args, 'instanceId');
        return workflowCommand(() =>
          deps.workflow.start({
            ...(workflowId === null ? {} : { workflowId }),
            ...(capabilities.length === 0 ? {} : { capabilities }),
            actor,
            simTime,
            title,
            goal,
            ...(instanceId === null ? {} : { instanceId }),
          }),
        );
      }

      case 'workflow.approve': {
        const instanceId = readString(args, 'instanceId');
        if (instanceId === null) {
          return {
            ok: false,
            error: planFailure('invalid_args', 'args.instanceId', 'instanceId is required'),
          };
        }
        const decision =
          step.action === 'RejectStep'
            ? 'denied'
            : readString(args, 'decision') === 'denied'
              ? 'denied'
              : 'granted';
        const reason = readString(args, 'reason');
        return workflowCommand(() =>
          deps.workflow.approve({
            instanceId,
            actor,
            decision,
            simTime,
            ...(reason === null ? {} : { reason }),
          }),
        );
      }

      case 'communication.sendMessage': {
        if (deps.communication === null) {
          return {
            ok: false,
            error: planFailure('unsupported_action', 'step.action', 'communication service is not wired'),
          };
        }
        const channelId = readString(args, 'channelId');
        const recipientIds = readStringArray(args, 'recipientIds');
        const subject = readString(args, 'subject') ?? 'message';
        const body = readString(args, 'body');
        if (channelId === null || recipientIds.length === 0 || body === null) {
          return {
            ok: false,
            error: planFailure(
              'invalid_args',
              'args',
              'channelId, recipientIds and body are required',
            ),
          };
        }
        const outcome = deps.communication.sendMessage({
          actor: context.actorContext,
          senderEmployeeId: context.actorContext.employeeId,
          channelId,
          recipientIds: recipientIds as readonly EmployeeId[],
          subject,
          body,
          messageType: readString(args, 'messageType') === 'response' ? 'response' : 'request',
          simTime,
        });
        if (!outcome.ok) return { ok: false, error: toPlanFailure(outcome.error) };
        return { ok: true, value: Object.freeze([outcome.value.event]) };
      }

      case 'collaboration.request': {
        if (deps.collaboration === null) {
          return {
            ok: false,
            error: planFailure(
              'unsupported_action',
              'step.action',
              'collaboration service is not wired',
            ),
          };
        }
        const toAgentId = readString(args, 'toAgentId');
        const purpose = readString(args, 'purpose');
        const collaboratorTaskId = requireTaskId(args);
        if (isFailure(collaboratorTaskId)) return { ok: false, error: collaboratorTaskId };
        if (toAgentId === null || purpose === null) {
          return {
            ok: false,
            error: planFailure('invalid_args', 'args', 'toAgentId and purpose are required'),
          };
        }
        const outcome = deps.collaboration.requestCollaboration({
          actor: context.actorContext,
          fromAgentId: context.actorContext.employeeId,
          toAgentId: toAgentId as EmployeeId,
          taskId: collaboratorTaskId,
          purpose,
          simTime,
          correlationId: context.correlationId as CorrelationId,
          causationId: context.causationId,
          traceId: context.traceId,
        });
        if (!outcome.ok) return { ok: false, error: toPlanFailure(outcome.error) };
        return { ok: true, value: Object.freeze([outcome.value.event]) };
      }

      case 'agents.create': {
        // A1 (`role-agents-cannot-complete-tasks.md` §9): `RecommendHire` fills a seat the
        // chart already has — seat creation stays a control-plane capability (`Agent.Create`
        // with `newPosition`), and every bound below is checked *before* the roster moves so a
        // refusal and "nothing happened" are the same thing.
        const positionId = readString(args, 'positionId');
        const employeeId = readString(args, 'employeeId');
        const name = readString(args, 'name');
        const responsibilities = readStringArray(args, 'responsibilities');
        const traits = readStringArray(args, 'traits');
        const expertise = readStringArray(args, 'expertise');
        const employeeNo = readString(args, 'employeeNo');
        const cognitionProfileId = readString(args, 'cognitionProfileId');
        const templateEmployeeId = readString(args, 'templateEmployeeId');
        const statedReason = readString(args, 'reason');
        if (
          positionId === null ||
          employeeId === null ||
          name === null ||
          responsibilities.length === 0
        ) {
          return {
            ok: false,
            error: planFailure(
              'invalid_args',
              'args',
              'positionId, employeeId, name and at least one responsibility are required to hire',
            ),
          };
        }
        const invalid = (field: string, why: string): Result<readonly OrgEvent[], PlanExecutionFailure> => ({
          ok: false,
          error: planFailure('invalid_args', field, why),
        });
        // 128 is the control envelope's `commandId` bound; `hire-` is the prefix this binding
        // adds, so the id it is built from must leave room for it (otherwise the event would
        // fail its contract only *after* the employee was materialized).
        if (employeeId.length > 123 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(employeeId)) {
          return invalid(
            'args.employeeId',
            'employeeId must be a stable id of at most 123 characters (letters, digits, ".", "_" or "-")',
          );
        }
        if (name.length > 200) return invalid('args.name', 'name must be at most 200 characters');
        if (positionId.length > 128) {
          return invalid('args.positionId', 'positionId must be at most 128 characters');
        }
        if (responsibilities.some((entry) => entry.length > 200)) {
          return invalid('args.responsibilities', 'each responsibility must be at most 200 characters');
        }
        if (traits.some((entry) => entry.length > 200)) {
          return invalid('args.traits', 'each trait must be at most 200 characters');
        }
        if (expertise.some((entry) => entry.length > 64)) {
          return invalid('args.expertise', 'each expertise must be at most 64 characters');
        }
        if (employeeNo !== null && employeeNo.length > 64) {
          return invalid('args.employeeNo', 'employeeNo must be at most 64 characters');
        }
        const reason = statedReason ?? `Recommended hire "${name}" into position "${positionId}"`;
        if (reason.length > 2000) return invalid('args.reason', 'reason must be at most 2000 characters');

        // A1: the hire is authorized against the seat it targets, exactly like the control
        // plane's `Agent.Create` — the only difference is that the actor here is an employee.
        const decision = deps.authz.can(
          context.actorContext,
          'ControlAgent',
          resourceRef(`position:${positionId}`),
        );
        if (!decision.allow) {
          const parts = [`ControlAgent on position:${positionId}: ${decision.reason}`];
          if (decision.requiredAuthority !== undefined) {
            parts.push(`requiredAuthority=${String(decision.requiredAuthority)}`);
          }
          if (decision.escalateTo !== undefined) parts.push(`escalateTo=${String(decision.escalateTo)}`);
          return {
            ok: false,
            error: planFailure(
              decision.reason === 'NEEDS_APPROVAL' ? 'NEEDS_APPROVAL' : 'UNAUTHORIZED',
              'permission',
              parts.join(' '),
            ),
          };
        }

        const position = deps.organization.positions.find((entry) => String(entry.id) === positionId);
        if (position === undefined) {
          return {
            ok: false,
            error: planFailure(
              'unknown_position',
              'args.positionId',
              `position "${positionId}" does not exist in this organization`,
            ),
          };
        }
        if (!withinReportingSubtree(deps.organization, context.actorContext.positionId, position.id)) {
          return {
            ok: false,
            error: planFailure(
              'UNAUTHORIZED',
              'args.positionId',
              `position "${positionId}" lies outside the reporting subtree of "${context.actorContext.positionId}"`,
            ),
          };
        }

        // A4 (`role-agents-cannot-complete-tasks.md` §9): the plan no longer fills the seat. It
        // enters the root approval chain instead — the roster, the original task's assignment and
        // the deferred workflow proposal must all stand still while the decision is open, and the
        // kernel's deterministic pass (`runHiringGatePhase`) applies the outcome. Everything a
        // refusal must undo therefore never happens here: before the first mutation the binding
        // checks the request is still undecided, and the side effects are exactly one blocked
        // (recoverable) task plus a `hire-gate` instance awaiting the root's grant.
        //
        // Idempotency (R9): a repeated recommendation for the same seat finds the live instance —
        // pending *or* decided — and becomes a no-op, so a duplicate approval can never open a
        // second gate or create a second employee.
        if (deps.organization.employees.some((entry) => String(entry.id) === employeeId)) {
          return { ok: true, value: Object.freeze([]) };
        }
        const priorHire = deps.instances.all().find(
          (instance) =>
            instance.workflowId === HIRING_WORKFLOW_ID &&
            hirePositionOf(instance) === positionId,
        );
        if (priorHire !== undefined) {
          return { ok: true, value: Object.freeze([]) };
        }

        // Late (post-authorization) so an unauthorized actor still fails on permission rather
        // than on argument shape: the resume after the grant routes by these capabilities, so a
        // hire without them would fill a seat and lose the objectives it was meant to carry.
        const proposal = readRecord(args, 'proposal');
        const proposalCapabilities = readStringArray(proposal, 'capabilities');
        if (proposalCapabilities.length === 0) {
          return invalid(
            'args.proposal',
            'the deferred proposal must carry the capabilities the resume will route by',
          );
        }

        const proposalTitle =
          readString(proposal, 'title') ?? `Hire ${name} for ${positionId}`;
        const proposalGoal = readString(proposal, 'goal') ?? reason;
        // One original task per request: the id is derived from the brief (or, when the plan
        // carries no explicit ref, from the causal event), so a re-offered brief or a replayed
        // turn finds the task already held instead of forking the objectives.
        const briefRefRaw =
          readString(args, 'briefRef') ?? context.causationId ?? context.correlationId;
        const briefRef =
          briefRefRaw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '').slice(0, 48) ||
          'brief';
        const originalTaskId = `hire-task-${briefRef}`;

        // The chain (create → assign → accept → start → block) is atomic in budget terms: the
        // whole unit is charged before the first mutation, because a half-built task on a turn
        // whose events the runtime drops would diverge from the log on replay.
        const needTaskChain = deps.tasks.get(originalTaskId) === null;
        const taskOpCount = needTaskChain ? 5 : 0;
        for (let index = 0; index < taskOpCount; index += 1) {
          if (!deps.budget.tryTask()) {
            return {
              ok: false,
              error: planFailure('budget_exceeded', 'budget.maxTasks', 'task budget exhausted'),
            };
          }
        }
        if (!deps.budget.tryWorkflowTransition()) {
          return {
            ok: false,
            error: planFailure(
              'budget_exceeded',
              'budget.maxWorkflowTransitions',
              'workflow transition budget exhausted',
            ),
          };
        }

        const produced: OrgEvent[] = [];
        const runOp = (
          outcome: Result<{ readonly events: readonly OrgEvent[] }, OperationError>,
        ): Result<never, PlanExecutionFailure> | null => {
          if (!outcome.ok) return { ok: false, error: toPlanFailure(outcome.error) };
          produced.push(...outcome.value.events);
          return null;
        };

        if (needTaskChain) {
          const held = runOp(
            deps.tasks.holdForApproval({
              actor,
              simTime,
              taskId: originalTaskId,
              title: proposalTitle.slice(0, 200),
              goal: proposalGoal.slice(0, 2000),
              detail: `Hiring request for ${employeeId} into ${positionId} awaits the root approval chain; these objectives resume when the gate decides.`,
              employeeId: context.actorContext.employeeId,
              reason: `waiting_for_approval: hiring ${employeeId} into ${positionId} awaits the root approval chain`,
            }),
          );
          if (held !== null) return held;
        }

        const started = runOp(
          deps.workflow.start({
            workflowId: HIRING_WORKFLOW_ID,
            actor,
            simTime,
            title: `Hire ${name} for ${positionId}`.slice(0, 200),
            goal: reason.slice(0, 2000),
            context: {
              hire: {
                positionId,
                employeeId,
                name,
                responsibilities: [...responsibilities],
                traits: [...traits],
                expertise: [...expertise],
                reason,
                employeeNo,
                cognitionProfileId,
                templateEmployeeId,
              },
              originalTaskId,
              proposal: {
                capabilities: [...proposalCapabilities],
                title: proposalTitle,
                goal: proposalGoal,
              },
              briefRef,
            },
          }),
        );
        if (started !== null) return started;

        // The roster event is *not* written here anymore: `Control.AgentCreated` is emitted by
        // the kernel's post-decision pass together with the materialization itself, so a replay
        // rebuilds the employee from a grant that actually happened instead of from a request
        // that only waited.
        return { ok: true, value: Object.freeze(produced) };
      }

      default:
        return {
          ok: false,
          error: planFailure(
            'unsupported_action',
            'step.action',
            `binding "${binding}" is not implemented`,
          ),
        };
    }
  };

  return { execute };
}
