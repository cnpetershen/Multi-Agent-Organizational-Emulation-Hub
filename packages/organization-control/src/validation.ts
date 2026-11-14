import type { ActorContext, OrgEvent, Result } from '@maoeh/shared-types';
import type { Identity } from '@maoeh/identity-system';
import type { Organization } from '@maoeh/organization-model';
import { validateActorLegitimacy } from '@maoeh/permission-system';

import { CONTROL_COMMAND_TYPES, type ControlCommand, type ControlFailure } from './types.js';

export function controlIssue(field: string, reason: string): { field: string; reason: string } {
  return { field, reason };
}

export function controlFailure(
  code: ControlFailure['code'],
  field: string,
  reason: string,
): ControlFailure {
  return { code, issues: [controlIssue(field, reason)] };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isArrayOfNonEmptyStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => isNonEmptyString(entry));
}

/** Structural command validation. Runs before any authorization. */
export function validateCommand(command: ControlCommand): ControlFailure | null {
  if (!isNonEmptyString(command.commandId)) {
    return controlFailure('INVALID_COMMAND', 'commandId', 'commandId must be a non-empty string');
  }
  if (!(CONTROL_COMMAND_TYPES as readonly string[]).includes(command.commandType)) {
    return controlFailure(
      'INVALID_COMMAND',
      'commandType',
      `unknown command type "${String(command.commandType)}"`,
    );
  }
  if (!isNonEmptyString(command.actor?.operatorId)) {
    return controlFailure('UNAUTHENTICATED', 'actor.operatorId', 'an operator identity is required');
  }
  if (!isNonEmptyString(command.actor.positionId)) {
    return controlFailure(
      'INVALID_COMMAND',
      'actor.positionId',
      'an operator must occupy a position (humans are organization members)',
    );
  }
  if (!isNonEmptyString(command.reason)) {
    return controlFailure('INVALID_COMMAND', 'reason', 'a reason is mandatory for every control command');
  }
  if (!isNonEmptyString(command.correlationId)) {
    return controlFailure('INVALID_COMMAND', 'correlationId', 'correlationId is required');
  }
  if (!isNonEmptyString(command.target?.targetId)) {
    return controlFailure('INVALID_TARGET', 'target.targetId', 'target.targetId is required');
  }
  if (command.expectedVersion !== undefined) {
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 0) {
      return controlFailure(
        'INVALID_COMMAND',
        'expectedVersion',
        'expectedVersion must be a non-negative integer',
      );
    }
  }
  if (typeof command.createdAtSim !== 'number' || !Number.isFinite(command.createdAtSim)) {
    return controlFailure('INVALID_COMMAND', 'createdAtSim', 'createdAtSim must be a finite number');
  }

  if (command.commandType === 'Simulation.Seek') {
    if (!Number.isInteger(command.tickNumber) || command.tickNumber < 0) {
      return controlFailure(
        'INVALID_COMMAND',
        'tickNumber',
        'tickNumber must be a non-negative integer',
      );
    }
  }
  if (command.commandType === 'Agent.Instruct' && !isNonEmptyString(command.instruction)) {
    return controlFailure('INVALID_COMMAND', 'instruction', 'instruction must be non-empty');
  }
  if (command.commandType === 'Agent.Create') {
    if (!isNonEmptyString(command.employeeId)) {
      return controlFailure('INVALID_COMMAND', 'employeeId', 'employeeId must be a non-empty string');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command.employeeId)) {
      return controlFailure(
        'INVALID_COMMAND',
        'employeeId',
        'employeeId must be a stable id (letters, digits, ".", "_" or "-")',
      );
    }
    if (command.employeeId.length > 128) {
      return controlFailure('INVALID_COMMAND', 'employeeId', 'employeeId must be at most 128 characters');
    }
    if (!isNonEmptyString(command.name)) {
      return controlFailure('INVALID_COMMAND', 'name', 'name must be a non-empty string');
    }
    // Length bounds live here, not only in the event schema: the event payload is built *after*
    // the Runtime has placed the agent, so an over-long field would create an employee with no
    // `Agent.Created` fact. Validating first keeps "refused" and "nothing happened" the same thing.
    if (command.name.length > 200) {
      return controlFailure('INVALID_COMMAND', 'name', 'name must be at most 200 characters');
    }
    if (!isNonEmptyString(command.positionId)) {
      return controlFailure('INVALID_COMMAND', 'positionId', 'positionId must be non-empty');
    }
    if (command.positionId.length > 128) {
      return controlFailure('INVALID_COMMAND', 'positionId', 'positionId must be at most 128 characters');
    }
    if (
      !Array.isArray(command.responsibilities) ||
      command.responsibilities.length === 0 ||
      command.responsibilities.some((entry) => !isNonEmptyString(entry))
    ) {
      return controlFailure(
        'INVALID_COMMAND',
        'responsibilities',
        'an agent must be created with at least one responsibility',
      );
    }
    if (command.responsibilities.some((entry) => entry.length > 200)) {
      return controlFailure(
        'INVALID_COMMAND',
        'responsibilities',
        'each responsibility must be at most 200 characters',
      );
    }
    if (
      command.employeeNo !== undefined &&
      command.employeeNo !== null &&
      !isNonEmptyString(command.employeeNo)
    ) {
      return controlFailure(
        'INVALID_COMMAND',
        'employeeNo',
        'employeeNo must be null or a non-empty string',
      );
    }
    if (typeof command.employeeNo === 'string' && command.employeeNo.length > 64) {
      return controlFailure('INVALID_COMMAND', 'employeeNo', 'employeeNo must be at most 64 characters');
    }
    if (command.traits !== undefined && !isArrayOfNonEmptyStrings(command.traits)) {
      return controlFailure('INVALID_COMMAND', 'traits', 'traits must be an array of non-empty strings');
    }
    if (command.traits !== undefined && command.traits.some((entry) => entry.length > 200)) {
      return controlFailure('INVALID_COMMAND', 'traits', 'each trait must be at most 200 characters');
    }
    // Expertise rides the same 64-char id budget as a seat's capability tags: both are matched
    // against capability ids, so an over-long tag could never be matched anyway.
    if (command.expertise !== undefined && !isArrayOfNonEmptyStrings(command.expertise)) {
      return controlFailure(
        'INVALID_COMMAND',
        'expertise',
        'expertise must be an array of non-empty strings',
      );
    }
    if (command.expertise !== undefined && command.expertise.some((entry) => entry.length > 64)) {
      return controlFailure(
        'INVALID_COMMAND',
        'expertise',
        'each expertise tag must be at most 64 characters',
      );
    }
    // The typed-in seat ("Engineering" + "Game Developer"): structural bounds live here for the
    // same reason name/responsibilities do — the event that carries the seat is written *after*
    // the Runtime has acted, so an over-long field must be refused before anything happens.
    if (command.newPosition !== undefined) {
      const spec = command.newPosition;
      if (typeof spec !== 'object' || spec === null) {
        return controlFailure('INVALID_COMMAND', 'newPosition', 'newPosition must be an object');
      }
      if (!isNonEmptyString(spec.departmentId)) {
        return controlFailure(
          'INVALID_COMMAND',
          'newPosition.departmentId',
          'newPosition.departmentId must be a non-empty string',
        );
      }
      if (spec.departmentId.length > 128) {
        return controlFailure(
          'INVALID_COMMAND',
          'newPosition.departmentId',
          'newPosition.departmentId must be at most 128 characters',
        );
      }
      if (!isNonEmptyString(spec.title)) {
        return controlFailure(
          'INVALID_COMMAND',
          'newPosition.title',
          'newPosition.title must be a non-empty string',
        );
      }
      if (spec.title.length > 120) {
        return controlFailure(
          'INVALID_COMMAND',
          'newPosition.title',
          'newPosition.title must be at most 120 characters',
        );
      }
      if (spec.capabilities !== undefined && !isArrayOfNonEmptyStrings(spec.capabilities)) {
        return controlFailure(
          'INVALID_COMMAND',
          'newPosition.capabilities',
          'newPosition.capabilities must be an array of non-empty strings',
        );
      }
      if (spec.capabilities !== undefined && spec.capabilities.some((entry) => entry.length > 64)) {
        return controlFailure(
          'INVALID_COMMAND',
          'newPosition.capabilities',
          'each capability must be at most 64 characters',
        );
      }
      if (
        spec.reportsToPositionId !== undefined &&
        spec.reportsToPositionId !== null &&
        !isNonEmptyString(spec.reportsToPositionId)
      ) {
        return controlFailure(
          'INVALID_COMMAND',
          'newPosition.reportsToPositionId',
          'newPosition.reportsToPositionId must be null, omitted, or a non-empty string',
        );
      }
    }
  }
  if (
    (command.commandType === 'Agent.CancelTask' || command.commandType === 'Agent.RequestReview') &&
    !isNonEmptyString(command.taskId)
  ) {
    return controlFailure('INVALID_COMMAND', 'taskId', 'taskId must be non-empty');
  }
  if (command.commandType === 'Task.Reassign' && !isNonEmptyString(command.positionId)) {
    return controlFailure('INVALID_COMMAND', 'positionId', 'positionId must be non-empty');
  }
  if (command.commandType === 'Task.AssignToAgent') {
    // Naming the employee is optional: without one the Control Plane runs the capability
    // matcher against the task's own `requiredSkills`.
    if (command.agentId !== undefined && !isNonEmptyString(command.agentId)) {
      return controlFailure('INVALID_COMMAND', 'agentId', 'agentId must be a non-empty string');
    }
    if (typeof command.agentId === 'string' && command.agentId.length > 128) {
      return controlFailure('INVALID_COMMAND', 'agentId', 'agentId must be at most 128 characters');
    }
  }
  if (command.commandType === 'Organization.InjectTask') {
    if (!isNonEmptyString(command.title)) {
      return controlFailure('INVALID_COMMAND', 'title', 'title must be non-empty');
    }
    if (!isNonEmptyString(command.goal)) {
      return controlFailure('INVALID_COMMAND', 'goal', 'goal must be non-empty');
    }
    if (command.requiredSkills !== undefined && !isArrayOfNonEmptyStrings(command.requiredSkills)) {
      return controlFailure(
        'INVALID_COMMAND',
        'requiredSkills',
        'requiredSkills must be an array of non-empty strings',
      );
    }
    if (command.requiredSkills !== undefined && command.requiredSkills.some((entry) => entry.length > 64)) {
      return controlFailure(
        'INVALID_COMMAND',
        'requiredSkills',
        'each required skill must be at most 64 characters',
      );
    }
    const hasSeat = isNonEmptyString(command.positionId);
    const hasCapabilities =
      command.requiredSkills !== undefined && command.requiredSkills.length > 0;
    if (hasSeat) {
      if (command.positionId !== undefined && command.positionId.length > 128) {
        return controlFailure(
          'INVALID_COMMAND',
          'positionId',
          'positionId must be at most 128 characters',
        );
      }
    } else if (!hasCapabilities) {
      // Routing needs one of the two: a seat to dispatch to, or capabilities to match on.
      return controlFailure(
        'INVALID_COMMAND',
        'positionId',
        'positionId or requiredSkills is required',
      );
    }
  }
  if (command.commandType === 'Organization.InjectEvent') {
    if (!isNonEmptyString(command.eventType)) {
      return controlFailure('INVALID_COMMAND', 'eventType', 'eventType must be non-empty');
    }
    if (!isNonEmptyString(command.subjectId)) {
      return controlFailure('INVALID_COMMAND', 'subjectId', 'subjectId must be non-empty');
    }
    if (typeof command.payload !== 'object' || command.payload === null) {
      return controlFailure('INVALID_COMMAND', 'payload', 'payload must be an object');
    }
  }
  if (command.commandType === 'Work.SubmitBrief') {
    // Bounds live here, not only in the event schema: the event is emitted *after* the brief
    // was accepted, so an over-long field must be refused before anything reaches the log.
    const brief = command.workBrief;
    if (typeof brief !== 'object' || brief === null) {
      return controlFailure('INVALID_COMMAND', 'workBrief', 'workBrief must be an object');
    }
    if (!isNonEmptyString(brief.title)) {
      return controlFailure('INVALID_COMMAND', 'workBrief.title', 'workBrief.title must be non-empty');
    }
    if (brief.title.length > 200) {
      return controlFailure(
        'INVALID_COMMAND',
        'workBrief.title',
        'workBrief.title must be at most 200 characters',
      );
    }
    if (!isNonEmptyString(brief.goal)) {
      return controlFailure('INVALID_COMMAND', 'workBrief.goal', 'workBrief.goal must be non-empty');
    }
    if (brief.goal.length > 8000) {
      return controlFailure(
        'INVALID_COMMAND',
        'workBrief.goal',
        'workBrief.goal must be at most 8000 characters',
      );
    }
    if (
      brief.context !== undefined &&
      brief.context !== null &&
      typeof brief.context !== 'string'
    ) {
      return controlFailure(
        'INVALID_COMMAND',
        'workBrief.context',
        'workBrief.context must be a string or null',
      );
    }
    if (typeof brief.context === 'string' && brief.context.length > 8000) {
      return controlFailure(
        'INVALID_COMMAND',
        'workBrief.context',
        'workBrief.context must be at most 8000 characters',
      );
    }
    // Q3: verification is required. Without it the dispatched work could never be judged.
    if (!Array.isArray(brief.verificationKeys) || brief.verificationKeys.length === 0) {
      return controlFailure(
        'INVALID_COMMAND',
        'workBrief.verificationKeys',
        'workBrief.verificationKeys must be a non-empty array',
      );
    }
    if (brief.verificationKeys.some((entry) => !isNonEmptyString(entry))) {
      return controlFailure(
        'INVALID_COMMAND',
        'workBrief.verificationKeys',
        'each verification key must be a non-empty string',
      );
    }
    if (brief.verificationKeys.some((entry) => entry.length > 64)) {
      return controlFailure(
        'INVALID_COMMAND',
        'workBrief.verificationKeys',
        'each verification key must be at most 64 characters',
      );
    }
    if (
      brief.priority !== undefined &&
      brief.priority !== null &&
      (!Number.isInteger(brief.priority) || brief.priority < 1 || brief.priority > 9)
    ) {
      return controlFailure(
        'INVALID_COMMAND',
        'workBrief.priority',
        'priority must be an integer between 1 and 9',
      );
    }
    if (
      brief.dueAtSim !== undefined &&
      brief.dueAtSim !== null &&
      (!Number.isInteger(brief.dueAtSim) || brief.dueAtSim < 0)
    ) {
      return controlFailure(
        'INVALID_COMMAND',
        'workBrief.dueAtSim',
        'workBrief.dueAtSim must be a non-negative integer',
      );
    }
  }

  if (command.commandType === 'Workflow.InstanceAssignmentOverride') {
    const overrides = command.overrides;
    if (!Array.isArray(overrides) || overrides.length === 0) {
      return controlFailure('INVALID_COMMAND', 'overrides', 'overrides must be a non-empty list');
    }
    if (overrides.length > 64) {
      return controlFailure('INVALID_COMMAND', 'overrides', 'overrides may carry at most 64 entries');
    }
    const seen = new Set<string>();
    for (let index = 0; index < overrides.length; index += 1) {
      const entry = overrides[index];
      const field = `overrides.${String(index)}`;
      if (typeof entry !== 'object' || entry === null) {
        return controlFailure('INVALID_COMMAND', field, 'each override must be an object');
      }
      if (!isNonEmptyString(entry.stepId) || entry.stepId.length > 64) {
        return controlFailure(
          'INVALID_COMMAND',
          `${field}.stepId`,
          'overrides[].stepId must be a non-empty string of at most 64 characters',
        );
      }
      if (!isNonEmptyString(entry.employeeId) || entry.employeeId.length > 64) {
        return controlFailure(
          'INVALID_COMMAND',
          `${field}.employeeId`,
          'overrides[].employeeId must be a non-empty string of at most 64 characters',
        );
      }
      if (
        entry.reason !== undefined &&
        entry.reason !== null &&
        (typeof entry.reason !== 'string' || entry.reason.length > 500)
      ) {
        return controlFailure(
          'INVALID_COMMAND',
          `${field}.reason`,
          'overrides[].reason must be a string of at most 500 characters',
        );
      }
      if (seen.has(entry.stepId)) {
        return controlFailure(
          'INVALID_COMMAND',
          `${field}.stepId`,
          `duplicate override for step "${entry.stepId}"`,
        );
      }
      seen.add(entry.stepId);
    }
  }

  const expectedTarget: Record<string, string> = {
    'Agent.Create': 'organization',
    'Agent.Archive': 'agent',
    'Agent.Pause': 'agent',
    'Agent.Resume': 'agent',
    'Agent.Instruct': 'agent',
    'Agent.CancelTask': 'agent',
    'Agent.RequestReview': 'agent',
    'Workflow.Pause': 'workflow',
    'Workflow.Resume': 'workflow',
    'Workflow.Cancel': 'workflow',
    'Workflow.Approve': 'workflow',
    'Workflow.Reject': 'workflow',
    'Workflow.Delete': 'workflow',
    'Workflow.InstanceAssignmentOverride': 'workflow',
    'Workflow.ConfirmStart': 'workflow',
    'Task.Cancel': 'task',
    'Task.Reassign': 'task',
    'Task.AssignToAgent': 'task',
    'Task.RequestReview': 'task',
    'Task.Delete': 'task',
    'Simulation.Start': 'simulation',
    'Simulation.Pause': 'simulation',
    'Simulation.Resume': 'simulation',
    'Simulation.Step': 'simulation',
    'Simulation.Seek': 'simulation',
    'Organization.InjectTask': 'organization',
    'Organization.InjectEvent': 'organization',
    // A brief is addressed at the agent who must turn it into a plan.
    'Work.SubmitBrief': 'agent',
  };
  const required = expectedTarget[command.commandType];
  if (required !== undefined && command.target.targetType !== required) {
    return controlFailure(
      'INVALID_TARGET',
      'target.targetType',
      `${command.commandType} requires targetType "${required}" but received "${command.target.targetType}"`,
    );
  }

  return null;
}

/**
 * Resolve an operator to an `ActorContext` through the single Identity factory, then
 * run the existing legitimacy pre-flight. No parallel identity model is created.
 */
export function resolveOperatorActor(
  identity: Identity,
  organization: Organization,
  command: ControlCommand,
): Result<ActorContext, ControlFailure> {
  let context: ActorContext;
  try {
    context = identity.actorContext(
      command.actor.operatorId,
      command.correlationId as ActorContext['correlationId'],
    );
  } catch {
    return {
      ok: false,
      error: controlFailure(
        'UNAUTHENTICATED',
        'actor.operatorId',
        `no registered identity for operator "${String(command.actor.operatorId)}"`,
      ),
    };
  }

  const issues = validateActorLegitimacy(organization, context);
  if (issues.length > 0) {
    return {
      ok: false,
      error: {
        code: 'UNAUTHENTICATED',
        issues: issues.map((issue) => controlIssue(issue.field, issue.reason)),
      },
    };
  }

  if (context.positionId !== command.actor.positionId) {
    return {
      ok: false,
      error: controlFailure(
        'OUT_OF_SCOPE',
        'actor.positionId',
        `operator "${String(command.actor.operatorId)}" does not occupy position "${command.actor.positionId}"`,
      ),
    };
  }

  return { ok: true, value: context };
}

/** Idempotency contract: the same commandId must always carry the same intent. */
export function fingerprintOf(command: ControlCommand): string {
  const relevant = Object.entries(command)
    .filter(([key]) => key !== 'createdAtSim')
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify(relevant);
}

export function readEventString(event: OrgEvent, key: string): string | null {
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Readonly<Record<string, unknown>>)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}
