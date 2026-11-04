import type { ReactNode } from 'react';
import { readNumber, readString, type Feedback, type Row } from './api';
import { useI18n } from './i18n';

export function Panel({
  title,
  actions,
  children,
  className = '',
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`panel ${className}`.trim()}>
      <div className="panel-head">
        <h3>{title}</h3>
        {actions !== undefined && <div className="panel-actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function PageIntro({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-intro">
      <div>
        <p className="section-kicker">{eyebrow}</p>
        <h2>{title}</h2>
        {description !== undefined && <p className="page-description">{description}</p>}
      </div>
      {actions !== undefined && <div className="page-intro-actions">{actions}</div>}
    </div>
  );
}

export function StatCard({ label, value, detail, tone = 'neutral' }: { label: string; value: string | number; detail?: string; tone?: string }) {
  return (
    <div className={`metric stat-card stat-${tone}`}>
      <span className="stat-label">{label}</span>
      <strong>{value}</strong>
      {detail !== undefined && <span className="stat-detail">{detail}</span>}
    </div>
  );
}

export function Avatar({ name, tone = 'default' }: { name: string; tone?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
  return <span className={`avatar avatar-${tone}`} aria-hidden="true">{initials}</span>;
}

const WARN_STATUSES = new Set([
  'blocked',
  'paused',
  'assigned',
  'accepted',
  'started',
  'submitted',
  'open',
  'running',
  'waiting',
  'pending',
]);
const BAD_STATUSES = new Set([
  'failed',
  'cancelled',
  'canceled',
  'rejected',
  'denied',
  'aborted',
  'error',
]);
const OK_STATUSES = new Set(['completed', 'granted', 'approved', 'done']);
/** Values that are not a problem, just out of play (M1.3 `archived`). */
const MUTED_STATUSES = new Set(['idle', 'archived', 'offboarded']);

/** Status colour is derived from the value the API returned — never from a stored label. */
function toneOf(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return 'muted';
  if (OK_STATUSES.has(normalized)) return 'ok';
  if (WARN_STATUSES.has(normalized)) return 'warn';
  if (BAD_STATUSES.has(normalized)) return 'bad';
  if (MUTED_STATUSES.has(normalized)) return 'muted';
  return 'neutral';
}

/**
 * A status pill.
 *
 * `value` is the value the console already holds — the API token, or a label a page derived
 * from one — and it keeps deciding the colour. What is *rendered* is the localized form: raw
 * tokens go through the locale's `statusToken` map, while an already-localized label passes
 * through untouched. `label` overrides the display text when a page wants an explicit wording.
 */
export function StatusPill({ value, title, label }: { value: string; title?: string; label?: string }) {
  const { status } = useI18n();
  if (value === '') return <span className="pill muted">—</span>;
  const display = label ?? status(value);
  return (
    <span className={`pill ${toneOf(value)}`} title={title ?? display}>
      {display}
    </span>
  );
}

/**
 * The remove affordance on a card. A glyph rather than a word: the button sits in a card corner
 * that only reveals it on hover, so it carries its own accessible name instead of relying on
 * visible text it has no room for.
 */
export function DeleteIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M2.5 4.5h11M6.5 4.5V3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1.5M4 4.5l.6 8.2a1 1 0 0 0 1 .8h4.8a1 1 0 0 0 1-.8L12 4.5M6.5 7v4M9.5 7v4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Table({
  rows,
  columns,
  labels,
  actions,
  empty,
}: {
  rows: readonly Row[];
  columns: readonly string[];
  labels?: Readonly<Record<string, string>>;
  actions?: (row: Row) => ReactNode;
  empty?: string;
}) {
  const { t } = useI18n();
  const header = (column: string): string =>
    labels === undefined || labels[column] === undefined ? column : (labels[column] as string);
  return (
    <div className="table">
      <div className="tr th">
        {columns.map((column) => (
          <span key={column}>{header(column)}</span>
        ))}
        {actions !== undefined && <span>{t('table.actions')}</span>}
      </div>
      {rows.length === 0 ? (
        <div className="empty">{empty ?? t('table.noRecords')}</div>
      ) : (
        rows.map((row, index) => (
          <div className="tr" key={rowKey(row, index)}>
            {columns.map((column) => (
              <span key={column}>{cellValue(row, column)}</span>
            ))}
            {actions !== undefined && <span className="row-actions">{actions(row)}</span>}
          </div>
        ))
      )}
    </div>
  );
}

const ROW_KEY_FIELDS = ['id', 'eventId', 'auditId', 'employeeId', 'taskId', 'instanceId', 'commandId'] as const;

function rowKey(row: Row, index: number): string {
  for (const field of ROW_KEY_FIELDS) {
    const value = row[field];
    if (typeof value === 'string' && value !== '') return value;
  }
  return String(index);
}

export function cellValue(row: Row, column: string): string {
  const value = row[column];
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value) ?? String(value);
  return String(value);
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty-block">
      <b>{title}</b>
      {hint !== undefined && <p>{hint}</p>}
    </div>
  );
}

/**
 * One group of record fields under its own heading. A record sheet groups its facts
 * (identity / placement / runtime / work) so a long one stays scannable instead of reading as a
 * single wall of key-value pairs; the grouped items keep the `.detail-grid` contract that
 * `.detail-grid span` already styles.
 */
export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="detail-section">
      <span className="field-label">{title}</span>
      <div className="detail-grid">{children}</div>
    </section>
  );
}

/** One labelled value inside a `DetailSection`. */
export function DetailItem({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <span>
      <small>{label}</small>
      <b>{children}</b>
    </span>
  );
}

/** One line of a timeline: the stored event type plus its `#seq · sim time · subject`. */
export function EventLine({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="row activity-row">
      <span className="activity-marker" aria-hidden="true" />
      <div className="activity-copy">
        <b>{title}</b>
        <span>{detail}</span>
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint !== undefined && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Submit({
  busy,
  disabled,
  children,
  onClick,
  dataTestId,
}: {
  busy: boolean;
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
  /** Stable hook for the e2e scripts, which click through the real DOM. */
  dataTestId?: string;
}) {
  const { t } = useI18n();
  return (
    <button
      className="primary"
      type="button"
      disabled={busy || disabled === true}
      onClick={onClick}
      data-testid={dataTestId}
    >
      {busy ? t('common.submitting') : children}
    </button>
  );
}

export function FeedbackBanner({ feedback }: { feedback: Feedback | null }) {
  if (feedback === null) return null;
  const mark = feedback.kind === 'success' ? '✓' : feedback.kind === 'error' ? '✕' : '…';
  return (
    <div
      className={`feedback ${feedback.kind}`}
      role={feedback.kind === 'error' ? 'alert' : 'status'}
      data-testid="feedback"
    >
      <b>
        {mark} {feedback.title}
      </b>
      {feedback.detail !== null && <span>{feedback.detail}</span>}
    </div>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="failure">
      <p>{message}</p>
      <button type="button" onClick={onRetry}>
        {t('common.retry')}
      </button>
    </div>
  );
}

/** `#seq · sim time · who it happened to` — every field read from the stored event. */
export function eventDetail(event: Row): string {
  const head = `#${readNumber(event['seq'])} · t${readNumber(event['occurredAtSim'])}`;
  const subject = readString(event['subjectId'], '');
  const actor = readString(event['actorId'], '');
  const tail = subject === '' ? actor : subject;
  return tail === '' ? head : `${head} · ${tail}`;
}

export function payloadOf(row: Row): Row {
  const payload = row['payload'];
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Row)
    : {};
}
