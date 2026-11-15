import { readNumber, readString, type Row } from './api';

/**
 * M3.4 · the execution-plan read model and canvas geometry.
 *
 * The plan document is the editable truth for the canvas; the workflow instance is what M3.5
 * will read after confirmation. Layout is derived from the DAG (depth = longest dependency
 * chain), so dragging a node never changes the execution order — only the view position does.
 */

export type PlanStatus = 'draft' | 'confirmed';

export interface PlanNodeView {
  readonly nodeId: string;
  readonly kind: 'task' | 'approval';
  readonly title: string;
  readonly goal: string;
  readonly capability: string | null;
  readonly employeeId: string | null;
  readonly positionId: string | null;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly acceptance: readonly string[];
  readonly dependsOn: readonly string[];
}

export interface PlanIssueView {
  readonly code: string;
  readonly severity: 'blocking' | 'warning';
  readonly detail: string;
  readonly nodeIds: readonly string[];
}

export interface PlanValidationView {
  readonly ok: boolean;
  readonly blockingCount: number;
  readonly warningCount: number;
  readonly issues: readonly PlanIssueView[];
  readonly cycleNodeIds: readonly string[];
  readonly missingCapabilities: readonly string[];
  readonly unassignedNodeIds: readonly string[];
}

export interface PlanView {
  readonly planId: string;
  readonly companyId: string;
  readonly version: number;
  readonly status: PlanStatus;
  readonly orchestrationId: string;
  readonly orchestrationVersion: number;
  readonly requirementId: string;
  readonly requirementVersion: number;
  readonly title: string;
  readonly goal: string;
  readonly nodes: readonly PlanNodeView[];
  readonly order: readonly string[];
  readonly validation: PlanValidationView;
  readonly summary: {
    readonly nodeCount: number;
    readonly taskCount: number;
    readonly employeeCount: number;
    readonly capabilities: readonly string[];
    readonly deliverables: readonly string[];
    readonly workflowInstanceId: string | null;
  };
  readonly change: {
    readonly fromVersion: number;
    readonly renamed: number;
    readonly reassigned: number;
    readonly dependenciesChanged: number;
    readonly contentChanged: number;
  } | null;
  readonly workflowInstanceId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAt: string | null;
  readonly confirmedBy: string | null;
  readonly confirmationNote: string | null;
}

export interface PlanRecordView {
  readonly planId: string;
  readonly companyId: string;
  readonly currentVersion: number;
  readonly versions: readonly PlanView[];
}

export interface PlanSummaryView {
  readonly planId: string;
  readonly title: string;
  readonly status: PlanStatus;
  readonly version: number;
  readonly workflowInstanceId: string | null;
  readonly updatedAt: string;
  readonly confirmedAt: string | null;
  readonly blockingCount: number;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as readonly unknown[]).map((entry) => readString(entry, '')).filter((entry) => entry !== '')
    : [];
}

function objectOf(value: unknown): Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : {};
}

export function parsePlanNode(value: unknown): PlanNodeView {
  const row = objectOf(value);
  return {
    nodeId: readString(row['nodeId'], ''),
    kind: row['kind'] === 'approval' ? 'approval' : 'task',
    title: readString(row['title'], ''),
    goal: readString(row['goal'], ''),
    capability: typeof row['capability'] === 'string' ? row['capability'] : null,
    employeeId: typeof row['employeeId'] === 'string' ? row['employeeId'] : null,
    positionId: typeof row['positionId'] === 'string' ? row['positionId'] : null,
    inputs: strings(row['inputs']),
    outputs: strings(row['outputs']),
    acceptance: strings(row['acceptance']),
    dependsOn: strings(row['dependsOn']),
  };
}

export function parsePlan(value: unknown): PlanView {
  const row = objectOf(value);
  const validation = objectOf(row['validation']);
  const summary = objectOf(row['summary']);
  const change = objectOf(row['change']);
  const nodes = Array.isArray(row['nodes'])
    ? (row['nodes'] as readonly unknown[]).map(parsePlanNode).filter((node) => node.nodeId !== '')
    : [];
  return {
    planId: readString(row['planId'], ''),
    companyId: readString(row['companyId'], ''),
    version: readNumber(row['version'], 1),
    status: row['status'] === 'confirmed' ? 'confirmed' : 'draft',
    orchestrationId: readString(row['orchestrationId'], ''),
    orchestrationVersion: readNumber(row['orchestrationVersion'], 1),
    requirementId: readString(row['requirementId'], ''),
    requirementVersion: readNumber(row['requirementVersion'], 1),
    title: readString(row['title'], ''),
    goal: readString(row['goal'], ''),
    nodes,
    order: strings(row['order']),
    validation: {
      ok: validation['ok'] === true,
      blockingCount: readNumber(validation['blockingCount'], 0),
      warningCount: readNumber(validation['warningCount'], 0),
      issues: Array.isArray(validation['issues'])
        ? (validation['issues'] as readonly unknown[]).map((entry) => {
            const issue = objectOf(entry);
            return {
              code: readString(issue['code'], ''),
              severity: issue['severity'] === 'blocking' ? ('blocking' as const) : ('warning' as const),
              detail: readString(issue['detail'], ''),
              nodeIds: strings(issue['nodeIds']),
            };
          })
        : [],
      cycleNodeIds: strings(validation['cycleNodeIds']),
      missingCapabilities: strings(validation['missingCapabilities']),
      unassignedNodeIds: strings(validation['unassignedNodeIds']),
    },
    summary: {
      nodeCount: readNumber(summary['nodeCount'], nodes.length),
      taskCount: readNumber(summary['taskCount'], nodes.filter((node) => node.kind === 'task').length),
      employeeCount: readNumber(summary['employeeCount'], 0),
      capabilities: strings(summary['capabilities']),
      deliverables: strings(summary['deliverables']),
      workflowInstanceId:
        typeof summary['workflowInstanceId'] === 'string' ? summary['workflowInstanceId'] : null,
    },
    change:
      row['change'] === null || row['change'] === undefined
        ? null
        : {
            fromVersion: readNumber(change['fromVersion'], 1),
            renamed: readNumber(change['renamed'], 0),
            reassigned: readNumber(change['reassigned'], 0),
            dependenciesChanged: readNumber(change['dependenciesChanged'], 0),
            contentChanged: readNumber(change['contentChanged'], 0),
          },
    workflowInstanceId: typeof row['workflowInstanceId'] === 'string' ? row['workflowInstanceId'] : null,
    createdAt: readString(row['createdAt'], ''),
    updatedAt: readString(row['updatedAt'], ''),
    confirmedAt: typeof row['confirmedAt'] === 'string' ? row['confirmedAt'] : null,
    confirmedBy: typeof row['confirmedBy'] === 'string' ? row['confirmedBy'] : null,
    confirmationNote: typeof row['confirmationNote'] === 'string' ? row['confirmationNote'] : null,
  };
}

export function parsePlanRecord(value: unknown): PlanRecordView {
  const row = objectOf(value);
  const versions = Array.isArray(row['versions'])
    ? (row['versions'] as readonly unknown[]).map(parsePlan).filter((plan) => plan.planId !== '')
    : [];
  return {
    planId: readString(row['planId'], ''),
    companyId: readString(row['companyId'], ''),
    currentVersion: readNumber(row['currentVersion'], versions.at(-1)?.version ?? 1),
    versions,
  };
}

export function parsePlanList(value: unknown): PlanSummaryView[] {
  const row = objectOf(value);
  const list = Array.isArray(value)
    ? (value as readonly unknown[])
    : Array.isArray(row['plans'])
      ? (row['plans'] as readonly unknown[])
      : [];
  return list.map((entry) => {
    const plan = objectOf(entry);
    return {
      planId: readString(plan['planId'], ''),
      title: readString(plan['title'], ''),
      status: plan['status'] === 'confirmed' ? 'confirmed' : 'draft',
      version: readNumber(plan['version'], 1),
      workflowInstanceId:
        typeof plan['workflowInstanceId'] === 'string' ? plan['workflowInstanceId'] : null,
      updatedAt: readString(plan['updatedAt'], ''),
      confirmedAt: typeof plan['confirmedAt'] === 'string' ? plan['confirmedAt'] : null,
      blockingCount: readNumber(plan['blockingCount'], 0),
    };
  });
}

// -------------------------------------------------------------------------------------------------
// Canvas geometry
// -------------------------------------------------------------------------------------------------

export interface PlanNodeBox {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PlanEdge {
  readonly from: string;
  readonly to: string;
  readonly cycle: boolean;
}

export interface PlanLayout {
  readonly boxes: ReadonlyMap<string, PlanNodeBox>;
  readonly edges: readonly PlanEdge[];
  readonly width: number;
  readonly height: number;
  readonly layers: ReadonlyMap<string, number>;
}

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 100;
const H_GAP = 36;
const V_GAP = 40;

function cycleIds(plan: PlanView): ReadonlySet<string> {
  const ids = new Set(plan.nodes.map((node) => node.nodeId));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles = new Set<string>();
  const visit = (id: string): void => {
    const current = state.get(id) ?? 0;
    if (current === 1) {
      const start = stack.indexOf(id);
      if (start >= 0) for (const nodeId of stack.slice(start)) cycles.add(nodeId);
      return;
    }
    if (current === 2) return;
    state.set(id, 1);
    stack.push(id);
    const node = plan.nodes.find((entry) => entry.nodeId === id);
    for (const dependency of node?.dependsOn ?? []) {
      if (ids.has(dependency)) visit(dependency);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const node of plan.nodes) visit(node.nodeId);
  return cycles;
}

function depthOf(
  id: string,
  byId: ReadonlyMap<string, PlanNodeView>,
  memo: Map<string, number>,
  seen: Set<string>,
): number {
  const cached = memo.get(id);
  if (cached !== undefined) return cached;
  if (seen.has(id)) return 0;
  seen.add(id);
  const node = byId.get(id);
  const depth =
    node === undefined || node.dependsOn.length === 0
      ? 0
      : 1 + Math.max(...node.dependsOn.map((dependency) => depthOf(dependency, byId, memo, seen)));
  seen.delete(id);
  memo.set(id, depth);
  return depth;
}

/** Layered DAG layout: x by longest dependency chain, y inside the layer. */
export function layoutPlan(plan: PlanView): PlanLayout {
  const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
  const memo = new Map<string, number>();
  const depths = new Map<string, number>();
  for (const node of plan.nodes) {
    depths.set(node.nodeId, depthOf(node.nodeId, byId, memo, new Set()));
  }
  const layers = new Map<number, PlanNodeView[]>();
  for (const node of plan.nodes) {
    const depth = depths.get(node.nodeId) ?? 0;
    const list = layers.get(depth) ?? [];
    list.push(node);
    layers.set(depth, list);
  }
  const boxes = new Map<string, PlanNodeBox>();
  let maxRows = 1;
  for (const [depth, list] of layers) {
    maxRows = Math.max(maxRows, list.length);
    list.forEach((node, index) => {
      boxes.set(node.nodeId, {
        nodeId: node.nodeId,
        x: 48 + depth * (NODE_WIDTH + H_GAP),
        y: 36 + index * (NODE_HEIGHT + V_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    });
  }
  const cycles = cycleIds(plan);
  const edges: PlanEdge[] = [];
  for (const node of plan.nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) continue;
      edges.push({
        from: dependency,
        to: node.nodeId,
        cycle: cycles.has(dependency) && cycles.has(node.nodeId),
      });
    }
  }
  const maxDepth = Math.max(0, ...[...layers.keys()]);
  return {
    boxes,
    edges,
    width: 48 * 2 + (maxDepth + 1) * NODE_WIDTH + maxDepth * H_GAP,
    height: 36 * 2 + maxRows * NODE_HEIGHT + (maxRows - 1) * V_GAP,
    layers: new Map([...depths.entries()]),
  };
}

export function planStatusTone(status: PlanStatus): 'ok' | 'warn' {
  return status === 'confirmed' ? 'ok' : 'warn';
}

export function changeSummaryText(change: PlanView['change']): readonly string[] {
  if (change === null) return [];
  return [
    `${'renamed'}:${String(change.renamed)}`,
    `${'reassigned'}:${String(change.reassigned)}`,
    `${'dependencies'}:${String(change.dependenciesChanged)}`,
    `${'content'}:${String(change.contentChanged)}`,
  ];
}
