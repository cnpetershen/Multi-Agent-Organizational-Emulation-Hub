import { readBoolean, readNumber, readString, type Row } from './api';

/**
 * The assignment canvas: the pure geometry and read-model parsing behind the dark studio.
 *
 * The console already has the command path (`Workflow.InstanceAssignmentOverride` +
 * `Workflow.ConfirmStart`) and the per-step truth in `/api/workflows`. This module adds only the
 * presentation model the new canvas needs: which steps are where, which edges connect them,
 * which stage band each node belongs to, and which employee is currently effective. Nothing here
 * calls the API or owns a command; the page remains the only thing that writes.
 *
 * Layout is deliberately deterministic and vertical, like the reference workflow builder:
 * stages read top-to-bottom, one node per step, a stage rail on the left. The graph is allowed
 * to be taller than its viewport; the page scrolls it instead of shrinking labels into noise.
 */

export const ASSIGNMENT_GRAPH_WIDTH = 760;
export const ASSIGNMENT_NODE_WIDTH = 330;
export const ASSIGNMENT_NODE_HEIGHT = 88;
export const ASSIGNMENT_NODE_GAP = 24;
export const ASSIGNMENT_TOP = 38;
export const ASSIGNMENT_BOTTOM = 28;
/** The vertical spine every node and edge sits on. */
export const ASSIGNMENT_NODE_CENTER_X = 375;

export interface AssignmentAuthority {
  readonly domain: string;
  readonly level: number;
}

export interface AssignmentStep {
  readonly stepId: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly name: string;
  readonly kind: string;
  readonly status: string;
  readonly taskId: string | null;
  readonly assigneeEmployeeId: string | null;
  readonly assigneePositionId: string | null;
  readonly capability: string | null;
  readonly requiredRoles: readonly string[];
  readonly requiredAuthority: AssignmentAuthority | null;
  readonly overridden: boolean;
}

export interface AssignmentApproval {
  readonly stepId: string;
  readonly status: string;
  readonly requiredCount: number;
  readonly grantedBy: readonly string[];
}

export interface AssignmentInstance {
  readonly instanceId: string;
  readonly title: string;
  readonly goal: string;
  readonly status: string;
  readonly eventCount: number;
  readonly steps: readonly AssignmentStep[];
  readonly assignmentOverrides: Readonly<Record<string, string>>;
  readonly draft: boolean;
  /** The instance's open (or last decided) approval gate, when the read model reports one. */
  readonly approval?: AssignmentApproval | null;
}

export interface AssignmentEmployee {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly kind: string;
  readonly positionId: string;
  readonly positionTitle: string;
  readonly capabilities: readonly string[];
  /** The department the seat belongs to — the company-structure line on the roster card. */
  readonly departmentId?: string;
  readonly departmentName?: string;
}

/**
 * One seat in the organization chart, staffed or vacant.
 *
 * The canvas shows vacant seats beside the team so the operator can drag a *seat* onto a step
 * before anyone holds it. A vacant seat cannot be written as an assignment override — the kernel
 * only accepts an employee — so dropping one opens the hiring approval gate in the inspector.
 */
export interface AssignmentSeat {
  readonly positionId: string;
  readonly title: string;
  readonly departmentId: string;
  readonly departmentName: string;
  readonly capabilities: readonly string[];
  /** Employees who currently hold the seat; empty means the seat is vacant. */
  readonly holderIds: readonly string[];
  readonly vacant: boolean;
}

/** The company structure the palette and the draft header read: departments and their seats. */
export interface AssignmentDepartment {
  readonly departmentId: string;
  readonly departmentName: string;
  readonly seats: readonly AssignmentSeat[];
  readonly staffed: number;
  readonly vacant: number;
}

export type AssignmentTone = 'ok' | 'info' | 'warn' | 'bad' | 'muted';

export interface AssignmentNode {
  readonly step: AssignmentStep;
  readonly index: number;
  readonly stageIndex: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly tone: AssignmentTone;
  readonly adjustable: boolean;
  /** The employee the node actually shows (staged override wins over the instance's assignee). */
  readonly effectiveEmployeeId: string | null;
  readonly staged: boolean;
}

export interface AssignmentEdge {
  readonly id: string;
  readonly fromStepId: string;
  readonly toStepId: string;
  readonly d: string;
  readonly tone: AssignmentTone;
  readonly active: boolean;
  readonly crossesStage: boolean;
}

export interface AssignmentStageBand {
  readonly stageId: string;
  readonly stageName: string;
  readonly index: number;
  readonly top: number;
  readonly height: number;
  readonly done: number;
  readonly total: number;
  readonly firstStepId: string;
  readonly lastStepId: string;
}

export interface AssignmentGraph {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly AssignmentNode[];
  readonly edges: readonly AssignmentEdge[];
  readonly stages: readonly AssignmentStageBand[];
  readonly selectedStepId: string | null;
}

/* --- Parsing -------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringList = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') : [];

const optionalString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

const authorityOf = (value: unknown): AssignmentAuthority | null => {
  if (!isRecord(value)) return null;
  const domain = readString(value['domain'], '');
  const level = readNumber(value['level'], NaN);
  if (domain === '' || !Number.isFinite(level)) return null;
  return { domain, level };
};

export function parseAssignmentStep(row: unknown): AssignmentStep | null {
  if (!isRecord(row)) return null;
  const stepId = readString(row['stepId'], '');
  if (stepId === '') return null;
  return {
    stepId,
    stageId: readString(row['stageId'], ''),
    stageName: readString(row['stageName'], readString(row['stageId'], stepId)),
    name: readString(row['name'], stepId),
    kind: readString(row['kind'], 'task'),
    status: readString(row['status'], 'pending'),
    taskId: optionalString(row['taskId']),
    assigneeEmployeeId: optionalString(row['assigneeEmployeeId']),
    assigneePositionId: optionalString(row['assigneePositionId']),
    capability: optionalString(row['capability']),
    requiredRoles: stringList(row['requiredRoles']),
    requiredAuthority: authorityOf(row['requiredAuthority']),
    overridden: readBoolean(row['overridden'], false),
  };
}

const overridesOf = (value: unknown): Readonly<Record<string, string>> => {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [stepId, employeeId] of Object.entries(value)) {
    if (typeof employeeId === 'string' && employeeId !== '') result[stepId] = employeeId;
  }
  return result;
};

/**
 * The instance's approval gate as `/api/workflows` reports it. The gate is `null` when the
 * instance has never requested one; `status` is `open`, `granted` or `denied`.
 */
export function parseAssignmentApproval(value: unknown): AssignmentApproval | null {
  if (!isRecord(value)) return null;
  const stepId = readString(value['stepId'], '');
  const status = readString(value['status'], '');
  if (stepId === '' && status === '') return null;
  return {
    stepId,
    status,
    requiredCount: Math.max(1, Math.trunc(readNumber(value['requiredCount'], 1))),
    grantedBy: stringList(value['grantedBy']),
  };
}

export function parseAssignmentInstance(row: Row): AssignmentInstance | null {
  const instanceId = readString(row['instanceId'], '');
  if (instanceId === '') return null;
  const steps = (Array.isArray(row['steps']) ? row['steps'] : [])
    .map(parseAssignmentStep)
    .filter((step): step is AssignmentStep => step !== null);
  if (steps.length === 0) return null;
  return {
    instanceId,
    title: readString(row['title'], instanceId),
    goal: readString(row['goal'], ''),
    status: readString(row['status'], ''),
    eventCount: readNumber(row['eventCount'], 0),
    steps,
    assignmentOverrides: overridesOf(row['assignmentOverrides']),
    draft: readBoolean(row['draft'], false),
    approval: parseAssignmentApproval(row['approval']),
  };
}

/** Instances with steps, drafts first (they want a decision), then live work, then history. */
export function parseAssignmentInstances(rows: readonly Row[]): readonly AssignmentInstance[] {
  const mapped = rows
    .map(parseAssignmentInstance)
    .filter((entry): entry is AssignmentInstance => entry !== null);
  const rank = (entry: AssignmentInstance): number =>
    entry.draft ? 0 : ['running', 'blocked', 'paused'].includes(entry.status.toLowerCase()) ? 1 : 2;
  return [...mapped].sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) return byRank;
    // Prefer the branch that actually shows a flow over a one-step hiring gate.
    if (left.steps.length !== right.steps.length) return right.steps.length - left.steps.length;
    return left.instanceId.localeCompare(right.instanceId);
  });
}

function departmentNames(departments: readonly Row[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const department of departments) {
    const id = readString(department['departmentId'], '');
    if (id !== '') names.set(id, readString(department['name'], id));
  }
  return names;
}

export function parseAssignmentEmployees(
  employees: readonly Row[],
  positions: readonly Row[],
  departments: readonly Row[] = [],
): readonly AssignmentEmployee[] {
  const capabilitiesByPosition = new Map<string, readonly string[]>();
  const departmentByPosition = new Map<string, string>();
  for (const position of positions) {
    const id = readString(position['positionId'], '');
    if (id === '') continue;
    capabilitiesByPosition.set(id, stringList(position['capabilities']));
    const departmentId = readString(position['departmentId'], '');
    if (departmentId !== '') departmentByPosition.set(id, departmentId);
  }
  const names = departmentNames(departments);
  return employees
    .map((employee): AssignmentEmployee | null => {
      const id = readString(employee['employeeId'], '');
      if (id === '') return null;
      const positionId = readString(employee['positionId'], '');
      const capabilities = [
        ...(capabilitiesByPosition.get(positionId) ?? []),
        ...stringList(employee['expertise']),
      ].filter((capability, index, all) => all.indexOf(capability) === index);
      const departmentId = readString(employee['departmentId'], departmentByPosition.get(positionId) ?? '');
      return {
        id,
        name: readString(employee['name'], id),
        status: readString(employee['status'], ''),
        kind: readString(employee['kind'], 'agent'),
        positionId,
        positionTitle: readString(employee['positionTitle'], readString(employee['positionId'], id)),
        capabilities,
        departmentId,
        departmentName: departmentId === '' ? '' : names.get(departmentId) ?? departmentId,
      };
    })
    .filter((employee): employee is AssignmentEmployee => employee !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Every seat of the organization chart, staffed or not.
 *
 * A seat is "vacant" when no live employee holds it. A holder counts only while their
 * employment is live — an `offboarded` employee keeps their `positionId` for the audit trail,
 * so both the chart's `employeeIds` and the roster are read through that status before a seat
 * may be called vacant. This mirrors `vacantPositions()` in `derive.ts`, but keeps the whole
 * chart (not only the unstaffed part) so the palette can group people and vacancies by
 * department.
 */
export function parseAssignmentSeats(
  positions: readonly Row[],
  employees: readonly Row[],
  departments: readonly Row[] = [],
): readonly AssignmentSeat[] {
  const names = departmentNames(departments);
  const offboarded = new Set(
    employees
      .filter((row) => readString(row['status'], '') === 'offboarded')
      .map((row) => readString(row['employeeId'], '')),
  );
  const holdersByPosition = new Map<string, string[]>();
  for (const employee of employees) {
    const employeeId = readString(employee['employeeId'], '');
    const positionId = readString(employee['positionId'], '');
    if (employeeId === '' || positionId === '' || offboarded.has(employeeId)) continue;
    const holders = holdersByPosition.get(positionId) ?? [];
    if (!holders.includes(employeeId)) holders.push(employeeId);
    holdersByPosition.set(positionId, holders);
  }
  return positions
    .flatMap((position): AssignmentSeat[] => {
      const positionId = readString(position['positionId'], '');
      if (positionId === '') return [];
      const listed = (Array.isArray(position['employeeIds']) ? (position['employeeIds'] as readonly unknown[]) : [])
        .map((id) => String(id))
        .filter((id) => id !== '' && !offboarded.has(id));
      const holderIds = [...new Set([...(holdersByPosition.get(positionId) ?? []), ...listed])];
      const departmentId = readString(position['departmentId'], '');
      return [{
        positionId,
        title: readString(position['title'], positionId),
        departmentId,
        departmentName: departmentId === '' ? '' : names.get(departmentId) ?? departmentId,
        capabilities: stringList(position['capabilities']),
        holderIds,
        vacant: holderIds.length === 0,
      }];
    })
    .sort((left, right) =>
      left.departmentName.localeCompare(right.departmentName) || left.title.localeCompare(right.title));
}

/** The roster grouped by the company's departments, unnamed seats last. */
export function groupEmployeesByDepartment(
  employees: readonly AssignmentEmployee[],
): readonly {
  readonly departmentId: string;
  readonly departmentName: string;
  readonly employees: readonly AssignmentEmployee[];
}[] {
  const groups: { departmentId: string; departmentName: string; employees: AssignmentEmployee[] }[] = [];
  for (const employee of employees) {
    const departmentId = employee.departmentId ?? '';
    const group = groups.find((entry) => entry.departmentId === departmentId);
    if (group === undefined) {
      groups.push({ departmentId, departmentName: employee.departmentName ?? '', employees: [employee] });
    } else {
      group.employees.push(employee);
    }
  }
  return groups.sort((left, right) => {
    if (left.departmentName === '') return 1;
    if (right.departmentName === '') return -1;
    return left.departmentName.localeCompare(right.departmentName);
  });
}

/** The organization chart grouped by department, with the staffed/vacant tally the header shows. */
export function groupSeatsByDepartment(seats: readonly AssignmentSeat[]): readonly AssignmentDepartment[] {
  const groups: AssignmentDepartment[] = [];
  for (const seat of seats) {
    const existing = groups.find((entry) => entry.departmentId === seat.departmentId);
    if (existing === undefined) {
      groups.push({
        departmentId: seat.departmentId,
        departmentName: seat.departmentName,
        seats: [seat],
        staffed: seat.vacant ? 0 : 1,
        vacant: seat.vacant ? 1 : 0,
      });
      continue;
    }
    const index = groups.indexOf(existing);
    groups[index] = {
      ...existing,
      seats: [...existing.seats, seat],
      staffed: existing.staffed + (seat.vacant ? 0 : 1),
      vacant: existing.vacant + (seat.vacant ? 1 : 0),
    };
  }
  return groups.sort((left, right) => {
    if (left.departmentName === '') return 1;
    if (right.departmentName === '') return -1;
    return left.departmentName.localeCompare(right.departmentName);
  });
}

/* --- Layout --------------------------------------------------------------- */

export function stepTone(status: string, draft: boolean): AssignmentTone {
  const code = status.trim().toLowerCase();
  if (draft) return 'warn';
  if (code === 'active' || code === 'running') return 'info';
  if (code === 'done' || code === 'completed') return 'ok';
  if (code === 'rejected' || code === 'failed' || code === 'blocked') return 'bad';
  return 'muted';
}

export function isAdjustableStep(step: AssignmentStep): boolean {
  return step.kind === 'task' && step.status === 'pending';
}

export function edgePath(fromY: number, toY: number): string {
  const bend = 34;
  return `M ${ASSIGNMENT_NODE_CENTER_X} ${fromY} C ${ASSIGNMENT_NODE_CENTER_X + bend} ${fromY + 22}, ${ASSIGNMENT_NODE_CENTER_X + bend} ${toY - 22}, ${ASSIGNMENT_NODE_CENTER_X} ${toY}`;
}

/**
 * Build the graph for one instance. `staging` is the page's local preview of overrides; it
 * changes the effective assignee and the SoD badges but never the node order or the edge set.
 */
export function buildAssignmentGraph(
  instance: AssignmentInstance,
  options: {
    readonly staging?: Readonly<Record<string, string>>;
    readonly selectedStepId?: string | null;
  } = {},
): AssignmentGraph {
  const staging = options.staging ?? {};
  const steps = instance.steps;
  const stageIndexById = new Map<string, number>();
  const stageOrder: string[] = [];
  for (const step of steps) {
    if (!stageIndexById.has(step.stageId)) {
      stageIndexById.set(step.stageId, stageOrder.length);
      stageOrder.push(step.stageId);
    }
  }

  const nodes: AssignmentNode[] = steps.map((step, index) => {
    const stageIndex = stageIndexById.get(step.stageId) ?? 0;
    const y = ASSIGNMENT_TOP + index * (ASSIGNMENT_NODE_HEIGHT + ASSIGNMENT_NODE_GAP);
    return {
      step,
      index,
      stageIndex,
      x: ASSIGNMENT_NODE_CENTER_X - ASSIGNMENT_NODE_WIDTH / 2,
      y,
      width: ASSIGNMENT_NODE_WIDTH,
      height: ASSIGNMENT_NODE_HEIGHT,
      tone: stepTone(step.status, instance.draft && step.status === 'pending'),
      adjustable: isAdjustableStep(step),
      effectiveEmployeeId: staging[step.stepId] ?? step.assigneeEmployeeId,
      staged: staging[step.stepId] !== undefined,
    };
  });

  const edges: AssignmentEdge[] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const from = nodes[index];
    const to = nodes[index + 1];
    if (from === undefined || to === undefined) continue;
    const active = from.step.status === 'done' && ['active', 'pending'].includes(to.step.status);
    edges.push({
      id: `${from.step.stepId}->${to.step.stepId}`,
      fromStepId: from.step.stepId,
      toStepId: to.step.stepId,
      d: edgePath(from.y + from.height, to.y),
      tone: to.tone,
      active,
      crossesStage: from.step.stageId !== to.step.stageId,
    });
  }

  const stages: AssignmentStageBand[] = stageOrder.flatMap((stageId, index) => {
    const members = nodes.filter((node) => node.step.stageId === stageId);
    const first = members[0];
    const last = members[members.length - 1];
    if (first === undefined || last === undefined) return [];
    const top = first.y - 20;
    const bottom = last.y + last.height + 20;
    return [{
      stageId,
      stageName: first.step.stageName,
      index,
      top,
      height: bottom - top,
      done: members.filter((node) => node.step.status === 'done').length,
      total: members.length,
      firstStepId: first.step.stepId,
      lastStepId: last.step.stepId,
    }];
  });

  const height = Math.max(
    520,
    ASSIGNMENT_TOP + nodes.length * (ASSIGNMENT_NODE_HEIGHT + ASSIGNMENT_NODE_GAP) + ASSIGNMENT_BOTTOM,
  );

  const selectedStepId = options.selectedStepId === undefined
    ? nodes[0]?.step.stepId ?? null
    : options.selectedStepId;

  return { width: ASSIGNMENT_GRAPH_WIDTH, height, nodes, edges, stages, selectedStepId };
}

/** Which employee a step would actually run on in the current log. */
export function effectiveAssignee(
  step: AssignmentStep,
  overrides: Readonly<Record<string, string>>,
): string | null {
  return overrides[step.stepId] ?? step.assigneeEmployeeId;
}

