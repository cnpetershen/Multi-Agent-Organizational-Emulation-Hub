import { useState } from 'react';
import { parseRows, readString } from '../api';
import { taskDelete, type CommandContext } from '../commands';
import { AgentAvatar, DeleteIcon, Empty, PageIntro, Panel, StatusPill } from '../components';
import type { ConsoleControl } from '../control';
import {
  deliveryProjects,
  type DeliveryContributor,
  type DeliveryProject,
  type DeliveryProjectTask,
  type DeliveryProjectState,
} from '../delivery-package';
import { deliverableState, employeeOf, positionTitle } from '../derive';
import { useJson } from '../hooks';
import { useI18n, type MessageKey } from '../i18n';
import { statusLabel, taskStatus } from '../status';

function ctxOf(control: ConsoleControl): CommandContext { return { companyId: control.companyId, simTime: control.simTime }; }

/**
 * Deliverables — the CEO workspace, grouped as projects.
 *
 * The old screen listed one card per task, which answered "what is being worked on?" but buried
 * the answer to "what did this project deliver, and who did what?". This version keeps one block
 * per workflow instance (or standalone task): the project's state and progress at the top, then
 * one row per contributor with the steps and tasks they own. Opening a row still routes to the
 * existing task delivery page (`/results/:taskId`), where the organization hands its outcome over.
 */

type Filter = 'all' | 'running' | 'needAction' | 'completed';
const FILTERS: readonly Filter[] = ['all', 'running', 'needAction', 'completed'];
const FILTER_KEYS: Readonly<Record<Filter, MessageKey>> = {
  all: 'deliverables.workspace.filter.all',
  running: 'deliverables.workspace.filter.running',
  needAction: 'deliverables.workspace.filter.needAction',
  completed: 'deliverables.workspace.filter.completed',
};

function ContributorRow({
  control,
  contributor,
  tasks,
  onDelete,
}: {
  readonly control: ConsoleControl;
  readonly contributor: DeliveryContributor;
  readonly tasks: readonly DeliveryProjectTask[];
  readonly onDelete: (task: DeliveryProjectTask) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const employee = employeeOf(control.snapshot.employees, contributor.employeeId);
  const name = employee === null ? t('common.unassigned') : readString(employee['name'], contributor.employeeId);
  const role = employee === null
    ? ''
    : positionTitle(control.snapshot.positions, readString(employee['positionId'], ''));
  return (
    <div className="project-contributor">
      <div className="project-person">
        <AgentAvatar name={name} positionId={employee === null ? undefined : readString(employee['positionId'], '')} positionTitle={role === '' ? undefined : role} status={employee === null ? 'vacant' : 'idle'} size="sm" />
        <div>
          <b>{name}</b>
          <small>{role === '' ? t('common.unassigned') : role}</small>
        </div>
        <span className="project-person-count">{tasks.length}</span>
      </div>
      <ul className="project-task-list">
        {tasks.map((task) => {
          const display = taskStatus(task.status);
          return (
            <li key={task.taskId}>
              <div className="project-task-copy">
                <span className="project-step">{task.stepTitle === '' ? t('deliverables.project.noStep') : task.stepTitle}</span>
                <b>{task.title === '' ? t('common.untitledTask') : task.title}</b>
              </div>
              <StatusPill value={display.tone} label={statusLabel(display, i18n)} />
              {task.completed && (
                <button type="button" className="link" onClick={() => control.openResults(task.taskId)}>
                  {t('deliverables.project.openTask')}
                </button>
              )}
              <button
                type="button"
                className="card-delete"
                aria-label={t('common.delete')}
                title={t('common.delete')}
                disabled={task.taskId === ''}
                onClick={() => onDelete(task)}
              >
                <DeleteIcon />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ProjectCard({
  control,
  project,
  onDelete,
}: {
  readonly control: ConsoleControl;
  readonly project: DeliveryProject;
  readonly onDelete: (task: DeliveryProjectTask, hasWorkflow: boolean) => void;
}) {
  const { t } = useI18n();
  const state = deliverableState(project.state === 'completed' ? 'completed' : project.state === 'needAction' ? 'blocked' : 'started', project.gateOpen);
  const contributorTasks = (contributor: DeliveryContributor): readonly DeliveryProjectTask[] =>
    project.tasks.filter((task) => contributor.taskIds.includes(task.taskId));
  return (
    <article className="project-card" data-state={project.state}>
      <header className="project-card-head">
        <div className="project-identity">
          <span className="project-kicker">
            {project.standalone ? t('deliverables.project.standalone') : t('deliverables.project.kicker')}
          </span>
          <h3>{project.title === '' ? t('common.untitledTask') : project.title}</h3>
          <p>
            {project.standalone
              ? t('deliverables.project.standaloneDetail')
              : t('deliverables.project.progress', { done: project.stepsDone, total: project.stepsTotal })}
          </p>
        </div>
        <div className="project-card-right">
          <StatusPill value={state.tone} label={t(state.labelKey)} />
          {project.anchorTaskId !== null && (
            <button type="button" className="primary" onClick={() => control.openResults(project.anchorTaskId as string)}>
              {t('deliverables.project.open')}
            </button>
          )}
        </div>
      </header>

      <div className="project-metrics">
        <span><b>{project.completed}/{project.total}</b><small>{t('deliverables.project.delivered')}</small></span>
        <span><b>{project.contributors.length}</b><small>{t('deliverables.project.contributors')}</small></span>
        {!project.standalone && <span><b>{project.stepsDone}/{project.stepsTotal}</b><small>{t('deliverables.project.steps')}</small></span>}
      </div>

      {project.gateOpen && (
        <div className="deliverable-flag"><i aria-hidden="true" />{t('deliverables.card.needsYou')}</div>
      )}

      <div className="project-what">
        <span className="field-label">{t('deliverables.project.what')}</span>
        {project.tasks.length === 0 ? (
          <Empty title={t('deliverables.project.empty')} hint={t('deliverables.project.emptyHint')} />
        ) : project.contributors.length === 0 ? (
          <p className="project-unassigned">{t('deliverables.project.noContributor')}</p>
        ) : (
          <div className="project-contributors">
            {project.contributors.map((contributor) => (
              <ContributorRow
                key={contributor.employeeId}
                control={control}
                contributor={contributor}
                tasks={contributorTasks(contributor)}
                onDelete={(task) => onDelete(task, !project.standalone)}
              />
            ))}
          </div>
        )}
      </div>

      {project.gateOpen && (
        <div className="project-actions">
          <button type="button" onClick={() => control.navigate('Approvals')}>{t('deliverables.card.decide')}</button>
        </div>
      )}
    </article>
  );
}

export function DeliverablesPage({ control }: { control: ConsoleControl }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>('all');
  // The workflows endpoint carries the stage, the step progress and the gate state the project
  // blocks show; the snapshot remains the fallback so the workspace renders before it answers.
  const workflows = useJson('/api/workflows', parseRows, control.refreshToken);
  const workflowRows = workflows.data ?? control.snapshot.workflows;
  const projects = deliveryProjects(control.snapshot.tasks, workflowRows);
  const countOf = (state: DeliveryProjectState): number =>
    projects.filter((project) => project.state === state).length;
  const counts = {
    running: countOf('running'),
    needAction: countOf('needAction'),
    completed: countOf('completed'),
  };
  const visible = filter === 'all' ? projects : projects.filter((project) => project.state === filter);

  const remove = async (task: DeliveryProjectTask, hasWorkflow: boolean): Promise<void> => {
    if (task.taskId === '') return;
    const confirmKey: MessageKey = hasWorkflow ? 'common.deleteTaskWorkflowConfirm' : 'common.deleteTaskConfirm';
    if (!window.confirm(t(confirmKey))) return;
    await control.run(taskDelete(ctxOf(control), task.taskId), t('feedback.taskDeleted'));
  };

  return <div className="stack">
    <PageIntro
      eyebrow={t('deliverables.eyebrow')}
      title={t('page.deliverables.title')}
      description={t('deliverables.description')}
      actions={<span className="page-count">{t('deliverables.pageCount', { running: counts.running, needAction: counts.needAction, completed: counts.completed })}</span>}
    />

    <Panel
      title={t('deliverables.projects.panel')}
      actions={<span className="muted">{t('deliverables.projects.hint', { count: projects.length })}</span>}
    >
      <div className="deliverable-filters" role="tablist" aria-label={t('deliverables.projects.panel')}>
        {FILTERS.map((entry) => (
          <button
            type="button"
            role="tab"
            aria-selected={filter === entry}
            className={filter === entry ? 'deliverable-filter active' : 'deliverable-filter'}
            key={entry}
            onClick={() => setFilter(entry)}
          >
            {t(FILTER_KEYS[entry])}<b>{entry === 'all' ? projects.length : counts[entry]}</b>
          </button>
        ))}
      </div>
      {projects.length === 0
        ? <Empty title={t('deliverables.workspace.empty')} hint={t('deliverables.workspace.emptyHint')} />
        : visible.length === 0
          ? <Empty title={t('deliverables.workspace.noneInFilter')} hint={t('deliverables.workspace.noneInFilterHint')} />
          : <div className="project-list">
              {visible.map((project) => (
                <ProjectCard
                  key={project.instanceId}
                  control={control}
                  project={project}
                  onDelete={(task, hasWorkflow) => void remove(task, hasWorkflow)}
                />
              ))}
            </div>}
    </Panel>
  </div>;
}
