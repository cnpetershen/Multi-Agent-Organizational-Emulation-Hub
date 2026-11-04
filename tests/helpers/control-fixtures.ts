import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CorrelationId, EmployeeId, OrgEvent } from '@maoeh/shared-types';
import { createAuditService } from '@maoeh/audit-system';
import type { KernelControlPlane } from '@maoeh/kernel';
import { createKernelControlPlane } from '@maoeh/kernel';
import type { Organization, OrganizationSourceReader } from '@maoeh/organization-model';
import { loadOrganization } from '@maoeh/organization-model';
import type { PermissionPolicy } from '@maoeh/permission-system';
import { createAuthzService } from '@maoeh/permission-system';
import type { ControlActor, ControlCommand, ControlTargetType } from '@maoeh/organization-control';
import { controlPolicyForPosition } from '@maoeh/organization-control';
import type { Simulation } from '@maoeh/kernel';
import type { WorkflowDefinition } from '@maoeh/workflow-engine';

import {
  createSimulationHarness,
  type SimulationHarness,
  type SimulationHarnessOptions,
} from './simulation-fixtures';

export const seedRoot = fileURLToPath(
  new URL('../../agents/future-ai-lab/', import.meta.url),
);

export const OPERATOR_POSITION_ID = 'board-operator';
export const OPERATOR_EMPLOYEE_ID = 'operator-dana';
export const OTHER_OPERATOR_EMPLOYEE_ID = 'operator-erin';
export const OTHER_OPERATOR_POSITION_ID = 'board-observer';

/** A human employee occupying a real position — the only shape `AuthzService.can()` accepts. */
const OPERATOR_POSITION_YAML = `id: board-operator
title: Board Operator
department: product
decision_domains:
  org: 5
  ops: 5
  product: 5
  engineering: 3
  finance: 5
  marketing: 5
`;

const OTHER_OPERATOR_POSITION_YAML = `id: board-observer
title: Board Observer
department: marketing
decision_domains:
  org: 1
  ops: 1
  product: 1
  engineering: 1
  finance: 1
  marketing: 1
`;

const OPERATOR_EMPLOYEE_YAML = `id: operator-dana
name: Dana
position: board-operator
employee_no: OP-001
kind: human
status: active
`;

const OTHER_OPERATOR_EMPLOYEE_YAML = `id: operator-erin
name: Erin
position: board-observer
employee_no: OP-002
kind: human
status: active
`;

const EXTRA_FILES: Readonly<Record<string, string>> = Object.freeze({
  'positions/board-operator.yaml': OPERATOR_POSITION_YAML,
  'positions/board-observer.yaml': OTHER_OPERATOR_POSITION_YAML,
  'employees/operator-dana.yaml': OPERATOR_EMPLOYEE_YAML,
  'employees/operator-erin.yaml': OTHER_OPERATOR_EMPLOYEE_YAML,
});

/**
 * The seed organization plus two human operators. The seed holds AI employees only, so
 * M1.0's human path needs an organization that contains a human organization member.
 */
export function loadSeedOrganizationWithOperators(): Organization {
  const reader: OrganizationSourceReader = {
    list(relativeDirectory) {
      const prefix = `${relativeDirectory}/`;
      const onDisk = existsSync(join(seedRoot, relativeDirectory))
        ? readdirSync(join(seedRoot, relativeDirectory))
            .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
            .map((entry) => `${prefix}${entry}`)
        : [];
      const extra = Object.keys(EXTRA_FILES).filter((path) => path.startsWith(prefix));
      return [...new Set([...onDisk, ...extra])].sort();
    },
    read(relativePath) {
      const extra = EXTRA_FILES[relativePath];
      if (extra !== undefined) return extra;
      const filePath = join(seedRoot, relativePath);
      return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
    },
  };

  const result = loadOrganization(reader);
  if (!result.ok) {
    throw new Error(
      `seed organization with operators failed: ${result.error.issues
        .map((issue) => `${issue.source}:${issue.reason}`)
        .join(', ')}`,
    );
  }
  return result.value;
}

/** Policy that grants every control action to the operator position only. */
export function operatorControlPolicy(): PermissionPolicy {
  return controlPolicyForPosition(OPERATOR_POSITION_ID);
}

/** Policy that grants control actions to the observer position only (authority-starved). */
export function observerControlPolicy(): PermissionPolicy {
  return controlPolicyForPosition(OTHER_OPERATOR_POSITION_ID);
}

/** Policy that grants nothing: every control command must fail closed. */
export const NO_CONTROL_POLICY: PermissionPolicy = Object.freeze({
  grants: Object.freeze([]),
  denies: Object.freeze([]),
});

export interface ControlHarnessOptions extends SimulationHarnessOptions {
  readonly policy?: PermissionPolicy;
  readonly org?: Organization;
}

/**
 * Seed workflow definitions with every approval gate also decidable by the human operator
 * position. Used only by M1.0 human-approval scenarios; the repository seed under
 * `workflows/` stays untouched so M0.9 tests keep asserting the original `[ceo]` role.
 */
export function humanDecidableWorkflowDefinitions(
  base: readonly WorkflowDefinition[],
): readonly WorkflowDefinition[] {
  return base.map((definition) => ({
    ...definition,
    stages: definition.stages.map((stage) => ({
      ...stage,
      steps: stage.steps.map((step) =>
        step.kind === 'approval'
          ? { ...step, requiredRoles: [OPERATOR_POSITION_ID] }
          : step,
      ),
    })),
  }));
}

export interface ControlHarness {
  readonly harness: SimulationHarness;
  readonly simulation: Simulation;
  readonly organization: Organization;
  readonly plane: KernelControlPlane;
  readonly audit: ReturnType<typeof createAuditService>;
  readonly policy: PermissionPolicy;
  operator(): ControlActor;
  observer(): ControlActor;
  command(
    commandType: ControlCommand['commandType'],
    overrides?: Partial<ControlCommand> & {
      readonly targetId?: string;
      readonly targetType?: ControlTargetType;
      readonly extra?: Readonly<Record<string, unknown>>;
    },
  ): ControlCommand;
}

let commandSeq = 0;
let correlationSeq = 0;

export const OPERATOR_CORRELATION_PREFIX = 'corr-control';

export async function createControlHarness(
  options: ControlHarnessOptions = {},
): Promise<ControlHarness> {
  const organization = options.org ?? options.organization ?? loadSeedOrganizationWithOperators();
  const policy = options.policy ?? operatorControlPolicy();
  const harness = await createSimulationHarness({ ...options, organization });
  const authz = createAuthzService({ organization, policy });
  const audit = createAuditService();

  const plane = createKernelControlPlane({
    simulation: harness.simulation,
    authz,
    registry: harness.simulation.registry,
    eventStore: harness.simulation.eventStore,
    auditService: audit,
  });

  const actorOf = (employeeId: string, positionId: string): ControlActor =>
    Object.freeze({
      operatorId: employeeId as EmployeeId,
      displayName: employeeId === OPERATOR_EMPLOYEE_ID ? 'Dana' : 'Erin',
      positionId,
      kind: 'human' as const,
    });

  return {
    harness,
    simulation: harness.simulation,
    organization,
    plane,
    audit,
    policy,
    operator: () => actorOf(OPERATOR_EMPLOYEE_ID, OPERATOR_POSITION_ID),
    observer: () => actorOf(OTHER_OPERATOR_EMPLOYEE_ID, OTHER_OPERATOR_POSITION_ID),
    command(commandType, overrides = {}) {
      commandSeq += 1;
      correlationSeq += 1;
      const { targetId, targetType, extra, ...rest } = overrides;
      const command: ControlCommand = {
        commandId: `cmd-${String(commandSeq)}`,
        commandType,
        actor: rest.actor ?? actorOf(OPERATOR_EMPLOYEE_ID, OPERATOR_POSITION_ID),
        target: rest.target ?? {
          targetType: targetType ?? defaultTargetType(commandType),
          targetId: targetId ?? defaultTargetId(commandType),
        },
        reason: rest.reason ?? 'operator action under test',
        correlationId: rest.correlationId ?? `${OPERATOR_CORRELATION_PREFIX}-${String(correlationSeq)}`,
        causationId: rest.causationId ?? null,
        createdAtSim:
          rest.createdAtSim ??
          (harness.simulation.scheduler.clock.simTime as ControlCommand['createdAtSim']),
        ...(rest.expectedVersion === undefined ? {} : { expectedVersion: rest.expectedVersion }),
        ...rest,
        ...(extra ?? {}),
      } as ControlCommand;
      return command;
    },
  };
}

function defaultTargetType(commandType: string): ControlTargetType {
  // `Agent.Create` (M1.3) changes the organization roster: its target is the company, while its
  // subject is the agent being born.
  if (commandType === 'Agent.Create') return 'organization';
  if (commandType.startsWith('Simulation.')) return 'simulation';
  if (commandType.startsWith('Agent.')) return 'agent';
  // M1.4: a work brief is addressed at the agent who must turn it into a plan.
  if (commandType.startsWith('Work.')) return 'agent';
  if (commandType.startsWith('Workflow.')) return 'workflow';
  if (commandType.startsWith('Task.')) return 'task';
  return 'organization';
}

function defaultTargetId(commandType: string): string {
  if (commandType === 'Agent.Create') return 'future-ai-lab';
  if (commandType.startsWith('Simulation.')) return 'future-ai-lab';
  if (commandType.startsWith('Agent.')) return 'ceo-alex';
  if (commandType.startsWith('Work.')) return 'ceo-alex';
  if (commandType.startsWith('Workflow.')) return 'instance-1';
  if (commandType.startsWith('Task.')) return 'task-1';
  return 'future-ai-lab';
}

export function operatorActorContextId(employeeId: string): EmployeeId {
  return employeeId as EmployeeId;
}

export function correlationIdOf(value: string): CorrelationId {
  return value as CorrelationId;
}

/** `true` when the workflow instance is waiting on a human-decidable approval gate. */
export function approvalGateOpen(simulation: Simulation, instanceId: string): boolean {
  const instance = simulation.instanceStore.get(instanceId);
  if (instance === null) return false;
  return (
    instance.status === 'blocked' &&
    instance.approval !== null &&
    instance.approval.status === 'open'
  );
}

/** Collect every stored event in append order (test-side replay helper). */
export async function collectEvents(eventStore: Simulation['eventStore']): Promise<readonly OrgEvent[]> {
  const collected: OrgEvent[] = [];
  for await (const event of eventStore.replay(1 as never)) collected.push(event);
  return collected;
}
