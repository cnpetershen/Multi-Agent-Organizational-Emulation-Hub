import type { EmployeeId } from '@maoeh/shared-types';
import type { WorkflowDefinition, WorkflowStage, WorkflowStep } from './workflow-types.js';

/**
 * M3.5 · materialize a human-confirmed execution plan into the existing workflow engine.
 *
 * This is deliberately a *translation*, not a planner: node order, owners, inputs, outputs,
 * acceptance criteria and the approval gate all come from the confirmed plan. The engine then
 * owns task creation, stage progression, retries and the approval request, so there is no second
 * execution engine and no second task system.
 */

export const EXECUTION_PLAN_CONTEXT_KEY = 'executionPlan';

export interface ExecutionPlanSnapshotNode {
  readonly nodeId: string;
  readonly kind: 'task' | 'approval';
  readonly title: string;
  readonly goal: string;
  readonly capability: string | null;
  readonly employeeId: string | null;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly acceptance: readonly string[];
  readonly dependsOn: readonly string[];
}

export interface ExecutionPlanSnapshot {
  readonly planId: string;
  readonly planVersion: number;
  readonly requirementId: string;
  readonly requirementVersion: number;
  readonly title: string;
  readonly goal: string;
  readonly nodes: readonly ExecutionPlanSnapshotNode[];
  readonly order: readonly string[];
}

export interface GenerateExecutionPlanWorkflowInput {
  readonly instanceId: string;
  readonly title: string;
  readonly goal: string;
  readonly plan: ExecutionPlanSnapshot;
  /** Root-position ids the closing approval accepts. */
  readonly approvalRoles: readonly string[];
}

const APPROVE_STAGE_ID = 'stage-approve';

function listBlock(label: string, values: readonly string[]): string {
  return `${label}:\n${values.map((value) => `- ${value}`).join('\n')}`;
}

function taskDescription(node: ExecutionPlanSnapshotNode): string {
  return [
    `Confirmed plan node: ${node.title}`,
    `Goal: ${node.goal}`,
    listBlock('Inputs', node.inputs),
    listBlock('Required outputs', node.outputs),
    listBlock('Acceptance criteria', node.acceptance),
  ]
    .join('\n\n')
    .slice(0, 4000);
}

function taskStep(
  node: ExecutionPlanSnapshotNode,
  stepId: string,
): WorkflowStep {
  if (node.employeeId === null) {
    throw new Error(`task node "${node.nodeId}" has no employee`);
  }
  return {
    stepId,
    name: node.title.slice(0, 200),
    kind: 'task',
    description: taskDescription(node),
    capability: node.capability,
    requiredArtifacts: [...node.outputs],
    acceptanceCriteria: [...node.acceptance],
    assignment: { kind: 'employee', employeeId: node.employeeId as EmployeeId },
    verification: null,
    maxAttempts: 1,
    requiredAuthority: null,
    requiredRoles: [],
    approvalPolicy: 'single',
    requiredCount: 1,
  };
}

function approvalStep(
  node: ExecutionPlanSnapshotNode,
  stepId: string,
  roles: readonly string[],
): WorkflowStep {
  return {
    stepId,
    name: node.title.slice(0, 200),
    kind: 'approval',
    description: node.goal.slice(0, 800),
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

function orderedNodes(plan: ExecutionPlanSnapshot): ExecutionPlanSnapshotNode[] {
  const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
  const ordered: ExecutionPlanSnapshotNode[] = [];
  for (const nodeId of plan.order) {
    const node = byId.get(nodeId);
    if (node !== undefined && !ordered.includes(node)) ordered.push(node);
  }
  for (const node of plan.nodes) if (!ordered.includes(node)) ordered.push(node);
  return ordered;
}

/**
 * One stage per confirmed node, in the plan's topological order, ending in the plan's approval
 * gate. The engine remains sequential; the plan's DAG has already been projected to this order.
 */
export function generateExecutionPlanWorkflowDefinition(
  input: GenerateExecutionPlanWorkflowInput,
): WorkflowDefinition {
  const nodes = orderedNodes(input.plan);
  if (nodes.length === 0) throw new Error('execution plan has no nodes');
  const hasApproval = nodes.some((node) => node.kind === 'approval');
  const stages: WorkflowStage[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const stageId = `stage-plan-${String(index + 1)}`;
    const stepId = node.nodeId;
    const nextStageId =
      index + 1 < nodes.length
        ? `stage-plan-${String(index + 2)}`
        : hasApproval
          ? null
          : APPROVE_STAGE_ID;
    if (node.kind === 'approval') {
      stages.push({
        stageId,
        name: node.title.slice(0, 200),
        steps: [approvalStep(node, stepId, input.approvalRoles)],
        transitions: [
          {
            transitionId: `${stageId}__granted`,
            fromStepId: stepId,
            when: { kind: 'approval_decision', decision: 'granted' },
            to: nextStageId === null ? { kind: 'complete' as const } : { kind: 'stage' as const, stageId: nextStageId },
          },
          {
            transitionId: `${stageId}__denied`,
            fromStepId: stepId,
            when: { kind: 'approval_decision', decision: 'denied' },
            to: { kind: 'fail' as const, reason: 'approval_denied' },
          },
        ],
      });
      continue;
    }
    stages.push({
      stageId,
      name: node.title.slice(0, 200),
      steps: [taskStep(node, stepId)],
      transitions: [
        {
          transitionId: `${stageId}__completed`,
          fromStepId: stepId,
          when: { kind: 'task_status', status: 'completed' },
          to: nextStageId === null ? { kind: 'complete' as const } : { kind: 'stage' as const, stageId: nextStageId },
        },
        {
          transitionId: `${stageId}__rejected`,
          fromStepId: stepId,
          when: { kind: 'task_status', status: 'rejected' },
          to: { kind: 'fail' as const, reason: `${stageId}_rejected` },
        },
      ],
    });
  }
  // The approval node is normally last (it is the human hand-off). If a plan has no approval,
  // the definition still ends in a real approval stage so M3.6 always receives a decision item.
  if (!hasApproval) {
    stages.push({
      stageId: APPROVE_STAGE_ID,
      name: 'Approval',
      steps: [
        approvalStep(
          {
            nodeId: 'approval-generated',
            kind: 'approval',
            title: 'Approve delivery',
            goal: input.goal,
            capability: null,
            employeeId: null,
            inputs: [],
            outputs: [],
            acceptance: [],
            dependsOn: [],
          },
          'approval-generated',
          input.approvalRoles,
        ),
      ],
      transitions: [
        {
          transitionId: `${APPROVE_STAGE_ID}__granted`,
          fromStepId: 'approval-generated',
          when: { kind: 'approval_decision', decision: 'granted' },
          to: { kind: 'complete' },
        },
        {
          transitionId: `${APPROVE_STAGE_ID}__denied`,
          fromStepId: 'approval-generated',
          when: { kind: 'approval_decision', decision: 'denied' },
          to: { kind: 'fail', reason: 'approval_denied' },
        },
      ],
    });
  }
  const lastStage = stages[stages.length - 1];
  return {
    workflowId: executionWorkflowId(input.instanceId),
    version: 1,
    name: `Execution: ${input.title}`.slice(0, 200),
    description: input.goal.slice(0, 500),
    cyclePolicy: 'forbid',
    entryStageId: stages[0]?.stageId ?? APPROVE_STAGE_ID,
    terminalStageIds: lastStage === undefined ? [] : [lastStage.stageId],
    stages,
  };
}

function executionWorkflowId(instanceId: string): string {
  // Same `generated-` namespace as capability plans: per-instance definitions are not templates
  // and must not appear in the authoring catalogue.
  const candidate = `generated-${instanceId}`;
  if (candidate.length <= 64) return candidate;
  let hash = 0x811c9dc5;
  for (const char of instanceId) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `generated-${hash.toString(16).padStart(8, '0')}`;
}

export function executionPlanContext(
  plan: ExecutionPlanSnapshot,
): Readonly<Record<string, unknown>> {
  return {
    [EXECUTION_PLAN_CONTEXT_KEY]: {
      planId: plan.planId,
      planVersion: plan.planVersion,
      requirementId: plan.requirementId,
      requirementVersion: plan.requirementVersion,
      title: plan.title,
      goal: plan.goal,
      nodes: plan.nodes.map((node) => ({ ...node, inputs: [...node.inputs], outputs: [...node.outputs], acceptance: [...node.acceptance], dependsOn: [...node.dependsOn] })),
      order: [...plan.order],
    },
  };
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    result.push(entry);
  }
  return result;
}

export function parseExecutionPlanSnapshot(raw: unknown): ExecutionPlanSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (
    typeof record['planId'] !== 'string' ||
    typeof record['planVersion'] !== 'number' ||
    typeof record['requirementId'] !== 'string' ||
    typeof record['requirementVersion'] !== 'number' ||
    typeof record['title'] !== 'string' ||
    typeof record['goal'] !== 'string' ||
    !Array.isArray(record['nodes']) ||
    !Array.isArray(record['order'])
  ) {
    return null;
  }
  const nodes: ExecutionPlanSnapshotNode[] = [];
  for (const entry of record['nodes'] as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const node = entry as Record<string, unknown>;
    const inputs = readStringArray(node['inputs']);
    const outputs = readStringArray(node['outputs']);
    const acceptance = readStringArray(node['acceptance']);
    const dependsOn = readStringArray(node['dependsOn']);
    if (
      typeof node['nodeId'] !== 'string' ||
      (node['kind'] !== 'task' && node['kind'] !== 'approval') ||
      typeof node['title'] !== 'string' ||
      typeof node['goal'] !== 'string' ||
      (node['capability'] !== null && typeof node['capability'] !== 'string') ||
      (node['employeeId'] !== null && typeof node['employeeId'] !== 'string') ||
      inputs === null ||
      outputs === null ||
      acceptance === null ||
      dependsOn === null
    ) {
      return null;
    }
    nodes.push({
      nodeId: node['nodeId'],
      kind: node['kind'],
      title: node['title'],
      goal: node['goal'],
      capability: node['capability'] as string | null,
      employeeId: node['employeeId'] as string | null,
      inputs,
      outputs,
      acceptance,
      dependsOn,
    });
  }
  const order = readStringArray(record['order']);
  return {
    planId: record['planId'],
    planVersion: record['planVersion'],
    requirementId: record['requirementId'],
    requirementVersion: record['requirementVersion'],
    title: record['title'],
    goal: record['goal'],
    nodes,
    order: order ?? [],
  };
}

export function regenerateExecutionPlanWorkflowDefinition(
  instance: { readonly instanceId: string; readonly title: string; readonly goal: string; readonly context: Readonly<Record<string, unknown>> },
  approvalRoles: readonly string[],
): WorkflowDefinition | null {
  const plan = parseExecutionPlanSnapshot(instance.context[EXECUTION_PLAN_CONTEXT_KEY]);
  if (plan === null) return null;
  return generateExecutionPlanWorkflowDefinition({
    instanceId: instance.instanceId,
    title: instance.title,
    goal: instance.goal,
    plan,
    approvalRoles,
  });
}
