import { readString, type Row, type TaskRecord, type TaskResultView } from './api';
import { employeeOf, findPosition } from './derive';
import type { MessageKey } from './i18n';

/**
 * The presentation model behind `/results/:taskId` — the "AI company delivered to me" view.
 *
 * Everything here is a pure function over the payload the console already reads
 * (`GET /api/tasks/:id`, `/api/workflows`, the snapshot), so the page renders facts and never
 * interprets them itself. Three rules the whole module obeys:
 *
 * - **No ids.** Roles are position titles, creators are role + name; a lookup that cannot be
 *   resolved returns `''` and the page falls back to copy instead of leaking an identifier.
 * - **No debug surface.** Nothing reads ticks, runtime state, events or traces, and no value is
 *   ever handed to `JSON.stringify` for display — structured content degrades to labelled rows.
 * - **Labels are keys.** Localized wording lives in the resource (`results.*`); this module
 *   returns `MessageKey`s and fixed tones so a locale switch can never change a state.
 */

/* --- 1. Header state ------------------------------------------------------ */

export type ResultsStateKind = 'completed' | 'running' | 'failed' | 'cancelled';

export interface ResultsState {
  readonly kind: ResultsStateKind;
  readonly tone: string;
  readonly labelKey: MessageKey;
}

const RESULTS_LABELS: Readonly<Record<string, { kind: ResultsStateKind; tone: string; labelKey: MessageKey }>> = {
  completed: { kind: 'completed', tone: 'ok', labelKey: 'results.state.completed' },
  cancelled: { kind: 'cancelled', tone: 'muted', labelKey: 'status.cancelled' },
  canceled: { kind: 'cancelled', tone: 'muted', labelKey: 'status.cancelled' },
  failed: { kind: 'failed', tone: 'bad', labelKey: 'results.state.failed' },
  aborted: { kind: 'failed', tone: 'bad', labelKey: 'results.state.failed' },
  rejected: { kind: 'failed', tone: 'bad', labelKey: 'status.rejected' },
  blocked: { kind: 'failed', tone: 'warn', labelKey: 'status.blocked' },
};

/**
 * The three states the delivery page speaks about — Completed / Running / Failed — plus the
 * cancelled label a finished-but-stopped task keeps. The kind is the contract the Actions
 * section branches on; the tone is fixed per status so 中文 cannot repaint a pill.
 */
export function resultsState(taskStatus: string): ResultsState {
  const code = taskStatus.trim().toLowerCase();
  return RESULTS_LABELS[code] ?? { kind: 'running', tone: 'neutral', labelKey: 'results.state.running' };
}

/* --- 2. The delivered artifact ------------------------------------------- */

export type DeliverableKind = 'code' | 'document' | 'report';

/**
 * Which delivery shape the page should speak in.
 *
 * The artifact store is not exposed over HTTP, so the type is derived from the delivery
 * itself: the keys the executor submitted and the file references it attached. An unknown
 * shape is a report — the honest default for "the team handed over findings".
 */
export function deliverableKind(result: Pick<TaskResultView, 'data' | 'artifacts'> | null): DeliverableKind {
  if (result === null) return 'report';
  const keys = Object.keys(result.data).map((key) => key.toLowerCase().replace(/[\s-]/g, ''));
  const files = result.artifacts.map((file) => file.toLowerCase());
  if (keys.some((key) => CODE_KEYS.has(key)) || files.some((file) => CODE_FILE.test(file))) return 'code';
  if (keys.some((key) => DOCUMENT_KEYS.has(key)) || files.some((file) => DOCUMENT_FILE.test(file))) return 'document';
  return 'report';
}

const CODE_KEYS = new Set([
  'stack', 'techstack', 'languages', 'framework', 'frameworks', 'repository', 'repo', 'repourl',
  'codeurl', 'sourceurl', 'entrypoint', 'deployment', 'demo', 'demourl',
]);
const DOCUMENT_KEYS = new Set([
  'document', 'content', 'body', 'abstract', 'outline', 'sections', 'brief', 'notes', 'specification', 'prose',
]);
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|py|go|rs|java|rb|php|cs|cpp|c|h|sql|sh|ipynb|zip|tar|gz)$/i;
const DOCUMENT_FILE = /\.(md|markdown|pdf|docx?|txt|rst|html)$/i;

/** One labelled piece of delivered content — a conclusion, a stack entry, a finding. */
export interface DeliverableFact {
  readonly label: string;
  readonly value: string | readonly string[];
}

export interface DeliverableView {
  readonly kind: DeliverableKind;
  /** Project / document / report name; falls back to the task title, never to an id. */
  readonly name: string;
  readonly description: string;
  readonly stack: readonly string[];
  readonly codeUrl: string | null;
  readonly demoUrl: string | null;
  readonly preview: string;
  /** The delivered content that answers the question first — findings, recommendations. */
  readonly conclusions: readonly DeliverableFact[];
  /** Everything else the executor delivered, so nothing is dropped from the record. */
  readonly details: readonly DeliverableFact[];
  readonly files: readonly string[];
}

/** Keys whose value reads as a conclusion first, so a report leads with its answer. */
const CONCLUSION_KEYS = [
  'conclusion', 'conclusions', 'recommendation', 'recommendations', 'findings', 'finding',
  'insights', 'insight', 'outcome', 'results', 'decision', 'decisions', 'risks', 'next_steps', 'nextsteps',
] as const;

const NAME_KEYS = ['name', 'title', 'project', 'document', 'report', 'repository', 'repo'] as const;
const STACK_KEYS = ['stack', 'techStack', 'tech_stack', 'languages', 'frameworks', 'framework'] as const;
const PREVIEW_KEYS = ['content', 'body', 'abstract', 'outline'] as const;
const CODE_URL_KEYS = ['repository', 'repoUrl', 'repo_url', 'repo', 'codeUrl', 'code_url', 'sourceUrl'] as const;
const DEMO_URL_KEYS = ['demoUrl', 'demo_url', 'demo', 'liveUrl', 'live_url'] as const;

/**
 * The delivery as the page renders it: one name, one description, and the fields each kind
 * needs. Every value is read from `result.data` verbatim — a key the executor chose is data,
 * exactly like an API enum token, and is shown as it was delivered. What a kind does not
 * surface in its own block lands in `details`, so no delivered content falls off the page.
 */
export function deliverableView(task: TaskRecord, kind: DeliverableKind): DeliverableView {
  const result = task.result;
  const data = result === null ? {} : result.data;
  const description = result === null ? '' : result.summary;
  const conclusions = conclusionFacts(data);
  const shown = new Set<string>([
    ...NAME_KEYS,
    ...conclusions.map((fact) => fact.label),
    ...(kind === 'code' ? [...STACK_KEYS, ...CODE_URL_KEYS, ...DEMO_URL_KEYS] : []),
    ...(kind === 'document' ? [...PREVIEW_KEYS, 'sections'] : []),
  ]);
  const details = Object.entries(data).flatMap(([key, value]): DeliverableFact[] => {
    if (shown.has(key) || value === null || value === undefined) return [];
    if (typeof value === 'string') return value.trim() === '' ? [] : [{ label: key, value: value.trim() }];
    if (typeof value === 'number' || typeof value === 'boolean') return [{ label: key, value: String(value) }];
    if (Array.isArray(value)) {
      const items = value.filter((entry) => typeof entry === 'string' || typeof entry === 'number');
      return items.length === 0 ? [] : [{ label: key, value: items.map((entry) => String(entry)) }];
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value as Row);
      return entries.length === 0 ? [] : [{ label: key, value: entries.map(([child, item]) => `${child}: ${String(item)}`) }];
    }
    return [];
  });
  return {
    kind,
    name: firstString(data, NAME_KEYS) || task.title,
    description,
    stack: stringList(data, STACK_KEYS),
    codeUrl: kind === 'code' ? firstString(data, CODE_URL_KEYS) || null : null,
    demoUrl: kind === 'code' ? firstString(data, DEMO_URL_KEYS) || null : null,
    preview: previewOf(data),
    conclusions,
    details,
    files: result === null ? [] : [...result.artifacts],
  };
}

function firstString(data: Row, keys: readonly string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

function stringList(data: Row, keys: readonly string[]): readonly string[] {
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      const items = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
      if (items.length > 0) return items.map((entry) => entry.trim());
    }
    if (typeof value === 'string' && value.trim() !== '') {
      return value.split(/[,·]/).map((entry) => entry.trim()).filter((entry) => entry !== '');
    }
  }
  return [];
}

function previewOf(data: Row): string {
  const direct = firstString(data, PREVIEW_KEYS);
  if (direct !== '') return direct;
  const sections = data['sections'];
  if (Array.isArray(sections)) {
    const items = sections.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
    if (items.length > 0) return items.map((entry) => entry.trim()).join('\n\n');
  }
  return '';
}

function conclusionFacts(data: Row): readonly DeliverableFact[] {
  const facts: DeliverableFact[] = [];
  for (const key of CONCLUSION_KEYS) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      if (value.trim() !== '') facts.push({ label: key, value: value.trim() });
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      facts.push({ label: key, value: String(value) });
      continue;
    }
    if (Array.isArray(value)) {
      const items = value.filter((entry) => typeof entry === 'string' || typeof entry === 'number');
      if (items.length > 0) facts.push({ label: key, value: items.map((entry) => String(entry)) });
    }
  }
  return facts;
}

/* --- 2b. The whole delivery ------------------------------------------------- */

/** One file the organization handed over, exactly as the executor submitted it. */
export interface DeliveredFile {
  readonly path: string;
  readonly language: string;
  readonly content: string;
}

/**
 * Every file *this* task handed over, in submission order: the `files` the executor enumerated
 * first, then any `artifacts` path it did not enumerate. The two lists answer different
 * questions — `files` carries the text, `artifacts` only names paths — so a file that appears in
 * both keeps its richer first record, and a path with no text still shows up with empty content
 * (the page offers the path, not a broken download).
 *
 * Everything here is defensive because `result.data` is `Record<string, unknown>`: an older
 * delivery predates `files`, half a delivery may omit `language`/`content`, and a sibling
 * executor may never submit either field. A malformed entry is dropped, never thrown on — a bad
 * file must not take down the page that exists to show the good ones.
 */
export function deliveredFiles(task: TaskRecord): readonly DeliveredFile[] {
  const result = task.result;
  if (result === null) return [];
  const files: DeliveredFile[] = [];
  const seen = new Set<string>();
  const add = (path: string, language: string, content: string): void => {
    if (path === '' || seen.has(path)) return;
    seen.add(path);
    files.push({ path, language, content });
  };

  const raw = result.data['files'];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const row = entry as Row;
      add(
        readString(row['path'], '').trim(),
        readString(row['language'], '').trim(),
        readString(row['content'], ''),
      );
    }
  }
  for (const artifact of result.artifacts) {
    const path = artifact.trim();
    if (path === '') continue;
    // The entry file is the one the executor named as the way in; its text is what the owner
    // actually needs when a delivery listed artifacts but not `files`.
    const entry = path === readString(result.data['entrypoint'], '').trim();
    add(path, '', entry ? readString(result.data['content'], '') : '');
  }
  return files;
}

/**
 * The deliveries of the workflow instance this task runs in, in the instance's own step order.
 *
 * `stepStates` is the only place the console learns what a workflow produced, so it is read the
 * same way `workflowJourney` reads it: an entry that is not an object, or whose `taskId` is
 * missing, is simply not a delivery. The current task is excluded — the panel that shows the
 * *rest* of the product must not repeat the artifact already above it.
 */
export function workflowStepTasks(
  workflow: Row | null,
  exceptTaskId: string,
): readonly { readonly stepId: string; readonly taskId: string }[] {
  if (workflow === null) return [];
  const raw = workflow['stepStates'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index): { stepId: string; taskId: string }[] => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const row = entry as Row;
    const stepId = readString(row['stepId'], `step-${String(index + 1)}`);
    // `taskId` may legitimately be JSON `null` for a step that has not produced work yet.
    const taskId = readString(row['taskId'], '').trim();
    if (taskId === '' || taskId === exceptTaskId) return [];
    return [{ stepId, taskId }];
  });
}

/**
 * The basename of a delivered path, for the name the browser saves a download under. Both
 * separators are handled because the server delivers POSIX paths while an operator may paste a
 * Windows one; a path that ends in a separator keeps its last readable segment rather than
 * producing a nameless file.
 */
export function fileName(path: string): string {
  const trimmed = path.trim();
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const name = cut === -1 ? trimmed : trimmed.slice(cut + 1);
  return name.trim() === '' ? trimmed : name;
}

/* --- 3. Work journey ------------------------------------------------------ */

export type JourneyState = 'done' | 'current' | 'pending' | 'stopped';

export interface JourneyStep {
  readonly key: string;
  /** Workflow steps carry their own label (the definition's step id, humanized) — data. */
  readonly label: string | null;
  /** Standalone tasks get three product phases — copy, translated by the caller. */
  readonly labelKey: MessageKey | null;
  readonly state: JourneyState;
}

const STEP_STATES: Readonly<Record<string, JourneyState>> = {
  done: 'done',
  active: 'current',
  rejected: 'stopped',
  skipped: 'pending',
};

/** `requirement-analysis` → `Requirement analysis`: readable without pretending it is copy. */
export function humanizeStep(stepId: string): string {
  const text = stepId.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text === '' ? stepId : text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The execution path of the workflow this task belongs to, in the instance's own step order.
 * Step status only — no events, no traces, no node ids: this is the journey an owner reads,
 * not the log an operator debugs.
 */
export function workflowJourney(workflow: Row | null): readonly JourneyStep[] {
  if (workflow === null) return [];
  const raw = workflow['stepStates'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index): JourneyStep[] => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const stepId = readString((entry as Row)['stepId'], `step-${String(index + 1)}`);
    const status = readString((entry as Row)['status'], '').toLowerCase();
    return [{ key: stepId, label: humanizeStep(stepId), labelKey: null, state: STEP_STATES[status] ?? 'pending' }];
  });
}

const TASK_RANK: Readonly<Record<string, number>> = {
  created: 0, assigned: 1, accepted: 2, started: 3, submitted: 4, completed: 5,
};
const STOPPED = new Set(['failed', 'rejected', 'blocked', 'aborted', 'cancelled', 'canceled']);

/**
 * The three phases every direct task moves through — assigned, working, delivered — derived
 * from the task's own status. Shown when the task has no workflow behind it, so a standalone
 * delivery still reads as a journey instead of a single lonely checkmark.
 */
export function taskJourney(status: string): readonly JourneyStep[] {
  const code = status.trim().toLowerCase();
  const rank = TASK_RANK[code] ?? 0;
  const step = (key: string, labelKey: MessageKey, state: JourneyState): JourneyStep => ({ key, label: null, labelKey, state });

  if (STOPPED.has(code)) {
    return [
      step('assigned', 'results.journey.phase.assigned', 'done'),
      step('working', 'results.journey.phase.working', 'stopped'),
      step('delivered', 'results.journey.phase.stopped', 'stopped'),
    ];
  }
  if (code === 'completed') {
    return [
      step('assigned', 'results.journey.phase.assigned', 'done'),
      step('working', 'results.journey.phase.working', 'done'),
      step('delivered', 'results.journey.phase.delivered', 'done'),
    ];
  }
  return [
    step('assigned', 'results.journey.phase.assigned', rank >= 1 ? 'done' : 'current'),
    step('working', 'results.journey.phase.working', rank >= 4 ? 'done' : rank >= 2 ? 'current' : 'pending'),
    step('delivered', 'results.journey.phase.delivered', rank >= 4 ? 'current' : 'pending'),
  ];
}

/* --- 4. Who delivered it -------------------------------------------------- */

export interface ContributionLine {
  readonly labelKey: MessageKey;
  /** A raw API value beside the line (a review verdict); the page localizes it. */
  readonly value: string | null;
}

export interface Contribution {
  /** The position title — a role, never a person id. */
  readonly roleTitle: string;
  readonly personName: string;
  readonly lines: readonly ContributionLine[];
}

export interface ContributionInput {
  readonly positions: readonly Row[];
  readonly employees: readonly Row[];
  readonly positionId: string | null;
  readonly assigneeEmployeeId: string | null;
  readonly producedBy: string | null;
  readonly reviews: readonly { readonly reviewerId: string; readonly verdict: string }[];
}

/**
 * The roles behind a delivery — owner, deliverer, reviewers — merged by role and person so
 * one岗位 shows its whole part instead of three fragments. A lookup that cannot be resolved
 * contributes nothing: the page would rather show fewer cards than an id.
 */
export function contributions(input: ContributionInput): readonly Contribution[] {
  const byRole = new Map<string, Contribution>();
  const add = (roleTitle: string, employeeId: string | null, line: ContributionLine): void => {
    if (roleTitle === '') return;
    const personName = employeeId === null ? '' : nameOf(input.employees, employeeId);
    const key = `${roleTitle}|${personName}`;
    const existing = byRole.get(key);
    if (existing === undefined) byRole.set(key, { roleTitle, personName, lines: [line] });
    else if (!existing.lines.some((entry) => entry.labelKey === line.labelKey)) {
      byRole.set(key, { ...existing, lines: [...existing.lines, line] });
    }
  };

  if (input.positionId !== null && input.positionId !== '') {
    add(roleTitleOf(input.positions, input.positionId), input.assigneeEmployeeId, {
      labelKey: 'results.contribution.owns',
      value: null,
    });
  }
  if (input.producedBy !== null && input.producedBy !== '') {
    add(employeeRoleTitle(input.employees, input.positions, input.producedBy), input.producedBy, {
      labelKey: 'results.contribution.delivered',
      value: null,
    });
  }
  for (const review of input.reviews) {
    add(employeeRoleTitle(input.employees, input.positions, review.reviewerId), review.reviewerId, {
      labelKey: 'results.contribution.reviewed',
      value: review.verdict,
    });
  }
  return [...byRole.values()];
}

function nameOf(employees: readonly Row[], employeeId: string): string {
  const employee = employeeOf(employees, employeeId);
  return employee === null ? '' : readString(employee['name'], '');
}

/**
 * A position title resolved strictly: a position the organization does not know contributes
 * nothing instead of falling back to its id — the delivery page never prints an identifier,
 * so an unresolvable lookup degrades to copy rather than to `position-7`.
 */
function roleTitleOf(positions: readonly Row[], positionId: string): string {
  if (positionId === '') return '';
  const row = findPosition(positions, positionId);
  return row === null ? '' : readString(row['title'], '');
}

/** The role behind one employee, under the same no-ids rule as `roleTitleOf`. */
function employeeRoleTitle(employees: readonly Row[], positions: readonly Row[], employeeId: string): string {
  const employee = employeeOf(employees, employeeId);
  return employee === null ? '' : roleTitleOf(positions, readString(employee['positionId'], ''));
}

/**
 * Who initiated the work, as `Role · Name`. Empty when it cannot be resolved to a person, so
 * the header falls back to the CEO-Agent copy instead of printing the initiator's id.
 */
export function creatorLabel(
  workflow: Row | null,
  employees: readonly Row[],
  positions: readonly Row[],
): string {
  if (workflow === null) return '';
  const initiator = readString(workflow['initiatedBy'], '');
  if (initiator === '') return '';
  const employee = employeeOf(employees, initiator);
  if (employee === null) return '';
  const role = roleTitleOf(positions, readString(employee['positionId'], ''));
  const name = readString(employee['name'], '');
  if (role === '' && name === '') return '';
  return name === '' ? role : `${role} · ${name}`;
}

/* --- 5. The downloadable copy -------------------------------------------- */

export interface DeliverableLabels {
  readonly goal: string;
  readonly summary: string;
  readonly files: string;
}

export interface DeliverableFile {
  readonly filename: string;
  readonly text: string;
}

/**
 * The delivery as a file the owner can keep: the brief, the executor's account, the delivered
 * content and the attached references — plain Markdown built from the record, never a JSON
 * dump. Section headings come from the caller so the file is written in the operator's
 * language.
 */
export function deliverableFile(task: TaskRecord, labels: DeliverableLabels): DeliverableFile {
  const lines: string[] = [`# ${task.title}`, '', `## ${labels.goal}`, task.goal];
  if (task.detail !== null && task.detail.trim() !== '') lines.push('', task.detail);
  const result = task.result;
  if (result !== null) {
    lines.push('', `## ${labels.summary}`, result.summary);
    for (const [key, value] of Object.entries(result.data)) {
      lines.push('', `${key}:`, ...scalarLines(value));
    }
    if (result.artifacts.length > 0) {
      lines.push('', `## ${labels.files}`);
      for (const file of result.artifacts) lines.push(`- ${file}`);
    }
  }
  return { filename: `${slug(task.title)}.md`, text: `${lines.join('\n')}\n` };
}

function scalarLines(value: unknown): readonly string[] {
  if (typeof value === 'string') return value.split('\n');
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.map((entry) => `- ${String(entry)}`);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Row).map(([key, entry]) => `- ${key}: ${String(entry)}`);
  }
  return [];
}

function slug(title: string): string {
  const clean = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return clean === '' ? 'deliverable' : clean;
}
