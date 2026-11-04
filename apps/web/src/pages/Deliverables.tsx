import { useState } from 'react';
import { parseRows, readString, type Row } from '../api';
import { taskDelete, type CommandContext } from '../commands';
import { DeleteIcon, Empty, PageIntro, Panel, StatusPill } from '../components';
import type { ConsoleControl } from '../control';
import { deliverableState, isOpenApproval, positionTitle, stepProgress, workflowById } from '../derive';
import { useJson } from '../hooks';
import { useI18n, type MessageKey } from '../i18n';
import { statusLabel, taskStatus } from '../status';

function ctxOf(control: ConsoleControl): CommandContext { return { companyId: control.companyId, simTime: control.simTime }; }

/**
 * Deliverables — the CEO workspace.
 *
 * Two questions, one screen: *what is my AI company working on right now, and what has it
 * delivered?* The workspace grid answers the first from the snapshot the shell already polls
 * (task title, responsible role, current stage, short progress, whether you are the blocker);
 * opening a task answers the second by routing to that task's delivery page
 * (`/results/:taskId`), where the organization hands its outcome over.
 *
 * What this page deliberately does not show: company runtime statistics, the agent roster,
 * agent ids, ticks, runtime state, events, workflow traces or debug payloads. Those belong to
 * Overview / Agents / Runtime / Workflows, and repeating them would turn the CEO view back into
 * a monitoring console.
 */

/** The workspace filters: the three states an owner cares about, plus "everything". */
type Filter = 'all' | 'running' | 'needAction' | 'completed';
const FILTERS: readonly Filter[] = ['all', 'running', 'needAction', 'completed'];
const FILTER_KEYS: Readonly<Record<Filter, MessageKey>> = {
  all: 'deliverables.workspace.filter.all',
  running: 'deliverables.workspace.filter.running',
  needAction: 'deliverables.workspace.filter.needAction',
  completed: 'deliverables.workspace.filter.completed',
};

/**
 * One workspace row: the task facts the card shows, plus the workflow stage/step/gate the task
 * inherits from its instance. The task row itself stays the source of truth.
 */
interface WorkspaceRow {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly positionId: string;
  readonly workflowTitle: string;
  readonly stageId: string;
  readonly gateOpen: boolean;
  readonly steps: { readonly done: number; readonly total: number };
  readonly hasWorkflow: boolean;
}

function workspaceRows(snapshotTasks: readonly Row[], workflows: readonly Row[]): readonly WorkspaceRow[] {
  return snapshotTasks.map((task) => {
    const instanceId = readString(task['workflowInstanceId'], '');
    const workflow = workflowById(workflows, instanceId);
    return {
      taskId: readString(task['taskId'], ''),
      title: readString(task['title'], ''),
      status: readString(task['status'], ''),
      positionId: readString(task['positionId'], ''),
      workflowTitle: workflow === null ? '' : readString(workflow['title'], ''),
      stageId: workflow === null ? '' : readString(workflow['stageId'], ''),
      gateOpen: workflow !== null && isOpenApproval(workflow),
      steps: workflow === null ? { done: 0, total: 0 } : stepProgress(workflow),
      hasWorkflow: instanceId !== '',
    };
  });
}

/** One workspace card: what it is, who owns it, where it stands, and whether it needs you. */
function DeliverableCard({ control, row, onOpen }: { control: ConsoleControl; row: WorkspaceRow; onOpen: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const state = deliverableState(row.status, row.gateOpen);
  const role = row.positionId === '' ? '' : positionTitle(control.snapshot.positions, row.positionId);
  const progress = row.hasWorkflow
    ? t('deliverables.card.progressSteps', { done: row.steps.done, total: row.steps.total })
    : t('deliverables.card.progressStandalone');
  /**
   * `Task.Delete` removes the task; when it belongs to a workflow the Control Plane takes the
   * instance with it, so the confirmation names both outcomes before anything is sent.
   */
  const remove = async (): Promise<void> => {
    if (row.taskId === '') return;
    const confirmKey: MessageKey = row.hasWorkflow ? 'common.deleteTaskWorkflowConfirm' : 'common.deleteTaskConfirm';
    if (!window.confirm(t(confirmKey))) return;
    await control.run(taskDelete(ctxOf(control), row.taskId), t('feedback.taskDeleted'));
  };
  return <article className="task-card deliverable-card">
    <div className="task-card-top">
      <div className="task-title"><h3>{row.title === '' ? t('common.untitledTask') : row.title}</h3><span>{row.hasWorkflow ? row.workflowTitle : t('deliverables.card.standalone')}</span></div>
      <div className="card-top-right">
        <StatusPill value={state.tone} label={t(state.labelKey)} />
        <button type="button" className="card-delete" aria-label={t('common.delete')} title={t('common.delete')} disabled={row.taskId === ''} onClick={() => void remove()}><DeleteIcon /></button>
      </div>
    </div>
    <p className="task-goal">{progress}</p>
    <div className="task-facts">
      <span><small>{t('deliverables.card.role')}</small><b>{role === '' ? t('common.unassigned') : role}</b></span>
      <span><small>{t('deliverables.card.stage')}</small><b>{row.stageId === '' ? t('deliverables.card.noStage') : row.stageId}</b></span>
      <span><small>{t('deliverables.card.delivery')}</small><b>{statusLabel(taskStatus(row.status), i18n)}</b></span>
    </div>
    {state.kind === 'needAction' && <div className="deliverable-flag"><i aria-hidden="true" />{t('deliverables.card.needsYou')}</div>}
    <div className="task-actions">
      <button type="button" className="primary" disabled={row.taskId === ''} onClick={onOpen}>{t('deliverables.card.open')}</button>
      {row.gateOpen && <button type="button" onClick={() => control.navigate('Approvals')}>{t('deliverables.card.decide')}</button>}
    </div>
  </article>;
}

export function DeliverablesPage({ control }: { control: ConsoleControl }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [filter, setFilter] = useState<Filter>('all');
  // The workflows endpoint carries the stage, the step progress and the gate state the cards
  // show; the snapshot remains the fallback so the workspace renders before it answers.
  const workflows = useJson('/api/workflows', parseRows, control.refreshToken);
  const rows = workspaceRows(control.snapshot.tasks, workflows.data ?? control.snapshot.workflows);
  const counts = {
    running: rows.filter((row) => deliverableState(row.status, row.gateOpen).kind === 'running').length,
    needAction: rows.filter((row) => deliverableState(row.status, row.gateOpen).kind === 'needAction').length,
    completed: rows.filter((row) => deliverableState(row.status, row.gateOpen).kind === 'completed').length,
  };
  const visible = filter === 'all' ? rows : rows.filter((row) => deliverableState(row.status, row.gateOpen).kind === filter);
  return <div className="stack">
    <PageIntro eyebrow={t('deliverables.eyebrow')} title={t('page.deliverables.title')} description={t('deliverables.description')} actions={<span className="page-count">{t('deliverables.pageCount', { running: counts.running, needAction: counts.needAction, completed: counts.completed })}</span>} />
    <Panel title={t('deliverables.workspace.panel')} actions={<span className="muted">{t('deliverables.workspace.hint', { count: rows.length })}</span>}>
      <div className="deliverable-filters" role="tablist" aria-label={t('deliverables.workspace.panel')}>
        {FILTERS.map((entry) => <button type="button" role="tab" aria-selected={filter === entry} className={filter === entry ? 'deliverable-filter active' : 'deliverable-filter'} key={entry} onClick={() => setFilter(entry)}>{t(FILTER_KEYS[entry])}<b>{entry === 'all' ? rows.length : counts[entry]}</b></button>)}
      </div>
      {rows.length === 0
        ? <Empty title={t('deliverables.workspace.empty')} hint={t('deliverables.workspace.emptyHint')} />
        : visible.length === 0
          ? <Empty title={t('deliverables.workspace.noneInFilter')} hint={t('deliverables.workspace.noneInFilterHint')} />
           : <div className="task-list deliverable-list">{visible.map((row) => <DeliverableCard control={control} row={row} key={row.taskId} onOpen={() => control.openResults(row.taskId)} />)}</div>}
    </Panel>
  </div>;
}
