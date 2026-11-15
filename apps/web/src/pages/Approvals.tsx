import { useState } from 'react';
import { parseApprovals, parseRows, parseWorkBriefs, readNumber, readString, type Row } from '../api';
import { workflowDecision, type CommandContext } from '../commands';
import type { ConsoleControl } from '../control';
import { Empty, EventLine, PageIntro, Panel, StatusPill, Table, eventDetail, payloadOf } from '../components';
import { isOpenApproval } from '../derive';
import { hiringRequests, isHiringGate, type HiringRequest } from '../hiring';
import { HiringRequestCard } from '../hiring-views';
import { useJson } from '../hooks';
import { useI18n, type MessageKey } from '../i18n';

function ctxOf(control: ConsoleControl): CommandContext { return { companyId: control.companyId, simTime: control.simTime }; }
/** Approval event type → the wording the decision is shown under. */
function decisionLabel(type: string, t: (key: MessageKey) => string): string {
  if (type.includes('Granted') || type.includes('Approved')) return t('status.approved');
  if (type.includes('Denied') || type.includes('Rejected')) return t('status.rejected');
  return type;
}

export function ApprovalsPage({ control }: { control: ConsoleControl }) {
  const i18n = useI18n();
  const { t, tp } = i18n;
  const workflows = useJson('/api/workflows', parseRows, control.refreshToken);
  const briefs = useJson('/api/work-briefs', parseWorkBriefs, control.refreshToken);
  const escalations = useJson('/api/approvals', parseApprovals, control.refreshToken);
  const history = useJson('/api/events?prefix=Workflow.Approval&limit=40', parseRows, control.refreshToken);
  const [busy, setBusy] = useState<string | null>(null);
  // A5: a hiring request is a `hire-gate` workflow instance; it gets its own card (role, reason,
  // requester, related tasks) and is kept out of the generic gate list so it never renders twice.
  const hiring = hiringRequests(workflows.data ?? [], briefs.data ?? []);
  const executionGates = (workflows.data ?? []).filter(isOpenApproval).filter((workflow) => workflow['executionPlan'] === true);
  const gates = (workflows.data ?? []).filter(isOpenApproval).filter((workflow) => !isHiringGate(workflow)).filter((workflow) => workflow['executionPlan'] !== true);
  const pendingHires = hiring.filter((request) => request.status === 'pending').length;
  const decide = async (workflow: Row, decision: 'approve' | 'reject'): Promise<void> => {
    const instanceId = readString(workflow['instanceId'], '');
    if (instanceId === '') return;
    const title = readString(workflow['title'], t('approvals.workflowFallback'));
    setBusy(instanceId);
    try {
      // The operational reason stays in one fixed form: it is written into the audit trail and
      // must not depend on the operator's UI language (see the decision history below).
      const ok = await control.run(workflowDecision(ctxOf(control), instanceId, decision, `${decision} of ${title} from console`), null);
      if (!ok) return;
      const resumed = await control.releaseHold(true);
      control.setFeedback({ kind: 'success', title: decision === 'approve' ? t('feedback.approved', { title }) : t('feedback.rejected', { title }), detail: resumed ? t('approvals.resumedDetail') : null });
    } finally { setBusy(null); }
  };
  // A hiring decision is the same `Workflow.Approve`/`Workflow.Reject` command on the same gate
  // instance — reusing the existing operation, only the card that names it is tailored (A5).
  const decideHire = (request: HiringRequest, decision: 'approve' | 'reject'): void => {
    void decide({ instanceId: request.instanceId, title: request.seatTitle }, decision);
  };
  const escalationRows = escalations.data ?? [];
  const registerRows = gates.map((workflow): Row => {
    const approval = workflow['approval'];
    const gate = typeof approval === 'object' && approval !== null && !Array.isArray(approval) ? approval as Row : {};
    const granted = Array.isArray(gate['grantedBy']) ? (gate['grantedBy'] as readonly unknown[]).length : 0;
    return {
      ...workflow,
      gateStep: readString(gate['stepId'], t('common.decisionStep')),
      gateStatus: i18n.status(readString(gate['status'], 'open')),
      required: `${String(granted)}/${String(readNumber(gate['requiredCount'], 1))}`,
    };
  });
  return <div className="stack">
    <PageIntro eyebrow={t('approvals.eyebrow')} title={t('page.approvals.title')} description={t('approvals.description')} actions={<span className="page-count">{t('approvals.pageCount', { count: gates.length + pendingHires + executionGates.length })}</span>} />
    {control.held && <div className="decision-hold" role="status"><span className="decision-pulse" /><div><b>{t('approvals.hold.title')}</b><p>{t('approvals.hold.detail')}</p></div></div>}
    {executionGates.length > 0 && <Panel title={t('approvals.executionPanel')} actions={<button type="button" className="primary" onClick={() => control.navigate('DeliveryApproval')}>{t('approvals.openExecutionApprovals')}</button>}>
      <p className="muted">{t('approvals.executionPanelHint', { count: executionGates.length })}</p>
    </Panel>}
    {hiring.length > 0 && <Panel title={t('hiring.approvals.panel')} actions={<span className="muted">{t('hiring.approvals.hint')}</span>}>
      <div className="approval-list">{hiring.map((request) => <HiringRequestCard key={request.instanceId} request={request} employees={control.snapshot.employees} positions={control.snapshot.positions} busy={busy === request.instanceId} onDecide={decideHire} />)}</div>
    </Panel>}
    <Panel title={t('approvals.inbox.panel')} actions={<span className="muted">{tp('approvals.openGates', gates.length)}</span>}>
      {workflows.status === 'failed' && workflows.data === null ? <Empty title={t('common.approvalInboxUnavailable')} hint={workflows.error ?? t('common.unknownError')} /> : gates.length === 0 ? <Empty title={t('approvals.inbox.empty')} hint={t('approvals.inbox.emptyHint')} /> : <div className="approval-list">{gates.map((workflow) => { const approval = workflow['approval']; const gate = typeof approval === 'object' && approval !== null && !Array.isArray(approval) ? (approval as Row) : {}; const granted = Array.isArray(gate['grantedBy']) ? (gate['grantedBy'] as readonly unknown[]).length : 0; const id = readString(workflow['instanceId'], ''); return <article className="approval-card" key={id}><div className="approval-card-top"><div><span className="approval-kicker">{readString(gate['stepId'], t('common.decisionStep'))}</span><h3>{readString(workflow['title'], t('common.workflowFallback'))}</h3></div><StatusPill value="Pending" label={t('status.pending')} /></div><p className="approval-objective">{readString(workflow['goal'], t('common.noObjective'))}</p><div className="approval-facts"><span><small>{t('approvals.card.required')}</small><b>{String(granted)}/{String(readNumber(gate['requiredCount'], 1))}</b></span><span><small>{t('approvals.card.stage')}</small><b>{readString(workflow['stageId'], '—')}</b></span><span><small>{t('approvals.card.instance')}</small><b>{id}</b></span></div><div className="approval-actions"><button type="button" className="primary" disabled={busy !== null} onClick={() => void decide(workflow, 'approve')}>{busy === id ? t('common.submitting') : t('common.approve')}</button><button type="button" disabled={busy !== null} onClick={() => void decide(workflow, 'reject')}>{t('common.reject')}</button><button type="button" className="link" onClick={() => control.navigate('Workflows')}>{t('approvals.card.viewWorkflow')}</button></div></article>; })}</div>}
    </Panel>
    <Panel title={t('approvals.register.panel')} className="approval-register" actions={<span className="muted">{t('approvals.register.hint')}</span>}>
      <Table
        rows={registerRows}
        columns={['title', 'gateStep', 'gateStatus', 'required']}
        labels={{ gateStep: t('approvals.register.gate'), gateStatus: t('approvals.register.status'), required: t('approvals.register.votes') }}
        actions={(row) => {
          const instanceId = readString(row['instanceId'], '');
          const workflow = gates.find((item) => readString(item['instanceId'], '') === instanceId);
          return <button type="button" className="primary" disabled={busy !== null || workflow === undefined} onClick={() => { if (workflow !== undefined) void decide(workflow, 'approve'); }}>{t('common.approve')}</button>;
        }}
        empty={t('approvals.register.empty')}
      />
    </Panel>
    <Panel title={t('approvals.escalations.panel')} actions={<span className="muted">{t('approvals.escalations.hint')}</span>}>
      {escalationRows.length === 0 ? <Empty title={t('approvals.escalations.empty')} hint={t('approvals.escalations.emptyHint')} /> : <div className="escalation-list">{escalationRows.map((row) => <div className="escalation-row" key={readString(row['commandId'])}><div><b>{readString(row['commandType'], t('approvals.escalations.commandFallback'))}</b><span>{readString(row['reason'], t('common.noReason'))}</span></div><StatusPill value="Pending" label={t('status.pending')} /><small>{readString(row['escalateTo'], t('approvals.escalations.awaitingAuthority'))}</small></div>)}</div>}
    </Panel>
    <Panel title={t('approvals.history.panel')} actions={<button type="button" className="link" onClick={() => control.navigate('Events')}>{t('approvals.history.open')}</button>}>
      {(history.data ?? []).length === 0 ? <Empty title={t('approvals.history.empty')} hint={t('approvals.history.emptyHint')} /> : [...(history.data ?? [])].reverse().map((event) => { const payload = payloadOf(event); const by = readString(payload['decidedBy'], readString(event['actorId'], '—')); return <EventLine key={readString(event['eventId'], String(event['seq']))} title={`${decisionLabel(readString(event['type']), t)} · ${by}`} detail={`${eventDetail(event)} · ${readString(payload['stepId'], '')}`} />; })}
    </Panel>
  </div>;
}
