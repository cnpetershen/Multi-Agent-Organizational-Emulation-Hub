import { describe, expect, it } from 'vitest';
import type { Row, TaskRecord } from '../../../apps/web/src/api';
import {
  buildDeliveryPackage,
  deliveryProjects,
  filesByStep,
  packageKindOf,
  packageTaskIds,
  isThreeDimensionalContent,
} from '../../../apps/web/src/delivery-package';
import { deliveredFiles } from '../../../apps/web/src/results';

/**
 * The package is the "one hand-over" view: a design doc, a playable game and a 3D asset from
 * three different steps must become one model with three previewable slots. These fixtures use
 * the exact result shape the API returns (`data.files[]` plus `artifacts[]`).
 */

function task(overrides: Partial<TaskRecord> & { taskId: string }): TaskRecord {
  return {
    taskId: overrides.taskId,
    title: overrides.title ?? overrides.taskId,
    status: 'completed',
    goal: '',
    detail: null,
    positionId: null,
    assigneeEmployeeId: null,
    workflowInstanceId: 'instance-1',
    workflowStepId: null,
    attempt: 1,
    maxAttempts: 1,
    createdAtSim: 0,
    completedAtSim: 1,
    blockedReason: null,
    rejectReason: null,
    outputs: [],
    result: null,
    reviews: [],
    verification: null,
    ...overrides,
  };
}

function withFiles(id: string, title: string, files: readonly { path: string; language: string; content: string }[], extra: Row = {}): TaskRecord {
  return task({
    taskId: id,
    title,
    result: {
      taskId: id,
      producedBy: 'engineer',
      summary: `${title} delivered`,
      data: { files, ...extra },
      artifacts: files.map((file) => file.path),
    },
  });
}

const workflow: Row = {
  instanceId: 'instance-1',
  title: '3D product tour',
  status: 'completed',
  steps: [
    { stepId: 'design', name: 'Design' },
    { stepId: 'build', name: 'Build' },
    { stepId: 'scene', name: '3D scene' },
  ],
  stepStates: [
    { stepId: 'design', status: 'done', taskId: 'task-design' },
    { stepId: 'build', status: 'done', taskId: 'task-game' },
    { stepId: 'scene', status: 'done', taskId: 'task-model' },
  ],
};

describe('delivery package', () => {
  const design = withFiles('task-design', 'Design document', [
    { path: 'design.md', language: 'markdown', content: '# Design\n\nA tour.' },
  ]);
  const game = withFiles('task-game', 'Tic-Tac-Toe', [
    { path: 'index.html', language: 'html', content: '<!doctype html><canvas id="board"></canvas><script>play()</script>' },
  ], { playable: true });
  const model = withFiles('task-model', 'Product model', [
    { path: 'scene/product.obj', language: 'text', content: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3' },
  ]);
  const records = { 'task-design': design, 'task-game': game, 'task-model': model };

  it('folds the whole instance into one package with one slot per preview kind', () => {
    const pkg = buildDeliveryPackage(workflow, design, records);
    expect(pkg.title).toBe('3D product tour');
    expect(pkg.items).toHaveLength(3);
    expect(pkg.kinds).toEqual(['document', 'game', '3d']);
    expect(pkg.gameTaskId).toBe('task-game');
    expect(pkg.documentTaskId).toBe('task-design');
    expect(pkg.modelAsset?.path).toBe('scene/product.obj');
    expect(pkg.modelAsset?.model?.format).toBe('obj');
    expect(pkg.files).toHaveLength(3);
    expect(pkg.members).toEqual(['engineer']);
    expect(pkg.steps).toEqual({ done: 3, total: 3 });
  });

  it('always includes the anchor and asks for every sibling record', () => {
    expect(packageTaskIds(workflow, design)).toEqual(['task-design', 'task-game', 'task-model']);
    const onlyAnchor = buildDeliveryPackage(null, design, {});
    expect(onlyAnchor.items.map((item) => item.taskId)).toEqual(['task-design']);
  });

  it('groups package files by step without losing order', () => {
    const pkg = buildDeliveryPackage(workflow, design, records);
    const groups = filesByStep(pkg.files);
    expect(groups.map((group) => group.stepTitle)).toEqual(['Design', 'Build', '3D scene']);
  });

  it('recognises a 3D HTML scene as 3D, not as a document', () => {
    expect(isThreeDimensionalContent('<!doctype html><script src="three.min.js"></script><canvas></canvas>')).toBe(true);
    expect(isThreeDimensionalContent('<h1>plain</h1>')).toBe(false);
    const scene = withFiles('task-scene', '3D page', [
      { path: 'index.html', language: 'html', content: '<!doctype html><script src="three.min.js"></script><canvas></canvas>' },
    ]);
    expect(packageKindOf(scene, deliveredFiles(scene))).toBe('3d');
  });

  it('folds tasks into one project block with contributor rows', () => {
    const projects = deliveryProjects([
      { taskId: 'task-design', title: 'Design', status: 'completed', workflowInstanceId: 'instance-1', workflowStepId: 'design', assigneeEmployeeId: 'bea', positionId: 'designer' },
      { taskId: 'task-game', title: 'Game', status: 'running', workflowInstanceId: 'instance-1', workflowStepId: 'build', assigneeEmployeeId: 'ada', positionId: 'engineer' },
      { taskId: 'task-alone', title: 'Standalone', status: 'completed', workflowInstanceId: null, assigneeEmployeeId: 'cy', positionId: 'analyst' },
    ], [{ ...workflow, status: 'running' }]);
    expect(projects.map((project) => [project.title, project.state, project.completed, project.total])).toEqual([
      ['3D product tour', 'running', 1, 2],
      ['Standalone', 'completed', 1, 1],
    ]);
    expect(projects[0]?.tasks.map((task) => [task.stepId, task.stepTitle, task.contributorId])).toEqual([
      ['design', 'Design', 'bea'],
      ['build', 'Build', 'ada'],
    ]);
    expect(projects[0]?.contributors.map((contributor) => [contributor.employeeId, contributor.taskIds])).toEqual([
      ['bea', ['task-design']],
      ['ada', ['task-game']],
    ]);
    expect(projects[0]?.anchorTaskId).toBe('task-design');
    expect(projects[1]?.standalone).toBe(true);
  });

  it('opens the implementation task, not the first requirement document', () => {
    const projects = deliveryProjects([
      { taskId: 'task-req', title: 'Product Requirement', status: 'completed', workflowInstanceId: 'instance-1', workflowStepId: 'step-1', assigneeEmployeeId: 'bea' },
      { taskId: 'task-build', title: 'Implementation', status: 'completed', workflowInstanceId: 'instance-1', workflowStepId: 'step-3', assigneeEmployeeId: 'ada' },
      { taskId: 'task-test', title: 'Testing', status: 'completed', workflowInstanceId: 'instance-1', workflowStepId: 'step-4', assigneeEmployeeId: 'cy' },
    ], [workflow]);
    expect(projects[0]?.anchorTaskId).toBe('task-build');
  });


  it('keeps one project block per title, choosing the richer run', () => {
    const projects = deliveryProjects([
      { taskId: 'old-a', title: 'Old', status: 'completed', workflowInstanceId: 'old', assigneeEmployeeId: 'bea' },
      { taskId: 'old-b', title: 'Old', status: 'created', workflowInstanceId: 'old', assigneeEmployeeId: 'ada' },
      { taskId: 'new-a', title: 'New', status: 'completed', workflowInstanceId: 'new', assigneeEmployeeId: 'bea' },
      { taskId: 'new-b', title: 'New', status: 'completed', workflowInstanceId: 'new', assigneeEmployeeId: 'ada' },
    ], [
      { ...workflow, instanceId: 'old', title: 'Fish', steps: [{ stepId: 'a', name: 'Requirement' }, { stepId: 'b', name: 'Implementation' }], stepStates: [{ stepId: 'a', status: 'done', taskId: 'old-a' }, { stepId: 'b', status: 'pending', taskId: 'old-b' }] },
      { ...workflow, instanceId: 'new', title: 'Fish', steps: [{ stepId: 'a', name: 'Requirement' }, { stepId: 'b', name: 'Implementation' }], stepStates: [{ stepId: 'a', status: 'done', taskId: 'new-a' }, { stepId: 'b', status: 'done', taskId: 'new-b' }] },
    ]);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.completed).toBe(2);
    expect(projects[0]?.anchorTaskId).toBe('new-b');
  });

  it('keeps unassigned work visible in an unassigned contributor row', () => {
    const projects = deliveryProjects([
      { taskId: 'task-unassigned', title: 'Waiting on a seat', status: 'assigned', workflowInstanceId: 'instance-1', assigneeEmployeeId: null },
    ], [workflow]);
    expect(projects[0]?.tasks).toHaveLength(1);
    expect(projects[0]?.contributors.map((contributor) => contributor.employeeId)).toEqual(['']);
  });

  it('a project with an open gate needs the owner even while its tasks run', () => {
    const gated = { ...workflow, status: 'running', approval: { stepId: 'review', status: 'open', requiredCount: 1, grantedBy: [] } };
    const projects = deliveryProjects([
      { taskId: 'task-design', title: 'Design', status: 'running', workflowInstanceId: 'instance-1', assigneeEmployeeId: 'bea' },
    ], [gated]);
    expect(projects[0]?.state).toBe('needAction');
    expect(projects[0]?.gateOpen).toBe(true);
  });

  it('keeps an unsupported model file visible as an asset', () => {
    const glb = withFiles('task-glb', 'Binary model', [
      { path: 'scene/product.glb', language: 'binary', content: '' },
    ]);
    const pkg = buildDeliveryPackage(null, glb, {});
    expect(pkg.modelAsset?.path).toBe('scene/product.glb');
    expect(pkg.modelAsset?.model).toBeNull();
    expect(pkg.kinds).toEqual(['3d']);
  });
});

