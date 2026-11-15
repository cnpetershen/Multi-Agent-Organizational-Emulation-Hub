import { useCallback, useEffect, useMemo, useState } from 'react';
import { messageOf, requestJson } from '../api';
import {
  approvalActionTone,
  artifactContent,
  parseApprovalLists,
  parseExecutionReview,
  type ApprovalAction,
  type ApprovalLists,
  type ApprovalRecordView,
  type ExecutionReviewView,
} from '../approval';
import { Empty, PageIntro, Panel, StatusPill } from '../components';
import type { ConsoleControl } from '../control';
import { useI18n, type MessageKey } from '../i18n';
import type { PlanNodeView } from '../plan';

/**
 * M3.6 · delivery approval workbench.
 *
 * The page renders the execution's real task results and artifacts next to the confirmed plan's
 * acceptance criteria. The server owns the decision; this page only presents evidence and sends
 * an explicit human action.
 */

export function DeliveryApprovalsPage({ control }: { control: ConsoleControl }) {
  const { t } = useI18n();
  const [lists, setLists] = useState<ApprovalLists>({ pending: [], history: [], approved: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [review, setReview] = useState<ExecutionReviewView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<ApprovalAction>('approve');
  const [reason, setReason] = useState('');
  const [artifactByTask, setArtifactByTask] = useState<Record<string, string>>({});

  const loadLists = useCallback(async (): Promise<void> => {
    try {
      const raw = await requestJson('/api/execution-approvals');
      const next = parseApprovalLists(raw);
      setLists(next);
      setSelectedId((current) => {
        if (current !== null && next.pending.some((entry) => entry.executionId === current)) return current;
        return next.pending[0]?.executionId ?? next.history[0]?.executionId ?? null;
      });
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);

  const openReview = useCallback(async (executionId: string): Promise<void> => {
    setBusy('open');
    setError(null);
    try {
      const raw = await requestJson(`/api/execution-approvals/${encodeURIComponent(executionId)}`);
      const next = parseExecutionReview(raw);
      setReview(next);
      setSelectedId(executionId);
      setAction('approve');
      setReason('');
      const initial: Record<string, string> = {};
      for (const task of next.execution.tasks) {
        const first = task.result?.artifacts[0];
        if (first !== undefined) initial[task.taskId] = first;
      }
      setArtifactByTask(initial);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  useEffect(() => {
    if (selectedId !== null) {
      void openReview(selectedId);
    }
  }, [openReview, selectedId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadLists();
      if (selectedId !== null) {
        void requestJson(`/api/execution-approvals/${encodeURIComponent(selectedId)}`)
          .then((raw) => setReview(parseExecutionReview(raw)))
          .catch(() => undefined);
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [loadLists, selectedId]);

  const planNodes = useMemo(() => {
    const map = new Map<string, PlanNodeView>();
    for (const node of review?.plan?.nodes ?? []) map.set(node.nodeId, node);
    return map;
  }, [review]);

  const latestDecision = review?.history[0] ?? null;
  const canDecide =
    review !== null &&
    review.execution.status === 'awaiting_approval' &&
    review.execution.approval?.status === 'open' &&
    latestDecision === null;

  const decide = async (): Promise<void> => {
    if (review === null || !canDecide) return;
    if (action !== 'approve' && reason.trim() === '') {
      setError(t('deliveryApproval.reasonRequired'));
      return;
    }
    setBusy('decide');
    setError(null);
    try {
      const raw = await requestJson(
        `/api/execution-approvals/${encodeURIComponent(review.execution.executionId)}/decide`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action,
            ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
          }),
        },
      );
      const decided = raw as { readonly execution?: unknown; readonly decision?: unknown };
      if (decided.execution !== undefined) setReview(parseExecutionReview({ execution: decided.execution, plan: review.plan, history: [] }));
      await loadLists();
      await openReview(review.execution.executionId);
      control.setFeedback({
        kind: 'success',
        title: t(`deliveryApproval.done.${action}` as MessageKey),
        detail: reason.trim() === '' ? null : reason.trim(),
      });
      setReason('');
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const decisionLabel = (record: ApprovalRecordView): string =>
    t(`deliveryApproval.action.${record.action}` as MessageKey);

  return (
    <div className="delivery-approval-page">
      <PageIntro
        eyebrow={t('deliveryApproval.eyebrow')}
        title={t('deliveryApproval.title')}
        description={t('deliveryApproval.description')}
        actions={<span className="page-count">{t('deliveryApproval.pendingCount', { count: lists.pending.length })}</span>}
      />

      {error !== null && <div className="planning-error" role="alert">{error}</div>}

      <div className="delivery-approval-grid">
        <div className="delivery-approval-list">
          <Panel title={t('deliveryApproval.pendingPanel')}>
            {lists.pending.length === 0 ? (
              <Empty title={t('deliveryApproval.noPending')} hint={t('deliveryApproval.noPendingHint')} />
            ) : (
              <div className="delivery-pending-list">
                {lists.pending.map((entry) => (
                  <button
                    key={entry.executionId}
                    type="button"
                    className={`delivery-pending-card${entry.executionId === selectedId ? ' active' : ''}`}
                    onClick={() => void openReview(entry.executionId)}
                  >
                    <div>
                      <b>{entry.planTitle || t('deliveryApproval.untitled')}</b>
                      <span>
                        {t('deliveryApproval.planVersion', { version: entry.planVersion })} ·{' '}
                        {t('deliveryApproval.progress', { completed: entry.completedCount, total: entry.taskCount })}
                      </span>
                    </div>
                    <StatusPill value="Pending" label={t('deliveryApproval.pending')} />
                    <small>
                      {entry.artifacts.length} {t('deliveryApproval.artifacts')} ·{' '}
                      {entry.startedBy}
                    </small>
                  </button>
                ))}
              </div>
            )}
          </Panel>

          <Panel title={t('deliveryApproval.historyPanel')}>
            {lists.history.length === 0 ? (
              <Empty title={t('deliveryApproval.noHistory')} hint={t('deliveryApproval.noHistoryHint')} />
            ) : (
              <div className="delivery-history-list">
                {lists.history.slice(0, 12).map((record) => (
                  <button
                    key={record.approvalId}
                    type="button"
                    className={`delivery-history-card ${approvalActionTone(record.action)}${record.executionId === selectedId ? ' active' : ''}`}
                    onClick={() => void openReview(record.executionId)}
                  >
                    <b>{decisionLabel(record)}</b>
                    <span>{record.decidedBy} · {record.decidedAt}</span>
                    {record.reason !== null && <small>{record.reason}</small>}
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="delivery-approval-main">
          {review === null ? (
            <Panel title={t('deliveryApproval.detailPanel')}>
              <Empty title={t('deliveryApproval.selectPrompt')} hint={t('deliveryApproval.selectHint')} />
            </Panel>
          ) : (
            <>
              <Panel
                title={review.plan?.title ?? review.execution.planTitle}
                actions={
                  <span className="delivery-execution-meta">
                    {t('deliveryApproval.planVersion', { version: review.execution.planVersion })} ·{' '}
                    {t('deliveryApproval.startedBy', { name: review.execution.startedBy })} ·{' '}
                    <StatusPill
                      value={review.execution.status}
                      label={t(`canvasPlan.executionStatus.${review.execution.status}` as MessageKey)}
                    />
                  </span>
                }
              >
                <div className="delivery-approval-summary">
                  <span>{t('deliveryApproval.completed', {
                    completed: review.execution.summary.completedCount,
                    total: review.execution.summary.taskCount,
                  })}</span>
                  <span>{t('deliveryApproval.artifactCount', { count: review.execution.summary.artifacts.length })}</span>
                  <span>{t('deliveryApproval.confirmedBy', { name: review.execution.planConfirmedBy ?? '—' })}</span>
                  {review.execution.approval?.status === 'open' && (
                    <span className="delivery-approval-open">{t('deliveryApproval.gateOpen')}</span>
                  )}
                </div>

                <div className="delivery-review-tasks">
                  {review.execution.tasks.map((task) => {
                    const node = task.planNodeId === null ? undefined : planNodes.get(task.planNodeId);
                    const selectedArtifact = artifactByTask[task.taskId] ?? task.result?.artifacts[0];
                    const content =
                      task.result !== null && selectedArtifact !== undefined
                        ? artifactContent(task.result.data, selectedArtifact)
                        : null;
                    return (
                      <article key={task.taskId} className={`delivery-review-task status-${task.status}`}>
                        <div className="delivery-review-task-head">
                          <div>
                            <span>{node?.capability?.replace(/_/g, ' ') ?? t('deliveryApproval.task')}</span>
                            <h3>{task.title}</h3>
                          </div>
                          <StatusPill
                            value={task.status}
                            label={t(`canvasPlan.taskStatus.${task.status}` as MessageKey)}
                          />
                        </div>
                        <div className="delivery-review-owner">
                          {task.assigneeName ?? t('canvasPlan.unassigned')} · {t('deliveryApproval.attempt', { attempt: task.attempt, max: task.maxAttempts })}
                        </div>
                        {node !== undefined && (
                          <div className="delivery-review-plan">
                            <div>
                              <small>{t('deliveryApproval.goal')}</small>
                              <p>{node.goal}</p>
                            </div>
                            <div>
                              <small>{t('deliveryApproval.acceptance')}</small>
                              <ul>{node.acceptance.map((entry) => <li key={entry}>{entry}</li>)}</ul>
                            </div>
                            <div>
                              <small>{t('deliveryApproval.inputs')}</small>
                              <p>{node.inputs.join('；') || '—'}</p>
                            </div>
                            <div>
                              <small>{t('deliveryApproval.outputs')}</small>
                              <p>{node.outputs.join('；') || '—'}</p>
                            </div>
                          </div>
                        )}
                        {task.result !== null && (
                          <div className="delivery-review-result">
                            <small>{t('deliveryApproval.submitted')}</small>
                            <p>{task.result.summary}</p>
                            {task.result.artifacts.length > 0 && (
                              <div className="delivery-artifacts">
                                {task.result.artifacts.map((artifact) => (
                                  <button
                                    key={artifact}
                                    type="button"
                                    className={selectedArtifact === artifact ? 'active' : ''}
                                    onClick={() =>
                                      setArtifactByTask((current) => ({ ...current, [task.taskId]: artifact }))
                                    }
                                  >
                                    {artifact}
                                  </button>
                                ))}
                              </div>
                            )}
                            {selectedArtifact !== undefined && (
                              <div className="delivery-artifact-preview">
                                <div>
                                  <b>{selectedArtifact}</b>
                                  <button type="button" className="link" onClick={() => control.openResults(task.taskId)}>
                                    {t('deliveryApproval.openResult')}
                                  </button>
                                </div>
                                <pre>{content ?? t('deliveryApproval.contentUnavailable')}</pre>
                              </div>
                            )}
                          </div>
                        )}
                        {task.rejectReason !== null && <p className="delivery-review-error">{task.rejectReason}</p>}
                      </article>
                    );
                  })}
                </div>
              </Panel>

              <Panel title={t('deliveryApproval.decisionPanel')}>
                {latestDecision !== null ? (
                  <div className={`delivery-decision-result ${approvalActionTone(latestDecision.action)}`}>
                    <div>
                      <b>{decisionLabel(latestDecision)}</b>
                      <span>{latestDecision.decidedBy} · {latestDecision.decidedAt}</span>
                    </div>
                    {latestDecision.reason !== null && <p>{latestDecision.reason}</p>}
                    <div className="delivery-decision-transition">
                      <span>{latestDecision.before.executionStatus}</span>
                      <span>→</span>
                      <span>{latestDecision.after.executionStatus}</span>
                    </div>
                    <small>{t('deliveryApproval.recordedArtifacts', { count: latestDecision.artifacts.length })}</small>
                    {latestDecision.action === 'request_changes' && (
                      <button type="button" className="link" onClick={() => control.navigate('Planning')}>
                        {t('deliveryApproval.openPlanningForRework')}
                      </button>
                    )}
                  </div>
                ) : canDecide ? (
                  <div className="delivery-decision-form">
                    <div className="delivery-actions">
                      {(['approve', 'reject', 'request_changes'] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          className={`delivery-action ${option}${action === option ? ' active' : ''}`}
                          onClick={() => setAction(option)}
                        >
                          {t(`deliveryApproval.action.${option}` as MessageKey)}
                        </button>
                      ))}
                    </div>
                    <label>
                      <span>{t('deliveryApproval.reason')}</span>
                      <textarea
                        rows={3}
                        value={reason}
                        placeholder={
                          action === 'approve'
                            ? t('deliveryApproval.approveReasonHint')
                            : t('deliveryApproval.changeReasonHint')
                        }
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className={`delivery-submit ${action}`}
                      disabled={busy !== null}
                      onClick={() => void decide()}
                      data-testid="delivery-decide"
                    >
                      {busy === 'decide' ? t('deliveryApproval.submitting') : t(`deliveryApproval.submit.${action}` as MessageKey)}
                    </button>
                    <p className="delivery-decision-hint">{t('deliveryApproval.securityHint')}</p>
                  </div>
                ) : (
                  <Empty title={t('deliveryApproval.notOpen')} hint={t('deliveryApproval.notOpenHint')} />
                )}

                {review.history.length > 0 && (
                  <div className="delivery-decision-history">
                    <h4>{t('deliveryApproval.localHistory')}</h4>
                    {review.history.map((record) => (
                      <div key={record.approvalId} className="delivery-history-row">
                        <b>{decisionLabel(record)}</b>
                        <span>{record.decidedBy} · {record.decidedAt}</span>
                        {record.reason !== null && <p>{record.reason}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
