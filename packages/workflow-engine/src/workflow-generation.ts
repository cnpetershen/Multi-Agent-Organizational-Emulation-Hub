import type { Organization } from '@maoeh/organization-model';
import {
  capabilityLabel,
  resolveCapabilityAssignments,
  type CapabilityResolutionOptions,
} from '@maoeh/organization-model';
import type { PositionId } from '@maoeh/shared-types';
import type { WorkflowIssue } from './workflow-errors.js';
import { workflowIssue } from './workflow-errors.js';
import type {
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowStage,
  WorkflowStep,
} from './workflow-types.js';
import {
  EXECUTION_PLAN_CONTEXT_KEY,
  generateExecutionPlanWorkflowDefinition,
  parseExecutionPlanSnapshot,
} from './execution-plan-workflow.js';

/**
 * Capability → generated workflow — how a CEO mandate becomes tracked, stage-gated work
 * without any position-name branching.
 *
 * Input is a *capability plan* (which kinds of work the goal needs, resolved to seats by
 * `resolveCapabilityAssignments`); output is a plain `WorkflowDefinition`: one task stage per
 * capability in order, then a single root-position approval stage. The plan is also embedded
 * in the instance context (`CAPABILITY_PLAN_CONTEXT_KEY`) so a replayed event log can
 * regenerate the same definition after a restart — definitions are derived state, the plan
 * inside the started-instance event is the durable fact.
 */

export const CAPABILITY_PLAN_CONTEXT_KEY = 'capabilityPlan';

export interface CapabilityPlan {
  readonly capabilities: readonly string[];
  readonly assignments: readonly {
    readonly capability: string;
    readonly matchedPositionId: string;
    readonly positionId: string;
    readonly escalated: boolean;
  }[];
}

export interface CapabilityPlanResult {
  readonly plan: CapabilityPlan | null;
  readonly issues: readonly WorkflowIssue[];
}

/**
 * Resolve requested capabilities against the live organization. `plan === null` means no
 * seat declares any of them — the caller must not start a workflow (empty workflows are
 * exactly the "phantom work" this design avoids).
 *
 * `options.excludeSeatIds` carries the dispatcher rule: the seat that composed this plan hands
 * the work out and is not one of its own assignees (see `CapabilityResolutionOptions`).
 */
export function buildCapabilityPlan(
  organization: Organization,
  capabilities: readonly string[],
  options: CapabilityResolutionOptions = {},
): CapabilityPlanResult {
  const requested = capabilities
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  if (requested.length === 0) {
    return {
      plan: null,
      issues: [workflowIssue('capabilities', 'at least one capability is required')],
    };
  }
  const assignments = resolveCapabilityAssignments(organization, requested, options);
  if (assignments.length === 0) {
    return {
      plan: null,
      issues: [
        workflowIssue(
          'capabilities',
          `no position in this organization declares any of: ${requested.join(', ')}`,
        ),
      ],
    };
  }
  return {
    plan: {
      capabilities: [...requested],
      assignments: assignments.map((assignment) => ({ ...assignment })),
    },
    issues: [],
  };
}

/**
 * Workflow id for a generated definition. Deterministic in `instanceId` so replay rebuilds
 * the same id, and length-capped at 64 (the event-contract limit for ids) via a stable
 * digest fallback.
 */
export function generatedWorkflowId(instanceId: string): string {
  const candidate = `generated-${instanceId}`;
  if (candidate.length <= 64) return candidate;
  let hash = 0x811c9dc5;
  for (const char of instanceId) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `generated-${hash.toString(16).padStart(8, '0')}`;
}

/**
 * Whether an id names a per-instance generated graph rather than an authored template.
 *
 * A generated definition exists to drive the one instance that produced it: its title and goal
 * are that instance's mandate, and its steps are the seats that instance routed to. Starting it
 * again as a "template" would silently replace a new brief's title, goal and routing with the
 * old instance's, so planners must not see it in the template catalogue.
 */
export function isGeneratedWorkflowId(workflowId: string): boolean {
  return workflowId.startsWith('generated-');
}

export interface GenerateWorkflowInput {
  readonly instanceId: string;
  readonly title: string;
  readonly goal: string;
  readonly plan: CapabilityPlan;
  /** Role ids the closing approval accepts — the organization's root position ids. */
  readonly approvalRoles: readonly string[];
}

const APPROVE_STAGE_ID = 'stage-approve';
const APPROVE_STEP_ID = 'step-approve';

/**
 * What a capability stage must actually hand over.
 *
 * The old generated step had `description: null`, so every executor received the whole brief
 * again and answered with prose ("implementation_report"). The task page then showed a workflow
 * with five green reports and no product. Naming the artifact and the proof at the step level is
 * the smallest contract that stops that failure: an implementation is a runnable artifact, a
 * test is evidence against that artifact, not another narrative.
 */
const CAPABILITY_CONTRACT: Readonly<Record<string, {
  readonly instruction: string;
  readonly requiredArtifacts: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}>> = Object.freeze({
  product_requirement: {
    instruction: 'Define the users, scope, roles, workflows and testable acceptance criteria. Deliver a requirement document whose criteria can be checked against the implementation.',
    requiredArtifacts: ['requirements-document'],
    acceptanceCriteria: ['requirements trace to a user-visible behavior', 'each criterion is testable'],
  },
  technical_design: {
    instruction: 'Design the architecture, data model, interfaces and execution flow that satisfy the requirement. Deliver a technical design that an implementer can build from.',
    requiredArtifacts: ['technical-design'],
    acceptanceCriteria: ['the design names the runtime interfaces', 'the design is buildable by the implementation seat'],
  },
  implementation: {
    instruction: 'Build the actual deliverable — code, page or service — that satisfies the requirement. Submission must contain runnable files or code, not a prose implementation report.',
    requiredArtifacts: ['runnable-code-or-page'],
    acceptanceCriteria: ['the artifact loads or runs', 'the required user behavior is present in the artifact'],
  },
  testing: {
    instruction: 'Run the actual delivered artifact and verify the acceptance criteria. Report pass/fail with evidence from the artifact; refuse to verify a document in place of the product.',
    requiredArtifacts: ['test-evidence'],
    acceptanceCriteria: ['the report cites the executed artifact', 'failures are reported, not narrated as success'],
  },
  marketing: {
    instruction: 'Produce the positioning, audience, channels, launch sequence and success metrics for the delivered product.',
    requiredArtifacts: ['marketing-plan'],
    acceptanceCriteria: ['the plan names audience, channels and metrics'],
  },
});

function taskStep(
  stepId: string,
  name: string,
  positionId: string,
  capability: string,
  goal: string,
): WorkflowStep {
  const contract = CAPABILITY_CONTRACT[capability];
  return {
    stepId,
    name,
    kind: 'task',
    // The stage exists *because* of one capability, so the step declares it: the executor's task
    // carries it to the wake-up event, and that is what lets a `backend` step hand back a service
    // while a `frontend` step hands back a page — even when one seat covers both.
    capability,
    description: contract === undefined
      ? null
      : `${contract.instruction}\n\nMandate: ${goal.slice(0, 500)}`.slice(0, 800),
    ...(contract === undefined
      ? {}
      : {
          requiredArtifacts: [...contract.requiredArtifacts],
          acceptanceCriteria: [...contract.acceptanceCriteria],
        }),
    assignment: { kind: 'position', positionId: positionId as PositionId },
    verification: null,
    maxAttempts: 1,
    requiredAuthority: null,
    requiredRoles: [],
    approvalPolicy: 'single',
    requiredCount: 1,
  };
}

function approvalStep(name: string, roles: readonly string[]): WorkflowStep {
  return {
    stepId: APPROVE_STEP_ID,
    name,
    kind: 'approval',
    description: null,
    assignment: null,
    verification: null,
    maxAttempts: 1,
    requiredAuthority: null,
    requiredRoles: [...roles],
    approvalPolicy: 'single',
    requiredCount: 1,
    humanOnly: true,
  };
}

/**
 * Sequential stage-per-capability graph, no cycles by construction:
 *
 *   cap stage 1 → cap stage 2 → … → approval stage → complete
 *        ├ rejected → fail            └ denied → fail
 *        └ failed   → fail
 *
 * `verification: null` means the task's own completion verdict is the step's verdict —
 * generated work is tracked and gated, its outputs are checked by the human observer, not
 * by a hand-written key list.
 */
export function generateWorkflowDefinition(
  input: GenerateWorkflowInput,
): WorkflowDefinition {
  const workflowId = generatedWorkflowId(input.instanceId);
  const stages: WorkflowStage[] = [];

  const stageCount = input.plan.assignments.length;
  for (let index = 0; index < stageCount; index += 1) {
    const assignment = input.plan.assignments[index];
    if (assignment === undefined) continue;
    const stageId = `stage-${index + 1}`;
    const stepId = `step-${index + 1}`;
    const label = capabilityLabel(assignment.capability);
    const nextStageId =
      index + 1 < stageCount ? `stage-${index + 2}` : APPROVE_STAGE_ID;
    stages.push({
      stageId,
      name: label,
      steps: [taskStep(stepId, label, assignment.positionId, assignment.capability, input.goal)],
      transitions: [
        {
          transitionId: `${stageId}__completed`,
          fromStepId: stepId,
          when: { kind: 'task_status', status: 'completed' },
          to: { kind: 'stage', stageId: nextStageId },
        },
        {
          transitionId: `${stageId}__rejected`,
          fromStepId: stepId,
          when: { kind: 'task_status', status: 'rejected' },
          to: { kind: 'fail', reason: `${stageId}_rejected` },
        },
        {
          // A failed task is a different terminal fact than a rejected one; do not route it
          // through the rejected branch. The step is spoken for: the instance aborts with the
          // explicit stage reason, exactly as the rejected branch would, without touching
          // rejected provenance and without an extra retry after `maxAttempts` is reached.
          transitionId: `${stageId}__failed`,
          fromStepId: stepId,
          when: { kind: 'task_status', status: 'failed' },
          to: { kind: 'fail', reason: `${stageId}_failed` },
        },
      ],
    });
  }

  stages.push({
    stageId: APPROVE_STAGE_ID,
    name: 'Approval',
    steps: [approvalStep('Approve generated delivery', input.approvalRoles)],
    transitions: [
      {
        transitionId: `${APPROVE_STAGE_ID}__granted`,
        fromStepId: APPROVE_STEP_ID,
        when: { kind: 'approval_decision', decision: 'granted' },
        to: { kind: 'complete' },
      },
      {
        transitionId: `${APPROVE_STAGE_ID}__denied`,
        fromStepId: APPROVE_STEP_ID,
        when: { kind: 'approval_decision', decision: 'denied' },
        to: { kind: 'fail', reason: 'approval_denied' },
      },
    ],
  });

  return {
    workflowId,
    version: 1,
    name: `Generated: ${input.title}`.slice(0, 200),
    description: input.goal.slice(0, 500),
    cyclePolicy: 'forbid',
    entryStageId: 'stage-1',
    terminalStageIds: [APPROVE_STAGE_ID],
    stages,
  };
}

/** Capability assignments recorded on the instance, for replay + observability. */
export function capabilityPlanContext(plan: CapabilityPlan): Readonly<Record<string, unknown>> {
  return {
    [CAPABILITY_PLAN_CONTEXT_KEY]: {
      capabilities: [...plan.capabilities],
      assignments: plan.assignments.map((assignment) => ({ ...assignment })),
    },
  };
}

function parseCapabilityPlan(raw: unknown): CapabilityPlan | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const capabilities = (raw as { readonly capabilities?: unknown }).capabilities;
  const assignments = (raw as { readonly assignments?: unknown }).assignments;
  if (!Array.isArray(capabilities) || capabilities.length === 0) return null;
  if (!Array.isArray(assignments) || assignments.length === 0) return null;
  const parsed: CapabilityPlan['assignments'][number][] = [];
  for (const entry of assignments) {
    if (typeof entry !== 'object' || entry === null) return null;
    const record = entry as Record<string, unknown>;
    const capability = record['capability'];
    const matchedPositionId = record['matchedPositionId'];
    const positionId = record['positionId'];
    if (
      typeof capability !== 'string' ||
      typeof matchedPositionId !== 'string' ||
      typeof positionId !== 'string'
    ) {
      return null;
    }
    parsed.push({
      capability,
      matchedPositionId,
      positionId,
      escalated: record['escalated'] === true,
    });
  }
  const parsedCapabilities = capabilities.filter(
    (entry): entry is string => typeof entry === 'string' && entry !== '',
  );
  if (parsedCapabilities.length === 0) return null;
  return { capabilities: parsedCapabilities, assignments: parsed };
}

/**
 * Rebuild a generated definition from a replayed instance. Generated definitions are derived
 * state — the durable fact is the capability plan the started-instance event carried in its
 * context, so a fresh boot (empty definition store) can regenerate the exact same graph and
 * the running instance can keep advancing. Returns `null` for template instances (their
 * definitions come from disk) or a malformed plan.
 */
export function regenerateWorkflowDefinition(
  instance: Pick<WorkflowInstance, 'instanceId' | 'title' | 'goal' | 'context'>,
  approvalRoles: readonly string[],
): WorkflowDefinition | null {
  // M3.5 execution instances carry the human-confirmed plan snapshot in their started event.
  // That snapshot is the durable fact; the definition is derived state and must be rebuilt from
  // it after a restart instead of silently falling back to the M3.3 capability graph.
  const executionPlan = parseExecutionPlanSnapshot(instance.context[EXECUTION_PLAN_CONTEXT_KEY]);
  if (executionPlan !== null) {
    return generateExecutionPlanWorkflowDefinition({
      instanceId: instance.instanceId,
      title: instance.title,
      goal: instance.goal,
      plan: executionPlan,
      approvalRoles,
    });
  }
  const plan = parseCapabilityPlan(instance.context[CAPABILITY_PLAN_CONTEXT_KEY]);
  if (plan === null) return null;
  return generateWorkflowDefinition({
    instanceId: instance.instanceId,
    title: instance.title,
    goal: instance.goal,
    plan,
    approvalRoles,
  });
}
