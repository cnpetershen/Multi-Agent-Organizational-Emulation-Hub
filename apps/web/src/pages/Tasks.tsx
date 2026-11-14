import { useState } from 'react';
import { parseWorkBriefs, parseRows, readString, type Row } from '../api';
import { injectTask, taskAssignToAgent, taskCancel, taskReassign, taskRequestReview, type CommandContext } from '../commands';
import type { ConsoleControl } from '../control';
import { Field, PageIntro, Panel, StatCard, StatusPill, Submit } from '../components';
import { CAPABILITY_IDS, assignmentReason, capabilityLabel, employeeLabel, isArchivedAgent, matchedCapabilities, positionTitle, workflowById } from '../derive';
import { hiringByTask, hiringRequests } from '../hiring';
import { HiringTaskNote } from '../hiring-views';
import { useJson } from '../hooks';
import { useI18n } from '../i18n';
import { statusLabel, taskStatus } from '../status';

function ctxOf(control: ConsoleControl): CommandContext { return { companyId: control.companyId, simTime: control.simTime }; }

/** The capabilities a task record declares — `null` never happens, `[]` means "seat-routed". */
function declaredSkills(task: Row): readonly string[] {
  const skills = task['requiredSkills'];
  if (!Array.isArray(skills)) return [];
  return skills.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

export function TasksPage({ control }: { control: ConsoleControl }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { snapshot } = control;
  const workflows = useJson('/api/workflows', parseRows, control.refreshToken);
  const briefs = useJson('/api/work-briefs', parseWorkBriefs, control.refreshToken);
  // A5: the hiring request a task waits on, if any — derived from the workflow and brief the
  // console already polls, so a parked task can explain itself without reading an event log.
  const hiringByTaskId = hiringByTask(hiringRequests(workflows.data ?? [], briefs.data ?? []));
  /** The newest company brief, so this page can show that its work already arrived here. */
  const latestBrief = [...(briefs.data ?? [])].sort((left, right) =>
    Number(right['submittedAtSim'] ?? 0) - Number(left['submittedAtSim'] ?? 0))[0] ?? null;
  const latestBriefItems = latestBrief !== null && Array.isArray(latestBrief['items'])
    ? (latestBrief['items'] as readonly Row[])
    : [];
  const latestBriefDone = latestBriefItems.filter((item) => readString(item['status'], '') === 'completed').length;
  const latestBriefCancelled = latestBriefItems.filter((item) => readString(item['status'], '') === 'cancelled').length;
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [detail, setDetail] = useState('');
  const [positionId, setPositionId] = useState('');
  /** Create-form routing: dispatch to a seat (M1.0) or let the capability matcher decide (M1.6). */
  const [assignMode, setAssignMode] = useState<'position' | 'capability'>('position');
  const [skills, setSkills] = useState<readonly string[]>([]);
  /** Why this direct dispatch exists — §5.7 makes the operator state it, and it is audited. */
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [reassignTarget, setReassignTarget] = useState<string | null>(null);
  /** How an open task moves: to another seat, to a named agent, or back through the matcher. */
  const [reassignMode, setReassignMode] = useState<'position' | 'agent' | 'capability'>('position');
  const [reassignPosition, setReassignPosition] = useState('');
  const [reassignAgent, setReassignAgent] = useState('');
  const positionOptions = snapshot.positions.map((position) => { const id = readString(position['positionId'], ''); const name = readString(position['title'], id); const staff = Array.isArray(position['employeeIds']) ? (position['employeeIds'] as readonly unknown[]).length : 0; return { id, label: staff === 0 ? t('tasks.create.unstaffed', { name }) : name }; });
  const agentOptions = snapshot.agents.filter((agent) => !isArchivedAgent(agent)).map((agent) => { const id = readString(agent['employeeId'], ''); return { id, label: employeeLabel(snapshot.employees, snapshot.positions, id) }; });
  const rows: readonly Row[] = snapshot.tasks.map((task) => {
    const workflow = readString(task['workflowInstanceId'], '') === '' ? null : workflowById(snapshot.workflows, readString(task['workflowInstanceId'], ''));
    const assigneeId = readString(task['assigneeEmployeeId'], '');
    const status = taskStatus(readString(task['status'], ''));
    return { ...task, assignee: assigneeId === '' ? '' : employeeLabel(snapshot.employees, snapshot.positions, assigneeId), position: readString(task['positionId'], '') === '' ? '' : positionTitle(snapshot.positions, readString(task['positionId'], '')), workflow: workflow === null ? '' : readString(workflow['title'], ''), statusCode: status.code, statusTone: status.tone, displayStatus: statusLabel(status, i18n), attempts: `${String(task['attempt'])}/${String(task['maxAttempts'])}`, reason: assignmentReason(task), matched: matchedCapabilities(task) };
  });
  const active = rows.filter((row) => !['completed', 'cancelled'].includes(readString(row['statusCode'], ''))).length;
  const review = rows.filter((row) => readString(row['statusCode'], '') === 'review').length;
  const blocked = rows.filter((row) => ['blocked', 'failed'].includes(readString(row['statusCode'], ''))).length;
  /** Reassigning by capability is only possible on a task that declares capabilities to match. */
  const targetRow = reassignTarget === null ? null : rows.find((row) => readString(row['taskId'], '') === reassignTarget) ?? null;
  const targetHasSkills = targetRow === null ? false : declaredSkills(targetRow).length > 0;
  /** The task domain forbids `assign` on a blocked task — surface that instead of firing a refused command. */
  const targetBlocked = targetRow !== null && readString(targetRow['statusCode'], '') === 'blocked';
  const toggleSkill = (skill: string, checked: boolean): void => {
    setSkills(checked ? [...skills, skill] : skills.filter((entry) => entry !== skill));
  };
  const submitTask = async (): Promise<void> => {
    const taskTitle = title.trim(); const taskGoal = goal.trim();
    if (taskTitle === '' || taskGoal === '') { control.setFeedback({ kind: 'error', title: t('tasks.titleRequired'), detail: t('tasks.titleRequiredDetail') }); return; }
    const why = reason.trim();
    if (why === '') { control.setFeedback({ kind: 'error', title: t('tasks.reasonRequired'), detail: t('tasks.reasonRequiredDetail') }); return; }

    const byCapability = assignMode === 'capability';
    if (byCapability) {
      if (skills.length === 0) { control.setFeedback({ kind: 'error', title: t('tasks.skillsRequired'), detail: t('tasks.skillsRequiredDetail') }); return; }
    } else if (positionId === '') { control.setFeedback({ kind: 'error', title: t('tasks.positionRequired'), detail: t('tasks.positionRequiredDetail') }); return; }
    setBusy(true);
    try {
      const ok = await control.run(
        injectTask(ctxOf(control), {
          title: taskTitle,
          goal: taskGoal,
          detail: detail.trim(),
          ...(byCapability ? { requiredSkills: skills } : { positionId }),
        }, why),
        byCapability
          ? t('feedback.taskInjectedByCapability', { capabilities: skills.map((skill) => capabilityLabel(skill, t)).join(', ') })
          : t('feedback.taskInjected', { position: positionTitle(snapshot.positions, positionId) }),
      );
      if (ok) { setTitle(''); setGoal(''); setDetail(''); setReason(''); if (byCapability) setSkills([]); }
    } finally { setBusy(false); }
  };
  const confirmReassign = async (): Promise<void> => {
    if (reassignTarget === null) return;
    if (targetBlocked) {
      control.setFeedback({ kind: 'error', title: t('tasks.card.reassignBlocked'), detail: null });
      return;
    }
    if (reassignMode === 'position') {
      if (reassignPosition === '') return;
      const ok = await control.run(taskReassign(ctxOf(control), reassignTarget, reassignPosition), t('feedback.taskReassigned', { position: positionTitle(snapshot.positions, reassignPosition) }));
      if (ok) { setReassignTarget(null); setReassignPosition(''); }
      return;
    }
    if (reassignMode === 'agent') {
      if (reassignAgent === '') return;
      const option = agentOptions.find((entry) => entry.id === reassignAgent);
      const ok = await control.run(taskAssignToAgent(ctxOf(control), reassignTarget, { agentId: reassignAgent }), t('feedback.taskAssignedToAgent', { agent: option === undefined ? reassignAgent : option.label }));
      if (ok) { setReassignTarget(null); setReassignAgent(''); }
      return;
    }
    if (!targetHasSkills) return;
    const ok = await control.run(taskAssignToAgent(ctxOf(control), reassignTarget), t('feedback.taskAssignedByCapability'));
    if (ok) setReassignTarget(null);
  };
  return <div className="stack">
    <PageIntro eyebrow={t('tasks.eyebrow')} title={t('page.tasks.title')} description={t('tasks.description')} actions={<button type="button" className="primary" onClick={() => control.navigate('Overview')}>{t('tasks.startBrief')}</button>} />
    <div className="stat-grid task-stats"><StatCard label={t('tasks.stat.active')} value={active} detail={t('tasks.stat.activeDetail', { count: snapshot.tasks.length })} tone="blue" /><StatCard label={t('tasks.stat.inReview')} value={review} detail={t('tasks.stat.inReviewDetail')} tone="amber" /><StatCard label={t('tasks.stat.attention')} value={blocked} detail={t('tasks.stat.attentionDetail')} tone={blocked > 0 ? 'amber' : 'green'} /></div>
    <Panel title={t('tasks.create.panel')} actions={<span className="muted">{t('tasks.create.hint')}</span>}>
      <div className="task-intake">
        <div>
          <small>{t('tasks.intake.kicker')}</small>
          <b>{latestBrief === null ? t('tasks.intake.none') : readString(latestBrief['title'], t('tasks.intake.none'))}</b>
          <p>
            {latestBrief === null
              ? t('tasks.intake.noneHint')
              : latestBriefItems.length === 0
                ? t('tasks.intake.waiting')
                : t('tasks.intake.items', {
                    count: latestBriefItems.length,
                    done: latestBriefDone,
                    cancelled: latestBriefCancelled,
                  })}
          </p>
        </div>
        <button type="button" className="link" onClick={() => control.navigate('Overview')}>
          {t('tasks.intake.open')}
        </button>
      </div>
      <div id="inject-task" className="form-grid task-form">
        <p className="task-direct-note">{t('tasks.create.directNotice')}</p>
        <Field label={t('tasks.create.title')}>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('tasks.create.titlePlaceholder')} />
        </Field>
        <Field label={t('tasks.create.goal')} hint={t('tasks.create.goalHint')}>
          <textarea rows={3} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={t('tasks.create.goalPlaceholder')} />
        </Field>
        <Field label={t('tasks.create.detail')}>
          <textarea rows={2} value={detail} onChange={(event) => setDetail(event.target.value)} />
        </Field>
        <Field label={t('tasks.create.mode')}>
          <select value={assignMode} onChange={(event) => setAssignMode(event.target.value === 'capability' ? 'capability' : 'position')}>
            <option value="position">{t('tasks.create.modePosition')}</option>
            <option value="capability">{t('tasks.create.modeCapability')}</option>
          </select>
        </Field>
        {assignMode === 'position' ? (
          <Field label={t('tasks.create.assignTo')} hint={t('tasks.create.assignHint')}>
            <select value={positionId} onChange={(event) => setPositionId(event.target.value)}>
              <option value="">{t('common.selectPosition')}</option>
              {positionOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </Field>
        ) : (
          <Field label={t('tasks.create.capabilities')} hint={t('tasks.create.capabilitiesHint')}>
            <div className="capability-row">
              {CAPABILITY_IDS.map((capability) => (
                <label key={capability}>
                  <input type="checkbox" checked={skills.includes(capability)} onChange={(event) => toggleSkill(capability, event.target.checked)} />
                  {capabilityLabel(capability, t)}
                </label>
              ))}
            </div>
          </Field>
        )}
        <Field label={t('tasks.create.reason')} hint={t('tasks.create.reasonHint')}>
          <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t('tasks.create.reasonPlaceholder')} />
        </Field>
        <div className="button-row">
          <Submit busy={busy} onClick={() => void submitTask()}>
            {t('tasks.createTask')}
          </Submit>
        </div>
      </div>

    </Panel>
    <Panel title={t('tasks.queue.panel')} actions={<span className="muted">{t('tasks.queue.hint', { count: rows.length })}</span>}>
      {rows.length === 0 ? <div className="empty-block"><b>{t('tasks.queue.empty')}</b><p>{t('tasks.queue.emptyHint')}</p></div> : <div className="task-list">{rows.map((row) => { const id = readString(row['taskId'], ''); const hire = hiringByTaskId.get(id) ?? null; const status = readString(row['displayStatus'], ''); const reason = readString(row['reason'], ''); const matched = Array.isArray(row['matched']) ? (row['matched'] as readonly string[]) : []; return <article className="task-card" key={id}><div className="task-card-top"><div className="task-title"><h3>{readString(row['title'], t('common.untitledTask'))}</h3><span>{readString(row['workflow'], '') === '' ? t('tasks.card.standalone') : readString(row['workflow'])}</span></div>{hire !== null && hire.status === 'pending' ? <StatusPill value="pending" label={t('hiring.tasks.waiting')} /> : hire !== null && hire.status === 'rejected' ? <StatusPill value="blocked" label={t('hiring.eta.rejected')} /> : <StatusPill value={readString(row['statusTone'], 'queued')} label={status} />}</div><p className="task-goal">{readString(row['goal'], t('common.noGoal'))}</p><div className="task-facts"><span><small>{t('tasks.card.owner')}</small><b>{readString(row['assignee'], '') === '' ? (readString(row['position'], '') || t('status.unassigned')) : readString(row['assignee'])}</b></span><span><small>{t('tasks.card.attempts')}</small><b>{readString(row['attempts'], '0/0')}</b></span><span><small>{t('tasks.card.taskId')}</small><b>{id || '—'}</b></span></div><div className="task-why"><span className="field-label">{t('tasks.card.whyAssigned')}</span><b>{reason === '' ? t('tasks.card.whyAssignedNone') : reason}</b>{matched.length > 0 && <><span className="field-label">{t('tasks.card.matchedCapabilities')}</span><ul className="chip-list">{matched.map((capability) => <li key={capability}>{capabilityLabel(capability, t)}</li>)}</ul></>}</div>{hire !== null && <HiringTaskNote request={hire} employees={snapshot.employees} />}<div className="task-actions"><button type="button" disabled={readString(row['statusCode'], '') === 'blocked'} title={readString(row['statusCode'], '') === 'blocked' ? t('tasks.card.reassignBlocked') : undefined} onClick={() => { setReassignTarget(id); setReassignPosition(''); setReassignAgent(''); setReassignMode('position'); }}>{t('tasks.card.reassign')}</button><button type="button" onClick={() => void control.run(taskRequestReview(ctxOf(control), id), t('feedback.reviewRequested'))}>{t('tasks.card.requestReview')}</button><button type="button" onClick={() => void control.run(taskCancel(ctxOf(control), id), t('feedback.taskCancelled'))}>{t('common.cancel')}</button></div></article>; })}</div>}
    </Panel>
    {reassignTarget !== null && <Panel title={t('tasks.reassign.panel')} actions={<span className="muted">{reassignTarget}</span>}><div className="reassign-row"><Field label={t('tasks.reassign.mode')}><select value={reassignMode} onChange={(event) => setReassignMode(event.target.value === 'agent' ? 'agent' : event.target.value === 'capability' ? 'capability' : 'position')}><option value="position">{t('tasks.reassign.modePosition')}</option><option value="agent">{t('tasks.reassign.modeAgent')}</option><option value="capability" disabled={!targetHasSkills}>{t('tasks.reassign.modeCapability')}</option></select></Field>{reassignMode === 'position' && <Field label={t('tasks.reassign.newPosition')}><select value={reassignPosition} onChange={(event) => setReassignPosition(event.target.value)}><option value="">{t('common.selectPosition')}</option>{positionOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></Field>}{reassignMode === 'agent' && <Field label={t('tasks.reassign.newAgent')}><select value={reassignAgent} onChange={(event) => setReassignAgent(event.target.value)}><option value="">{t('tasks.reassign.selectAgent')}</option>{agentOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></Field>}{reassignMode === 'capability' && <p className="muted">{targetHasSkills ? t('tasks.reassign.capabilityHint') : t('tasks.reassign.capabilityNeedsSkills')}</p>}<div className="button-row"><button type="button" className="primary" disabled={targetBlocked || (reassignMode === 'position' && reassignPosition === '') || (reassignMode === 'agent' && reassignAgent === '') || (reassignMode === 'capability' && !targetHasSkills)} onClick={() => void confirmReassign()}>{t('tasks.card.reassign')}</button><button type="button" onClick={() => setReassignTarget(null)}>{t('common.cancel')}</button></div></div></Panel>}
  </div>;
}
