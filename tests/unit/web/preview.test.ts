import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../apps/web/src/api';
import {
  PREVIEW_STATES,
  canRerun,
  canStart,
  canStop,
  isBusy,
  parsePreviewStatus,
  previewActions,
  previewLabelKey,
  previewNotices,
  previewPath,
  previewTone,
  type PreviewState,
  type PreviewStatus,
} from '../../../apps/web/src/preview';

/**
 * The delivery page's run-preview panel: the wire contract and the button logic, without a DOM.
 *
 * The panel makes a literal promise — *your project, running* — and everything that promise rests
 * on is a pure function: the status the runtime answers, the tone and label it is shown in, which
 * of the four buttons is live, and what the panel admits about the product it is running. A
 * preview that cannot be parsed must be an error naming the offending path (an iframe pointed at
 * nothing is worse than no iframe), while `available: false` is a complete answer from the
 * runtime and must parse without complaint.
 */

const PATH = 'GET /api/preview/task-1';

const RUNNING = {
  available: true,
  state: 'running',
  taskId: 'task-1',
  projectName: '俄罗斯方块 Tetris',
  runCommand: 'python server/app.py',
  plan: 'python-server',
  note: null,
  previewUrl: 'http://127.0.0.1:43117/',
  error: null,
  startedAt: 1_700_000_000_000,
  logs: ['pygame 2.5.2 (SDL 2.28.2)', ''],
  sources: [
    { taskId: 'task-1', title: 'Build the game', files: 3 },
    { taskId: 'task-2', title: 'Wire the server', files: 2 },
  ],
  skipped: [],
};

function status(overrides: Record<string, unknown> = {}): PreviewStatus {
  return parsePreviewStatus({ ...RUNNING, ...overrides }, PATH);
}

/** The full status of one state, so the button logic can be asserted per state. */
function stateOf(state: PreviewState): PreviewStatus {
  return status({ state, previewUrl: state === 'running' ? RUNNING.previewUrl : null });
}

const live = (state: PreviewState): readonly string[] =>
  previewActions(stateOf(state)).filter((action) => !action.disabled).map((action) => action.kind);

/** The states the panel must render, even though only one of them can be shown at a time. */
const NOT_RUNNING: readonly PreviewState[] = ['stopped', 'starting', 'failed'];

/** Assert both that a payload is rejected and that the message names the offending field. */
function reject(payload: unknown, path: RegExp): void {
  expect(() => parsePreviewStatus(payload, PATH)).toThrow(ApiError);
  expect(() => parsePreviewStatus(payload, PATH)).toThrow(path);
}

describe('preview endpoint', () => {
  it('addresses one task, percent-encoded, on the same origin', () => {
    expect(previewPath('task-1')).toBe('/api/preview/task-1');
    expect(previewPath('task 1/x')).toBe('/api/preview/task%201%2Fx');
  });
});

describe('preview status contract', () => {
  it('parses a running project down to its log tail and the steps it runs', () => {
    expect(status()).toEqual(RUNNING);
  });

  it('reads available:false as a complete statement rather than a malformed payload', () => {
    expect(parsePreviewStatus({ available: false }, PATH)).toEqual({
      available: false,
      state: 'stopped',
      taskId: '',
      projectName: '',
      runCommand: '',
      plan: 'none',
      note: null,
      previewUrl: null,
      error: null,
      startedAt: null,
      logs: [],
      sources: [],
      skipped: [],
    });
  });

  it('keeps the reason a not-runnable delivery gives for there being nothing to run', () => {
    const off = parsePreviewStatus(
      {
        available: false,
        state: 'stopped',
        taskId: 'task-1',
        plan: 'none',
        error: 'the delivery has no entry point the runtime can serve',
      },
      PATH,
    );
    expect(off.available).toBe(false);
    expect(off.error).toBe('the delivery has no entry point the runtime can serve');
    expect(off.state).toBe('stopped');
    expect(off.plan).toBe('none');
  });

  it('keeps the nullable fields the runtime leaves empty', () => {
    const stopped = status({ state: 'stopped', previewUrl: null, error: null, startedAt: null, logs: [] });
    expect(stopped.previewUrl).toBeNull();
    expect(stopped.error).toBeNull();
    expect(stopped.startedAt).toBeNull();
    expect(stopped.logs).toEqual([]);
  });

  it('keeps the failure reason and the boot time a failed preview reports', () => {
    const failed = status({ state: 'failed', previewUrl: null, error: 'port 43117 never opened', startedAt: 42 });
    expect(failed.error).toBe('port 43117 never opened');
    expect(failed.startedAt).toBe(42);
    expect(failed.previewUrl).toBeNull();
  });

  it('reads the delivered steps a preview runs and the ones it could not read', () => {
    const partial = status({
      sources: [{ taskId: 'task-1', title: '', files: 0 }],
      skipped: [{ taskId: 'task-2', reason: 'the delivery carried no files' }],
    });
    expect(partial.sources).toEqual([{ taskId: 'task-1', title: '', files: 0 }]);
    expect(partial.skipped).toEqual([{ taskId: 'task-2', reason: 'the delivery carried no files' }]);
  });

  it('treats an absent log tail as empty rather than as a broken preview', () => {
    expect(status({ logs: undefined }).logs).toEqual([]);
    expect(status({ logs: null }).logs).toEqual([]);
  });

  it('names the offending path instead of handing React a half-parsed preview', () => {
    reject(null, /GET \/api\/preview\/task-1 response/);
    reject([], /GET \/api\/preview\/task-1 response/);
    reject({}, /\.available/);
    reject({ available: 'yes' }, /\.available/);
    reject({ ...RUNNING, state: 'booting' }, /\.state/);
    reject({ ...RUNNING, state: null }, /\.state/);
    reject({ ...RUNNING, taskId: '' }, /\.taskId/);
    reject({ ...RUNNING, projectName: '' }, /\.projectName/);
    reject({ ...RUNNING, runCommand: '   ' }, /\.runCommand/);
    reject({ ...RUNNING, plan: undefined }, /\.plan/);
    reject({ ...RUNNING, previewUrl: 43117 }, /\.previewUrl/);
    reject({ ...RUNNING, error: 42 }, /\.error/);
    reject({ ...RUNNING, startedAt: 'just now' }, /\.startedAt/);
    reject({ ...RUNNING, logs: 'pygame' }, /\.logs/);
    reject({ ...RUNNING, logs: ['ok', 7] }, /\.logs\[1\]/);
    reject({ ...RUNNING, sources: 'two' }, /\.sources/);
    reject({ ...RUNNING, sources: [{ taskId: 'task-1', title: 'x' }] }, /\.sources\[0\]\.files/);
    reject({ ...RUNNING, skipped: {} }, /\.skipped/);
    reject({ ...RUNNING, skipped: [{ taskId: 'task-2' }] }, /\.skipped\[0\]\.reason/);
  });
});

describe('preview state presentation', () => {
  it('pins one tone and one label per state, so a locale switch cannot repaint it', () => {
    expect(PREVIEW_STATES.map(previewTone)).toEqual(['muted', 'warn', 'ok', 'bad']);
    expect(PREVIEW_STATES.map(previewLabelKey)).toEqual([
      'results.preview.state.stopped',
      'results.preview.state.starting',
      'results.preview.state.running',
      'results.preview.state.failed',
    ]);
  });

  it('treats only booting as busy', () => {
    expect(PREVIEW_STATES.filter(isBusy)).toEqual(['starting']);
  });
});

describe('preview buttons', () => {
  it('starts a preview that is not up — including a failed one, which is the retry path', () => {
    expect(canStart('stopped')).toBe(true);
    expect(canStart('failed')).toBe(true);
    expect(canStart('starting')).toBe(false);
    expect(canStart('running')).toBe(false);
  });

  it('restarts only a running project', () => {
    expect(canRerun('running')).toBe(true);
    expect(NOT_RUNNING.map(canRerun)).toEqual([false, false, false]);
  });

  it('stops anything in flight, booting included', () => {
    expect(canStop('starting')).toBe(true);
    expect(canStop('running')).toBe(true);
    expect(canStop('stopped')).toBe(false);
    expect(canStop('failed')).toBe(false);
  });

  it('shows the same four buttons, in reading order, in every state', () => {
    for (const state of PREVIEW_STATES) {
      expect(previewActions(stateOf(state)).map((action) => action.kind)).toEqual([
        'start',
        'rerun',
        'stop',
        'fullscreen',
      ]);
    }
  });

  it('enables exactly the affordances each state allows', () => {
    expect(live('stopped')).toEqual(['start']);
    expect(live('starting')).toEqual(['stop']);
    expect(live('running')).toEqual(['rerun', 'stop', 'fullscreen']);
    expect(live('failed')).toEqual(['start']);
  });

  it('leads with start only when starting is what happens next', () => {
    const primary = (state: PreviewState): readonly string[] =>
      previewActions(stateOf(state)).filter((action) => action.primary).map((action) => action.kind);
    expect(primary('stopped')).toEqual(['start']);
    expect(primary('failed')).toEqual(['start']);
    expect(primary('starting')).toEqual([]);
    expect(primary('running')).toEqual([]);
  });

  it('labels every button through the resource layer', () => {
    for (const action of previewActions(stateOf('running'))) {
      expect(action.labelKey).toMatch(/^results\.preview\.action\./);
    }
  });
});

describe('what the preview admits it is running', () => {
  it('counts the delivered steps and flags the whole product only above one', () => {
    const single = status({ sources: [{ taskId: 'task-1', title: 'x', files: 1 }] });
    expect(previewNotices(single)).toEqual({ sources: 1, wholeProduct: false, skipped: 0, skipReason: '' });
    expect(previewNotices(status())).toEqual({ sources: 2, wholeProduct: true, skipped: 0, skipReason: '' });
  });

  it('joins every reason a partial preview could not read, so it never looks complete', () => {
    const partial = status({
      sources: [],
      skipped: [
        { taskId: 'task-1', reason: 'no files' },
        { taskId: 'task-2', reason: 'unreadable delivery' },
      ],
    });
    expect(previewNotices(partial)).toEqual({
      sources: 0,
      wholeProduct: false,
      skipped: 2,
      skipReason: 'no files · unreadable delivery',
    });
  });
});
