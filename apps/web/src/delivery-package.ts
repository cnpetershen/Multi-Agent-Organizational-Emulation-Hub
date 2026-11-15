import { readString, type Row, type TaskRecord } from './api';
import { documentPreviewOf, isPlayableGame, type DocumentPreviewModel } from './document-preview';
import { modelFromFile, type Model3D } from './model3d';
import { deliverableKind, deliveredFiles, workflowStepTasks, type DeliveredFile } from './results';
import {
  extensionOf,
  isModelAssetPath,
  isSpatialDelivery,
  isThreeDimensionalContent,
} from './spatial';

export { isModelAssetPath, isThreeDimensionalContent } from './spatial';

/**
 * The delivery package: every artifact one workflow produced, grouped as one hand-over.
 *
 * The old delivery page opened one task at a time. That is the right unit for "what did this
 * seat do?", but not for "what did the company deliver to me?" — a game, its design doc and its
 * QA report arrive on different steps. This module folds the whole instance into one model so
 * the package can show the game, the document, the 3D asset and the files together.
 *
 * Pure: it only reads records the console already fetched. The page decides when to fetch.
 */

export type PackageKind = 'game' | 'document' | '3d' | 'code' | 'report';

export interface PackageFile extends DeliveredFile {
  readonly taskId: string;
  readonly stepId: string;
  readonly stepTitle: string;
  readonly taskTitle: string;
}

export interface PackageItem {
  readonly taskId: string;
  readonly stepId: string;
  readonly stepTitle: string;
  readonly title: string;
  readonly kind: PackageKind;
  readonly summary: string;
  readonly producedBy: string;
  readonly files: readonly PackageFile[];
  readonly document: DocumentPreviewModel | null;
  readonly model: Model3D | null;
  readonly is3dHtml: boolean;
  readonly isGame: boolean;
}

export interface ModelAsset {
  readonly path: string;
  readonly format: string;
  readonly taskId: string;
  readonly model: Model3D | null;
}

export interface DeliveryPackageModel {
  readonly instanceId: string;
  readonly title: string;
  readonly status: string;
  readonly items: readonly PackageItem[];
  readonly files: readonly PackageFile[];
  readonly kinds: readonly PackageKind[];
  readonly gameTaskId: string | null;
  readonly documentTaskId: string | null;
  readonly threeTaskId: string | null;
  readonly modelAsset: ModelAsset | null;
  readonly members: readonly string[];
  readonly steps: { readonly done: number; readonly total: number };
}

function isHtml(content: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(content);
}

function stepNamesOf(workflow: Row | null): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  if (workflow === null) return names;
  const raw = workflow['steps'];
  if (!Array.isArray(raw)) return names;
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const row = entry as Row;
    const stepId = readString(row['stepId'], '');
    if (stepId !== '') names.set(stepId, readString(row['name'], stepId));
  }
  return names;
}

function stepCounts(workflow: Row | null): { done: number; total: number } {
  if (workflow === null) return { done: 0, total: 0 };
  const states = Array.isArray(workflow['stepStates']) ? workflow['stepStates'] : [];
  let done = 0;
  for (const entry of states) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    if (readString((entry as Row)['status'], '') === 'done') done += 1;
  }
  const total = Array.isArray(workflow['steps']) ? workflow['steps'].length : states.length;
  return { done, total };
}

/** The best kind label for one delivered task. Game wins over code, 3D over document. */
export function packageKindOf(task: TaskRecord, files: readonly DeliveredFile[]): PackageKind {
  if (isPlayableGame(task)) return 'game';
  if (isSpatialDelivery(files)) return '3d';
  const document = documentPreviewOf(task);
  if (document !== null) return 'document';
  const kind = deliverableKind(task.result, task);
  if (kind === 'document') return 'document';
  if (kind === 'code') return 'code';
  return 'report';
}

function itemOf(
  task: TaskRecord,
  stepId: string,
  stepTitle: string,
): PackageItem {
  const files = deliveredFiles(task).map((file) => ({
    ...file,
    taskId: task.taskId,
    stepId,
    stepTitle,
    taskTitle: task.title,
  }));
  const document = documentPreviewOf(task);
  const modelFile = files.find((file) => isModelAssetPath(file.path)) ?? null;
  const is3dHtml = files.some((file) => isHtml(file.content) && isThreeDimensionalContent(file.content));
  return {
    taskId: task.taskId,
    stepId,
    stepTitle,
    title: task.title,
    kind: packageKindOf(task, files),
    summary: task.result?.summary ?? '',
    producedBy: task.result?.producedBy ?? task.assigneeEmployeeId ?? '',
    files,
    document,
    model: modelFile === null ? null : modelFromFile(modelFile.path, modelFile.content),
    is3dHtml,
    isGame: isPlayableGame(task),
  };
}

/**
 * Build the package for the workflow the anchor task belongs to.
 *
 * The anchor is always included, even when `stepStates` has not caught up (a task can be opened
 * while its step is still settling); siblings are added in workflow order and de-duplicated.
 */
export function buildDeliveryPackage(
  workflow: Row | null,
  anchor: TaskRecord,
  records: Readonly<Record<string, TaskRecord>>,
): DeliveryPackageModel {
  const names = stepNamesOf(workflow);
  const pairs = workflow === null ? [] : [...workflowStepTasks(workflow, '')];
  if (!pairs.some((pair) => pair.taskId === anchor.taskId)) {
    pairs.push({ stepId: anchor.workflowStepId ?? 'delivery', taskId: anchor.taskId });
  }

  const items: PackageItem[] = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (seen.has(pair.taskId)) continue;
    const task = records[pair.taskId] ?? (pair.taskId === anchor.taskId ? anchor : null);
    if (task === null) continue;
    seen.add(pair.taskId);
    items.push(itemOf(task, pair.stepId, names.get(pair.stepId) ?? pair.stepId));
  }

  const files = items.flatMap((item) => item.files);
  const kinds: PackageKind[] = [];
  for (const item of items) if (!kinds.includes(item.kind)) kinds.push(item.kind);

  const game = items.find((item) => item.isGame) ?? null;
  const document = items.find((item) => item.document !== null) ?? null;
  const three = items.find((item) => item.is3dHtml) ?? null;
  const model = items.find((item) => item.model !== null || item.files.some((file) => isModelAssetPath(file.path))) ?? null;
  const modelFile = model?.files.find((file) => isModelAssetPath(file.path)) ?? null;

  const members: string[] = [];
  for (const item of items) {
    if (item.producedBy !== '' && !members.includes(item.producedBy)) members.push(item.producedBy);
  }

  return {
    instanceId: anchor.workflowInstanceId ?? '',
    title: workflow === null ? anchor.title : readString(workflow['title'], anchor.title),
    status: workflow === null ? anchor.status : readString(workflow['status'], anchor.status),
    items,
    files,
    kinds,
    gameTaskId: game?.taskId ?? null,
    documentTaskId: document?.taskId ?? null,
    threeTaskId: three?.taskId ?? null,
    modelAsset: modelFile === null
      ? null
      : {
          path: modelFile.path,
          format: extensionOf(modelFile.path).replace(/^\./, '').toUpperCase(),
          taskId: modelFile.taskId,
          model: modelFromFile(modelFile.path, modelFile.content),
        },
    members,
    steps: stepCounts(workflow),
  };
}

export type DeliveryProjectState = 'running' | 'needAction' | 'completed';

/** One task inside a project block: what it is, which step it belongs to and who did it. */
export interface DeliveryProjectTask {
  readonly taskId: string;
  readonly stepId: string;
  readonly stepTitle: string;
  readonly title: string;
  readonly status: string;
  readonly contributorId: string;
  readonly positionId: string;
  readonly completed: boolean;
}

/** One person and the tasks they contributed to inside the project. */
export interface DeliveryContributor {
  readonly employeeId: string;
  readonly taskIds: readonly string[];
  readonly steps: readonly string[];
}

/**
 * A project block: one workflow instance (or one standalone task) with every task the team
 * worked on, grouped by contributor. The page renders one card per project instead of one card
 * per task, so the answer to "what did this project deliver, and who did what?" is one read.
 */
export interface DeliveryProject {
  readonly instanceId: string;
  readonly title: string;
  readonly standalone: boolean;
  readonly status: string;
  readonly gateOpen: boolean;
  readonly stepsDone: number;
  readonly stepsTotal: number;
  readonly tasks: readonly DeliveryProjectTask[];
  readonly contributors: readonly DeliveryContributor[];
  readonly anchorTaskId: string | null;
  readonly completed: number;
  readonly total: number;
  readonly state: DeliveryProjectState;
  /** The brief this instance belongs to; several attempts of one brief share it. */
  readonly correlationId: string;
  /**
   * Attempts of the same brief that delivered nothing — a failed or aborted run the operator
   * should see as history, not as a second project card next to the delivery that worked.
   */
  readonly earlierAttempts: readonly DeliveryAttempt[];
}

/** One earlier attempt of the same brief, folded under the delivery that succeeded. */
export interface DeliveryAttempt {
  readonly instanceId: string;
  readonly title: string;
  readonly status: string;
  readonly completed: number;
  readonly total: number;
}

const finishedStatus = (status: string): boolean =>
  ['completed', 'cancelled', 'canceled'].includes(status.trim().toLowerCase());

/**
 * Which completed task should a project card open?
 *
 * The first step is usually a requirement/design document, which has no runnable preview. The
 * implementation/frontend/3D task is the one that actually carries the product, so prefer it over
 * documents and QA. Ties keep workflow order.
 */
function previewAnchor(tasks: readonly DeliveryProjectTask[]): string | null {
  const rank = (task: DeliveryProjectTask): number => {
    const text = `${task.stepTitle} ${task.title}`.toLowerCase();
    if (/(implementation|frontend|backend|build|game|dashboard|3d|scene)/.test(text)) return 0;
    if (/(test|qa|verify|verification)/.test(text)) return 2;
    return 1;
  };
  const completed = tasks.filter((task) => task.completed);
  return [...completed].sort((left, right) => rank(left) - rank(right))[0]?.taskId ?? null;
}

const stoppedStatus = (status: string): boolean =>
  ['blocked', 'failed', 'rejected'].includes(status.trim().toLowerCase());

function projectState(gateOpen: boolean, tasks: readonly DeliveryProjectTask[]): DeliveryProjectState {
  if (gateOpen || tasks.some((task) => stoppedStatus(task.status))) return 'needAction';
  if (tasks.length > 0 && tasks.every((task) => finishedStatus(task.status))) return 'completed';
  return 'running';
}

function contributorsOf(tasks: readonly DeliveryProjectTask[]): readonly DeliveryContributor[] {
  const contributors: { employeeId: string; taskIds: string[]; steps: string[] }[] = [];
  for (const task of tasks) {
    const employeeId = task.contributorId;
    const existing = contributors.find((entry) => entry.employeeId === employeeId);
    if (existing === undefined) {
      contributors.push({ employeeId, taskIds: [task.taskId], steps: [task.stepTitle] });
      continue;
    }
    existing.taskIds.push(task.taskId);
    if (!existing.steps.includes(task.stepTitle)) existing.steps.push(task.stepTitle);
  }
  return contributors;
}

function projectTasks(
  workflow: Row | null,
  memberTasks: readonly Row[],
): readonly DeliveryProjectTask[] {
  const byId = new Map(memberTasks.map((task) => [readString(task['taskId'], ''), task]));
  const ordered: DeliveryProjectTask[] = [];
  const seen = new Set<string>();
  const pairs = workflow === null ? [] : workflowStepTasks(workflow, '');
  const names = stepNamesOf(workflow);
  const add = (task: Row, stepId: string): void => {
    const taskId = readString(task['taskId'], '');
    if (taskId === '' || seen.has(taskId)) return;
    seen.add(taskId);
    const status = readString(task['status'], '');
    ordered.push({
      taskId,
      stepId,
      stepTitle: names.get(stepId) ?? (workflow === null ? '' : stepId),
      title: readString(task['title'], taskId),
      status,
      contributorId: readString(task['assigneeEmployeeId'], ''),
      positionId: readString(task['positionId'], ''),
      completed: status.trim().toLowerCase() === 'completed',
    });
  };
  for (const pair of pairs) {
    const task = byId.get(pair.taskId);
    if (task !== undefined) add(task, pair.stepId);
  }
  for (const task of memberTasks) {
    const stepId = readString(task['workflowStepId'], 'delivery');
    add(task, stepId === '' ? 'delivery' : stepId);
  }
  return ordered;
}

/**
 * Group the workspace by project before rendering.
 *
 * Every workflow instance with at least one task becomes one project; a task with no instance
 * becomes a project of one. `state` mirrors the three CEO filters (Need action, Running,
 * Completed) while `tasks` keeps the step order so the block can show who did what.
 */
export function deliveryProjects(
  tasks: readonly Row[],
  workflows: readonly Row[],
): readonly DeliveryProject[] {
  const workflowById = new Map<string, Row>();
  for (const workflow of workflows) {
    const instanceId = readString(workflow['instanceId'], '');
    if (instanceId !== '') workflowById.set(instanceId, workflow);
  }

  const projects: DeliveryProject[] = [];
  for (const [instanceId, workflow] of workflowById) {
    const memberTasks = tasks.filter((task) => readString(task['workflowInstanceId'], '') === instanceId);
    if (memberTasks.length === 0) continue;
    const projectTasksList = projectTasks(workflow, memberTasks);
    const approval = workflow['approval'];
    const gateOpen = typeof approval === 'object' && approval !== null && !Array.isArray(approval)
      && readString((approval as Row)['status'], '') === 'open';
    const counts = stepCounts(workflow);
    const anchor = previewAnchor(projectTasksList);
    projects.push({
      instanceId,
      title: readString(workflow['title'], instanceId),
      standalone: false,
      status: readString(workflow['status'], ''),
      gateOpen,
      stepsDone: counts.done,
      stepsTotal: counts.total,
      tasks: projectTasksList,
      contributors: contributorsOf(projectTasksList),
      anchorTaskId: anchor,
      completed: projectTasksList.filter((task) => task.completed).length,
      total: projectTasksList.length,
      state: projectState(gateOpen, projectTasksList),
      correlationId: readString(workflow['correlationId'], ''),
      earlierAttempts: [],
    });
  }

  // A task can outlive the workflow row a poll carried in: keep it visible as its own project
  // under the instance id rather than dropping work the operator can still open.
  const orphanByInstance = new Map<string, Row[]>();
  for (const task of tasks) {
    const instanceId = readString(task['workflowInstanceId'], '');
    if (instanceId === '' || workflowById.has(instanceId)) continue;
    const memberTasks = orphanByInstance.get(instanceId) ?? [];
    memberTasks.push(task);
    orphanByInstance.set(instanceId, memberTasks);
  }
  for (const [instanceId, memberTasks] of orphanByInstance) {
    const parsed = projectTasks(null, memberTasks);
    projects.push({
      instanceId,
      title: readString(memberTasks[0]?.['title'], instanceId),
      standalone: false,
      status: '',
      gateOpen: false,
      stepsDone: 0,
      stepsTotal: 0,
      tasks: parsed,
      contributors: contributorsOf(parsed),
      anchorTaskId: previewAnchor(parsed),
      completed: parsed.filter((task) => task.completed).length,
      total: parsed.length,
      state: projectState(false, parsed),
      correlationId: readString(memberTasks[0]?.['correlationId'], ''),
      earlierAttempts: [],
    });
  }

  for (const task of tasks) {
    if (readString(task['workflowInstanceId'], '') !== '') continue;
    const taskId = readString(task['taskId'], '');
    if (taskId === '') continue;
    const parsed = projectTasks(null, [task]);
    const status = readString(task['status'], '');
    projects.push({
      instanceId: taskId,
      title: readString(task['title'], taskId),
      standalone: true,
      status,
      gateOpen: false,
      stepsDone: 0,
      stepsTotal: 0,
      tasks: parsed,
      contributors: contributorsOf(parsed),
      anchorTaskId: status.trim().toLowerCase() === 'completed' ? taskId : null,
      completed: status.trim().toLowerCase() === 'completed' ? 1 : 0,
      total: 1,
      state: projectState(false, parsed),
      correlationId: readString(task['correlationId'], ''),
      earlierAttempts: [],
    });
  }

  // A product can have an early aborted/simplified run and a later complete one under the same
  // title. The workspace is "one project per block", so keep the richest run; showing both gave
  // the same name twice and the operator could open the 1/2 placeholder instead of the real 5/5
  // delivery.
  const byTitle = new Map<string, DeliveryProject>();
  for (const project of projects) {
    const key = project.title.trim().toLowerCase() || project.instanceId;
    const existing = byTitle.get(key);
    if (existing === undefined) {
      byTitle.set(key, project);
      continue;
    }
    const richer = (project.completed * 1000 + project.total * 10 + project.stepsTotal)
      > (existing.completed * 1000 + existing.total * 10 + existing.stepsTotal);
    if (richer) byTitle.set(key, project);
  }

  const rank: Record<DeliveryProjectState, number> = { needAction: 0, running: 1, completed: 2 };
  return [...foldAttempts([...byTitle.values()])].sort((left, right) =>
    rank[left.state] - rank[right.state] || left.title.localeCompare(right.title));
}

/**
 * One brief, several attempts: show the delivery that worked, not the failures beside it.
 *
 * The same brief can produce a failed or aborted instance and a later complete one — they share
 * a `correlationId` and read as one project to the operator. Attempts that delivered nothing are
 * folded into the best card of that brief and listed as "earlier attempts"; anything that did
 * deliver keeps its own card (a hiring or promotion run is a separate project, not a retry).
 */
function foldAttempts(projects: readonly DeliveryProject[]): readonly DeliveryProject[] {
  const groups = new Map<string, DeliveryProject[]>();
  for (const project of projects) {
    const key = project.correlationId === '' ? `instance:${project.instanceId}` : `correlation:${project.correlationId}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [project]);
    else list.push(project);
  }
  const out: DeliveryProject[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0] as DeliveryProject);
      continue;
    }
    const ranked = [...group].sort((left, right) =>
      right.completed - left.completed
      || right.total - left.total
      || (left.state === 'completed' ? -1 : 1) - (right.state === 'completed' ? -1 : 1));
    const best = ranked[0] as DeliveryProject;
    const delivered = group.filter((project) => project.completed > 0 && project !== best);
    const empty = group.filter((project) => project.completed === 0);
    out.push(...delivered);
    out.push(empty.length === 0
      ? best
      : {
          ...best,
          earlierAttempts: [
            ...best.earlierAttempts,
            ...empty.map((project): DeliveryAttempt => ({
              instanceId: project.instanceId,
              title: project.title,
              status: project.status === '' ? project.state : project.status,
              completed: project.completed,
              total: project.total,
            })),
          ],
        });
  }
  return out;
}

/** The task ids a package needs, so the page can fetch all records in one effect. */
export function packageTaskIds(workflow: Row | null, anchor: TaskRecord): readonly string[] {
  if (workflow === null) return [anchor.taskId];
  const ids = workflowStepTasks(workflow, '').map((pair) => pair.taskId);
  if (!ids.includes(anchor.taskId)) ids.push(anchor.taskId);
  return [...new Set(ids)];
}

/** Files grouped by step, preserving workflow order. */
export function filesByStep(files: readonly PackageFile[]): readonly {
  readonly stepId: string;
  readonly stepTitle: string;
  readonly files: readonly PackageFile[];
}[] {
  const groups: { stepId: string; stepTitle: string; files: PackageFile[] }[] = [];
  for (const file of files) {
    const group = groups.find((entry) => entry.stepId === file.stepId);
    if (group === undefined) groups.push({ stepId: file.stepId, stepTitle: file.stepTitle, files: [file] });
    else group.files.push(file);
  }
  return groups;
}
