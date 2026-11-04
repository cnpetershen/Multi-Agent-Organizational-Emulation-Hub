import type { I18n, MessageKey } from './i18n';

/**
 * Status rendering for the console.
 *
 * The API returns enum tokens (`completed`, `aborted`, `submitted`, …) and each page shows a
 * different wording for them. Splitting that into three fields keeps the two concerns apart:
 *
 * - `code` — a stable identifier for filtering and counting. Never rendered, never localized.
 * - `tone` — the exact label the pre-i18n console passed to `StatusPill`, which is what decided
 *   the pill colour. Keeping it fixed means a switch to 中文 cannot change any status colour.
 * - `labelKey` — the locale key for the visible label, or `null` when the console should show
 *   the API token itself.
 *
 * Only the API token crosses this boundary: nothing here mutates domain state or command payloads.
 */
export interface StatusDisplay {
  readonly code: string;
  readonly tone: string;
  readonly labelKey: MessageKey | null;
  readonly raw: string;
}

/** The visible text of a status — localized copy, or the API token for values with no wording. */
export function statusLabel(display: StatusDisplay, i18n: I18n): string {
  return display.labelKey === null ? i18n.status(display.raw) : i18n.t(display.labelKey);
}

/** A status shown verbatim from the runtime: the token is the label, translated when known. */
export function rawStatusDisplay(raw: string): StatusDisplay {
  return { code: 'raw', tone: raw, labelKey: null, raw };
}

const COMPLETED: Pick<StatusDisplay, 'code' | 'tone' | 'labelKey'> = { code: 'completed', tone: 'Completed', labelKey: 'status.completed' };
const NEEDS_ATTENTION: Pick<StatusDisplay, 'code' | 'tone' | 'labelKey'> = { code: 'failed', tone: 'Needs attention', labelKey: 'status.needsAttention' };
const BLOCKED: Pick<StatusDisplay, 'code' | 'tone' | 'labelKey'> = { code: 'blocked', tone: 'Blocked', labelKey: 'status.blocked' };
const PAUSED: Pick<StatusDisplay, 'code' | 'tone' | 'labelKey'> = { code: 'paused', tone: 'Paused', labelKey: 'status.paused' };
const IN_PROGRESS: Pick<StatusDisplay, 'code' | 'tone' | 'labelKey'> = { code: 'active', tone: 'In progress', labelKey: 'status.inProgress' };
const IN_REVIEW: Pick<StatusDisplay, 'code' | 'tone' | 'labelKey'> = { code: 'review', tone: 'In review', labelKey: 'status.inReview' };
const CANCELLED: Pick<StatusDisplay, 'code' | 'tone' | 'labelKey'> = { code: 'cancelled', tone: 'Cancelled', labelKey: 'status.cancelled' };
const QUEUED: Pick<StatusDisplay, 'code' | 'tone' | 'labelKey'> = { code: 'queued', tone: 'Queued', labelKey: 'status.queued' };

function of(shape: Pick<StatusDisplay, 'code' | 'tone' | 'labelKey'>, raw: string): StatusDisplay {
  return { ...shape, raw };
}

/** Overview work cards: anything that is not finished reads as one motion state. */
export function overviewWorkStatus(raw: string): StatusDisplay {
  switch (raw.toLowerCase()) {
    case 'completed': return of(COMPLETED, raw);
    case 'failed': return of(NEEDS_ATTENTION, raw);
    case 'blocked': return of(BLOCKED, raw);
    case 'paused': return of(PAUSED, raw);
    default: return of(IN_PROGRESS, raw);
  }
}

/** Workflow status — used by the work map card and the detail panel. */
export function workflowStatus(raw: string): StatusDisplay {
  switch (raw.toLowerCase()) {
    case 'completed': return of(COMPLETED, raw);
    case 'failed': return of(NEEDS_ATTENTION, raw);
    case 'blocked': return of(BLOCKED, raw);
    case 'paused': return of(PAUSED, raw);
    case 'running': case 'started': return of(IN_PROGRESS, raw);
    default: return raw === '' ? of(QUEUED, raw) : rawStatusDisplay(raw);
  }
}

/** Task status. */
export function taskStatus(raw: string): StatusDisplay {
  switch (raw.toLowerCase()) {
    case 'completed': return of(COMPLETED, raw);
    case 'failed': return of(NEEDS_ATTENTION, raw);
    case 'blocked': return of(BLOCKED, raw);
    case 'cancelled': case 'canceled': return of(CANCELLED, raw);
    case 'submitted': return of(IN_REVIEW, raw);
    case 'started': case 'assigned': case 'accepted': return of(IN_PROGRESS, raw);
    default: return raw === '' ? of(QUEUED, raw) : rawStatusDisplay(raw);
  }
}
