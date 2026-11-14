import { describe, expect, it } from 'vitest';
import { parseTaskRecord, type Row } from '../../../apps/web/src/api';
import { documentPreviewOf, isPlayableGame, markdownTitle } from '../../../apps/web/src/document-preview';

/**
 * The document sheet's model: which body a delivery shows, and whether a delivery is a playable
 * game. Both are pure reads over the task record, so the decisions are pinned without a browser.
 */

const baseRow: Row = {
  taskId: 'task-doc',
  title: 'Product Requirement',
  status: 'completed',
  goal: 'Write the requirement',
  detail: null,
  positionId: 'business-analyst',
  assigneeEmployeeId: 'business-analyst-hire',
  workflowInstanceId: null,
  workflowStepId: null,
  attempt: 1,
  maxAttempts: 1,
  createdAtSim: 1,
  completedAtSim: 2,
  blockedReason: null,
  rejectReason: null,
  outputs: [],
  result: {
    taskId: 'task-doc',
    producedBy: 'business-analyst-hire',
    summary: 'Wrote the brief.',
    data: {
      name: 'Product Requirement',
      content: '# Product Requirement\n\n实时追踪工单流转状态。\n\n- Context: why now\n',
    },
    artifacts: ['product-requirement.md'],
  },
  reviews: [],
  verification: null,
};

function record(result?: unknown): ReturnType<typeof parseTaskRecord> {
  return parseTaskRecord(result === undefined ? baseRow : { ...baseRow, result }, 'GET /api/tasks/task-doc');
}

const baseResult = baseRow['result'] as Row;

describe('documentPreviewOf', () => {
  it('prefers the delivered Markdown file over the single-file content field', () => {
    const file = '# Delivered file\n\nThis is the attached file.\n';
    const task = record({
      ...baseResult,
      data: {
        ...(baseResult['data'] as Row),
        files: [{ path: 'brief.md', language: 'markdown', content: file }],
      },
    });
    const preview = documentPreviewOf(task);
    expect(preview).toMatchObject({
      kind: 'markdown',
      title: 'Delivered file',
      sourcePath: 'brief.md',
    });
    expect(preview?.content).toBe(file);
    expect(preview?.files.map((entry) => entry.path)).toContain('brief.md');
  });

  it('falls back to result.data.content and reads its first heading as the title', () => {
    const preview = documentPreviewOf(record());
    expect(preview).toMatchObject({
      kind: 'markdown',
      title: 'Product Requirement',
      sourcePath: null,
    });
    expect(preview?.content).toContain('实时追踪工单流转状态');
  });

  it('keeps an HTML document as HTML for a document delivery', () => {
    const task = record({
      ...baseResult,
      data: {
        name: 'Report',
        content: '<!doctype html><html><body><h1>Report</h1></body></html>',
      },
    });
    expect(documentPreviewOf(task)?.kind).toBe('html');
  });

  it('returns null when a delivery carries no document body', () => {
    const task = record({
      ...baseResult,
      data: { passed: true, failures: [] },
      artifacts: [],
    });
    expect(documentPreviewOf(task)).toBeNull();
    expect(documentPreviewOf(record(null))).toBeNull();
  });

  it('does not turn a 3D scene into a document just because it also ships Markdown', () => {
    const task = record({
      ...baseResult,
      data: {
        files: [
          { path: 'index.html', language: 'html', content: '<!doctype html><style>.s{perspective:900px;transform-style:preserve-3d;transform:rotateY(20deg)}</style>' },
          { path: 'design.md', language: 'markdown', content: '# Design' },
        ],
      },
      artifacts: [],
    });
    expect(documentPreviewOf(task)).toBeNull();
  });
});

describe('isPlayableGame', () => {
  it('recognizes a canvas game delivered as an index.html data key', () => {
    const task = record({
      ...baseResult,
      data: {
        'index.html':
          '<!doctype html><canvas id="board"></canvas><script>requestAnimationFrame(loop);document.addEventListener("keydown", go);</script>',
        playable: true,
      },
      artifacts: [],
    });
    expect(isPlayableGame(task)).toBe(true);
  });

  it('recognizes an SVG board game by its title', () => {
    const task = parseTaskRecord({
      ...baseRow,
      title: 'Implement single-file HTML5 tic-tac-toe with an SVG board',
      result: {
        ...baseResult,
        data: { 'index.html': '<!doctype html><svg id="board"></svg><script>render();</script>' },
        artifacts: [],
      },
    }, 'GET /api/tasks/task-doc');
    expect(isPlayableGame(task)).toBe(true);
  });

  it('does not call a static page or a canvas dashboard a game', () => {
    const staticPage = record({
      ...baseResult,
      data: { 'index.html': '<!doctype html><h1>Summary</h1>' },
      artifacts: [],
    });
    expect(isPlayableGame(staticPage)).toBe(false);
    const dashboard = record({
      ...baseResult,
      data: { 'index.html': '<!doctype html><canvas id="chart"></canvas><script>drawChart();</script>' },
      artifacts: [],
    });
    expect(isPlayableGame(dashboard)).toBe(false);
    expect(isPlayableGame(record())).toBe(false);
  });
});

describe('markdownTitle', () => {
  it('reads the first ATX heading, ignoring leading whitespace', () => {
    expect(markdownTitle('  # Hello world  \n\ntext')).toBe('Hello world');
    expect(markdownTitle('no heading')).toBe('');
  });
});
