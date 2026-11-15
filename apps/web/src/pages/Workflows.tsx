import { useState } from 'react';
import { parseRows, readBoolean, readNumber, readString, type Row } from '../api';
import { workflowDelete, workflowPause, workflowResume, type CommandContext } from '../commands';
import type { ConsoleControl } from '../control';
import { DeleteIcon, Empty, EventLine, PageIntro, Panel, StatusPill, Table, eventDetail } from '../components';
import { approvalOf, employeeLabel, isOpenApproval, positionTitle, stepProgress } from '../derive';
import { useJson } from '../hooks';
import { useI18n } from '../i18n';
import { statusLabel, workflowStatus } from '../status';

function ctxOf(control: ConsoleControl): CommandContext { return { companyId: control.companyId, simTime: control.simTime }; }

export function WorkflowsPage({ control }: { control: ConsoleControl }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { snapshot } = control;
  const workflows = useJson('/api/workflows', parseRows, control.refreshToken);
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * `Workflow.Delete` takes the instance and every task it owns, so the operator confirms the
   * whole cascade before anything is sent — and the detail panel closes if it was showing the
   * instance that just left.
   */
  const removeWorkflow = async (instanceId: string): Promise<void> => {
    if (instanceId === '') return;
    if (!window.confirm(t('common.deleteWorkflowConfirm'))) return;
    const ok = await control.run(workflowDelete(ctxOf(control), instanceId), t('feedback.workflowDeleted'));
    if (ok && selected === instanceId) setSelected(null);
  };
  const rows = workflows.data ?? snapshot.workflows;
  const detail = rows.find((row) => readString(row['instanceId'], '') === selected) ?? null;
  const gate = detail === null ? null : approvalOf(detail);
  const detailStatus = detail === null ? null : workflowStatus(readString(detail['status'], ''));
  const paused = detail !== null && readBoolean(detail['paused'], false);
  const detailCode = detail === null ? '' : readString(detail['status'], '').toLowerCase();
  // Pause is only meaningful for a running instance. An approval block is not a pause: the
  // engine refuses `Workflow.Pause` there, so the action must not be offered.
  const canPause = detail !== null
    && !readBoolean(detail['draft'], false)
    && (paused || detailCode === 'running');
  const togglePaused = async (): Promise<void> => {
    if (detail === null) return;
    const instanceId = readString(detail['instanceId'], '');
    if (instanceId === '') return;
    const ok = await control.run(
      paused
        ? workflowResume(ctxOf(control), instanceId)
        : workflowPause(ctxOf(control), instanceId),
      paused ? t('feedback.workflowResumed') : t('feedback.workflowPaused'),
    );
    if (!ok) return;
  };
  const active = rows.filter((workflow) => !['completed', 'failed', 'cancelled'].includes(readString(workflow['status'], '').toLowerCase()));
  const completed = rows.filter((workflow) => readString(workflow['status'], '').toLowerCase() === 'completed').length;
  const waiting = rows.filter(isOpenApproval).length;
  const registerRows = rows.map((workflow) => { const progress = stepProgress(workflow); return { ...workflow, displayStatus: i18n.status(readString(workflow['status'], '')), stage: readString(workflow['stageId'], t('common.stagePlanning')), progress: t('workflows.steps', { done: progress.done, total: progress.total }) }; });
  return <div className="stack">
    <PageIntro eyebrow={t('workflows.eyebrow')} title={t('page.workflows.title')} description={t('workflows.description')} actions={<span className="page-count">{t('workflows.pageCount', { active: active.length, waiting })}</span>} />
    <div className="stat-grid workflow-stats"><div className="metric stat-card stat-blue"><span className="stat-label">{t('workflows.stat.inMotion')}</span><strong>{active.length}</strong><span className="stat-detail">{t('workflows.stat.inMotionDetail')}</span></div><div className="metric stat-card stat-green"><span className="stat-label">{t('workflows.stat.completed')}</span><strong>{completed}</strong><span className="stat-detail">{t('workflows.stat.completedDetail')}</span></div><div className="metric stat-card stat-amber"><span className="stat-label">{t('workflows.stat.gates')}</span><strong>{waiting}</strong><span className="stat-detail">{t('workflows.stat.gatesDetail')}</span></div></div>
    <Panel title={t('workflows.map.panel')} actions={<span className="muted">{t('workflows.map.hint', { count: rows.length })}</span>}>
      {workflows.status === 'failed' && workflows.data === null ? <Empty title={t('workflows.map.failed')} hint={workflows.error ?? t('common.unknownError')} /> : rows.length === 0 ? <Empty title={t('common.noWorkflows')} hint={t('workflows.map.emptyHint')} /> : <div className="workflow-board">{rows.map((workflow) => { const progress = stepProgress(workflow); const display = workflowStatus(readString(workflow['status'], '')); const instanceId = readString(workflow['instanceId'], ''); const isSelected = selected === instanceId; return <div role="button" tabIndex={0} className={`workflow-card ${isSelected ? 'selected' : ''}`} key={instanceId} onClick={() => setSelected(instanceId)} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(instanceId); } }}><div className="workflow-card-top"><span className="workflow-stage">{readString(workflow['stageId'], t('common.stagePlanning'))}</span><div className="card-top-right">{readBoolean(workflow['paused'], false) && <span className="workflow-stage" title={t('workflows.detail.pausedHint')}>{t('status.paused')}</span>}<StatusPill value={display.tone} label={statusLabel(display, i18n)} /><button type="button" className="card-delete" aria-label={t('common.delete')} title={t('common.delete')} onClick={(event) => { event.stopPropagation(); void removeWorkflow(instanceId); }}><DeleteIcon /></button></div></div><h3>{readString(workflow['title'], t('common.untitledWorkflow'))}</h3><p>{readString(workflow['goal'], t('common.noObjective'))}</p><div className="progress-line"><span style={{ width: progress.total === 0 ? '0%' : `${String(Math.round((progress.done / progress.total) * 100))}%` }} /></div><div className="workflow-card-foot"><span>{t('workflows.steps', { done: progress.done, total: progress.total })}</span><span>{t('workflows.events', { count: readString(workflow['eventCount'], '0') })}</span></div></div>; })}</div>}
    </Panel>
    <Panel title={t('workflows.register.panel')} actions={<span className="muted">{t('workflows.register.hint')}</span>}><Table rows={registerRows} columns={['title', 'displayStatus', 'stage', 'progress']} labels={{ displayStatus: t('workflows.register.status'), stage: t('workflows.register.stage'), progress: t('workflows.register.steps') }} empty={t('common.noWorkflows')} /></Panel>
    {detail !== null && <Panel title={readString(detail['title'], t('common.workflowFallback'))} actions={<>{canPause && <button type="button" className="link" onClick={() => void togglePaused()}>{paused ? t('workflows.detail.resume') : t('workflows.detail.pause')}</button>}<button type="button" className="link" onClick={() => setSelected(null)}>{t('common.close')}</button></>}>
      <div className="workflow-detail-head"><div><span className="field-label">{t('workflows.detail.currentStage')}</span><b>{readString(detail['stageId'], t('common.stagePlanning'))}</b></div>{paused ? <StatusPill value="Paused" label={t('status.paused')} /> : detailStatus !== null && <StatusPill value={detailStatus.tone} label={statusLabel(detailStatus, i18n)} />}</div>
      {paused && <p className="muted">{t('workflows.detail.pausedHint')}</p>}
      <div className="detail-grid"><div><span className="field-label">{t('workflows.detail.workflowId')}</span><p>{readString(detail['workflowId'], '—')}</p></div><div><span className="field-label">{t('workflows.detail.instance')}</span><p>{readString(detail['instanceId'], '—')}</p></div><div><span className="field-label">{t('workflows.detail.startedCompleted')}</span><p>{`t${String(readNumber(detail['startedAtSim']))} / ${detail['completedAtSim'] === null ? '—' : `t${String(readNumber(detail['completedAtSim']))}`}`}</p></div><div><span className="field-label">{t('workflows.detail.initiatedBy')}</span><p>{readString(detail['initiatedBy'], '—')}</p></div></div>
      <div className="detail-block"><span className="field-label">{t('workflows.detail.objective')}</span><p className="objective">{readString(detail['goal'], '—')}</p></div>
      <div className="detail-block"><span className="field-label">{t('workflows.detail.executionSteps')}</span><div className="step-list">{(Array.isArray(detail['stepStates']) ? (detail['stepStates'] as readonly Row[]) : []).map((step) => <div className="step-row" key={readString(step['stepId'])}><span className={`step-dot step-${readString(step['status'], '').toLowerCase()}`} /><span><b>{readString(step['stepId'], t('workflows.detail.stepFallback'))}</b><small>{t('workflows.detail.stepMeta', { status: i18n.status(readString(step['status'], 'pending')), task: readString(step['taskId'], t('common.noTask')) })}</small></span></div>)}</div></div>
      {gate !== null && <div className="approval-callout"><span className="field-label">{t('workflows.detail.approvalGate')}</span><b>{t('workflows.detail.gateMeta', { step: readString(gate['stepId'], t('common.decisionStep')), status: i18n.status(readString(gate['status'], 'open')) })}</b><span>{t('workflows.detail.approvalsRequired', { count: readNumber(gate['requiredCount'], 1) })}</span><button type="button" className="primary" onClick={() => control.navigate('Approvals')}>{t('workflows.detail.reviewApproval')}</button></div>}
    </Panel>}
    <div className="grid-two"><Panel title={t('workflows.tasks.panel')}>{snapshot.tasks.length === 0 ? <Empty title={t('common.noTasks')} hint={t('workflows.tasks.emptyHint')} /> : snapshot.tasks.slice(0, 8).map((task) => <EventLine key={readString(task['taskId'], '')} title={readString(task['title'], '')} detail={t('workflows.tasks.meta', { status: i18n.status(readString(task['status'], '')), owner: readString(task['assigneeEmployeeId'], '') === '' ? t('common.unassigned') : employeeLabel(snapshot.employees, snapshot.positions, readString(task['assigneeEmployeeId'], '')), position: positionTitle(snapshot.positions, readString(task['positionId'], '')) })} />)}</Panel><Panel title={t('workflows.activity.panel')} actions={<button type="button" className="link" onClick={() => control.navigate('Events')}>{t('workflows.activity.open')}</button>}>{snapshot.recentEvents.filter((event) => readString(event['type'], '').startsWith('Workflow.')).length === 0 ? <Empty title={t('workflows.activity.empty')} /> : snapshot.recentEvents.filter((event) => readString(event['type'], '').startsWith('Workflow.')).slice(0, 8).map((event) => <EventLine key={readString(event['eventId'], String(event['seq']))} title={readString(event['type'])} detail={eventDetail(event)} />)}</Panel></div>
  </div>;
}
