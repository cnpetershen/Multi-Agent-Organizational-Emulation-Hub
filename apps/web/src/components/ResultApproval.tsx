import { useState } from 'react';
import { parseTaskRecord } from '../api';
import { workflowDecision } from '../commands';
import type { ConsoleControl } from '../control';
import { useJson } from '../hooks';
import { useI18n } from '../i18n';
import { resultApprovalOf, type ResultApprovalView } from '../result-approval';
import { Panel } from '../components';

/**
 * M2: accept or reject a workflow's open gate on the delivery page itself.
 *
 * The panel is a view over the same read model the Approvals page uses, and the buttons send
 * the same `Workflow.Approve` / `Workflow.Reject` commands. There is no local "approved"
 * flag: after the command the workflow row refreshes, the gate disappears, and the workflow
 * status on the page is whatever the kernel wrote. A refusal (no permission, already decided,
 * not open) is shown verbatim instead of being swallowed.
 */
function ApprovalTaskResult({ taskId, refreshToken }: { taskId: string; refreshToken: number }) {
  const { t } = useI18n();
  const record = useJson(`/api/tasks/${encodeURIComponent(taskId)}`, parseTaskRecord, refreshToken);
  const task = record.data;
  if (task === null) {
    return (
      <div className="result-approval-task">
        <b>{t('results.approval.taskFallback')}</b>
        <p className="muted">{record.error === null ? t('results.approval.loading') : t('results.approval.taskFailed')}</p>
      </div>
    );
  }
  return (
    <div className="result-approval-task" data-task-id={task.taskId}>
      <div className="result-approval-task-head">
        <b>{task.title}</b>
        <span className="result-approval-status">{task.status}</span>
      </div>
      {task.result === null ? (
        <p className="muted">{t('results.approval.noResult')}</p>
      ) : (
        <>
          <p className="result-approval-summary">{task.result.summary}</p>
          <p className="muted">
            {t('results.approval.artifacts', { count: task.result.artifacts.length })}
          </p>
        </>
      )}
    </div>
  );
}

function ApprovalFacts({ view }: { view: ResultApprovalView }) {
  const { t } = useI18n();
  return (
    <div className="result-approval-facts">
      <span><small>{t('results.approval.gate')}</small><b>{view.stepName}</b></span>
      <span><small>{t('results.approval.votes')}</small><b>{view.grantedCount}/{view.requiredCount}</b></span>
      <span><small>{t('results.approval.instance')}</small><b>{view.instanceId}</b></span>
    </div>
  );
}

export function ResultApprovalPanel({
  control,
  workflow,
}: {
  readonly control: ConsoleControl;
  readonly workflow: Parameters<typeof resultApprovalOf>[0];
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const view = resultApprovalOf(workflow);
  if (view === null) return null;

  const decide = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (busy !== null) return;
    setBusy(decision);
    setFailure(null);
    try {
      const outcome = await control.runDetailed(
        workflowDecision(
          { companyId: control.companyId, simTime: control.simTime },
          view.instanceId,
          decision,
          reason.trim() === ''
            ? `${decision} of ${view.title} from Results`
            : reason.trim(),
        ),
        null,
      );
      if (!outcome.ok) {
        setFailure(outcome.failure ?? t('common.unknownError'));
        return;
      }
      await control.releaseHold(true);
      setReason('');
      control.setFeedback({
        kind: 'success',
        title: decision === 'approve'
          ? t('feedback.approved', { title: view.title })
          : t('feedback.rejected', { title: view.title }),
        detail: null,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title={t('results.approval.panel')}
      className="result-approval"
      actions={<span className="muted">{t('results.approval.hint')}</span>}
    >
      <section className="detail-section">
        <div className="result-approval-head">
          <div>
            <span className="field-label">{t('results.approval.subject')}</span>
            <h3>{view.title}</h3>
            <p className="objective">{view.goal}</p>
          </div>
          <span className="result-approval-badge">{t('results.approval.pending')}</span>
        </div>
        <ApprovalFacts view={view} />
        {view.detail === '' ? null : (
          <p className="result-approval-reason-line">
            <span className="field-label">{t('results.approval.reasonLabel')}</span>
            {view.detail}
          </p>
        )}

        <div className="result-approval-results">
          <span className="field-label">{t('results.approval.results')}</span>
          {view.tasks.length === 0 ? (
            <p className="muted">{t('results.approval.noTasks')}</p>
          ) : (
            view.tasks.map((task) => (
              <ApprovalTaskResult key={task.taskId} taskId={task.taskId} refreshToken={control.refreshToken} />
            ))
          )}
        </div>

        <label className="result-approval-comment">
          <span className="field-label">{t('results.approval.comment')}</span>
          <textarea
            rows={2}
            value={reason}
            data-testid="result-approval-reason"
            placeholder={t('results.approval.commentPlaceholder')}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>

        {failure !== null && (
          <p className="result-approval-failure" role="alert">{failure}</p>
        )}

        <div className="button-row result-approval-actions">
          <button
            type="button"
            className="primary"
            data-testid="result-approval-approve"
            disabled={busy !== null}
            onClick={() => void decide('approve')}
          >
            {busy === 'approve' ? t('common.submitting') : t('results.approval.approve')}
          </button>
          <button
            type="button"
            data-testid="result-approval-reject"
            disabled={busy !== null}
            onClick={() => void decide('reject')}
          >
            {busy === 'reject' ? t('common.submitting') : t('results.approval.reject')}
          </button>
        </div>
      </section>
    </Panel>
  );
}
