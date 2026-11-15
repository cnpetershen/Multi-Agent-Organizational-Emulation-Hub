import type { CorrelationId, EmployeeId, OrgEvent } from '@maoeh/shared-types';
import type { Identity } from '@maoeh/identity-system';
import type { Organization } from '@maoeh/organization-model';
import type { AuthzService } from '@maoeh/permission-system';
import { resourceRef } from '@maoeh/permission-system';
import type { WakeupTriggerKind } from '@maoeh/runtime-scheduler';
import type { TaskService } from '@maoeh/task-system';
import type {
  WorkflowDefinitionStore,
  WorkflowInstanceStore,
} from '@maoeh/workflow-engine';
import { HIRING_WORKFLOW_ID, findStep } from '@maoeh/workflow-engine';

export interface EligibilityDeps {
  readonly companyId: string;
  readonly organization: Organization;
  readonly identity: Identity;
  readonly authz: AuthzService;
  readonly tasks: TaskService;
  readonly instances: WorkflowInstanceStore;
  readonly definitions: WorkflowDefinitionStore;
  /**
   * Control-plane overlay. An operator may pause a single agent without pausing the
   * simulation; a paused agent is simply never eligible to be woken.
   */
  readonly controlState?: {
    isAgentPaused(employeeId: EmployeeId): boolean;
  };
}

export interface EligibleAgent {
  readonly employeeId: EmployeeId;
  readonly triggerKind: WakeupTriggerKind;
  readonly refId: string | null;
}

const NON_RUNNABLE_EMPLOYMENT = new Set(['suspended', 'transferred', 'offboarded']);

const NON_WAKEUP_PREFIXES = ['Runtime.', 'System.', 'Control.'] as const;

const TASK_EXECUTOR_EVENTS = [
  'Task.Blocked',
  'Task.Rejected',
  'Task.Failed',
] as const;

function payloadOf(event: OrgEvent): Readonly<Record<string, unknown>> {
  return typeof event.payload === 'object' && event.payload !== null
    ? (event.payload as Readonly<Record<string, unknown>>)
    : {};
}

function readString(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readStringArray(payload: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

function runnableEmployees(deps: EligibilityDeps): readonly EmployeeId[] {
  return deps.organization.employees
    .filter((employee) => !NON_RUNNABLE_EMPLOYMENT.has(employee.status))
    .filter((employee) => !isPaused(deps, employee.id))
    .map((employee) => employee.id);
}

function isPaused(deps: EligibilityDeps, employeeId: EmployeeId): boolean {
  return deps.controlState?.isAgentPaused(employeeId) ?? false;
}

function taskExecutor(
  deps: EligibilityDeps,
  event: OrgEvent,
): EmployeeId | null {
  const payload = payloadOf(event);
  const taskId = readString(payload, 'taskId');
  if (taskId !== null) {
    const task = deps.tasks.get(taskId);
    if (task !== null && task.assignment.assigneeEmployeeId !== null) {
      return task.assignment.assigneeEmployeeId;
    }
  }
  const employeeId = readString(payload, 'employeeId');
  return employeeId === null ? null : (employeeId as EmployeeId);
}

function approvalCandidates(
  deps: EligibilityDeps,
  event: OrgEvent,
): readonly EligibleAgent[] {
  const payload = payloadOf(event);
  const instanceId = readString(payload, 'instanceId');
  const stepId = readString(payload, 'stepId');
  if (instanceId === null || stepId === null) return [];

  const instance = deps.instances.get(instanceId);
  if (instance === null) return [];
  // A4: a hiring gate is a decision for the root, not a vote for the org chart. Its approval
  // step names `ceo`/`board-operator` roles, so the CEO agent would otherwise be woken and
  // deterministically grant its own request — the request must wait for the human, and the
  // kernel's post-decision pass (`runHiringGatePhase`) applies whatever the console decides.
  if (instance.workflowId === HIRING_WORKFLOW_ID) return [];
  const definition = deps.definitions.get(instance.workflowId);
  if (definition === null) return [];

  const located = findStep(definition, stepId);
  if (located === null) return [];
  const requiredRoles = located.step.requiredRoles;
  const resource = resourceRef(`workflow:${instanceId}/step:${stepId}`);
  const correlationId = event.correlationId as CorrelationId;

  const eligible: EligibleAgent[] = [];
  for (const employeeId of runnableEmployees(deps)) {
    let actor;
    try {
      actor = deps.identity.actorContext(employeeId, correlationId);
    } catch {
      continue;
    }
    const decision = deps.authz.can(actor, 'ApproveStep', resource, {
      requiredRoles,
    });
    if (!decision.allow) continue;
    eligible.push({
      employeeId,
      triggerKind: 'workflow',
      refId: instanceId,
    });
  }
  return eligible;
}

export function eligibleAgentsFor(
  event: OrgEvent,
  deps: EligibilityDeps,
): readonly EligibleAgent[] {
  return eligibleAgentsForEvent(event, deps).filter(
    (eligible) => !isPaused(deps, eligible.employeeId),
  );
}

/**
 * `true` when the entity the event is about no longer exists.
 *
 * Deletion drops an aggregate from its store, but it cannot retract the events that already
 * woke somebody about it: a wakeup queued for `Task.Assigned` may still be pending when the
 * operator deletes the task. Running that turn would report progress against work that is
 * already gone, so the turn is skipped instead of attempted and failed. The events themselves
 * never wake anyone — `Task.Deleted` and `Workflow.InstanceDeleted` are not triggers — this is
 * only about the wakeups the deletion arrived *after*.
 */
export function refersToDeletedWork(event: OrgEvent, deps: EligibilityDeps): boolean {
  const payload = payloadOf(event);
  if (event.type.startsWith('Task.')) {
    const taskId = readString(payload, 'taskId');
    return taskId !== null && deps.tasks.get(taskId) === null;
  }
  if (event.type.startsWith('Workflow.')) {
    const instanceId = readString(payload, 'instanceId');
    return instanceId !== null && deps.instances.get(instanceId) === null;
  }
  return false;
}

function eligibleAgentsForEvent(
  event: OrgEvent,
  deps: EligibilityDeps,
): readonly EligibleAgent[] {
  if (event.companyId !== deps.companyId) return [];
  for (const prefix of NON_WAKEUP_PREFIXES) {
    if (event.type.startsWith(prefix)) return [];
  }

  const payload = payloadOf(event);

  if (event.type === 'Task.Assigned') {
    const assignment = payload['assignment'];
    if (typeof assignment !== 'object' || assignment === null) return [];
    const assignee = readString(
      assignment as Readonly<Record<string, unknown>>,
      'assigneeEmployeeId',
    );
    if (assignee === null) return [];
    const taskId = readString(payload, 'taskId');
    // A4: the hiring gate parks its original task through assign → … → block in one turn, so the
    // assignment wake reaches the assignee only on a later tick, after the task is already
    // blocked. Waking them would burn a turn trying to work a task the root has not released.
    if (taskId !== null) {
      const task = deps.tasks.get(taskId);
      if (task !== null && task.status === 'blocked') return [];
      // M3.1: an accepted handoff emits `Task.Assigned` and the receiver may finish the work in
      // the very same turn. Re-waking them on the next tick for a submitted/completed task would
      // be a turn with nothing to do.
      if (
        task !== null &&
        (task.status === 'submitted' || task.status === 'completed' || task.status === 'cancelled')
      ) {
        return [];
      }
    }
    return [
      {
        employeeId: assignee as EmployeeId,
        triggerKind: 'task',
        refId: taskId,
      },
    ];
  }

  /**
   * M3.1 collaboration handoff. The receiver is woken by the request (that is where they decide),
   * and the sender is woken by every answer: accepted (the task moved), declined (the sender must
   * keep or re-route it) and completed (the result they were waiting for). A completed handoff is
   * the "result feedback" half of the handoff contract, not decoration.
   */
  if (event.type === 'Task.HandoffRequested') {
    const toAgentId = readString(payload, 'toEmployeeId');
    if (toAgentId === null) return [];
    if (!runnableEmployees(deps).includes(toAgentId as EmployeeId)) return [];
    return [
      {
        employeeId: toAgentId as EmployeeId,
        triggerKind: 'task',
        refId: readString(payload, 'handoffId'),
      },
    ];
  }

  if (
    event.type === 'Task.HandoffAccepted' ||
    event.type === 'Task.HandoffDeclined' ||
    event.type === 'Task.HandoffCompleted'
  ) {
    const fromAgentId = readString(payload, 'fromEmployeeId');
    if (fromAgentId === null) return [];
    if (!runnableEmployees(deps).includes(fromAgentId as EmployeeId)) return [];
    return [
      {
        employeeId: fromAgentId as EmployeeId,
        triggerKind: 'task',
        refId: readString(payload, 'handoffId'),
      },
    ];
  }

  if ((TASK_EXECUTOR_EVENTS as readonly string[]).includes(event.type)) {
    const executor = taskExecutor(deps, event);
    if (executor === null) return [];
    const taskId = readString(payload, 'taskId');
    return [{ employeeId: executor, triggerKind: 'task', refId: taskId }];
  }

  if (event.type === 'Workflow.ApprovalRequested') {
    return approvalCandidates(deps, event);
  }

  if (event.type === 'Communication.MessageSent') {
    return readStringArray(payload, 'recipientIds')
      .filter((employeeId) => runnableEmployees(deps).includes(employeeId as EmployeeId))
      .map((employeeId) => ({
        employeeId: employeeId as EmployeeId,
        triggerKind: 'communication' as const,
        refId: readString(payload, 'channelId'),
      }));
  }

  if (event.type === 'Communication.CollaborationRequested') {
    const toAgentId = readString(payload, 'toAgentId');
    if (toAgentId === null) return [];
    if (!runnableEmployees(deps).includes(toAgentId as EmployeeId)) return [];
    return [
      {
        employeeId: toAgentId as EmployeeId,
        triggerKind: 'communication' as const,
        refId: readString(payload, 'taskId'),
      },
    ];
  }

  return [];
}
