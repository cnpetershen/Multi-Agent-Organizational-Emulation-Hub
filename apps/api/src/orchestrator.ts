import type { Organization } from '@maoeh/organization-model';
import {
  capabilityLabel,
  isExecutableEmployment,
  resolveCapabilityAssignments,
} from '@maoeh/organization-model';
import {
  OrchestrationDraftSchema,
  type OrchestrationConflict,
  type OrchestrationDraft,
  type OrchestrationNode,
  type RequirementPlan,
} from './planning-types.js';

/**
 * M3.3 · 智能体编排（纯函数）。
 *
 * Input: a **confirmed** requirement plan + the real organization. Output: an editable draft with
 * nodes, real employee owners, inputs/outputs, acceptance criteria, dependencies and the
 * conflicts the organization cannot resolve by itself.
 *
 * Deliberately deterministic. Every assignment is derived from the same capability resolution the
 * workflow engine uses (`resolveCapabilityAssignments` + the seat's real employee); no model is
 * asked to invent a person or a capability. If a capability has no seat, the node is unassigned and
 * the plan is `blocked` — it is never quietly handed to someone who cannot do it.
 */

const CAPABILITY_ORDER: Readonly<Record<string, number>> = Object.freeze({
  product_requirement: 10,
  technical_design: 20,
  backend: 31,
  frontend: 32,
  implementation: 35,
  testing: 40,
  marketing: 50,
  release: 60,
});

const DELIVERABLE_BY_CAPABILITY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  product_requirement: ['需求说明书'],
  technical_design: ['技术设计文档'],
  implementation: ['可运行交付物'],
  frontend: ['前端页面或交互'],
  backend: ['后端服务或接口'],
  testing: ['验收报告与证据'],
  marketing: ['定位、受众、渠道与发布计划'],
  release: ['可发布版本与发布说明'],
});

const ACCEPTANCE_BY_CAPABILITY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  product_requirement: ['需求范围、交付物与验收标准已由人类确认。'],
  technical_design: ['设计覆盖需求中的每个交付物，并说明接口、数据与运行方式。'],
  implementation: ['交付物可实际运行，不是实现报告或占位文本。'],
  frontend: ['页面可打开、关键交互可用，并与设计一致。'],
  backend: ['接口可调用、数据持久化可用，并说明依赖与启动方式。'],
  testing: ['对真实交付物执行检查，给出通过/失败与证据。'],
  marketing: ['定位、受众、渠道与发布节奏可直接执行。'],
  release: ['发布包、版本号与回滚说明齐全。'],
});

const IMPLEMENTATION_CAPABILITIES = new Set(['implementation', 'frontend', 'backend']);

function rankOf(capability: string): number {
  return CAPABILITY_ORDER[capability] ?? 90;
}

function orderedCapabilities(plan: RequirementPlan): string[] {
  const seen = new Set<string>();
  const capabilities: { capability: string; index: number }[] = [];
  for (const raw of plan.requiredCapabilities) {
    const capability = raw.trim().toLowerCase();
    if (capability === '' || seen.has(capability)) continue;
    seen.add(capability);
    capabilities.push({ capability, index: capabilities.length });
  }
  return capabilities
    .sort((left, right) => rankOf(left.capability) - rankOf(right.capability) || left.index - right.index)
    .map((entry) => entry.capability);
}

export interface OrchestrationBuildInput {
  readonly orchestrationId: string;
  readonly version: number;
  readonly requirement: RequirementPlan;
  readonly organization: Organization;
  readonly now: string;
}

function findEmployeeFor(
  organization: Organization,
  capability: string,
): { employeeId: string; positionId: string } | null {
  const assignment = resolveCapabilityAssignments(organization, [capability])[0];
  if (assignment === undefined) return null;
  const employee = organization.employees.find(
    (candidate) =>
      isExecutableEmployment(candidate.status) &&
      (String(candidate.positionId) === assignment.positionId ||
        String(candidate.positionId) === assignment.matchedPositionId),
  );
  if (employee === undefined) return null;
  return { employeeId: String(employee.id), positionId: String(employee.positionId) };
}

/**
 * Capability dependency categories. The graph is a DAG by construction:
 *
 *   requirement → design → implementation(s) → testing → release
 *                     └──→ marketing ──────────────┘
 *   everything task-like → approval (human gate)
 */
function dependenciesFor(
  capability: string,
  nodes: readonly { readonly nodeId: string; readonly capability: string | null }[],
): string[] {
  const byCapability = (targets: readonly string[]): string[] =>
    nodes
      .filter((node) => node.capability !== null && targets.includes(node.capability))
      .map((node) => node.nodeId);
  if (capability === 'product_requirement') return [];
  if (capability === 'technical_design') return byCapability(['product_requirement']);
  if (IMPLEMENTATION_CAPABILITIES.has(capability)) {
    return byCapability(['product_requirement', 'technical_design', ...IMPLEMENTATION_CAPABILITIES]);
  }
  if (capability === 'testing') {
    return byCapability([...IMPLEMENTATION_CAPABILITIES, 'product_requirement', 'technical_design']);
  }
  if (capability === 'marketing') {
    return byCapability(['product_requirement', 'technical_design']);
  }
  if (capability === 'release') {
    return byCapability(['testing', 'marketing', ...IMPLEMENTATION_CAPABILITIES]);
  }
  // Unknown capability: it can only depend on what already exists, keeping the graph acyclic.
  return nodes.map((node) => node.nodeId);
}

function topologicalOrder(
  nodes: readonly OrchestrationNode[],
): { readonly order: readonly string[]; readonly cycle: boolean } {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const remaining = new Set(byId.keys());
  const order: string[] = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const node of nodes) {
      if (!remaining.has(node.nodeId)) continue;
      if (node.dependsOn.every((dependency) => !remaining.has(dependency))) {
        remaining.delete(node.nodeId);
        order.push(node.nodeId);
        progressed = true;
        break;
      }
    }
    if (!progressed) return { order: [], cycle: true };
  }
  return { order, cycle: false };
}

export function buildOrchestrationDraft(input: OrchestrationBuildInput): OrchestrationDraft {
  const { requirement, organization } = input;
  const conflicts: OrchestrationConflict[] = [];
  const missingCapabilities: string[] = [];
  const capabilities = orderedCapabilities(requirement);

  if (requirement.status !== 'confirmed') {
    conflicts.push({
      code: 'missing_acceptance',
      severity: 'blocking',
      detail: `需求 v${String(requirement.version)} 尚未确认，不能进入编排。`,
      nodeIds: [],
    });
  }
  if (requirement.deliverables.length === 0) {
    conflicts.push({
      code: 'missing_deliverable',
      severity: 'blocking',
      detail: '需求没有交付物，无法建立任务节点。',
      nodeIds: [],
    });
  }
  if (requirement.acceptanceCriteria.length === 0) {
    conflicts.push({
      code: 'missing_acceptance',
      severity: 'blocking',
      detail: '需求没有验收标准，任务无法被判定完成。',
      nodeIds: [],
    });
  }
  if (capabilities.length === 0) {
    conflicts.push({
      code: 'missing_capability',
      severity: 'blocking',
      detail: '需求没有声明所需能力，无法选择真实员工。',
      nodeIds: [],
    });
  }

  const nodes: OrchestrationNode[] = [];
  const assignments = new Map<string, { employeeId: string; positionId: string }>();
  for (const capability of capabilities) {
    const assignment = findEmployeeFor(organization, capability);
    if (assignment === null) missingCapabilities.push(capability);
    if (assignment !== null) assignments.set(capability, assignment);
    const nodeId = `node-${String(nodes.length + 1)}`;
    const dependsOn = dependenciesFor(capability, nodes);
    nodes.push({
      nodeId,
      kind: 'task',
      title: capabilityLabel(capability),
      capability,
      employeeId: assignment === null ? null : assignment.employeeId,
      positionId: assignment === null ? null : assignment.positionId,
      inputs:
        dependsOn.length === 0
          ? [`已确认需求 v${String(requirement.version)}`]
          : dependsOn.flatMap((dependency) => {
              const node = nodes.find((candidate) => candidate.nodeId === dependency);
              return node === undefined ? [] : node.outputs;
            }),
      outputs: [...(DELIVERABLE_BY_CAPABILITY[capability] ?? [`${capability} 交付物`])],
      acceptance: [
        ...(ACCEPTANCE_BY_CAPABILITY[capability] ?? [`${capabilityLabel(capability)} 的结果符合已确认需求。`]),
        ...requirement.acceptanceCriteria,
      ].slice(0, 20),
      dependsOn,
      order: nodes.length,
      status: assignment === null ? 'unassigned' : 'planned',
    });
  }

  // The real organization can only carry what it has a seat for. Report each gap explicitly.
  for (const capability of missingCapabilities) {
    const node = nodes.find((candidate) => candidate.capability === capability);
    conflicts.push({
      code: 'missing_capability',
      severity: 'blocking',
      detail: `组织中没有可执行「${capabilityLabel(capability)}」的 AI 员工（能力 ${capability} 无可用席位）。`,
      nodeIds: node === undefined ? [] : [node.nodeId],
    });
  }
  for (const node of nodes.filter((candidate) => candidate.status === 'unassigned')) {
    conflicts.push({
      code: 'unassigned_task',
      severity: 'blocking',
      detail: `任务「${node.title}」没有负责人；不得静默分配给不具备能力的员工。`,
      nodeIds: [node.nodeId],
    });
  }

  const employeeUse = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.employeeId === null) continue;
    const list = employeeUse.get(node.employeeId) ?? [];
    list.push(node.nodeId);
    employeeUse.set(node.employeeId, list);
  }
  for (const [employeeId, nodeIds] of employeeUse) {
    if (nodeIds.length <= 1) continue;
    conflicts.push({
      code: 'resource_contention',
      severity: 'warning',
      detail: `员工 ${employeeId} 承担 ${String(nodeIds.length)} 个节点；执行顺序已串行化，但存在排队风险。`,
      nodeIds,
    });
  }

  const approvalDependsOn = nodes.map((node) => node.nodeId);
  const approvalNode: OrchestrationNode = {
    nodeId: 'node-approve',
    kind: 'approval',
    title: '人类审批',
    capability: null,
    employeeId: null,
    positionId: null,
    inputs: nodes.flatMap((node) => node.outputs),
    outputs: ['审批决定'],
    acceptance: ['人类明确确认画布与交付物后才允许进入任务实施。'],
    dependsOn: approvalDependsOn,
    order: nodes.length,
    status: 'human-gate',
  };
  nodes.push(approvalNode);

  const topo = topologicalOrder(nodes);
  if (topo.cycle) {
    conflicts.push({
      code: 'dependency_cycle',
      severity: 'blocking',
      detail: '任务依赖出现环，无法确定执行顺序。',
      nodeIds: nodes.map((node) => node.nodeId),
    });
  }

  const blocking = conflicts.some((conflict) => conflict.severity === 'blocking');
  const status = blocking || missingCapabilities.length > 0 ? 'blocked' : 'ready';
  const employees = [
    ...new Set(nodes.flatMap((node) => (node.employeeId === null ? [] : [node.employeeId]))),
  ];

  return OrchestrationDraftSchema.parse({
    orchestrationId: input.orchestrationId,
    companyId: String(organization.company.id),
    version: input.version,
    status,
    requirementId: requirement.requirementId,
    requirementVersion: requirement.version,
    title: requirement.title,
    goal: requirement.source.goal,
    nodes,
    order: topo.cycle ? nodes.map((node) => node.nodeId) : topo.order,
    conflicts,
    missingCapabilities,
    unassignedNodeIds: nodes
      .filter((node) => node.kind === 'task' && node.status === 'unassigned')
      .map((node) => node.nodeId),
    basis: {
      requirementId: requirement.requirementId,
      requirementVersion: requirement.version,
      capabilities,
      employees,
      rule: 'capability-seat-employee/1 + explicit DAG + human approval gate',
    },
    workflowInstanceId: null,
    workflowId: null,
    workflowVersion: null,
    createdAt: input.now,
    updatedAt: input.now,
  });
}
