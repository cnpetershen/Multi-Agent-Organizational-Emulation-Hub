import { describe, expect, it } from 'vitest';
import { parseTaskRecord, type Row, type TaskRecord } from '../../../apps/web/src/api';
import { parseRoute, resultsPath } from '../../../apps/web/src/router';
import {
  contributions,
  creatorLabel,
  deliverableFile,
  deliverableKind,
  deliverableView,
  humanizeStep,
  resultsState,
  taskJourney,
  workflowJourney,
} from '../../../apps/web/src/results';

/**
 * M1.5 Delivery centre: the pure logic behind `/results/:taskId`.
 *
 * The delivery page answers "my AI company did the work — here is what it hands back", so the
 * model behind it is pinned without a render: the one deep link the console owns, the three
 * states the Actions section branches on, the shape of the delivered artifact, the journey and
 * the roles behind it. Three properties matter more than any single case: a lookup that cannot
 * be resolved must never print an id, delivered content must never fall off the page, and a
 * state must keep its tone regardless of locale.
 */

const positions = [
  { positionId: 'ceo', title: 'Chief Executive Officer' },
  { positionId: 'cto', title: 'Chief Technology Officer' },
  { positionId: 'qa', title: 'QA Engineer' },
];

const employees = [
  { employeeId: 'ceo-alex', name: 'Alex', positionId: 'ceo' },
  { employeeId: 'cto-john', name: 'John', positionId: 'cto' },
  { employeeId: 'qa-sara', name: 'Sara', positionId: 'qa' },
];

const baseRow: Row = {
  taskId: 'task-1',
  title: 'Quantify Q3 churn',
  status: 'completed',
  goal: 'Publish the churn driver table with sources',
  detail: 'Enterprise accounts only',
  positionId: 'cto',
  assigneeEmployeeId: 'cto-john',
  workflowInstanceId: 'instance-1',
  workflowStepId: 'analysis',
  attempt: 1,
  maxAttempts: 3,
  createdAtSim: 4,
  completedAtSim: 9,
  blockedReason: null,
  rejectReason: null,
  outputs: ['artifact-churn-table'],
  result: {
    taskId: 'task-1',
    producedBy: 'cto-john',
    summary: 'The churn driver table is published with citations.',
    data: { findings: ['onboarding friction'], method: 'cohort split' },
    artifacts: ['artifact-churn-table'],
  },
  reviews: [{ reviewerId: 'qa-sara', verdict: 'approved', reason: 'meets the brief' }],
  verification: { kind: 'deterministic', requiredOutputKeys: ['findings'] },
};

function record(overrides: Row = {}): TaskRecord {
  return parseTaskRecord({ ...baseRow, ...overrides }, 'GET /api/tasks/task-1');
}

describe('delivery routes', () => {
  it('addresses one task and nothing else', () => {
    expect(parseRoute('/results/task-9')).toEqual({ kind: 'results', taskId: 'task-9' });
    expect(parseRoute('/results/task-9/')).toEqual({ kind: 'results', taskId: 'task-9' });
    expect(parseRoute('/results/')).toEqual({ kind: 'console' });
    expect(parseRoute('/results')).toEqual({ kind: 'console' });
    expect(parseRoute('/')).toEqual({ kind: 'console' });
    expect(parseRoute('/deliverables')).toEqual({ kind: 'console' });
  });

  it('round-trips an encoded id instead of pasting it in raw', () => {
    const path = resultsPath('task 1/x');
    expect(path).toBe('/results/task%201%2Fx');
    expect(parseRoute(path)).toEqual({ kind: 'results', taskId: 'task 1/x' });
  });

  it('sends a malformed escape back to the shell instead of throwing', () => {
    expect(parseRoute('/results/%E0%A4%A')).toEqual({ kind: 'console' });
    expect(parseRoute('/results/%20')).toEqual({ kind: 'console' });
  });
});

describe('delivery states', () => {
  it('reads finished, running and cancelled work from the task status', () => {
    expect(resultsState('completed')).toEqual({ kind: 'completed', tone: 'ok', labelKey: 'results.state.completed' });
    expect(resultsState('started')).toEqual({ kind: 'running', tone: 'neutral', labelKey: 'results.state.running' });
    expect(resultsState('')).toEqual({ kind: 'running', tone: 'neutral', labelKey: 'results.state.running' });
    expect(resultsState('cancelled')).toEqual({ kind: 'cancelled', tone: 'muted', labelKey: 'status.cancelled' });
  });

  it('reads stopped work as failed, keeping its own label and tone per status', () => {
    expect(resultsState('failed')).toEqual({ kind: 'failed', tone: 'bad', labelKey: 'results.state.failed' });
    expect(resultsState('rejected')).toEqual({ kind: 'failed', tone: 'bad', labelKey: 'status.rejected' });
    expect(resultsState('blocked')).toEqual({ kind: 'failed', tone: 'warn', labelKey: 'status.blocked' });
  });
});

describe('delivered artifact shape', () => {
  it('reads code, document and report deliveries from what was delivered', () => {
    expect(deliverableKind(null)).toBe('report');
    expect(deliverableKind({ data: { stack: 'TypeScript' }, artifacts: [] })).toBe('code');
    expect(deliverableKind({ data: {}, artifacts: ['main.py'] })).toBe('code');
    expect(deliverableKind({ data: { content: 'brief text' }, artifacts: [] })).toBe('document');
    expect(deliverableKind({ data: {}, artifacts: ['notes.md'] })).toBe('document');
    expect(deliverableKind({ data: { findings: ['friction'] }, artifacts: [] })).toBe('report');
  });

  it('calls a delivered dashboard with a script runnable code, not a document', () => {
    const dashboard = record({
      title: 'Implementation',
      result: {
        taskId: 'task-1',
        producedBy: 'engineer',
        summary: 'A content generation dashboard.',
        data: {
          'index.html': '<!doctype html><html><body><div id="app"></div><script>renderBoard();</script></body></html>',
        },
        artifacts: [],
      },
    });
    expect(deliverableKind(dashboard.result, dashboard)).toBe('code');
  });

  it('calls a delivered Markdown file a document, not a report', () => {
    const document = record({
      title: 'Product Requirement',
      result: {
        taskId: 'task-1',
        producedBy: 'analyst',
        summary: 'A requirements document.',
        data: { 'product-requirement-spec.md': '# Requirements\n\nBody' },
        artifacts: [],
      },
    });
    expect(deliverableKind(document.result, document)).toBe('document');
  });

  it('calls a CSS 3D scene a 3D delivery, not a report or document', () => {
    const scene = record({
      title: '3D product tour',
      result: {
        taskId: 'task-1',
        producedBy: 'engineer',
        summary: 'A rotatable CSS 3D product tour.',
        data: {
          files: [
            { path: 'index.html', language: 'html', content: '<!doctype html><style>.s{perspective:900px;transform-style:preserve-3d;transform:rotateY(20deg)}</style>' },
            { path: 'design.md', language: 'markdown', content: '# Design' },
          ],
        },
        artifacts: [],
      },
    });
    expect(deliverableKind(scene.result, scene)).toBe('3d');
  });

  it('calls a playable index.html a game instead of a document', () => {
    const game = record({
      title: 'Tic-Tac-Toe',
      result: {
        taskId: 'task-1',
        producedBy: 'engineer',
        summary: 'A playable SVG tic-tac-toe board.',
        data: {
          'index.html': '<!doctype html><html><body><svg></svg><script>document.addEventListener("click", play);</script></body></html>',
        },
        artifacts: ['index.html'],
      },
    });
    expect(deliverableKind(game.result, game)).toBe('game');
  });

  it('names the delivery, its stack and its links without ever inventing a label', () => {
    const task = record({
      result: {
        taskId: 'task-1',
        producedBy: 'cto-john',
        summary: 'A working prototype for the churn dashboard.',
        data: {
          project: 'churn-dashboard',
          stack: 'TypeScript, React',
          repository: 'https://example.invalid/repo',
          demo: 'https://example.invalid/demo',
        },
        artifacts: ['dashboard.tsx'],
      },
    });
    const view = deliverableView(task, 'code');
    expect(view.name).toBe('churn-dashboard');
    expect(view.description).toBe('A working prototype for the churn dashboard.');
    expect(view.stack).toEqual(['TypeScript', 'React']);
    expect(view.codeUrl).toBe('https://example.invalid/repo');
    expect(view.demoUrl).toBe('https://example.invalid/demo');
    expect(view.files).toEqual(['dashboard.tsx']);
  });

  it('previews a document and keeps everything else it delivered', () => {
    const task = record({
      result: {
        taskId: 'task-1',
        producedBy: 'cto-john',
        summary: 'The Q3 operating brief, ready for review.',
        data: { content: 'Churn is concentrated in the first 30 days.', author: 'Mira' },
        artifacts: [],
      },
    });
    const view = deliverableView(task, 'document');
    expect(view.preview).toBe('Churn is concentrated in the first 30 days.');
    expect(view.details).toEqual([{ label: 'author', value: 'Mira' }]);
  });

  it('leads a report with its conclusions and keeps every other delivered key', () => {
    const task = record({
      result: {
        taskId: 'task-1',
        producedBy: 'cto-john',
        summary: 'Onboarding friction is the driver.',
        data: { findings: ['onboarding friction'], method: 'cohort split', risks: { survey: 'small sample' } },
        artifacts: [],
      },
    });
    const view = deliverableView(task, 'report');
    expect(view.conclusions).toEqual([{ label: 'findings', value: ['onboarding friction'] }]);
    expect(view.details.map((fact) => fact.label)).toEqual(['method', 'risks']);
    expect(view.name).toBe('Quantify Q3 churn');
    expect(view.preview).toBe('');
    expect(view.files).toEqual([]);
  });
});

describe('work journey', () => {
  it('reads the workflow path from step status, in the instance order', () => {
    const journey = workflowJourney({
      stepStates: [
        { stepId: 'requirement-analysis', status: 'done' },
        { stepId: 'build_api', status: 'active' },
        { stepId: 'release', status: 'skipped' },
        { stepId: 'handover', status: 'rejected' },
        { stepId: 'unknown-step', status: 'mystery' },
      ],
    });
    expect(journey.map((step) => step.label)).toEqual([
      'Requirement analysis',
      'Build api',
      'Release',
      'Handover',
      'Unknown step',
    ]);
    expect(journey.map((step) => step.state)).toEqual(['done', 'current', 'pending', 'stopped', 'pending']);
    expect(journey.every((step) => step.labelKey === null)).toBe(true);
  });

  it('has no journey to show when the task stands alone or carries none', () => {
    expect(workflowJourney(null)).toEqual([]);
    expect(workflowJourney({})).toEqual([]);
    expect(humanizeStep('')).toBe('');
  });

  it('gives a standalone task three readable phases', () => {
    expect(taskJourney('completed').map((step) => step.state)).toEqual(['done', 'done', 'done']);
    expect(taskJourney('created').map((step) => step.state)).toEqual(['current', 'pending', 'pending']);
    expect(taskJourney('submitted').map((step) => step.state)).toEqual(['done', 'done', 'current']);
    expect(taskJourney('failed').map((step) => step.state)).toEqual(['done', 'stopped', 'stopped']);
    expect(taskJourney('failed').every((step) => step.labelKey !== null)).toBe(true);
  });
});

describe('who delivered it', () => {
  it('names roles and people, never ids', () => {
    const roles = contributions({
      positions,
      employees,
      positionId: 'cto',
      assigneeEmployeeId: 'cto-john',
      producedBy: 'cto-john',
      reviews: [{ reviewerId: 'qa-sara', verdict: 'approved' }],
    });
    expect(roles).toEqual([
      {
        roleTitle: 'Chief Technology Officer',
        personName: 'John',
        lines: [
          { labelKey: 'results.contribution.owns', value: null },
          { labelKey: 'results.contribution.delivered', value: null },
        ],
      },
      {
        roleTitle: 'QA Engineer',
        personName: 'Sara',
        lines: [{ labelKey: 'results.contribution.reviewed', value: 'approved' }],
      },
    ]);
    expect(JSON.stringify(roles)).not.toContain('cto-john');
    expect(JSON.stringify(roles)).not.toContain('position-');
  });

  it('contributes nothing for a role the organization does not know', () => {
    expect(contributions({
      positions,
      employees,
      positionId: 'ghost-position',
      assigneeEmployeeId: 'ghost-employee',
      producedBy: 'ghost-employee',
      reviews: [{ reviewerId: 'ghost-employee', verdict: 'rejected' }],
    })).toEqual([]);
  });

  it('falls back to the CEO copy when no initiator resolves to a person', () => {
    const workflow: Row = { initiatedBy: 'ceo-alex' };
    expect(creatorLabel(workflow, employees, positions)).toBe('Chief Executive Officer · Alex');
    expect(creatorLabel({ initiatedBy: 'ghost' }, employees, positions)).toBe('');
    expect(creatorLabel({}, employees, positions)).toBe('');
    expect(creatorLabel(null, employees, positions)).toBe('');
    expect(JSON.stringify(creatorLabel({ initiatedBy: 'ghost' }, employees, positions))).not.toContain('ghost');
  });
});

describe('the downloadable copy', () => {
  it('writes the brief, the account and the delivered content as Markdown', () => {
    const file = deliverableFile(record(), {
      goal: 'User goal',
      summary: 'AI execution summary',
      files: 'Attached files',
    });
    expect(file.filename).toBe('quantify-q3-churn.md');
    expect(file.text).toContain('# Quantify Q3 churn');
    expect(file.text).toContain('## User goal');
    expect(file.text).toContain('Publish the churn driver table with sources');
    expect(file.text).toContain('## AI execution summary');
    expect(file.text).toContain('## Attached files');
    expect(file.text).toContain('- artifact-churn-table');
    expect(file.text).not.toContain('{"');
  });

  it('names a deliverable whose title cannot slug instead of dropping the file', () => {
    const file = deliverableFile(record({ title: '???' }), { goal: 'Goal', summary: 'Summary', files: 'Files' });
    expect(file.filename).toBe('deliverable.md');
  });
});
