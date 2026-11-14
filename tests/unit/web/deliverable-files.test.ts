import { describe, expect, it } from 'vitest';
import { parseTaskRecord, type Row, type TaskRecord } from '../../../apps/web/src/api';
import { deliveredFiles, fileName, workflowStepTasks } from '../../../apps/web/src/results';

/**
 * The whole-delivery panel: the pure logic behind "my organization built a frontend *and* a
 * backend, let me keep all of it".
 *
 * A capability-shaped delivery carries its files inside `result.data.files`, while an older one
 * only names them in `result.artifacts`, and the workflow instance is the only place that knows
 * which sibling step delivered what. All three reads are defensive by contract — `result.data`
 * is `Record<string, unknown>` and `stepStates` arrives as JSON — so the property that matters
 * most here is that malformed input degrades to fewer entries, never to a thrown page.
 */

const baseRow: Row = {
  taskId: 'task-frontend',
  title: 'Build the operator console frontend',
  status: 'completed',
  goal: 'Ship a SPA the operator can open',
  detail: null,
  positionId: 'cto',
  assigneeEmployeeId: 'cto-john',
  workflowInstanceId: 'instance-1',
  workflowStepId: 'frontend',
  attempt: 1,
  maxAttempts: 3,
  createdAtSim: 4,
  completedAtSim: 9,
  blockedReason: null,
  rejectReason: null,
  outputs: ['artifact-frontend'],
  result: {
    taskId: 'task-frontend',
    producedBy: 'cto-john',
    summary: 'The console ships with a typed client and a Python seed API.',
    data: { name: 'Frontend', entrypoint: 'client/index.html', content: '<!doctype html>' },
    artifacts: ['client/index.html', 'README.md'],
  },
  reviews: [],
  verification: null,
};

function record(result?: unknown): TaskRecord {
  return parseTaskRecord(
    result === undefined ? baseRow : { ...baseRow, result },
    'GET /api/tasks/task-frontend',
  );
}

const files = [
  { path: 'client/index.html', language: 'html', content: '<!doctype html>' },
  { path: 'client/app.js', language: 'javascript', content: 'console.log(1);' },
];

const baseResult = baseRow['result'] as Row;

describe('deliveredFiles', () => {
  it('reads the enumerated files in submission order, with their metadata', () => {
    const task = record({ ...baseResult, data: { ...baseResult['data'] as Row, files }, artifacts: [] });
    expect(deliveredFiles(task)).toEqual(files);
  });

  it('falls back to artifacts when the delivery predates files, keeping the entry text', () => {
    // `content` in `result.data` belongs to `entrypoint`, so only that artifact can carry text.
    expect(deliveredFiles(record())).toEqual([
      { path: 'client/index.html', language: '', content: '<!doctype html>' },
      { path: 'README.md', language: '', content: '' },
    ]);
  });

  it('drops entries that are not a usable file instead of throwing', () => {
    const task = record({
      ...baseResult,
      data: { ...baseResult['data'] as Row, files: [null, 'client/index.html', 42, files[0], { path: '   ' }, { path: 'client/app.js' }] },
      artifacts: [],
    });
    expect(deliveredFiles(task)).toEqual([
      { path: 'client/index.html', language: 'html', content: '<!doctype html>' },
      { path: 'client/app.js', language: '', content: '' },
    ]);
  });

  it('collapses duplicates by path, letting the richer first record win', () => {
    const task = record({
      ...baseResult,
      data: { ...baseResult['data'] as Row, files: [files[0], { path: 'client/index.html', language: 'html', content: 'stale' }] },
      artifacts: [],
    });
    expect(deliveredFiles(task)).toEqual([files[0]]);
  });

  it('keeps artifacts the enumerated files did not already cover', () => {
    const task = record({
      ...baseResult,
      data: { ...baseResult['data'] as Row, files },
      artifacts: ['README.md', 'client/app.js'],
    });
    expect(deliveredFiles(task).map((file) => file.path)).toEqual(['client/index.html', 'client/app.js', 'README.md']);
  });

  it('sees a single-file delivery exposed as an index.html data key', () => {
    const task = record({
      ...baseResult,
      data: { 'index.html': '<!doctype html><canvas id="board"></canvas>', playable: true },
      artifacts: [],
    });
    expect(deliveredFiles(task)).toEqual([
      { path: 'index.html', language: 'html', content: '<!doctype html><canvas id="board"></canvas>' },
    ]);
  });

  it('reads a task with no delivery as no files', () => {
    expect(deliveredFiles(record(null))).toEqual([]);
  });

  it('survives a files field that is not an array', () => {
    const task = record({ ...baseResult, data: { ...baseResult['data'] as Row, files: 'client/index.html' } });
    // The string is not a file list, so the two named artifacts are what remains.
    expect(deliveredFiles(task).map((file) => file.path)).toEqual(['client/index.html', 'README.md']);
  });
});

describe('workflowStepTasks', () => {
  const workflow: Row = {
    workflowInstanceId: 'instance-1',
    stepStates: [
      { stepId: 'implementation', status: 'done', taskId: 'task-plan' },
      { stepId: 'frontend', status: 'done', taskId: 'task-frontend' },
      { stepId: 'backend', status: 'done', taskId: 'task-backend' },
      { stepId: 'release', status: 'active', taskId: null },
    ],
  };

  it('reads the deliveries in step order, excluding the task that is already on the page', () => {
    expect(workflowStepTasks(workflow, 'task-frontend')).toEqual([
      { stepId: 'implementation', taskId: 'task-plan' },
      { stepId: 'backend', taskId: 'task-backend' },
    ]);
  });

  it('keeps every step when the current task is not part of the workflow', () => {
    expect(workflowStepTasks(workflow, 'task-elsewhere').map((step) => step.taskId)).toEqual([
      'task-plan',
      'task-frontend',
      'task-backend',
    ]);
  });

  it('reads a missing workflow, a missing field and a non-array stepStates as no steps', () => {
    expect(workflowStepTasks(null, 'task-frontend')).toEqual([]);
    expect(workflowStepTasks({ workflowInstanceId: 'instance-1' }, 'task-frontend')).toEqual([]);
    expect(workflowStepTasks({ stepStates: 'implementation' }, 'task-frontend')).toEqual([]);
  });

  it('skips entries that are not objects, and steps whose taskId is null or empty', () => {
    const odd: Row = {
      // An absent `taskId` must stay empty, not become `readString`'s `'taskId'` default — the
      // reader supplies its own fallback so a half-written step never looks like a delivery.
      stepStates: [
        null, 'frontend', 7, [], { status: 'done' }, { stepId: 'a', taskId: '' },
        { taskId: null }, {}, { taskId: 'task-a' }, { stepId: 'e', taskId: 'task-e' },
      ],
    };
    expect(workflowStepTasks(odd, 'task-frontend')).toEqual([
      { stepId: 'step-9', taskId: 'task-a' },
      { stepId: 'e', taskId: 'task-e' },
    ]);
  });
});

describe('fileName', () => {
  it('keeps the last segment of a delivered path, for the download name', () => {
    expect(fileName('client/index.html')).toBe('index.html');
    expect(fileName('api/app/main.py')).toBe('main.py');
    expect(fileName('README.md')).toBe('README.md');
  });

  it('handles a Windows path the operator may have pasted', () => {
    expect(fileName('client\\src\\main.py')).toBe('main.py');
  });

  it('trims whitespace instead of shipping a padded filename', () => {
    expect(fileName('  client/index.html  ')).toBe('index.html');
  });

  it('never returns an empty name for an odd path', () => {
    expect(fileName('client/')).toBe('client/');
    expect(fileName('')).toBe('');
  });
});
