import type { EmployeeId, OrgEvent } from '@maoeh/shared-types';
import type { AuthorityService } from '@maoeh/authority-engine';
import type { EventRegistry } from '@maoeh/event-system';
import { createOrgEvent } from '@maoeh/event-system';
import type { EventStore } from '@maoeh/event-store';
import type { Identity } from '@maoeh/identity-system';
import type { AuthzService, CommandActor } from '@maoeh/permission-system';
import type { CandidateAgent } from '@maoeh/organization-model';
import { bestCapabilityMatch, capabilityLabel } from '@maoeh/organization-model';
import type { TaskAssignmentInput, TaskService } from '@maoeh/task-system';
import { isTerminalStatus } from '@maoeh/task-system';
import type { WorkflowEngine, WorkflowInstance } from '@maoeh/workflow-engine';

import { isArchivedEmployment } from './agent-lifecycle.js';
import { createControlAuthorizer, type ControlAuthorizer } from './authorization.js';
import {
  CONTROL_AGENT_ARCHIVED,
  CONTROL_AGENT_CREATED,
  CONTROL_AGENT_INSTRUCTED,
  CONTROL_AGENT_PAUSED,
  CONTROL_AGENT_RESUMED,
  CONTROL_AGENT_REVIEW_REQUESTED,
  CONTROL_AGENT_TASK_CANCELLED,
  CONTROL_COMMAND_REJECTED,
  CONTROL_EVENT_INJECTED,
  CONTROL_SIMULATION_PAUSED,
  CONTROL_SIMULATION_RESUMED,
  CONTROL_SIMULATION_SOUGHT,
  CONTROL_SIMULATION_STARTED,
  CONTROL_SIMULATION_STEPPED,
  CONTROL_TASK_ASSIGNED,
  CONTROL_TASK_CANCELLED,
  CONTROL_TASK_DELETED,
  CONTROL_TASK_INJECTED,
  CONTROL_TASK_REASSIGNED,
  CONTROL_TASK_REVIEW_REQUESTED,
  CONTROL_WORK_BRIEFED,
  CONTROL_WORKFLOW_APPROVAL_DECIDED,
  CONTROL_WORKFLOW_CANCELLED,
  CONTROL_WORKFLOW_DELETED,
  CONTROL_WORKFLOW_INSTANCE_ASSIGNMENT_OVERRIDDEN,
  CONTROL_WORKFLOW_INSTANCE_CONFIRMED,
  CONTROL_DELEGATION_DECIDED,
} from './events.js';
import { createControlQuery, type ControlQuery } from './query.js';
import {
  applyControlEvent,
  createInitialControlProjection,
  type ControlProjection,
} from './state.js';
import type {
  AgentArchiveCommand,
  AgentCreateCommand,
  AgentLifecycleFailureCode,
  AuditPort,
  ControlCommand,
  ControlFailure,
  ControlOutcome,
  ControlSimulationPort,
  ControlState,
} from './types.js';
import { fingerprintOf, readEventString, resolveOperatorActor, validateCommand } from './validation.js';

export interface ControlPlane {
  execute(command: ControlCommand): Promise<ControlOutcome>;
  /** Rebuild the in-memory control projection from the event log during recovery. */
  hydrate(events: readonly OrgEvent[]): void;
  query: ControlQuery;
  state(): ControlState;
}

export interface ControlServiceOptions {
  readonly companyId: string;
  readonly identity: Identity;
  readonly authz: AuthzService;
  readonly authority: AuthorityService;
  readonly registry: EventRegistry;
  readonly eventStore: EventStore;
  readonly audit: AuditPort;
  readonly simulation: ControlSimulationPort;
  readonly tasks: TaskService;
  readonly workflow: WorkflowEngine;
  readonly eventIdGenerator: () => string;
}

function issue(field: string, reason: string): { field: string; reason: string } {
  return { field, reason };
}

function failure(code: ControlFailure['code'], field: string, reason: string): ControlFailure {
  return { code, issues: [issue(field, reason)] };
}

interface Attempt {
  readonly events: readonly OrgEvent[];
  readonly failure: ControlFailure | null;
  readonly details: Readonly<Record<string, unknown>>;
}

function ok(
  events: readonly OrgEvent[],
  details: Readonly<Record<string, unknown>> = {},
): Attempt {
  return { events, failure: null, details };
}

function bad(error: ControlFailure, events: readonly OrgEvent[] = []): Attempt {
  return { events, failure: error, details: {} };
}

export function createControlService(options: ControlServiceOptions): ControlPlane {
  const {
    companyId,
    identity,
    authz,
    authority,
    registry,
    eventStore,
    audit,
    simulation,
    tasks,
    workflow,
    eventIdGenerator,
  } = options;
  const organization = simulation.organization();
  const authorizer: ControlAuthorizer = createControlAuthorizer({
    organization,
    companyId,
    authz,
    authority,
  });

  let projection: ControlProjection = createInitialControlProjection();
  let instructionSeq = 0;
  let reviewSeq = 0;
  let briefSeq = 0;

  const state = (): ControlState => {
    const snapshot = simulation.snapshot();
    return Object.freeze({
      simulationPaused: projection.simulationPaused,
      pausedAgentIds: Object.freeze([...projection.pausedAgentIds]),
      // M2: a manual block is a paused workflow; an approval block is not (the gate is the
      // reason it waits, and resume must not clear it). Derived from the same instance state
      // the workflow read model uses, so the two cannot disagree.
      pausedWorkflowIds: Object.freeze(
        simulation
          .workflows()
          .filter(
            (instance) =>
              instance.status === 'blocked' && instance.blockedReason?.kind === 'manual',
          )
          .map((instance) => instance.instanceId),
      ),
      issuedInstructionIds: projection.issuedInstructionIds,
      tick: snapshot.tick,
      simTime: snapshot.simTime,
      processedCommandIds: Object.freeze(
        audit.recent(1000).map((entry) => entry.commandId),
      ),
    });
  };

  const query = createControlQuery({
    companyId,
    organization,
    simulation,
    eventStore,
    audit,
    controlState: state,
  });

  /**
   * `brief-<n>` comes from a process-local counter, so a restarted kernel would otherwise hand
   * out an id that is already on the log — and `getWorkBrief(briefId)` would then answer for two
   * different briefs. Recovery reseeds the counter past every id the log already carries.
   */
  const seedBriefSeq = (events: readonly OrgEvent[]): void => {
    for (const event of events) {
      if (event.type !== CONTROL_WORK_BRIEFED) continue;
      const match = /^brief-(\d+)$/.exec(readEventString(event, 'briefId') ?? '');
      if (match === null) continue;
      const seq = Number(match[1]);
      if (seq > briefSeq) briefSeq = seq;
    }
  };

  const hydrate = (events: readonly OrgEvent[]): void => {
    seedBriefSeq(events);
    let next = createInitialControlProjection();
    for (const event of events) next = applyControlEvent(next, event);
    projection = next;
    for (const agentId of next.pausedAgentIds) simulation.setAgentPaused(agentId, true);
    if (next.simulationPaused) simulation.pause();
  };

  const emit = (
    type: string,
    command: ControlCommand,
    subjectType: string,
    payload: unknown,
    /**
     * Subject override. Every command's subject is its target (`Agent.Pause` → the agent),
     * except `Agent.Create`, whose target is the organization while its subject is the agent
     * being born — the event has to name the new employee, not the company.
     */
    subjectId: string = command.target.targetId,
  ): { readonly ok: true; readonly event: OrgEvent } | { readonly ok: false; readonly failure: ControlFailure } => {
    const created = createOrgEvent(
      registry,
      {
        companyId: companyId as never,
        type,
        occurredAtSim: command.createdAtSim,
        actorKind: command.actor.kind,
        actorId: String(command.actor.operatorId),
        subjectType,
        subjectId,
        correlationId: command.correlationId,
        causationId: command.causationId ?? command.commandId,
        payload,
      },
      { eventIdGenerator },
    );
    if (!created.ok) {
      return {
        ok: false,
        failure: {
          code: 'INVALID_COMMAND',
          issues: created.error.issues.map((entry) => issue(entry.field, entry.reason)),
        },
      };
    }
    return { ok: true, event: created.value };
  };

  const versionCheck = (expected: number | undefined, actual: number): ControlFailure | null => {
    if (expected === undefined || expected === actual) return null;
    return {
      code: 'STALE_VERSION',
      issues: [
        issue(
          'expectedVersion',
          `expected version ${String(expected)} but the target is at version ${String(actual)}`,
        ),
      ],
      actualVersion: actual,
    };
  };

  const auditVerdict = (
    status: ControlOutcome['status'],
    command: ControlCommand,
    targetType: string,
    resultCode: string | null,
    eventIds: readonly string[],
    details: Readonly<Record<string, unknown>>,
  ): void => {
    audit.record({
      actorKind: command.actor.kind,
      actorId: String(command.actor.operatorId),
      actionType: command.commandType,
      actionReason: command.reason,
      actionResource: `${targetType}:${command.target.targetId}`,
      targetType,
      targetId: command.target.targetId,
      verdict: status,
      commandId: command.commandId,
      correlationId: command.correlationId,
      causationId: command.causationId,
      resultCode,
      eventIds,
      createdAtSim: Number(command.createdAtSim),
      details,
    });
  };

  const replayOutcome = (command: ControlCommand): ControlOutcome | null => {
    const existing = audit.find(command.commandId);
    if (existing === null) return null;
    const details = auditDetails(existing);
    if (details !== null && details['fingerprint'] !== fingerprintOf(command)) {
      return {
        status: 'rejected',
        commandId: command.commandId,
        commandType: command.commandType,
        replayed: true,
        events: Object.freeze([]),
        auditId: existing.auditId,
        failure: failure(
          'CONFLICT',
          'commandId',
          `commandId "${command.commandId}" was already used with a different payload`,
        ),
      };
    }
    return {
      status: existing.verdict as ControlOutcome['status'],
      commandId: command.commandId,
      commandType: command.commandType,
      replayed: true,
      events: Object.freeze([...existing.eventIds]),
      auditId: existing.auditId,
      failure: null,
    };
  };

  /** Simulation commands --------------------------------------------------- */

  const handleSimulation = async (command: ControlCommand): Promise<Attempt> => {
    switch (command.commandType) {
      case 'Simulation.Start': {
        const result = await simulation.start();
        const created = emit(CONTROL_SIMULATION_STARTED, command, 'system', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          tickNumber: result.tick,
        });
        if (!created.ok) return bad(created.failure);
        return ok([created.event], { tick: result.tick, tickStatus: result.status });
      }
      case 'Simulation.Pause': {
        const snapshot = simulation.snapshot();
        const stale = versionCheck(command.expectedVersion, snapshot.tick);
        if (stale !== null) return bad(stale);
        if (snapshot.paused) {
          return bad(failure('CONFLICT', 'simulation', 'the simulation is already paused'));
        }
        simulation.pause();
        const created = emit(CONTROL_SIMULATION_PAUSED, command, 'system', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          tickNumber: snapshot.tick,
        });
        if (!created.ok) return bad(created.failure);
        return ok([created.event], { tick: snapshot.tick });
      }
      case 'Simulation.Resume': {
        const snapshot = simulation.snapshot();
        const stale = versionCheck(command.expectedVersion, snapshot.tick);
        if (stale !== null) return bad(stale);
        if (!snapshot.paused) {
          return bad(failure('CONFLICT', 'simulation', 'the simulation is not paused'));
        }
        simulation.resume();
        const created = emit(CONTROL_SIMULATION_RESUMED, command, 'system', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          tickNumber: snapshot.tick,
        });
        if (!created.ok) return bad(created.failure);
        return ok([created.event], { tick: snapshot.tick });
      }
      case 'Simulation.Step': {
        const snapshot = simulation.snapshot();
        const stale = versionCheck(command.expectedVersion, snapshot.tick);
        if (stale !== null) return bad(stale);
        const result = await simulation.step();
        const created = emit(CONTROL_SIMULATION_STEPPED, command, 'system', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          tickNumber: result.tick,
          tickStatus: result.status,
        });
        if (!created.ok) return bad(created.failure);
        return ok([created.event], { tick: result.tick, tickStatus: result.status });
      }
      case 'Simulation.Seek': {
        const snapshot = simulation.snapshot();
        const stale = versionCheck(command.expectedVersion, snapshot.tick);
        if (stale !== null) return bad(stale);
        if (command.tickNumber < snapshot.tick) {
          return bad(
            failure(
              'UNSUPPORTED',
              'tickNumber',
              `backward seek from tick ${String(snapshot.tick)} to ${String(command.tickNumber)} is unsupported: the M0.9 clock aligns forward only and never rewrites history`,
            ),
          );
        }
        simulation.seek(command.tickNumber);
        const created = emit(CONTROL_SIMULATION_SOUGHT, command, 'system', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          fromTick: snapshot.tick,
          toTick: command.tickNumber,
        });
        if (!created.ok) return bad(created.failure);
        return ok([created.event], { fromTick: snapshot.tick, toTick: command.tickNumber });
      }
      default:
        return bad(failure('INVALID_COMMAND', 'commandType', 'not a simulation command'));
    }
  };

  /** Agent commands -------------------------------------------------------- */

  const agentExists = (employeeId: EmployeeId): boolean =>
    resolutionOrganization().employees.some((employee) => employee.id === employeeId);

  const resolutionOrganization = () => simulation.organization();

  /**
   * An agent-targeted command addresses a live roster member: an unknown id is
   * `INVALID_TARGET`, an archived one is out of the roster (`INVALID_STATE`). Shared by the
   * `Agent.*` and `Work.*` families so the two can never drift apart on who may be addressed.
   */
  const unusableAgentFailure = (agentId: EmployeeId): ControlFailure | null => {
    if (!agentExists(agentId)) {
      return failure('INVALID_TARGET', 'target.targetId', `unknown agent "${String(agentId)}"`);
    }
    const employee = resolutionOrganization().employees.find(
      (entry) => String(entry.id) === String(agentId),
    );
    if (employee !== undefined && isArchivedEmployment(employee.status)) {
      return failure(
        'INVALID_STATE',
        'target.targetId',
        `agent "${String(agentId)}" is archived and no longer part of the roster`,
      );
    }
    return null;
  };

  /** Runtime lifecycle failures keep their meaning when they cross into the control contract. */
  const fromLifecycleFailure = (
    code: AgentLifecycleFailureCode,
    reason: string,
  ): ControlFailure => {
    switch (code) {
      case 'duplicate_employee':
        return failure('CONFLICT', 'employeeId', reason);
      case 'duplicate_employee_no':
        return failure('CONFLICT', 'employeeNo', reason);
      case 'unknown_position':
        return failure('INVALID_TARGET', 'positionId', reason);
      case 'unknown_department':
        return failure('INVALID_TARGET', 'departmentId', reason);
      case 'duplicate_position':
        return failure('CONFLICT', 'positionId', reason);
      case 'unknown_cognition_profile':
        return failure('INVALID_COMMAND', 'cognitionProfileId', reason);
      case 'unknown_template':
        return failure('INVALID_COMMAND', 'templateEmployeeId', reason);
      case 'unknown_agent':
        return failure('NOT_FOUND', 'target.targetId', reason);
      case 'already_archived':
        return failure('CONFLICT', 'target.targetId', reason);
      default:
        return failure('INVALID_STATE', 'target.targetId', reason);
    }
  };

  /**
   * `Agent.Create` (M1.3). The roster change itself is a Runtime act: this handler validates the
   * command against the live organization, asks the Runtime to materialize the agent (identity
   * registration + 8-layer instantiation + placement), and only then writes the fact
   * `Control.AgentCreated`. The order mirrors `Agent.Pause` — the port call is the effect, the
   * event and the audit record are its trace (the EventStore append happens in `execute`).
   */
  const handleCreateAgent = (command: AgentCreateCommand): Attempt => {
    const organization = resolutionOrganization();
    const employeeId = command.employeeId;
    if (organization.employees.some((entry) => String(entry.id) === employeeId)) {
      return bad(
        failure('CONFLICT', 'employeeId', `employee "${employeeId}" already exists in this organization`),
      );
    }
    if (
      command.employeeNo !== undefined &&
      command.employeeNo !== null &&
      organization.employees.some((entry) => entry.employeeNo === command.employeeNo)
    ) {
      return bad(
        failure(
          'CONFLICT',
          'employeeNo',
          `employee number "${command.employeeNo}" is already taken`,
        ),
      );
    }
    if (
      command.newPosition === undefined &&
      !organization.positions.some((position) => String(position.id) === command.positionId)
    ) {
      return bad(
        failure('INVALID_TARGET', 'positionId', `unknown position "${command.positionId}"`),
      );
    }

    const materialized = simulation.createAgent({
      employeeId,
      name: command.name,
      positionId: command.positionId,
      employeeNo: command.employeeNo ?? null,
      responsibilities: command.responsibilities,
      traits: command.traits ?? [],
      expertise: command.expertise ?? [],
      cognitionProfileId: command.cognitionProfileId ?? null,
      templateEmployeeId: command.templateEmployeeId ?? null,
      simTime: command.createdAtSim,
      ...(command.newPosition === undefined ? {} : { newPosition: command.newPosition }),
    });
    if (!materialized.ok) return bad(fromLifecycleFailure(materialized.code, materialized.reason));
    const agent = materialized.value;

    const created = emit(
      CONTROL_AGENT_CREATED,
      command,
      'employee',
      {
        commandId: command.commandId,
        operatorId: String(command.actor.operatorId),
        reason: command.reason,
        agentId: agent.employeeId,
        name: agent.name,
        positionId: agent.positionId,
        employeeNo: agent.employeeNo,
        responsibilities: [...command.responsibilities],
        traits: [...(command.traits ?? [])],
        // What the person actually carries (the request, else the template's) — the fact a replay
        // needs to rebuild their matchable skill shape.
        expertise: [...agent.expertise],
        cognitionProfileId: agent.cognitionProfileId,
        templateEmployeeId: command.templateEmployeeId ?? null,
        definitionSource: agent.definitionSource,
        status: 'active',
        ...(agent.createdPosition === null
          ? {}
          : {
              position: {
                departmentId: agent.createdPosition.departmentId,
                title: agent.createdPosition.title,
                capabilities: [...agent.createdPosition.capabilities],
                reportsToPositionId: agent.createdPosition.reportsToPositionId,
              },
            }),
      },
      agent.employeeId,
    );
    if (!created.ok) return bad(created.failure);
    return ok([created.event], {
      agentId: agent.employeeId,
      positionId: agent.positionId,
      lifecycle: agent.lifecycle,
    });
  };

  /**
   * `Agent.Archive` (M1.3). Deletion is refused by design: the employee record, its events and
   * its audit trail survive, and only the employment status is closed.
   *
   * The running-work guard comes first: an agent that still owns a live task is not archivable
   * (`Task.Completed` / `Task.Cancelled` are the only ways out), so work can never be orphaned
   * by a roster change.
   */
  const handleArchiveAgent = (command: AgentArchiveCommand): Attempt => {
    const agentId = command.target.targetId;
    const organization = resolutionOrganization();
    const employee = organization.employees.find((entry) => String(entry.id) === agentId);
    if (employee === undefined) {
      return bad(failure('NOT_FOUND', 'target.targetId', `unknown agent "${agentId}"`));
    }
    if (isArchivedEmployment(employee.status)) {
      return bad(
        failure('CONFLICT', 'target.targetId', `agent "${agentId}" is already archived`),
      );
    }
    if (String(command.actor.operatorId) === agentId) {
      // Fail closed: archiving the identity a command is acting as would lock the operator out
      // of the console (its later commands would be refused as non-executable).
      return bad(
        failure(
          'FORBIDDEN',
          'target.targetId',
          `operator "${agentId}" cannot archive the agent it is acting as`,
        ),
      );
    }

    const running = simulation
      .tasks()
      .filter(
        (task) =>
          !isTerminalStatus(task.status) &&
          (String(task.assignment.assigneeEmployeeId ?? '') === agentId ||
            String(task.assignment.actingEmployeeId ?? '') === agentId),
      );
    if (running.length > 0) {
      return bad(
        failure(
          'CONFLICT',
          'target.targetId',
          `agent "${agentId}" still owns ${String(running.length)} running task(s): ${running
            .map((task) => task.taskId)
            .join(', ')} — archive is refused until they complete or are cancelled`,
        ),
      );
    }

    const archived = simulation.archiveAgent(agentId as EmployeeId);
    if (!archived.ok) return bad(fromLifecycleFailure(archived.code, archived.reason));

    const created = emit(
      CONTROL_AGENT_ARCHIVED,
      command,
      'employee',
      {
        commandId: command.commandId,
        operatorId: String(command.actor.operatorId),
        reason: command.reason,
        agentId,
        status: 'archived',
        employmentStatus: 'offboarded',
      },
      agentId,
    );
    if (!created.ok) return bad(created.failure);
    return ok([created.event], { agentId, lifecycle: 'archived' });
  };

  const handleAgent = async (
    command: ControlCommand,
    actor: CommandActor,
  ): Promise<Attempt> => {
    if (command.commandType === 'Agent.Create') {
      return handleCreateAgent(command);
    }
    // Archiving is addressed at an agent record, so an unknown id is `NOT_FOUND` (matching the
    // workflow/task command families) rather than the `INVALID_TARGET` of the runtime commands.
    if (command.commandType === 'Agent.Archive') {
      return handleArchiveAgent(command);
    }
    const agentId = command.target.targetId as EmployeeId;
    const unusable = unusableAgentFailure(agentId);
    if (unusable !== null) return bad(unusable);

    switch (command.commandType) {
      case 'Agent.Pause': {
        const actual = simulation.snapshot().agentStateVersions.get(agentId) ?? 0;
        const stale = versionCheck(command.expectedVersion, actual);
        if (stale !== null) return bad(stale);
        if (simulation.isAgentPaused(agentId)) {
          return bad(
            failure('CONFLICT', 'agentId', `agent "${command.target.targetId}" is already paused`),
          );
        }
        simulation.setAgentPaused(agentId, true);
        const created = emit(CONTROL_AGENT_PAUSED, command, 'employee', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          agentId: String(agentId),
        });
        if (!created.ok) return bad(created.failure);
        return ok([created.event], { agentId: String(agentId) });
      }
      case 'Agent.Resume': {
        const actual = simulation.snapshot().agentStateVersions.get(agentId) ?? 0;
        const stale = versionCheck(command.expectedVersion, actual);
        if (stale !== null) return bad(stale);
        if (!simulation.isAgentPaused(agentId)) {
          return bad(
            failure('CONFLICT', 'agentId', `agent "${command.target.targetId}" is not paused`),
          );
        }
        simulation.setAgentPaused(agentId, false);
        const created = emit(CONTROL_AGENT_RESUMED, command, 'employee', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          agentId: String(agentId),
        });
        if (!created.ok) return bad(created.failure);
        return ok([created.event], { agentId: String(agentId) });
      }
      case 'Agent.Instruct': {
        if (simulation.isAgentPaused(agentId)) {
          return bad(
            failure(
              'AGENT_PAUSED',
              'agentId',
              `agent "${command.target.targetId}" is paused and cannot be instructed`,
            ),
          );
        }
        instructionSeq += 1;
        const instructionId = `instruction-${String(instructionSeq)}`;
        const created = emit(CONTROL_AGENT_INSTRUCTED, command, 'employee', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          agentId: String(agentId),
          instructionId,
          instruction: command.instruction,
        });
        if (!created.ok) return bad(created.failure);
        // Deliver through the existing scheduler: the instruction becomes the agent's next
        // turn input (`MANUAL` wakeup). Without this the instruction would sit unread forever,
        // because `Control.*` events are intentionally not wakeup-eligible.
        simulation.wakeAgent(agentId, created.event.eventId, instructionId);
        return ok([created.event], { agentId: String(agentId), instructionId });
      }
      case 'Agent.CancelTask': {
        const targetId = command.taskId;
        const task = tasks.get(targetId);
        if (task === null) return bad(failure('NOT_FOUND', 'taskId', `unknown task "${targetId}"`));
        const assignee = task.assignment.assigneeEmployeeId;
        if (assignee !== null && assignee !== agentId) {
          return bad(
            failure(
              'INVALID_TARGET',
              'taskId',
              `task "${targetId}" is not assigned to agent "${command.target.targetId}"`,
            ),
          );
        }
        const result = tasks.cancel({
          taskId: targetId,
          actor,
          simTime: command.createdAtSim,
          reason: command.reason,
        });
        if (!result.ok) return bad(fromTaskFailure(result.error));
        const created = emit(CONTROL_AGENT_TASK_CANCELLED, command, 'employee', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          agentId: String(agentId),
          taskId: targetId,
        });
        if (!created.ok) return bad(created.failure, result.value.events);
        return ok([...result.value.events, created.event], { taskId: targetId });
      }
      case 'Agent.RequestReview': {
        const targetId = command.taskId;
        const task = tasks.get(targetId);
        if (task === null) return bad(failure('NOT_FOUND', 'taskId', `unknown task "${targetId}"`));
        reviewSeq += 1;
        const reviewId = `review-${String(reviewSeq)}`;
        const created = emit(CONTROL_AGENT_REVIEW_REQUESTED, command, 'employee', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          agentId: String(agentId),
          taskId: targetId,
          reviewId,
        });
        if (!created.ok) return bad(created.failure);
        return ok([created.event], { taskId: targetId, reviewId });
      }
      default:
        return bad(failure('INVALID_COMMAND', 'commandType', 'not an agent command'));
    }
  };

  /** Work commands --------------------------------------------------------- */

  /**
   * `Work.SubmitBrief` (M1.4 §5.7): the single human entry point for organizational work.
   *
   * The brief becomes a fact on the log (`Control.WorkBriefed`) and the briefed agent is then
   * woken explicitly — `Control.*` events are deliberately outside the subscription table, so
   * without this bridge the brief would sit unread forever. This is the same scheduler path
   * `Agent.Instruct` uses, and the brief's `correlationId` rides the turn, which is what lets
   * the read model group "brief → decomposition" without new events (§5.4).
   */
  const handleWork = async (command: ControlCommand): Promise<Attempt> => {
    if (command.commandType !== 'Work.SubmitBrief') {
      return bad(failure('INVALID_COMMAND', 'commandType', 'not a work command'));
    }
    const agentId = command.target.targetId as EmployeeId;
    const unusable = unusableAgentFailure(agentId);
    if (unusable !== null) return bad(unusable);
    if (simulation.isAgentPaused(agentId)) {
      return bad(
        failure(
          'AGENT_PAUSED',
          'agentId',
          `agent "${command.target.targetId}" is paused and cannot receive a work brief`,
        ),
      );
    }

    const brief = command.workBrief;
    briefSeq += 1;
    const briefId = `brief-${String(briefSeq)}`;
    const created = emit(CONTROL_WORK_BRIEFED, command, 'employee', {
      commandId: command.commandId,
      operatorId: String(command.actor.operatorId),
      reason: command.reason,
      agentId: String(agentId),
      briefId,
      title: brief.title,
      goal: brief.goal,
      context: brief.context ?? null,
      verificationKeys: [...brief.verificationKeys],
      sourceSessionId: brief.sourceSessionId ?? null,
      priority: brief.priority ?? null,
      dueAtSim: brief.dueAtSim ?? null,
    });
    if (!created.ok) return bad(created.failure);
    simulation.wakeAgent(agentId, created.event.eventId, briefId);
    return ok([created.event], { agentId: String(agentId), briefId });
  };

  /** Workflow commands ----------------------------------------------------- */

  const handleWorkflow = async (
    command: ControlCommand,
    actor: CommandActor,
  ): Promise<Attempt> => {
    const instanceId = command.target.targetId;
    const instance: WorkflowInstance | null = simulation.workflow(instanceId);
    if (instance === null) {
      return bad(
        failure('NOT_FOUND', 'target.targetId', `unknown workflow instance "${instanceId}"`),
      );
    }
    const stale = versionCheck(command.expectedVersion, instance.processedEventIds.length);
    if (stale !== null) return bad(stale);

    switch (command.commandType) {
      case 'Workflow.Pause': {
        if (instance.status === 'blocked') {
          return bad(
            failure(
              'WORKFLOW_BLOCKED',
              'instanceId',
              `workflow "${instanceId}" is already blocked (${instance.blockedReason?.kind ?? 'unknown'})`,
            ),
          );
        }
        const result = workflow.wait({
          instanceId,
          actor,
          simTime: command.createdAtSim,
          reason: command.reason,
        });
        if (!result.ok) return bad(fromWorkflowFailure(result.error));
        return ok(result.value.events, { instanceId });
      }
      case 'Workflow.Resume': {
        const result = workflow.resume({
          instanceId,
          actor,
          simTime: command.createdAtSim,
          reason: command.reason,
        });
        if (!result.ok) return bad(fromWorkflowFailure(result.error));
        return ok(result.value.events, { instanceId });
      }
      case 'Workflow.Cancel': {
        const result = workflow.cancel({
          instanceId,
          actor,
          simTime: command.createdAtSim,
          reason: command.reason,
        });
        if (!result.ok) return bad(fromWorkflowFailure(result.error));
        const created = emit(CONTROL_WORKFLOW_CANCELLED, command, 'workflow_instance', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          instanceId,
        });
        if (!created.ok) return bad(created.failure, result.value.events);
        return ok([...result.value.events, created.event], { instanceId });
      }
      case 'Workflow.Delete': {
        const deletedTaskIds = tasks
          .all()
          .filter((entry) => entry.workflowInstanceId === instanceId)
          .map((entry) => entry.taskId);
        const result = workflow.delete({
          instanceId,
          actor,
          simTime: command.createdAtSim,
          reason: command.reason,
        });
        if (!result.ok) return bad(fromWorkflowFailure(result.error));
        const created = emit(CONTROL_WORKFLOW_DELETED, command, 'workflow_instance', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          instanceId,
        });
        if (!created.ok) return bad(created.failure, result.value.events);
        return ok([...result.value.events, created.event], { instanceId, deletedTaskIds });
      }
      case 'Workflow.Approve':
      case 'Workflow.Reject': {
        const decision = command.commandType === 'Workflow.Approve' ? 'granted' : 'denied';
        if (instance.approval === null || instance.approval.status !== 'open') {
          return bad(
            failure('INVALID_STATE', 'instanceId', `workflow "${instanceId}" has no open approval`),
          );
        }
        const stepId = instance.approval.stepId;
        const result = workflow.approve({
          instanceId,
          actor,
          decision,
          simTime: command.createdAtSim,
          reason: command.reason,
          humanApproval: command.actor.kind === 'human',
        });
        if (!result.ok) return bad(fromWorkflowFailure(result.error));
        const created = emit(CONTROL_WORKFLOW_APPROVAL_DECIDED, command, 'workflow_instance', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          instanceId,
          stepId,
          decision,
        });
        if (!created.ok) return bad(created.failure, result.value.events);
        return ok([...result.value.events, created.event], { instanceId, decision });
      }
      case 'Workflow.InstanceAssignmentOverride': {
        const result = workflow.overrideAssignments({
          instanceId,
          actor,
          simTime: command.createdAtSim,
          reason: command.reason,
          overrides: command.overrides.map((entry) => ({
            stepId: entry.stepId,
            employeeId: entry.employeeId,
            ...(entry.reason === undefined ? {} : { reason: entry.reason }),
          })),
        });
        if (!result.ok) return bad(fromWorkflowFailure(result.error));
        const created = emit(
          CONTROL_WORKFLOW_INSTANCE_ASSIGNMENT_OVERRIDDEN,
          command,
          'workflow_instance',
          {
            commandId: command.commandId,
            operatorId: String(command.actor.operatorId),
            reason: command.reason,
            instanceId,
            overrides: command.overrides.map((entry) => ({
              stepId: entry.stepId,
              employeeId: entry.employeeId,
              reason: entry.reason ?? command.reason ?? null,
            })),
          },
        );
        if (!created.ok) return bad(created.failure, result.value.events);
        return ok([...result.value.events, created.event], { instanceId });
      }
      case 'Workflow.ConfirmStart': {
        const result = workflow.confirm({
          instanceId,
          actor,
          simTime: command.createdAtSim,
          reason: command.reason,
        });
        if (!result.ok) return bad(fromWorkflowFailure(result.error));
        const created = emit(
          CONTROL_WORKFLOW_INSTANCE_CONFIRMED,
          command,
          'workflow_instance',
          {
            commandId: command.commandId,
            operatorId: String(command.actor.operatorId),
            reason: command.reason,
            instanceId,
          },
        );
        if (!created.ok) return bad(created.failure, result.value.events);
        return ok([...result.value.events, created.event], { instanceId });
      }
      default:
        return bad(failure('INVALID_COMMAND', 'commandType', 'not a workflow command'));
    }
  };

  /** Task commands --------------------------------------------------------- */

  /**
   * M1.6 capability delegation.
   *
   * The matcher is a pure function of the organization; the only thing the Control Plane
   * adds is *who is paused right now*, because the operator's pause overlay lives here and
   * nowhere else. Employment availability is the matcher's own rule.
   */
  const pausedAgentIds = (): ReadonlySet<EmployeeId> => {
    const paused = new Set<EmployeeId>();
    for (const employee of organization.employees) {
      if (simulation.isAgentPaused(employee.id)) paused.add(employee.id);
    }
    return paused;
  };

  const matchCandidate = (
    title: string,
    goal: string,
    requiredCapabilities: readonly string[],
  ): CandidateAgent | null =>
    bestCapabilityMatch(
      organization,
      { title, goal, requiredCapabilities },
      { unavailable: pausedAgentIds() },
    );

  /** The sentence the console shows under "why assigned" — built once, stored on the log. */
  const rationaleOf = (candidate: CandidateAgent, required: readonly string[]): string => {
    const needs = required.map(capabilityLabel).join(', ');
    const covers = candidate.matchedCapabilities.map(capabilityLabel).join(', ');
    const scope =
      candidate.departmentMatch && candidate.profile.departmentId !== null
        ? ` in department "${String(candidate.profile.departmentId)}"`
        : '';
    return `Requires ${needs}; ${candidate.profile.name} (${candidate.profile.positionTitle})${scope} covers ${covers}`;
  };

  /** Capabilities a seat itself covers, for the routed (position) path. */
  const coveredBySeat = (
    positionId: string | null,
    requiredCapabilities: readonly string[],
  ): readonly string[] => {
    if (positionId === null || requiredCapabilities.length === 0) return Object.freeze([]);
    const position = organization.positions.find((entry) => String(entry.id) === positionId);
    if (position === undefined) return Object.freeze([]);
    const declared = new Set(
      (position.capabilities ?? []).map((entry) => entry.trim().toLowerCase()),
    );
    return Object.freeze(
      requiredCapabilities.filter((entry) => declared.has(entry.trim().toLowerCase())),
    );
  };

  const delegationEvent = (
    command: ControlCommand,
    task: {
      readonly taskId: string;
      readonly title: string;
      readonly requiredSkills: readonly string[];
      readonly assignment: { readonly assigneeEmployeeId: EmployeeId | null; readonly positionId: string | null };
    },
    rationale: string,
  ): { readonly ok: true; readonly event: OrgEvent } | { readonly ok: false; readonly failure: ControlFailure } => {
    const assignee = task.assignment.assigneeEmployeeId;
    const positionId = task.assignment.positionId;
    if (assignee === null || positionId === null) {
      return {
        ok: false,
        failure: failure('INVALID_STATE', 'assignment', 'a delegation decision needs an assignee'),
      };
    }
    return emit(CONTROL_DELEGATION_DECIDED, command, 'task', {
      commandId: command.commandId,
      operatorId: String(command.actor.operatorId),
      reason: command.reason,
      taskId: task.taskId,
      title: task.title,
      requiredCapabilities: [...task.requiredSkills],
      assigneeEmployeeId: assignee,
      assigneePositionId: positionId,
      rationale,
    });
  };

  const handleTask = async (command: ControlCommand, actor: CommandActor): Promise<Attempt> => {
    const taskId = command.target.targetId;
    const task = tasks.get(taskId);
    if (task === null) {
      return bad(failure('NOT_FOUND', 'target.targetId', `unknown task "${taskId}"`));
    }

    switch (command.commandType) {
      case 'Task.Cancel': {
        const result = tasks.cancel({
          taskId,
          actor,
          simTime: command.createdAtSim,
          reason: command.reason,
        });
        if (!result.ok) return bad(fromTaskFailure(result.error));
        const created = emit(CONTROL_TASK_CANCELLED, command, 'task', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          taskId,
        });
        if (!created.ok) return bad(created.failure, result.value.events);
        return ok([...result.value.events, created.event], { taskId });
      }
      case 'Task.Delete': {
        // The step's deliverable is not separable from the workflow it belongs to: deleting it
        // alone would leave the instance pointing at a task that no longer exists. Removing the
        // instance deletes every task it owns, this one included.
        const cascadeInstanceId = task.workflowInstanceId;
        let events: readonly OrgEvent[];
        if (cascadeInstanceId !== null) {
          const result = workflow.delete({
            instanceId: cascadeInstanceId,
            actor,
            simTime: command.createdAtSim,
            reason: command.reason,
          });
          if (!result.ok) return bad(fromWorkflowFailure(result.error));
          events = result.value.events;
        } else {
          const result = tasks.delete({
            taskId,
            actor,
            simTime: command.createdAtSim,
            reason: command.reason,
          });
          if (!result.ok) return bad(fromTaskFailure(result.error));
          events = result.value.events;
        }
        const created = emit(CONTROL_TASK_DELETED, command, 'task', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          taskId,
        });
        if (!created.ok) return bad(created.failure, events);
        return ok([...events, created.event], {
          taskId,
          ...(cascadeInstanceId === null
            ? { cascade: false }
            : { cascade: true, workflowInstanceId: cascadeInstanceId }),
        });
      }
      case 'Task.Reassign': {
        const result = tasks.assign({
          taskId,
          actor,
          simTime: command.createdAtSim,
          assignment: { kind: 'position', positionId: command.positionId as never },
          reason: command.reason,
        });
        if (!result.ok) return bad(fromTaskFailure(result.error));
        const created = emit(CONTROL_TASK_REASSIGNED, command, 'task', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          taskId,
          positionId: command.positionId,
        });
        if (!created.ok) return bad(created.failure, result.value.events);
        return ok([...result.value.events, created.event], {
          taskId,
          positionId: command.positionId,
        });
      }
      case 'Task.AssignToAgent': {
        const agentId = command.agentId;
        let assignment: TaskAssignmentInput;
        let matched: readonly string[];
        let rationale: string;
        let assigneeId: string;

        if (agentId !== undefined) {
          const employee = organization.employees.find(
            (entry) => String(entry.id) === agentId,
          );
          if (employee === undefined) {
            return bad(failure('INVALID_TARGET', 'agentId', `unknown employee "${agentId}"`));
          }
          if (simulation.isAgentPaused(employee.id)) {
            return bad(failure('INVALID_STATE', 'agentId', `agent "${agentId}" is paused`));
          }
          const position = organization.positions.find(
            (entry) => entry.id === employee.positionId,
          );
          matched = coveredBySeat(
            String(employee.positionId),
            task.requiredSkills,
          );
          assignment = { kind: 'employee', employeeId: employee.id };
          assigneeId = String(employee.id);
          rationale =
            matched.length > 0
              ? `Requires ${task.requiredSkills.map(capabilityLabel).join(', ')}; operator chose ${employee.name} (${position?.title ?? String(employee.positionId)}), who covers ${matched.map(capabilityLabel).join(', ')}`
              : `Operator chose ${employee.name} (${position?.title ?? String(employee.positionId)}) directly`;
        } else {
          if (task.requiredSkills.length === 0) {
            return bad(
              failure(
                'INVALID_COMMAND',
                'requiredSkills',
                `task "${taskId}" declares no requiredSkills; pass agentId to assign it to a named agent`,
              ),
            );
          }
          const candidate = matchCandidate(task.title, task.goal, task.requiredSkills);
          if (candidate === null) {
            return bad(
              failure(
                'INVALID_TARGET',
                'requiredSkills',
                `no available employee covers ${task.requiredSkills.join(', ')}`,
              ),
            );
          }
          matched = candidate.matchedCapabilities;
          assignment = { kind: 'employee', employeeId: candidate.profile.employeeId };
          assigneeId = String(candidate.profile.employeeId);
          rationale = rationaleOf(candidate, task.requiredSkills);
        }

        const result = tasks.assign({
          taskId,
          actor,
          simTime: command.createdAtSim,
          assignment,
          reason: rationale,
          matchedCapabilities: matched,
        });
        if (!result.ok) return bad(fromTaskFailure(result.error));

        const assigned = emit(CONTROL_TASK_ASSIGNED, command, 'task', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          taskId,
          agentId: assigneeId,
          matchedCapabilities: [...matched],
        });
        if (!assigned.ok) return bad(assigned.failure, result.value.events);

        const delegated = delegationEvent(command, result.value.task, rationale);
        if (!delegated.ok) return bad(delegated.failure, [...result.value.events, assigned.event]);

        return ok([...result.value.events, assigned.event, delegated.event], {
          taskId,
          agentId: assigneeId,
          matchedCapabilities: [...matched],
        });
      }
      case 'Task.RequestReview': {
        reviewSeq += 1;
        const reviewId = `review-${String(reviewSeq)}`;
        const created = emit(CONTROL_TASK_REVIEW_REQUESTED, command, 'task', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          taskId,
          reviewId,
        });
        if (!created.ok) return bad(created.failure);
        return ok([created.event], { taskId, reviewId });
      }
      default:
        return bad(failure('INVALID_COMMAND', 'commandType', 'not a task command'));
    }
  };

  /** Organization input ---------------------------------------------------- */

  const handleOrganization = async (
    command: ControlCommand,
    actor: CommandActor,
  ): Promise<Attempt> => {
    switch (command.commandType) {
      case 'Organization.InjectTask': {
        const requiredSkills = Object.freeze(
          [...new Set((command.requiredSkills ?? []).map((entry) => entry.trim()))].filter(
            (entry) => entry !== '',
          ),
        );
        // Route by seat when one is named (the original behaviour), otherwise delegate by
        // capability: the seat-less path is the M1.6 "hand it to whoever can do it" flow.
        const routedBySeat = typeof command.positionId === 'string' && command.positionId !== '';
        let assignment: TaskAssignmentInput;
        let matched: readonly string[] = Object.freeze([]);
        let rationale: string | null = null;
        let candidate: CandidateAgent | null = null;

        if (routedBySeat) {
          assignment = { kind: 'position', positionId: command.positionId as never };
          if (requiredSkills.length > 0) {
            matched = coveredBySeat(command.positionId ?? null, requiredSkills);
            rationale =
              matched.length > 0
                ? `Routed to seat "${command.positionId}", which covers ${matched.map(capabilityLabel).join(', ')}`
                : `Routed to seat "${command.positionId}" by the operator`;
          }
        } else {
          candidate = matchCandidate(command.title, command.goal, requiredSkills);
          if (candidate === null) {
            return bad(
              failure(
                'INVALID_TARGET',
                'requiredSkills',
                `no available employee covers ${requiredSkills.join(', ')}`,
              ),
            );
          }
          matched = candidate.matchedCapabilities;
          rationale = rationaleOf(candidate, requiredSkills);
          assignment = { kind: 'employee', employeeId: candidate.profile.employeeId };
        }

        const result = tasks.create({
          actor,
          simTime: command.createdAtSim,
          title: command.title,
          goal: command.goal,
          detail: command.detail ?? null,
          assignment,
          requiredSkills,
          workflowInstanceId: command.workflowInstanceId ?? null,
          workflowStepId: command.workflowStepId ?? null,
        });
        if (!result.ok) return bad(fromTaskFailure(result.error));
        const taskId = result.value.task.taskId;
        // Dispatch to the target, exactly as the workflow engine does when it enters a task
        // step. Without this the injected task never produces `Task.Assigned`, so the scheduler
        // never wakes anybody and the work is invisible to the organization (M1.0 §9.4:
        // "写入正常任务流，由 Scheduler 唤醒"). An unstaffed position leaves the assignee empty,
        // which is the documented `task-system` behaviour (§11.7).
        const assigned = tasks.assign({
          taskId,
          actor,
          simTime: command.createdAtSim,
          ...(rationale === null ? {} : { reason: rationale }),
          ...(matched.length === 0 ? {} : { matchedCapabilities: matched }),
        });
        if (!assigned.ok) return bad(fromTaskFailure(assigned.error), result.value.events);
        const created = emit(CONTROL_TASK_INJECTED, command, 'task', {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          taskId,
          title: command.title,
          goal: command.goal,
          positionId: assigned.value.task.assignment.positionId,
          assigneeEmployeeId: assigned.value.task.assignment.assigneeEmployeeId,
          createdAtSim: Number(command.createdAtSim),
        });
        if (!created.ok) {
          return bad(created.failure, [...result.value.events, ...assigned.value.events]);
        }
        const events: OrgEvent[] = [
          ...result.value.events,
          ...assigned.value.events,
          created.event,
        ];
        // The delegation decision is a fact only when a delegation actually happened: the
        // capability-matched path picks a person, the seat path dispatches to a seat.
        if (candidate !== null && rationale !== null) {
          const delegated = delegationEvent(command, assigned.value.task, rationale);
          if (!delegated.ok) return bad(delegated.failure, events);
          events.push(delegated.event);
        }
        return ok(events, { taskId });
      }
      case 'Organization.InjectEvent': {
        const injected = createOrgEvent(
          registry,
          {
            companyId: companyId as never,
            type: command.eventType,
            occurredAtSim: command.createdAtSim,
            actorKind: command.actor.kind,
            actorId: String(command.actor.operatorId),
            subjectType: command.subjectType,
            subjectId: command.subjectId,
            correlationId: command.correlationId,
            causationId: command.causationId ?? command.commandId,
            payload: command.payload,
          },
          { eventIdGenerator },
        );
        if (!injected.ok) {
          return bad({
            code: 'INVALID_COMMAND',
            issues: injected.error.issues.map((entry) => issue(entry.field, entry.reason)),
          });
        }
        const marker = emit(CONTROL_EVENT_INJECTED, command, command.subjectType, {
          commandId: command.commandId,
          operatorId: String(command.actor.operatorId),
          reason: command.reason,
          injectedEventType: command.eventType,
          injectedEventId: injected.value.eventId,
        });
        if (!marker.ok) return bad(marker.failure);
        return ok([injected.value, marker.event], {
          injectedEventId: injected.value.eventId,
          injectedEventType: command.eventType,
        });
      }
      default:
        return bad(failure('INVALID_COMMAND', 'commandType', 'not an organization command'));
    }
  };

  const dispatch = async (command: ControlCommand, actor: CommandActor): Promise<Attempt> => {
    if (command.commandType.startsWith('Simulation.')) return handleSimulation(command);
    if (command.commandType.startsWith('Agent.')) return handleAgent(command, actor);
    if (command.commandType.startsWith('Work.')) return handleWork(command);
    if (command.commandType.startsWith('Workflow.')) return handleWorkflow(command, actor);
    if (command.commandType.startsWith('Task.')) return handleTask(command, actor);
    if (command.commandType.startsWith('Organization.')) return handleOrganization(command, actor);
    return bad(
      failure('INVALID_COMMAND', 'commandType', `unsupported command "${command.commandType}"`),
    );
  };

  const record = (
    command: ControlCommand,
    status: ControlOutcome['status'],
    events: readonly OrgEvent[],
    error: ControlFailure | null,
    targetType: string,
    details: Readonly<Record<string, unknown>> = {},
  ): ControlOutcome => {
    const eventIds = events.map((event) => event.eventId);
    auditVerdict(
      status,
      command,
      targetType,
      error === null ? null : error.code,
      eventIds,
      { ...details, fingerprint: fingerprintOf(command) },
    );
    const entry = audit.find(command.commandId);
    return {
      status,
      commandId: command.commandId,
      commandType: command.commandType,
      replayed: false,
      events: Object.freeze(eventIds),
      auditId: entry === null ? '' : entry.auditId,
      failure: error,
    };
  };

  const execute = async (command: ControlCommand): Promise<ControlOutcome> => {
    const replayed = replayOutcome(command);
    if (replayed !== null) return replayed;

    const targetType = command.target?.targetType ?? 'unknown';

    const structural = validateCommand(command);
    if (structural !== null) {
      // Uniform contract: every post-envelope rejection leaves a `Control.CommandRejected`
      // fact (when the envelope can still be formed), so refusals are replayable too.
      return reject(command, structural, targetType);
    }

    const resolvedOperator = resolveOperatorActor(identity, organization, command);
    if (!resolvedOperator.ok) {
      return reject(command, resolvedOperator.error, targetType);
    }

    const authorized = authorizer.authorize(resolvedOperator.value, command);
    if (!authorized.ok) {
      return reject(command, authorized.error, targetType);
    }

    const attempt = await dispatch(command, authorized.value);
    if (attempt.failure !== null) {
      return reject(command, attempt.failure, targetType, attempt.events);
    }

    if (attempt.events.length > 0) await eventStore.append(attempt.events);
    for (const event of attempt.events) projection = applyControlEvent(projection, event);

    return record(command, 'accepted', attempt.events, null, targetType, attempt.details);
  };

  /**
   * A refused command leaves a permanent, replayable trace on the event log
   * (`Control.CommandRejected`) in addition to its audit record — so "who tried to do what
   * and what did the system answer" survives recovery without a second event source.
   */
  const reject = async (
    command: ControlCommand,
    error: ControlFailure,
    targetType: string,
    producedEvents: readonly OrgEvent[] = [],
  ): Promise<ControlOutcome> => {
    // Let the event registry decide whether this refusal can be expressed as a
    // `Control.CommandRejected` fact. The registration contract is the single authority —
    // hardcoding envelope preconditions here would silently diverge from it.
    const created = emit(CONTROL_COMMAND_REJECTED, command, targetType, {
      commandId: command.commandId,
      operatorId: typeof command.actor?.operatorId === 'string' ? command.actor.operatorId : '',
      reason: typeof command.reason === 'string' ? command.reason : '',
      commandType: String(command.commandType ?? ''),
      targetType,
      targetId: typeof command.target?.targetId === 'string' ? command.target.targetId : '',
      resultCode: error.code,
      issues: error.issues.map((entry) => ({ field: entry.field, reason: entry.reason })),
    });
    const events = created.ok ? [...producedEvents, created.event] : [...producedEvents];
    if (created.ok) {
      await eventStore.append([created.event]);
      projection = applyControlEvent(projection, created.event);
    }
    return record(command, 'rejected', events, error, targetType, {
      ...(error.requiredAuthority === undefined
        ? {}
        : { requiredAuthority: error.requiredAuthority }),
      ...(error.escalateTo === undefined ? {} : { escalateTo: String(error.escalateTo) }),
    });
  };

  return { execute, hydrate, query, state };
}

function auditDetails(
  view: import('./types.js').AuditView,
): Readonly<Record<string, unknown>> | null {
  const details = (view as unknown as { readonly details?: Readonly<Record<string, unknown>> })
    .details;
  return details ?? null;
}

export function fromTaskFailure(error: {
  readonly code: string;
  readonly issues: readonly { readonly field: string; readonly reason: string }[];
}): ControlFailure {
  const code: ControlFailure['code'] =
    error.code === 'unknown_task'
      ? 'NOT_FOUND'
      : error.code === 'permission_denied'
        ? 'UNAUTHORIZED'
        : error.code === 'invalid_transition'
          ? 'INVALID_STATE'
          : error.code === 'invalid_actor'
            ? 'UNAUTHENTICATED'
            : error.code === 'employee_not_executable'
              ? 'INVALID_STATE'
              : 'INVALID_COMMAND';
  return { code, issues: error.issues.map((entry) => issue(entry.field, entry.reason)) };
}

export function fromWorkflowFailure(error: {
  readonly code: string;
  readonly issues: readonly { readonly field: string; readonly reason: string }[];
  readonly denial?: unknown;
}): ControlFailure {
  const code: ControlFailure['code'] =
    error.code === 'unknown_instance' || error.code === 'unknown_workflow'
      ? 'NOT_FOUND'
      : error.code === 'permission_denied' || error.code === 'authority_insufficient'
        ? 'UNAUTHORIZED'
        : error.code === 'instance_blocked'
          ? 'WORKFLOW_BLOCKED'
          : error.code === 'instance_terminal' ||
              error.code === 'instance_not_running' ||
              error.code === 'instance_not_draft' ||
              error.code === 'approval_not_open' ||
              error.code === 'approval_already_decided'
            ? 'INVALID_STATE'
            : error.code === 'invalid_actor'
              ? 'UNAUTHENTICATED'
              : 'INVALID_COMMAND';
  const mapped: ControlFailure = {
    code,
    issues: error.issues.map((entry) => issue(entry.field, entry.reason)),
  };
  if (error.denial === undefined) return mapped;
  const denial = error.denial as {
    readonly requiredAuthority?: number;
    readonly escalateTo?: string;
  };
  return {
    ...mapped,
    ...(denial.requiredAuthority === undefined
      ? {}
      : { requiredAuthority: denial.requiredAuthority as never }),
    ...(denial.escalateTo === undefined ? {} : { escalateTo: denial.escalateTo as EmployeeId }),
  };
}
