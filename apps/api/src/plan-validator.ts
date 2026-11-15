import type { Organization } from '@maoeh/organization-model';
import { isExecutableEmployment } from '@maoeh/organization-model';
import type {
  PlanIssue,
  PlanNode,
  PlanValidation,
} from './planning-types.js';

/**
 * M3.4 · execution-plan validation.
 *
 * A plan may be saved while invalid (a human is mid-edit), but it may not be **confirmed** until
 * this function reports no blocking issue. The rules are the ones the milestone names:
 * structure, real employee capability, dependencies and completeness.
 *
 * The same function computes the topological order, so "execution order" is always derived from
 * the DAG instead of being a second, hand-maintained field.
 */

export interface PlanValidationInput {
  readonly nodes: readonly PlanNode[];
  readonly organization: Organization;
  readonly workflowInstanceId: string | null;
}

function capabilitiesOf(organization: Organization, employeeId: string): readonly string[] {
  const employee = organization.employees.find((entry) => String(entry.id) === employeeId);
  if (employee === undefined) return [];
  const position = organization.positions.find(
    (entry) => String(entry.id) === String(employee.positionId),
  );
  return [
    ...(position?.capabilities ?? []),
    ...(employee.expertise ?? []),
  ];
}

function employeeIsExecutable(organization: Organization, employeeId: string): boolean {
  const employee = organization.employees.find((entry) => String(entry.id) === employeeId);
  return employee !== undefined && isExecutableEmployment(employee.status);
}

function issue(
  code: PlanIssue['code'],
  severity: PlanIssue['severity'],
  detail: string,
  nodeIds: readonly string[],
): PlanIssue {
  return { code, severity, detail, nodeIds: [...nodeIds] };
}

function topological(
  nodes: readonly PlanNode[],
): { readonly order: string[]; readonly cycle: string[] } {
  const ids = new Set(nodes.map((node) => node.nodeId));
  const remaining = new Set(ids);
  const order: string[] = [];
  while (remaining.size > 0) {
    let progressed = false;
    for (const node of nodes) {
      if (!remaining.has(node.nodeId)) continue;
      const deps = node.dependsOn.filter((dependency) => ids.has(dependency));
      if (deps.every((dependency) => !remaining.has(dependency))) {
        remaining.delete(node.nodeId);
        order.push(node.nodeId);
        progressed = true;
        break;
      }
    }
    if (!progressed) break;
  }
  return { order, cycle: [...remaining] };
}

/** `true` when `from` is reachable from `to` through `dependsOn` (or is the same node). */
function reaches(
  nodes: ReadonlyMap<string, PlanNode>,
  from: string,
  to: string,
  seen: Set<string> = new Set(),
): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const node = nodes.get(from);
  if (node === undefined) return false;
  return node.dependsOn.some((dependency) => reaches(nodes, dependency, to, seen));
}

export function validatePlan(input: PlanValidationInput): PlanValidation {
  const issues: PlanIssue[] = [];
  const nodeIds = input.nodes.map((node) => node.nodeId);
  const known = new Set(nodeIds);
  const byId = new Map(input.nodes.map((node) => [node.nodeId, node]));
  const missingCapabilities = new Set<string>();
  const unassigned: string[] = [];

  if (input.workflowInstanceId === null) {
    issues.push(
      issue(
        'missing_workflow_draft',
        'blocking',
        '没有关联的 M3.3 画布草案实例；M3.5 无法读取并启动任务。',
        [],
      ),
    );
  }

  for (const node of input.nodes) {
    if (node.title.trim() === '') issues.push(issue('missing_title', 'blocking', '任务缺少名称。', [node.nodeId]));
    if (node.goal.trim() === '') issues.push(issue('missing_goal', 'blocking', '任务缺少目标。', [node.nodeId]));
    if (node.inputs.length === 0) issues.push(issue('missing_input', 'blocking', '任务缺少输入。', [node.nodeId]));
    if (node.outputs.length === 0) issues.push(issue('missing_output', 'blocking', '任务缺少输出。', [node.nodeId]));
    if (node.acceptance.length === 0) {
      issues.push(issue('missing_acceptance', 'blocking', '任务缺少验收标准。', [node.nodeId]));
    }
    for (const dependency of node.dependsOn) {
      if (!known.has(dependency)) {
        issues.push(
          issue('unknown_dependency', 'blocking', `依赖的任务不存在：${dependency}。`, [node.nodeId]),
        );
      }
      if (dependency === node.nodeId) {
        issues.push(issue('self_dependency', 'blocking', '任务不能依赖自己。', [node.nodeId]));
      }
    }

    if (node.kind === 'task') {
      if (node.employeeId === null) {
        unassigned.push(node.nodeId);
        issues.push(issue('missing_employee', 'blocking', '任务没有负责人。', [node.nodeId]));
        continue;
      }
      if (!employeeIsExecutable(input.organization, node.employeeId)) {
        unassigned.push(node.nodeId);
        issues.push(issue('missing_employee', 'blocking', '负责人不是可执行员工。', [node.nodeId]));
        continue;
      }
      if (node.capability !== null) {
        const capabilities = capabilitiesOf(input.organization, node.employeeId);
        if (!capabilities.includes(node.capability)) {
          missingCapabilities.add(node.capability);
          issues.push(
            issue(
              'employee_not_capable',
              'blocking',
              `负责人不具备任务所需能力：${node.capability}。`,
              [node.nodeId],
            ),
          );
        }
      }
    }
  }

  const topo = topological(input.nodes);
  if (topo.cycle.length > 0) {
    issues.push(
      issue(
        'dependency_cycle',
        'blocking',
        `依赖存在循环：${topo.cycle.join('、')}。`,
        topo.cycle,
      ),
    );
  }

  // Resource conflict: the same employee on two nodes with no dependency path between them.
  const taskNodes = input.nodes.filter((node) => node.kind === 'task' && node.employeeId !== null);
  for (let left = 0; left < taskNodes.length; left += 1) {
    for (let right = left + 1; right < taskNodes.length; right += 1) {
      const a = taskNodes[left];
      const b = taskNodes[right];
      if (a === undefined || b === undefined) continue;
      if (a.employeeId !== b.employeeId) continue;
      const comparable = reaches(byId, a.nodeId, b.nodeId) || reaches(byId, b.nodeId, a.nodeId);
      if (comparable) continue;
      issues.push(
        issue(
          'employee_conflict',
          'warning',
          '同一员工被安排到两个没有先后依赖的任务；执行会排队，存在资源争用。',
          [a.nodeId, b.nodeId],
        ),
      );
    }
  }

  const blocking = issues.filter((entry) => entry.severity === 'blocking').length;
  const warnings = issues.filter((entry) => entry.severity === 'warning').length;
  return {
    ok: blocking === 0,
    blockingCount: blocking,
    warningCount: warnings,
    issues,
    cycleNodeIds: topo.cycle,
    missingCapabilities: [...missingCapabilities],
    unassignedNodeIds: unassigned,
  };
}

export function topologicalOrderOf(nodes: readonly PlanNode[]): readonly string[] {
  return topological(nodes).order;
}
