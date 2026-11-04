import { type Row } from './api';
import { StatusPill } from './components';
import { employeeName, positionTitle } from './derive';
import type { HiringRequest, HiringStatus } from './hiring';
import { useI18n, type MessageKey } from './i18n';
import { statusLabel, taskStatus } from './status';

/** The pill value for a hiring state — an existing token, so the colour is decided once. */
const STATUS_TONE: Readonly<Record<HiringStatus, string>> = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
};

function statusKey(status: HiringStatus): MessageKey {
  return `hiring.status.${status}` as MessageKey;
}

/**
 * One hiring request as a card. The same card serves Company Overview (read-only) and the
 * Approvals inbox (with the decision actions), so a request can never be described one way in
 * one page and another way in the next — every fact comes from the gate and the brief the
 * console already reads, and no id, tick or event ever reaches the screen.
 */
export function HiringRequestCard({
  request,
  employees,
  positions,
  busy = false,
  onDecide,
}: {
  readonly request: HiringRequest;
  readonly employees: readonly Row[];
  readonly positions: readonly Row[];
  readonly busy?: boolean;
  readonly onDecide?: (request: HiringRequest, decision: 'approve' | 'reject') => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const role =
    request.seatTitle !== ''
      ? request.seatTitle
      : request.seatId !== ''
        ? positionTitle(positions, request.seatId)
        : t('hiring.fact.role');
  const statusText = t(statusKey(request.status));
  const requester = employeeName(employees, request.requesterId === '' ? null : request.requesterId);
  return (
    <article className={`approval-card hiring-card hiring-${request.status}`}>
      <div className="approval-card-top">
        <div>
          <span className="approval-kicker">
            {request.status === 'pending' ? t('hiring.decisionRequired') : statusText}
          </span>
          <h3>{role}</h3>
        </div>
        <StatusPill value={STATUS_TONE[request.status]} label={statusText} />
      </div>
      <p className="approval-objective">
        <span className="field-label">{t('hiring.fact.why')}</span>
        <br />
        {request.rationale === '' ? t('hiring.whyFallback') : request.rationale}
      </p>
      <div className="approval-facts hiring-facts">
        <span>
          <small>{t('hiring.fact.role')}</small>
          <b>{role}</b>
        </span>
        <span>
          <small>{t('hiring.fact.requester')}</small>
          <b>{requester === '—' ? t('hiring.requesterFallback') : requester}</b>
        </span>
        <span>
          <small>{t('hiring.fact.status')}</small>
          <b>{statusText}</b>
        </span>
      </div>
      <div className="hiring-tasks">
        <span className="field-label">
          {request.relatedTasks.length === 1 ? t('hiring.fact.task') : t('hiring.fact.tasks')}
        </span>
        {request.relatedTasks.length === 0 ? (
          <p className="muted">{t('hiring.tasksNone')}</p>
        ) : (
          <ul className="hiring-task-list">
            {request.relatedTasks.map((task) => {
              const display = taskStatus(task.status);
              return (
                <li key={task.taskId}>
                  <b>{task.title === '' ? t('common.untitledTask') : task.title}</b>
                  <StatusPill value={display.tone} label={statusLabel(display, i18n)} />
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {request.status === 'approved' && (
        <p className="hiring-outcome hiring-outcome-approved">
          {t('hiring.joined.line', { seat: role })}
        </p>
      )}
      {request.status === 'rejected' && (
        <p className="hiring-outcome hiring-outcome-rejected">
          {t('hiring.approvals.outcomeRejected')}
        </p>
      )}
      {request.status === 'pending' && onDecide !== undefined && (
        <div className="approval-actions">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => onDecide(request, 'approve')}
          >
            {busy ? t('common.submitting') : t('hiring.approvals.approve')}
          </button>
          <button type="button" disabled={busy} onClick={() => onDecide(request, 'reject')}>
            {t('common.reject')}
          </button>
        </div>
      )}
    </article>
  );
}

/** A task card's hiring explanation: why it waits, who asked, and how it was decided — no ids. */
export function HiringTaskNote({
  request,
  employees,
}: {
  readonly request: HiringRequest;
  readonly employees: readonly Row[];
}) {
  const { t } = useI18n();
  const requester = employeeName(employees, request.requesterId === '' ? null : request.requesterId);
  return (
    <div className={`hiring-task-note hiring-task-note-${request.status}`}>
      <span className="field-label">{t('hiring.tasks.detail')}</span>
      <p className="hiring-task-explain">
        {request.status === 'pending'
          ? t('hiring.explanation.noCapability')
          : request.status === 'approved'
            ? t('hiring.eta.approved', { seat: request.seatTitle })
            : t('hiring.eta.rejected')}
      </p>
      <div className="hiring-task-facts">
        <span>
          <small>{t('hiring.tasks.rationale')}</small>
          <b>{request.rationale === '' ? t('hiring.whyFallback') : request.rationale}</b>
        </span>
        <span>
          <small>{t('hiring.tasks.requester')}</small>
          <b>{requester === '—' ? t('hiring.requesterFallback') : requester}</b>
        </span>
        <span>
          <small>{t('hiring.tasks.outcome')}</small>
          <b>{t(statusKey(request.status))}</b>
        </span>
      </div>
      {request.status === 'rejected' && (
        <p className="hiring-task-human">
          <span className="field-label">{t('hiring.tasks.humanDecision')}</span>
          <b>{t('hiring.explanation.rejectedDetail')}</b>
        </p>
      )}
    </div>
  );
}
