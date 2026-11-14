import { readBoolean, readNumber, readString, type Row, type Snapshot } from './api';
import { isOpenApproval, positionTitle, stepProgress } from './derive';

/**
 * The company as a network — the pure model behind the Network canvas.
 *
 * The console already has a *list* view of every entity (Agents, Workflows, Deliverables) and a
 * per-instance *flow* view (Canvas). What it did not have is the one picture that answers "how is
 * this company wired right now": who reports to whom, which workflow is running on which seat,
 * and which deliveries came out of which branch.
 *
 * Three rules, matching `results.ts`/`results`-style presentation models:
 *
 * - **Pure.** No React, no DOM, no fetch, no clock. Layout is a deterministic function of the
 *   read models, so the same snapshot always draws the same network and the whole thing is unit
 *   testable without a browser.
 * - **No invented facts.** A workflow with no resolvable initiatedBy or assignee simply has no
 *   `runs` edge; an agent with no manager has no `reports` edge. The layout never invents a node
 *   to make the picture look busier.
 * - **Bounded.** The graph is a *summary*, not a dump: it shows the active branches and the most
 *   recent deliveries, and reports how many it held back so the page can say so out loud.
 */

/* --- Coordinates ---------------------------------------------------------- */

/** The canvas is laid out in a fixed coordinate space and scaled by CSS, so tests can pin it. */
export const NETWORK_WIDTH = 1000;
export const NETWORK_HEIGHT = 640;

const CENTER = Object.freeze({ x: NETWORK_WIDTH / 2, y: NETWORK_HEIGHT / 2 });
const AGENT_COLUMN_X = 128;
const AGENT_TOP = 70;
const AGENT_BOTTOM = 550;
const WORKFLOW_COLUMN_X = 892;
const WORKFLOW_DENSE_LEFT_X = 742;
const WORKFLOW_DENSE_RIGHT_X = 892;
const WORKFLOW_TOP = 92;
const WORKFLOW_BOTTOM = 540;
const DELIVERABLE_ROW_Y = 586;
const DELIVERABLE_LEFT_X = 270;
const DELIVERABLE_RIGHT_X = 930;

export interface NetworkPoint {
  readonly x: number;
  readonly y: number;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Evenly place `count` nodes between `top` and `bottom` in one column. */
function columnPoint(index: number, count: number, x: number, top: number, bottom: number): NetworkPoint {
  const y = count <= 1 ? (top + bottom) / 2 : top + (index / (count - 1)) * (bottom - top);
  return { x: round(x), y: round(y) };
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A quadratic edge between two nodes, bowed sideways by `bend` × its length.
 *
 * Straight lines between a centre core and an outer ring all cross at the same point and read as
 * one blob; a small bow keeps parallel edges distinguishable and lets a running branch visibly
 * "flow" without an arrow head.
 */
export function edgePath(from: NetworkPoint, to: NetworkPoint, bend = 0.16): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const controlX = midX + (-dy / length) * length * bend;
  const controlY = midY + (dx / length) * length * bend;
  return `M ${rounded(from.x)} ${rounded(from.y)} Q ${rounded(controlX)} ${rounded(controlY)} ${rounded(to.x)} ${rounded(to.y)}`;
}

/* --- Nodes ---------------------------------------------------------------- */

export type NetworkTone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

export interface NetworkAgentNode extends NetworkPoint {
  readonly kind: 'agent';
  readonly id: string;
  readonly name: string;
  readonly positionTitle: string;
  readonly departmentId: string;
  readonly departmentName: string;
  readonly status: string;
  readonly presence: string;
  readonly paused: boolean;
  /** The employee this agent reports to, when that manager is itself on the canvas. */
  readonly managerId: string | null;
  readonly currentTaskId: string | null;
  readonly currentTaskTitle: string;
  readonly currentWorkflowInstanceId: string | null;
  readonly working: boolean;
  readonly angle: number;
  readonly tone: NetworkTone;
}

export interface NetworkWorkflowNode extends NetworkPoint {
  readonly kind: 'workflow';
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly stageId: string;
  readonly goal: string;
  readonly draft: boolean;
  readonly tone: NetworkTone;
  readonly progress: { readonly done: number; readonly total: number };
  readonly gateOpen: boolean;
  readonly ownerEmployeeId: string | null;
  readonly assigneeEmployeeIds: readonly string[];
  /** Desktop seats this branch touched, so the inspector can list them without parsing steps. */
  readonly stepTaskIds: readonly string[];
  readonly angle: number;
}

export interface NetworkDeliverableNode extends NetworkPoint {
  readonly kind: 'deliverable';
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly completedAtSim: number;
  readonly workflowInstanceId: string | null;
  readonly assigneeEmployeeId: string | null;
  readonly roleTitle: string;
  readonly angle: number;
}

export interface NetworkCoreNode extends NetworkPoint {
  readonly kind: 'core';
  readonly id: 'core';
}

export type NetworkNode = NetworkAgentNode | NetworkWorkflowNode | NetworkDeliverableNode | NetworkCoreNode;

/* --- Edges ---------------------------------------------------------------- */

export type NetworkEdgeKind = 'reports' | 'runs' | 'delivers';

export interface NetworkEdge {
  readonly id: string;
  readonly kind: NetworkEdgeKind;
  readonly from: string;
  readonly to: string;
  readonly tone: NetworkTone;
  readonly animated: boolean;
  readonly d: string;
}

/* --- Stats ---------------------------------------------------------------- */

export interface NetworkStats {
  readonly agents: number;
  readonly workingAgents: number;
  readonly departments: number;
  readonly positions: number;
  readonly workflows: number;
  readonly activeWorkflows: number;
  readonly gates: number;
  readonly tasks: number;
  readonly completedTasks: number;
}

/* --- Input / output ------------------------------------------------------- */

export interface NetworkInput {
  readonly snapshot: Pick<Snapshot, 'employees' | 'positions' | 'departments' | 'agents' | 'tasks'>;
  readonly workflows: readonly Row[];
  /** How many workflow branches the canvas draws before the page says "show all". */
  readonly maxWorkflows?: number;
  /** How many deliveries the outer ring draws before the page says "show all". */
  readonly maxDeliverables?: number;
  readonly showAll?: boolean;
}

export interface NetworkModel {
  readonly core: NetworkCoreNode;
  readonly agents: readonly NetworkAgentNode[];
  readonly workflows: readonly NetworkWorkflowNode[];
  readonly deliverables: readonly NetworkDeliverableNode[];
  readonly edges: readonly NetworkEdge[];
  readonly stats: NetworkStats;
  /** Workflow branches held back by the cap — the page offers "show all" when this is > 0. */
  readonly hiddenWorkflows: number;
  /** Deliveries held back by the cap. */
  readonly hiddenDeliverables: number;
}

/* --- Status vocabulary ---------------------------------------------------- */

const TERMINAL = new Set(['completed', 'cancelled', 'canceled', 'failed', 'aborted']);
const ACTIVE = new Set(['running', 'active', 'blocked', 'paused', 'in_progress']);

/** The status token a workflow node/pill paints. Fixed by token, never by localized copy. */
export function workflowTone(status: string, draft: boolean): NetworkTone {
  const code = status.trim().toLowerCase();
  if (draft) return 'warn';
  if (code === 'blocked' || code === 'failed' || code === 'rejected') return 'bad';
  if (code === 'completed') return 'ok';
  if (code === 'cancelled' || code === 'canceled' || code === 'aborted') return 'neutral';
  if (ACTIVE.has(code)) return 'info';
  return 'neutral';
}

/** The tone of an agent's presence: working is live, paused is a warning, idle is neutral. */
export function agentTone(presence: string, paused: boolean): NetworkTone {
  if (paused) return 'warn';
  const code = presence.trim().toLowerCase();
  if (code === 'idle' || code === '') return 'neutral';
  if (code === 'blocked' || code === 'faulted') return 'bad';
  if (code === 'waiting_input') return 'warn';
  return 'info';
}

function isTerminal(status: string): boolean {
  return TERMINAL.has(status.trim().toLowerCase());
}

function isActive(status: string): boolean {
  return ACTIVE.has(status.trim().toLowerCase());
}

/* --- Row readers ---------------------------------------------------------- */

const NO_VALUE = new Set(['', 'null', 'undefined']);

function textOf(value: unknown): string {
  const text = readString(value, '').trim();
  return NO_VALUE.has(text.toLowerCase()) ? '' : text;
}

function rowsOf(value: unknown): readonly Row[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Row => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
    : [];
}

/* --- The model ------------------------------------------------------------ */

/**
 * Build the canvas model from the read models the console already polls.
 *
 * Layout order is intentional:
 * - agents by department, so colleagues sit together;
 * - workflow branches by "wants your attention" (draft, then active/blocked, then completed);
 * - deliveries at the same angle as the branch (or seat) that produced them, so the outer ring
 *   reads as "this branch shipped this".
 */
export function buildNetworkModel(input: NetworkInput): NetworkModel {
  const { snapshot, workflows } = input;
  const showAll = input.showAll === true;
  const maxWorkflows = Math.max(1, input.maxWorkflows ?? 8);
  const maxDeliverables = Math.max(1, input.maxDeliverables ?? 5);

  const tasks = snapshot.tasks;
  const taskTitleById = new Map<string, string>();
  for (const task of tasks) {
    const id = textOf(task['taskId']);
    if (id !== '') taskTitleById.set(id, textOf(task['title']) || id);
  }

  const departmentNameById = new Map<string, string>();
  for (const department of snapshot.departments) {
    const id = textOf(department['departmentId']);
    if (id !== '') departmentNameById.set(id, textOf(department['name']) || id);
  }

  const positionDepartmentById = new Map<string, string>();
  for (const position of snapshot.positions) {
    const id = textOf(position['positionId']);
    if (id !== '') positionDepartmentById.set(id, textOf(position['departmentId']));
  }

  const runtimeByEmployee = new Map<string, Row>();
  for (const agent of snapshot.agents) {
    const id = textOf(agent['employeeId']);
    if (id !== '') runtimeByEmployee.set(id, agent);
  }

  const employees = snapshot.employees
    .filter((employee) => textOf(employee['employeeId']) !== '')
    .filter((employee) => {
      const status = textOf(employee['status']).toLowerCase();
      return status !== 'archived' && status !== 'offboarded';
    })
    .slice()
    .sort((left, right) => {
      // The root seat has no department; it belongs at the top of the ring, not after "research".
      const leftDepartment = textOf(left['departmentId']);
      const rightDepartment = textOf(right['departmentId']);
      if (leftDepartment !== rightDepartment) {
        if (leftDepartment === '') return -1;
        if (rightDepartment === '') return 1;
        return leftDepartment.localeCompare(rightDepartment);
      }
      return textOf(left['name']).localeCompare(textOf(right['name']));
    });

  const agents: NetworkAgentNode[] = employees.map((employee, index) => {
    const id = textOf(employee['employeeId']);
    const runtime = runtimeByEmployee.get(id);
    const departmentId = textOf(employee['departmentId']);
    const presence = runtime === undefined ? 'idle' : textOf(runtime['presence']) || 'idle';
    const paused = runtime !== undefined && readBoolean(runtime['paused'], false);
    const currentTaskId = runtime === undefined || textOf(runtime['currentTaskId']) === '' ? null : textOf(runtime['currentTaskId']);
    const managerId = textOf(employee['managerEmployeeId']) || (runtime === undefined ? '' : textOf(runtime['managerEmployeeId']));
    const point = columnPoint(index, employees.length, AGENT_COLUMN_X, AGENT_TOP, AGENT_BOTTOM);
    const angle = Math.atan2(point.y - CENTER.y, point.x - CENTER.x);
    return {
      kind: 'agent',
      id,
      name: textOf(employee['name']) || id,
      positionTitle: positionTitle(snapshot.positions, textOf(employee['positionId'])),
      departmentId,
      departmentName: departmentNameById.get(departmentId) ?? '',
      status: textOf(employee['status']),
      presence,
      paused,
      managerId: managerId === '' || !employees.some((candidate) => textOf(candidate['employeeId']) === managerId) ? null : managerId,
      currentTaskId,
      currentTaskTitle: currentTaskId === null ? '' : taskTitleById.get(currentTaskId) ?? '',
      currentWorkflowInstanceId: runtime === undefined || textOf(runtime['currentWorkflowInstanceId']) === '' ? null : textOf(runtime['currentWorkflowInstanceId']),
      working: currentTaskId !== null || (!paused && presence !== 'idle' && presence !== ''),
      angle,
      tone: agentTone(presence, paused),
      ...point,
    };
  });

  const agentIds = new Set(agents.map((agent) => agent.id));

  const rankedWorkflows = workflows
    .filter((workflow) => textOf(workflow['instanceId']) !== '')
    .slice()
    .sort((left, right) => {
      const rank = (row: Row): number => {
        const status = textOf(row['status']);
        if (readBoolean(row['draft'], false)) return 0;
        if (status === 'blocked') return 1;
        if (isActive(status)) return 2;
        return 3;
      };
      const byRank = rank(left) - rank(right);
      if (byRank !== 0) return byRank;
      const leftTime = readNumber(left['completedAtSim'], readNumber(left['startedAtSim'], 0));
      const rightTime = readNumber(right['completedAtSim'], readNumber(right['startedAtSim'], 0));
      return rightTime - leftTime;
    });

  const workflowCap = showAll ? Math.max(maxWorkflows, rankedWorkflows.length) : maxWorkflows;
  const visibleWorkflowRows = rankedWorkflows.slice(0, workflowCap);

  const ownerOf = (workflow: Row): string | null => {
    const initiatedBy = textOf(workflow['initiatedBy']);
    if (initiatedBy !== '' && agentIds.has(initiatedBy)) return initiatedBy;
    for (const step of rowsOf(workflow['steps'])) {
      const assignee = textOf(step['assigneeEmployeeId']);
      if (assignee !== '' && agentIds.has(assignee)) return assignee;
    }
    return null;
  };

  const workflowCount = visibleWorkflowRows.length;
  // Seven branches fit a single right-hand column. "Show all" may mean eleven, so the two
  // dense columns take over beyond eight — with a smaller card, the same total height.
  const denseWorkflows = workflowCount > 8;
  const denseRows = Math.max(1, Math.ceil(workflowCount / 2));

  const workflowsNodes: NetworkWorkflowNode[] = visibleWorkflowRows.map((workflow, index) => {
    const steps = rowsOf(workflow['steps']);
    const assignees = new Set<string>();
    const stepTaskIds: string[] = [];
    for (const step of steps) {
      const assignee = textOf(step['assigneeEmployeeId']);
      if (assignee !== '' && agentIds.has(assignee)) assignees.add(assignee);
      const taskId = textOf(step['taskId']);
      if (taskId !== '') stepTaskIds.push(taskId);
    }
    const ownerEmployeeId = ownerOf(workflow);
    const point = denseWorkflows
      ? {
          x: index % 2 === 0 ? WORKFLOW_DENSE_LEFT_X : WORKFLOW_DENSE_RIGHT_X,
          y: round(
            denseRows <= 1
              ? (WORKFLOW_TOP + WORKFLOW_BOTTOM) / 2
              : WORKFLOW_TOP + (Math.floor(index / 2) / (denseRows - 1)) * (WORKFLOW_BOTTOM - WORKFLOW_TOP),
          ),
        }
      : columnPoint(index, workflowCount, WORKFLOW_COLUMN_X, WORKFLOW_TOP, WORKFLOW_BOTTOM);
    const angle = Math.atan2(point.y - CENTER.y, point.x - CENTER.x);
    const status = textOf(workflow['status']) || 'pending';
    return {
      kind: 'workflow',
      id: textOf(workflow['instanceId']),
      title: textOf(workflow['title']) || textOf(workflow['instanceId']),
      status,
      stageId: textOf(workflow['stageId']),
      goal: textOf(workflow['goal']),
      draft: readBoolean(workflow['draft'], false),
      tone: workflowTone(status, readBoolean(workflow['draft'], false)),
      progress: stepProgress(workflow),
      gateOpen: isOpenApproval(workflow),
      ownerEmployeeId,
      assigneeEmployeeIds: [...assignees],
      stepTaskIds,
      angle,
      ...point,
    };
  });

  const workflowById = new Map(workflowsNodes.map((workflow) => [workflow.id, workflow]));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));

  const completed = tasks
    .filter((task) => {
      const status = textOf(task['status']).toLowerCase();
      return status === 'completed' || status === 'submitted';
    })
    .slice()
    .sort((left, right) => readNumber(right['completedAtSim'], 0) - readNumber(left['completedAtSim'], 0));

  const deliverableCap = showAll ? Math.max(maxDeliverables, 5) : maxDeliverables;
  const deliverableRows = completed.slice(0, deliverableCap);
  const deliverableCount = deliverableRows.length;

  const deliverables: NetworkDeliverableNode[] = deliverableRows.map((task, index) => {
    const workflowInstanceId = textOf(task['workflowInstanceId']);
    const assigneeEmployeeId = textOf(task['assigneeEmployeeId']);
    const x = deliverableCount <= 1
      ? CENTER.x
      : DELIVERABLE_LEFT_X + (index / (deliverableCount - 1)) * (DELIVERABLE_RIGHT_X - DELIVERABLE_LEFT_X);
    const point = { x: round(x), y: DELIVERABLE_ROW_Y };
    const angle = Math.atan2(point.y - CENTER.y, point.x - CENTER.x);
    return {
      kind: 'deliverable',
      id: textOf(task['taskId']),
      title: textOf(task['title']) || textOf(task['taskId']),
      status: textOf(task['status']),
      completedAtSim: readNumber(task['completedAtSim'], 0),
      workflowInstanceId: workflowInstanceId === '' ? null : workflowInstanceId,
      assigneeEmployeeId: assigneeEmployeeId === '' ? null : assigneeEmployeeId,
      roleTitle: positionTitle(snapshot.positions, textOf(task['positionId'])),
      angle,
      ...point,
    };
  });

  const edges: NetworkEdge[] = [];
  const addEdge = (edge: NetworkEdge): void => {
    edges.push(edge);
  };

  for (const agent of agents) {
    if (agent.managerId === null) continue;
    const manager = agentById.get(agent.managerId);
    if (manager === undefined) continue;
    addEdge({
      id: `reports:${agent.id}:${manager.id}`,
      kind: 'reports',
      from: agent.id,
      to: manager.id,
      tone: 'neutral',
      animated: false,
      d: edgePath(agent, manager, 0.12),
    });
  }

  for (const workflow of workflowsNodes) {
    // One accountable edge per branch. Every seat is still listed in the inspector; drawing all
    // of them turned the canvas into a crossing bundle with no readable line.
    const seat = workflow.ownerEmployeeId ?? workflow.assigneeEmployeeIds[0];
    if (seat === undefined) continue;
    const agent = agentById.get(seat);
    if (agent === undefined) continue;
    addEdge({
      id: `runs:${workflow.id}:${seat}`,
      kind: 'runs',
      from: workflow.id,
      to: seat,
      tone: workflow.tone,
      animated: workflow.tone === 'info' || workflow.tone === 'warn' || workflow.tone === 'bad',
      d: edgePath(workflow, agent, -0.12),
    });
  }

  for (const deliverable of deliverables) {
    const workflow = deliverable.workflowInstanceId === null ? undefined : workflowById.get(deliverable.workflowInstanceId);
    const agent = deliverable.assigneeEmployeeId === null ? undefined : agentById.get(deliverable.assigneeEmployeeId);
    const source = workflow ?? agent;
    if (source === undefined) {
      addEdge({
        id: `delivers:core:${deliverable.id}`,
        kind: 'delivers',
        from: 'core',
        to: deliverable.id,
        tone: 'ok',
        animated: false,
        d: edgePath(CENTER, deliverable, 0.08),
      });
      continue;
    }
    addEdge({
      id: `delivers:${source.id}:${deliverable.id}`,
      kind: 'delivers',
      from: source.id,
      to: deliverable.id,
      tone: 'ok',
      animated: false,
      d: edgePath(source, deliverable, 0.1),
    });
  }

  const activeWorkflows = workflows.filter((workflow) => !isTerminal(textOf(workflow['status']))).length;
  const gates = workflows.filter((workflow) => isOpenApproval(workflow)).length;

  return {
    core: { kind: 'core', id: 'core', ...CENTER },
    agents,
    workflows: workflowsNodes,
    deliverables,
    edges,
    stats: {
      agents: agents.length,
      workingAgents: agents.filter((agent) => agent.working).length,
      departments: snapshot.departments.length,
      positions: snapshot.positions.length,
      workflows: workflows.length,
      activeWorkflows,
      gates,
      tasks: tasks.length,
      completedTasks: completed.length,
    },
    hiddenWorkflows: Math.max(0, rankedWorkflows.length - workflowsNodes.length),
    hiddenDeliverables: Math.max(0, completed.length - deliverables.length),
  };
}

/* --- The delivery theatre ------------------------------------------------- */

const DOCUMENT_TITLE = /requirement|design|report|document|spec|brief|docx?|文档|需求|设计|报告|说明/i;
const GAME_TITLE = /game|tetris|snake|tac|toe|chess|棋|游戏|canvas|playable/i;

/**
 * The deliveries worth showing off, in one bound.
 *
 * "Most recent" alone is the wrong sample: a demo company's five newest completed tasks can all
 * be game iterations, and the page would then never show that the organisation also writes
 * documents. This picks the newest game-shaped delivery, the newest document-shaped delivery and
 * then fills the remaining slots with the latest work, so the rail always represents the product
 * mix the company actually ships. It is a *selection* helper only — nothing here claims a kind;
 * the card fetches the record and decides from its real files.
 */
export function showcaseDeliveries(tasks: readonly Row[], limit = 5): readonly Row[] {
  const completed = tasks
    .filter((task) => {
      const status = textOf(task['status']).toLowerCase();
      return status === 'completed' || status === 'submitted';
    })
    .slice()
    .sort((left, right) => readNumber(right['completedAtSim'], 0) - readNumber(left['completedAtSim'], 0));
  const picks: Row[] = [];
  const seen = new Set<string>();
  const add = (row: Row | undefined): void => {
    if (row === undefined || picks.length >= limit) return;
    const id = textOf(row['taskId']);
    if (id === '' || seen.has(id)) return;
    seen.add(id);
    picks.push(row);
  };

  add(completed.find((task) => GAME_TITLE.test(textOf(task['title']))));
  add(completed.find((task) => DOCUMENT_TITLE.test(textOf(task['title']))));
  for (const task of completed) add(task);
  return picks.sort((left, right) => readNumber(right['completedAtSim'], 0) - readNumber(left['completedAtSim'], 0));
}

/* --- Inspector helpers ---------------------------------------------------- */

/** The node the page keeps selected, resolved against the current model (or `null` if gone). */
export function nodeById(model: NetworkModel, id: string | null): NetworkNode | null {
  if (id === null || id === '') return null;
  if (id === 'core') return model.core;
  return (
    model.agents.find((agent) => agent.id === id) ??
    model.workflows.find((workflow) => workflow.id === id) ??
    model.deliverables.find((deliverable) => deliverable.id === id) ??
    null
  );
}
