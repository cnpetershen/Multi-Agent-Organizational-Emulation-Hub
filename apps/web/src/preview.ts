import { ApiError } from './api';
import { t, type MessageKey } from './i18n';

/**
 * The delivery page's "run preview" panel: the wire contract, and the pure logic behind it.
 *
 * The console's promise here is unusually literal — *this is your project, running*. So the
 * module keeps three things apart, exactly like `results.ts` does for the rest of the page:
 *
 * - **The contract.** `GET /api/preview/:taskId` answers with a `PreviewStatus`; every field the
 *   panel renders is parsed and checked here, naming the offending path, so a malformed response
 *   is an error the operator can read instead of an iframe pointing nowhere.
 * - **The view logic.** Tone, label, which buttons are live: pure functions over the state token,
 *   never over a stored label, so 中文 and English can never disagree about whether a preview is
 *   running.
 * - **Nothing that runs.** This module holds no timer, no `fetch` and no React: the polling lives
 *   in `preview-hook.ts`. A unit test can therefore pin the contract without a DOM.
 *
 * `available: false` is a first-class answer, not a failure: the delivery simply is not a
 * runnable web app, and the page renders no preview panel at all for it.
 */

/** The four states the preview runtime reports. `starting` is the only transitional one. */
export type PreviewState = 'stopped' | 'starting' | 'running' | 'failed';

/**
 * One delivered workflow step this preview runs — the whole product it stands for, not only the
 * task the page is about. `files` is how many files that step handed over.
 */
export interface PreviewSource {
  readonly taskId: string;
  readonly title: string;
  readonly files: number;
}

/** One product step whose delivery could not be read, and why. */
export interface PreviewSkip {
  readonly taskId: string;
  readonly reason: string;
}

/**
 * One preview status, mirroring the API contract field for field.
 *
 * `previewUrl` is the absolute origin of the locally running project and is only set while it is
 * running; `error` is the human-readable reason a `failed` preview could not start; `logs` is a
 * recent stdout/stderr tail that may legitimately be empty. `sources` and `skipped` are always
 * present — a preview can run several delivered steps, and a partial preview must say so.
 */
export interface PreviewStatus {
  readonly available: boolean;
  readonly state: PreviewState;
  readonly taskId: string;
  readonly projectName: string;
  readonly runCommand: string;
  /** How the runtime decided to run it: `python-server`, `node-server`, `launcher`, `static`, `html`. */
  readonly plan: string;
  /** A sentence the runtime wants shown with the preview, or `null`. */
  readonly note: string | null;
  readonly previewUrl: string | null;
  readonly error: string | null;
  readonly startedAt: number | null;
  readonly logs: readonly string[];
  /** The delivered steps this preview runs, in workflow order. */
  readonly sources: readonly PreviewSource[];
  /** Product steps the runtime could not read — the preview is incomplete when this is non-empty. */
  readonly skipped: readonly PreviewSkip[];
}

/** Tone tokens `StatusPill` already paints — the same vocabulary the delivery page's states use. */
export type PreviewTone = 'ok' | 'warn' | 'bad' | 'muted';

/**
 * Which affordances are live in which state. Kept as data the component maps over, so the
 * enabled/disabled rules are a pure function rather than four hand-written `disabled={…}`.
 */
export type PreviewActionKind = 'start' | 'rerun' | 'stop' | 'fullscreen';

export interface PreviewAction {
  readonly kind: PreviewActionKind;
  readonly labelKey: MessageKey;
  readonly disabled: boolean;
  readonly primary: boolean;
}

export const PREVIEW_STATES: readonly PreviewState[] = ['stopped', 'starting', 'running', 'failed'];

const STATE_TONES: Readonly<Record<PreviewState, PreviewTone>> = {
  stopped: 'muted',
  starting: 'warn',
  running: 'ok',
  failed: 'bad',
};

const STATE_LABELS: Readonly<Record<PreviewState, MessageKey>> = {
  stopped: 'results.preview.state.stopped',
  starting: 'results.preview.state.starting',
  running: 'results.preview.state.running',
  failed: 'results.preview.state.failed',
};

const ACTION_LABELS: Readonly<Record<PreviewActionKind, MessageKey>> = {
  start: 'results.preview.action.start',
  rerun: 'results.preview.action.rerun',
  stop: 'results.preview.action.stop',
  fullscreen: 'results.preview.action.fullscreen',
};

/* --- 1. The endpoint ------------------------------------------------------ */

/** The one URL shape this feature owns: relative, same-origin, id percent-encoded. */
export function previewPath(taskId: string): string {
  return `/api/preview/${encodeURIComponent(taskId)}`;
}

/* --- 2. The contract ------------------------------------------------------ */

function received(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return t('api.receivedArray');
  if (typeof value === 'object') return t('api.receivedObject');
  return t('api.receivedType', { type: typeof value });
}

function objectAt(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(t('api.object', { where, received: received(value) }));
  }
  return value as Record<string, unknown>;
}

function booleanAt(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ApiError(t('api.boolean', { where, received: received(value) }));
  }
  return value;
}

function textAt(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(t('api.string', { where, received: received(value) }));
  }
  return value;
}

function numberAt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(t('api.number', { where, received: received(value) }));
  }
  return value;
}

/** A field the contract declares as nullable: absent and `null` both mean "no value". */
function nullableText(value: unknown, where: string): string | null {
  if (value === null || value === undefined) return null;
  return textAt(value, where);
}

/** A string the runtime owns that may legitimately be empty (a step title, a failure reason). */
function plainTextAt(value: unknown, where: string): string {
  if (typeof value !== 'string') {
    throw new ApiError(t('api.string', { where, received: received(value) }));
  }
  return value;
}

function nullableNumber(value: unknown, where: string): number | null {
  if (value === null || value === undefined) return null;
  return numberAt(value, where);
}

/**
 * A stdout/stderr tail. Unlike every other string field, a blank line is a legitimate entry, so
 * only the type is checked here. An absent tail reads as empty rather than as a contract
 * violation: the panel never renders logs, so a missing diagnostic must not hide the preview.
 */
function logLinesAt(value: unknown, where: string): readonly string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ApiError(t('api.array', { where, received: received(value) }));
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new ApiError(t('api.string', { where: `${where}[${String(index)}]`, received: received(entry) }));
    }
    return entry;
  });
}

export function isPreviewState(value: unknown): value is PreviewState {
  return typeof value === 'string' && (PREVIEW_STATES as readonly string[]).includes(value);
}

function sourcesAt(value: unknown, where: string): readonly PreviewSource[] {
  if (!Array.isArray(value)) {
    throw new ApiError(t('api.array', { where, received: received(value) }));
  }
  return value.map((entry, index) => {
    const at = `${where}[${String(index)}]`;
    const source = objectAt(entry, at);
    return {
      taskId: textAt(source['taskId'], `${at}.taskId`),
      title: plainTextAt(source['title'], `${at}.title`),
      files: numberAt(source['files'], `${at}.files`),
    };
  });
}

function skipsAt(value: unknown, where: string): readonly PreviewSkip[] {
  if (!Array.isArray(value)) {
    throw new ApiError(t('api.array', { where, received: received(value) }));
  }
  return value.map((entry, index) => {
    const at = `${where}[${String(index)}]`;
    const skip = objectAt(entry, at);
    return {
      taskId: textAt(skip['taskId'], `${at}.taskId`),
      reason: plainTextAt(skip['reason'], `${at}.reason`),
    };
  });
}

/**
 * The status of a delivery the runtime refuses to run.
 *
 * `available: false` is a complete statement, not a malformed one, so this reads only what the
 * runtime chose to send and defaults the rest — including the `{ available: false }`-only body a
 * runtime is allowed to answer with. Nothing is rendered for it, so no field can be misrendered;
 * `error` is kept because it is the runtime's own explanation of why there is nothing to run.
 */
function unavailableStatus(root: Record<string, unknown>): PreviewStatus {
  const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);
  const optional = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const stamp = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    available: false,
    state: isPreviewState(root['state']) ? root['state'] : 'stopped',
    taskId: text(root['taskId'], ''),
    projectName: text(root['projectName'], ''),
    runCommand: text(root['runCommand'], ''),
    plan: text(root['plan'], 'none'),
    note: optional(root['note']),
    previewUrl: optional(root['previewUrl']),
    error: optional(root['error']),
    startedAt: stamp(root['startedAt']),
    logs: Array.isArray(root['logs'])
      ? root['logs'].filter((line): line is string => typeof line === 'string')
      : [],
    sources: [],
    skipped: [],
  };
}

/**
 * Parse one `PreviewStatus`, naming the exact path of the first field the panel cannot render.
 *
 * Everything the panel shows when a preview *is* available is required, because a silently
 * missing `previewUrl` would render an iframe of nothing: an unparsable status is an error, not a
 * blank panel. The two exceptions are the fields the panel treats as optional metadata (`note`,
 * `error`, `startedAt`, `logs`) and `previewUrl` itself, which is legitimately `null` until the
 * project is up.
 */
export function parsePreviewStatus(payload: unknown, path: string): PreviewStatus {
  const where = `${path} response`;
  const root = objectAt(payload, where);
  const available = booleanAt(root['available'], `${where}.available`);
  if (!available) return unavailableStatus(root);

  const state = root['state'];
  if (!isPreviewState(state)) {
    throw new ApiError(
      t('results.preview.unknownState', { where: `${where}.state`, state: received(state) }),
    );
  }
  return {
    available: true,
    state,
    taskId: textAt(root['taskId'], `${where}.taskId`),
    projectName: textAt(root['projectName'], `${where}.projectName`),
    runCommand: textAt(root['runCommand'], `${where}.runCommand`),
    plan: textAt(root['plan'], `${where}.plan`),
    note: nullableText(root['note'], `${where}.note`),
    previewUrl: nullableText(root['previewUrl'], `${where}.previewUrl`),
    error: nullableText(root['error'], `${where}.error`),
    startedAt: nullableNumber(root['startedAt'], `${where}.startedAt`),
    logs: logLinesAt(root['logs'], `${where}.logs`),
    sources: sourcesAt(root['sources'], `${where}.sources`),
    skipped: skipsAt(root['skipped'], `${where}.skipped`),
  };
}

/* --- 3. The view logic ---------------------------------------------------- */

/** The pill colour for a state: a fixed tone, so a locale switch can never repaint it. */
export function previewTone(state: PreviewState): PreviewTone {
  return STATE_TONES[state];
}

/** The localized label for a state. */
export function previewLabelKey(state: PreviewState): MessageKey {
  return STATE_LABELS[state];
}

/** The transitional state: the runtime is booting the project and there is nothing to show yet. */
export function isBusy(state: PreviewState): boolean {
  return state === 'starting';
}

/** A preview that is not up can be started — including a failed one, which is the retry path. */
export function canStart(state: PreviewState): boolean {
  return state === 'stopped' || state === 'failed';
}

/** Only a running project can be restarted; a stopped one is (re)started by `canStart`. */
export function canRerun(state: PreviewState): boolean {
  return state === 'running';
}

/** Anything in flight — booting or running — can be stopped. */
export function canStop(state: PreviewState): boolean {
  return state === 'running' || state === 'starting';
}

/** Only a running project has a frame to expand. */
export function canFullscreen(state: PreviewState): boolean {
  return state === 'running';
}

/**
 * The button row, in reading order. Every button is always present and carries its own
 * enabled/disabled flag, so "why is this greyed out?" has one answer per state and a unit test
 * can assert the whole row without a render.
 */
export function previewActions(status: PreviewStatus): readonly PreviewAction[] {
  const { state } = status;
  return [
    { kind: 'start', labelKey: ACTION_LABELS.start, disabled: !canStart(state), primary: canStart(state) },
    { kind: 'rerun', labelKey: ACTION_LABELS.rerun, disabled: !canRerun(state), primary: false },
    { kind: 'stop', labelKey: ACTION_LABELS.stop, disabled: !canStop(state), primary: false },
    { kind: 'fullscreen', labelKey: ACTION_LABELS.fullscreen, disabled: !canFullscreen(state), primary: false },
  ];
}

/**
 * What the preview is *actually* running, as the panel must say it out loud.
 *
 * Two honesty rules live here: a preview of several delivered steps is the workflow's whole
 * product, not this task's slice, and a preview whose product could not be read in full must say
 * so — otherwise a partial run looks like the entire delivery.
 */
export interface PreviewNotices {
  /** How many delivered workflow steps this preview runs. */
  readonly sources: number;
  readonly wholeProduct: boolean;
  /** How many product steps the runtime could not read. */
  readonly skipped: number;
  /** Their reasons, joined for the one warning line the panel shows. */
  readonly skipReason: string;
}

export function previewNotices(status: PreviewStatus): PreviewNotices {
  return {
    sources: status.sources.length,
    wholeProduct: status.sources.length > 1,
    skipped: status.skipped.length,
    skipReason: status.skipped.map((skip) => skip.reason).join(' · '),
  };
}
