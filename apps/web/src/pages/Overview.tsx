import { useState } from 'react';
import { parseRows, parseWorkBriefs, readNumber, readString, requestJson, type Row } from '../api';
import {
  buildWorkBrief,
  simulationCommand,
  submitWorkBrief,
  type BriefProblem,
  type CommandContext,
} from '../commands';
import type { ConsoleControl } from '../control';
import { Avatar, Empty, EventLine, Field, PageIntro, Panel, StatCard, StatusPill, Submit, eventDetail } from '../components';
import {
  agentState,
  agentStateLabel,
  approvalOf,
  briefProgress,
  briefState,
  briefSubmission,
  isOpenApproval,
  openGate,
  positionTitle,
  submissionStatus,
  taskById,
  type BriefSubmission,
  type SubmissionStatus,
} from '../derive';
import { useJson } from '../hooks';
import { hiringRequests } from '../hiring';
import { HiringRequestCard } from '../hiring-views';
import { useI18n, type MessageKey } from '../i18n';
import { overviewWorkStatus, statusLabel, taskStatus } from '../status';

/**
 * How long the console keeps stepping a held runtime while waiting for the Chief Officer to
 * split the brief. Every step is one HTTP round trip and one tick, so this is a bound on
 * patience, not on work — a brief that never decomposes is a failure worth reporting.
 */
const MAX_STEPS_TO_BRIEF = 24;

/**
 * The local half of one submission — what the console knows before the read model answers.
 *
 * It is set synchronously on the click (`creating`), so the operator's own action is on screen in
 * the same frame instead of only after the round trip. `filed` then carries the command id the
 * brief is looked up by; `failed` carries the sentence to show verbatim.
 */
type SubmissionAttempt =
  | { readonly kind: 'creating'; readonly title: string }
  | { readonly kind: 'filed'; readonly title: string; readonly commandId: string; readonly steps: number }
  | { readonly kind: 'failed'; readonly title: string; readonly reason: string };

function ctxOf(control: ConsoleControl): CommandContext { return { companyId: control.companyId, simTime: control.simTime }; }
function chiefOfficer(control: ConsoleControl): { id: string; title: string; name: string } | null {
  const { agents, positions } = control.snapshot;
  const agent = agents.find((row) => readString(row['positionId'], '') === 'ceo') ?? agents[0];
  if (agent === undefined) return null;
  const id = readString(agent['employeeId'], '');
  return id === '' ? null : { id, title: positionTitle(positions, readString(agent['positionId'], '')), name: readString(agent['name'], id) };
}
function fetchBriefRows(): Promise<readonly Row[]> {
  return requestJson('/api/work-briefs').then((payload) => parseWorkBriefs(payload, '/api/work-briefs'));
}
function fetchWorkflowRows(): Promise<readonly Row[]> {
  return requestJson('/api/workflows').then((payload) => parseRows(payload, '/api/workflows'));
}

/** The sentence the operator gets for the field `buildWorkBrief` refused. */
const BRIEF_PROBLEMS: Readonly<Record<BriefProblem, { readonly title: MessageKey; readonly detail: MessageKey }>> = {
  title: { title: 'overview.titleRequired', detail: 'overview.titleRequiredDetail' },
  keys: { title: 'overview.brief.keysRequired', detail: 'overview.brief.keysRequiredDetail' },
  reason: { title: 'overview.brief.reasonRequired', detail: 'overview.brief.reasonRequiredDetail' },
  priority: { title: 'overview.brief.priorityInvalid', detail: 'overview.brief.priorityInvalidDetail' },
  due: { title: 'overview.brief.dueInvalid', detail: 'overview.brief.dueInvalidDetail' },
};

export function OverviewPage({ control }: { control: ConsoleControl }) {
  const i18n = useI18n();
  const { t, tp } = i18n;
  const { snapshot } = control;
  const simulation = snapshot.simulation;
  const workflows = useJson('/api/workflows', parseRows, control.refreshToken);
  const briefs = useJson('/api/work-briefs', parseWorkBriefs, control.refreshToken);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [context, setContext] = useState('');
  const [keys, setKeys] = useState('');
  const [priority, setPriority] = useState('');
  const [dueAtSim, setDueAtSim] = useState('');
  const [reason, setReason] = useState('');
  const [hold, setHold] = useState(true);
  const [busy, setBusy] = useState(false);
  const workflowRows = workflows.data ?? snapshot.workflows;
  const openGates = workflowRows.filter(isOpenApproval).length;
  const activeTasks = snapshot.tasks.filter((task) => !['completed', 'cancelled', 'failed'].includes(readString(task['status'], '').toLowerCase()));
  const activeWorkflows = workflowRows.filter((workflow) => !['completed', 'cancelled', 'failed'].includes(readString(workflow['status'], '').toLowerCase()));
  const workingAgents = snapshot.agents.filter((agent) => readString(agent['currentTaskId'], '') !== '' || agent['paused'] === true);
  const agentRows: readonly Row[] = snapshot.agents.map((agent) => {
    const currentTaskId = readString(agent['currentTaskId'], '');
    const task = currentTaskId === '' ? null : taskById(snapshot.tasks, currentTaskId);
    const state = agentState(agent);
    return { ...agent, position: positionTitle(snapshot.positions, readString(agent['positionId'], '')), state: agentStateLabel(state, task === null ? '' : readString(task['title'], ''), i18n), stateTone: state.tone };
  });
  const briefRows: readonly Row[] = briefs.data ?? [];
  /**
   * The hiring requests the company has raised, read from the same `/api/workflows` and
   * `/api/work-briefs` payloads this page already polls (A5). A request *is* a `hire-gate`
   * instance; its tasks are the brief's own items. Nothing here is an event or an id — the card
   * shows only role, reason, requester, status and the linked work.
   */
  const hiring = hiringRequests(workflows.data ?? [], briefRows);
  const [attempt, setAttempt] = useState<SubmissionAttempt | null>(null);

  /**
   * The submission the operator just made, resolved live against the two read models the console
   * already polls: the brief comes back from `/api/work-briefs` under the operator's own
   * `commandId`, and the workflow (plus the gate it may be waiting on) carries that same id as its
   * correlation. So the block below the button keeps telling the truth as the organization moves —
   * no second transport, no optimistic copy of server state.
   */
  const submitted: BriefSubmission = briefSubmission(
    briefRows,
    workflowRows,
    attempt !== null && attempt.kind === 'filed' ? attempt.commandId : '',
  );
  /**
   * The gate that stands between the operator and the work moving again: this submission's own
   * workflow when the read model has generated one (matched by the command's correlation), or —
   * while the console holds the runtime for review — an open gate on any workflow the hold is
   * protecting. Both come from `/api/workflows`; neither is invented for the panel.
   */
  const pendingGate = submitted.gate ?? (control.held || simulation.paused ? openGate(workflowRows) : null);
  const submitResult: SubmissionStatus | null = attempt === null
    ? null
    : submissionStatus({ stage: attempt.kind, submission: submitted, held: control.held, paused: simulation.paused, gate: pendingGate });

  /**
   * Hold is a promise to the operator: "you will see this brief as work before anything moves".
   * The runtime stays paused, so the only way the decomposition can happen is the console's own
   * one-tick steps — which is exactly what `Simulation.Step` is for. The hold is *not* released
   * when the items land: the brief is now work in motion, and the operator decides when the
   * company continues.
   *
   * A brief is decomposed by the Chief Officer into a *capability-routed workflow* (M1.6), whose
   * work items are created one per workflow step as the run advances — so the first read model
   * that carries this command is already the truth worth reporting: the workflow it started, and
   * the items that exist right now. The block below names both and says the rest follow the run;
   * it must never claim a final item count the read model has not produced yet.
   */
  const stepToBrief = async (commandId: string, briefTitle: string): Promise<void> => {
    for (let attemptIndex = 0; attemptIndex < MAX_STEPS_TO_BRIEF; attemptIndex += 1) {
      const view = briefSubmission(await fetchBriefRows(), await fetchWorkflowRows(), commandId);
      if (view.brief !== null && (view.workflows.length > 0 || view.items.length > 0)) {
        setAttempt({ kind: 'filed', title: briefTitle, commandId, steps: attemptIndex });
        control.setFeedback({
          kind: 'success',
          title: t('feedback.briefSubmitted', { title: briefTitle }),
          detail: t('feedback.briefDecomposed', { count: view.items.length }),
        });
        return;
      }
      // Naming the tick the console is on is the difference between "nothing is happening" and
      // "the organization is still planning" — the same number the step command just advanced.
      setAttempt({ kind: 'filed', title: briefTitle, commandId, steps: attemptIndex + 1 });
      const stepped = await control.runDetailed(simulationCommand(ctxOf(control), 'Simulation.Step'), null);
      if (!stepped.ok) {
        setAttempt({ kind: 'failed', title: briefTitle, reason: stepped.failure ?? t('overview.brief.result.failedDetail') });
        return;
      }
    }
    await control.releaseHold();
    setAttempt({
      kind: 'failed',
      title: briefTitle,
      reason: t('overview.brief.decomposeTimeoutDetail', { steps: MAX_STEPS_TO_BRIEF }),
    });
    control.setFeedback({
      kind: 'error',
      title: t('feedback.briefNoItems'),
      detail: t('overview.brief.decomposeTimeoutDetail', { steps: MAX_STEPS_TO_BRIEF }),
    });
  };

  const startWork = async (): Promise<void> => {
    const draft = buildWorkBrief({ title, goal: objective, context, keys, reason, priority, dueAtSim });
    if (!draft.ok) {
      const problem = BRIEF_PROBLEMS[draft.problem];
      setAttempt({ kind: 'failed', title: title.trim(), reason: `${t(problem.title)} — ${t(problem.detail)}` });
      control.setFeedback({ kind: 'error', title: t(problem.title), detail: t(problem.detail) });
      return;
    }
    const chief = chiefOfficer(control);
    if (chief === null) {
      setAttempt({ kind: 'failed', title: draft.brief.title, reason: `${t('overview.noAgent')} — ${t('overview.noAgentDetail')}` });
      control.setFeedback({ kind: 'error', title: t('overview.noAgent'), detail: t('overview.noAgentDetail') });
      return;
    }
    setBusy(true);
    // Before the first await: the click is acknowledged in this frame, so the panel can never look
    // untouched while the round trip is in flight.
    setAttempt({ kind: 'creating', title: draft.brief.title });
    try {
      if (hold) {
        const held = await control.beginHold();
        if (!held.ok) {
          setAttempt({ kind: 'failed', title: draft.brief.title, reason: held.failure ?? t('overview.brief.result.failedDetail') });
          return;
        }
      }
      const command = submitWorkBrief(ctxOf(control), chief.id, draft.brief, draft.reason);
      const commandId = readString(command['commandId'], '');
      const sent = await control.runDetailed(command, t('feedback.briefSubmitted', { title: draft.brief.title }), null);
      if (!sent.ok) {
        setAttempt({ kind: 'failed', title: draft.brief.title, reason: sent.failure ?? t('overview.brief.result.failedDetail') });
        return;
      }
      setAttempt({ kind: 'filed', title: draft.brief.title, commandId, steps: 0 });
      // Without the hold the runtime advances on its own, so the block reports the read model as it
      // catches up; with it, the console is the only thing that can tick the decomposition.
      if (hold) await stepToBrief(commandId, draft.brief.title);
    } finally { setBusy(false); }
  };

  const status = control.held ? t('overview.status.held') : simulation.paused ? t('overview.status.paused') : t('overview.status.normal');
  return <div className="stack">
    <PageIntro eyebrow={t('overview.eyebrow')} title={snapshot.company.name} description={t('overview.description')} actions={<button type="button" className="primary" onClick={() => document.getElementById('start-work')?.scrollIntoView({ behavior: 'smooth' })}>{t('overview.startWork')}</button>} />
    <section className="overview-hero"><div><span className="live-label"><i />{status}</span><h3>{activeWorkflows.length > 0 ? tp('overview.workInMotion', activeWorkflows.length) : t('overview.ready')}</h3><p>{t('overview.heroMeta', { tick: simulation.tick, simTime: simulation.simTime, queue: simulation.queueDepth })}</p></div><div className="hero-people">{snapshot.agents.slice(0, 5).map((agent) => <Avatar key={readString(agent['employeeId'])} name={readString(agent['name'], t('common.agentFallback'))} />)}{snapshot.agents.length > 5 && <span className="avatar-more">+{String(snapshot.agents.length - 5)}</span>}</div></section>
    <div className="stat-grid"><StatCard label={t('overview.stat.agents')} value={snapshot.agents.length} detail={t('overview.stat.agentsDetail', { count: workingAgents.length })} tone="green" /><StatCard label={t('overview.stat.activeWork')} value={activeTasks.length} detail={t('overview.stat.activeWorkDetail', { count: snapshot.tasks.length })} tone="blue" /><StatCard label={t('overview.stat.workflows')} value={activeWorkflows.length} detail={t('overview.stat.workflowsDetail', { count: workflowRows.length })} /><StatCard label={t('overview.stat.waiting')} value={openGates} detail={openGates > 0 ? t('overview.stat.approvalRequired') : t('overview.stat.noDecisions')} tone={openGates > 0 ? 'amber' : 'green'} /></div>
    <Panel title={t('overview.brief.panel')} actions={<span className="muted">{t('overview.brief.hint')}</span>}><div id="start-work" className="form-grid brief-form">
      <Field label={t('overview.brief.workTitle')}><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t('overview.brief.workTitlePlaceholder')} /></Field>
      <Field label={t('overview.brief.objective')} hint={t('overview.brief.objectiveHint')}><textarea rows={3} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder={t('overview.brief.objectivePlaceholder')} /></Field>
      <Field label={t('overview.brief.context')} hint={t('overview.brief.contextHint')}><textarea rows={3} value={context} onChange={(event) => setContext(event.target.value)} placeholder={t('overview.brief.contextPlaceholder')} /></Field>
      <Field label={t('overview.brief.keys')} hint={t('overview.brief.keysHint')}><textarea rows={2} value={keys} onChange={(event) => setKeys(event.target.value)} placeholder={t('overview.brief.keysPlaceholder')} /></Field>
      <div className="brief-number-row">
        <Field label={t('overview.brief.priority')}><input value={priority} onChange={(event) => setPriority(event.target.value)} placeholder={t('overview.brief.priorityPlaceholder')} inputMode="numeric" /></Field>
        <Field label={t('overview.brief.dueAtSim')}><input value={dueAtSim} onChange={(event) => setDueAtSim(event.target.value)} placeholder={t('overview.brief.dueAtSimPlaceholder')} inputMode="numeric" /></Field>
      </div>
      <Field label={t('overview.brief.reason')} hint={t('overview.brief.reasonHint')}><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t('overview.brief.reasonPlaceholder')} /></Field>
      <label className="checkline"><input type="checkbox" checked={hold} onChange={(event) => setHold(event.target.checked)} /><span>{t('overview.brief.hold')}</span></label>
      <div className="button-row"><Submit busy={busy} onClick={() => void startWork()}>{t('overview.brief.startWork')}</Submit></div>
    </div>
    {attempt !== null && submitResult !== null && <SubmissionReport control={control} attempt={attempt} submission={submitted} status={submitResult} gate={pendingGate} />}
    </Panel>
    {hiring.length > 0 && <Panel title={t('hiring.overview.panel')} actions={<span className="muted">{t('hiring.overview.hint')}</span>}><div className="approval-list">{hiring.map((request) => <HiringRequestCard key={request.instanceId} request={request} employees={snapshot.employees} positions={snapshot.positions} />)}</div></Panel>}
    <Panel title={t('overview.briefs.panel')} actions={<span className="muted">{t('overview.briefs.hint')}</span>}>
      {briefRows.length === 0 ? <Empty title={t('overview.briefs.empty')} hint={t('overview.briefs.emptyHint')} /> : <div className="brief-list">{[...briefRows].reverse().map((brief) => {
        const state = briefState(brief);
        const progress = briefProgress(brief);
        const items = Array.isArray(brief['items']) ? (brief['items'] as readonly Row[]) : [];
        const briefId = readString(brief['briefId'], readString(brief['correlationId']));
        return <article className="brief-detail" key={briefId}>
          <div className="brief-detail-top"><h4>{readString(brief['title'], t('common.untitledWorkflow'))}</h4><StatusPill value={state.pillValue} label={t(state.labelKey)} /></div>
          <p className="brief-goal">{readString(brief['goal'], t('common.noGoal'))}</p>
          <div className="brief-facts">
            <span><small>{t('overview.briefs.submittedBy')}</small><b>{readString(brief['operatorId'], t('common.unassigned'))}</b></span>
            <span><small>{t('overview.briefs.simTime')}</small><b>t{String(readNumber(brief['submittedAtSim'], 0))}</b></span>
            <span><small>{t('overview.briefs.itemsLabel')}</small><b>{t('overview.briefs.progress', { completed: progress.completed, total: progress.total })}</b></span>
            <span><small>{t('overview.briefs.achievement')}</small><b>{String(progress.percent)}%</b></span>
          </div>
          {progress.hasBlockers && <p className="brief-blockers">{tp('overview.briefs.blockers', progress.blocked + progress.rejected)}</p>}
          {items.length === 0 ? <p className="muted">{t('overview.briefs.noItems')}</p> : <ul className="brief-items">{items.map((item) => {
            const status = taskStatus(readString(item['status'], ''));
            const positionId = readString(item['positionId'], '');
            return <li className="brief-item" key={readString(item['taskId'], briefId)}>
              <b>{readString(item['title'], t('common.untitledTask'))}</b>
              <span className="brief-item-id">{t('overview.briefs.taskId')} <code>{readString(item['taskId'], '—')}</code></span>
              <span className="brief-item-position">{positionId === '' ? t('status.unassigned') : positionTitle(snapshot.positions, positionId)}</span>
              <StatusPill value={status.tone} label={statusLabel(status, i18n)} />
            </li>;
          })}</ul>}
        </article>;
      })}</div>}
    </Panel>
    <div className="overview-columns"><Panel title={t('overview.motion.panel')} actions={<button type="button" className="link" onClick={() => control.navigate('Workflows')}>{t('common.viewAll')}</button>}>{activeWorkflows.length === 0 ? <Empty title={t('overview.motion.empty')} hint={t('overview.motion.emptyHint')} /> : activeWorkflows.slice(0, 5).map((workflow) => {
      const display = overviewWorkStatus(readString(workflow['status'], 'running'));
      return <button type="button" className="work-card" key={readString(workflow['instanceId'])} onClick={() => control.navigate('Workflows')}><span className="work-card-main"><b>{readString(workflow['title'], t('common.untitledWorkflow'))}</b><span>{t('overview.motion.cardMeta', { stage: readString(workflow['stageId'], t('common.stagePlanning')), events: readString(workflow['eventCount'], '0') })}</span></span><StatusPill value={display.tone} label={statusLabel(display, i18n)} /></button>;
    })}</Panel><Panel title={t('common.recentActivity')} actions={<button type="button" className="link" onClick={() => control.navigate('Events')}>{t('common.openActivity')}</button>}>{snapshot.recentEvents.length === 0 ? <Empty title={t('common.noActivity')} hint={t('common.noActivityHint')} /> : snapshot.recentEvents.slice(0, 8).map((event) => <EventLine key={readString(event['eventId'], String(event['seq']))} title={readString(event['type'])} detail={eventDetail(event)} />)}</Panel></div>
    <Panel title={t('overview.team.panel')} actions={<button type="button" className="link" onClick={() => control.navigate('Agents')}>{t('overview.team.meet')}</button>}>{agentRows.length === 0 ? <Empty title={t('common.noAgentsOnDuty')} /> : <div className="agent-strip">{agentRows.map((agent) => <button type="button" className="agent-chip" key={readString(agent['employeeId'])} onClick={() => control.navigate('Agents')}><Avatar name={readString(agent['name'], t('common.agentFallback'))} tone={readString(agent['stateTone'], '') === 'ok' ? 'green' : 'default'} /><span><b>{readString(agent['name'], t('common.agentFallback'))}</b><small>{t('overview.team.chipMeta', { position: readString(agent['position'], t('common.agentFallback')), state: readString(agent['state'], t('status.idle')) })}</small></span></button>)}</div>}</Panel>
  </div>;
}

/**
 * The answer to "did my click do anything", rendered where the operator is looking: directly
 * under the Start Work button, inside the brief panel, and left on screen — unlike the
 * console-wide banner, which is at the top of the document and clears itself after eight seconds.
 *
 * Every value is server data the console already reads back: the brief id and its work items from
 * `/api/work-briefs`, the gate from `/api/workflows` (matched by the command's correlation id),
 * and the hold from the runtime. A failure shows the Control Plane's own sentence verbatim, so
 * a refused command is never indistinguishable from a click that did nothing.
 */
function SubmissionReport({ control, attempt, submission, status, gate }: {
  readonly control: ConsoleControl;
  readonly attempt: SubmissionAttempt;
  readonly submission: BriefSubmission;
  readonly status: SubmissionStatus;
  /** The gate waiting for the operator, or `null` when this submission owes no decision. */
  readonly gate: Row | null;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const { positions } = control.snapshot;
  const failed = attempt.kind === 'failed';
  const approval = gate === null ? null : approvalOf(gate);
  const progress = submission.brief === null ? null : briefProgress(submission.brief);
  const workflow = submission.workflows.at(0) ?? null;
  const detail = failed
    ? attempt.reason
    : status.stage === 'creating'
      ? t('overview.brief.result.creatingDetail')
      : status.stage === 'held'
        ? t('overview.brief.result.heldDetail')
        : t('overview.brief.result.createdDetail');
  return <section
    className={`submit-result ${failed ? 'failed' : status.stage}`}
    data-testid="brief-result"
    data-stage={failed ? 'failed' : status.stage}
    role={failed ? 'alert' : 'status'}
    aria-live="polite"
  >
    <div className="submit-result-top">
      <h4>{failed ? t('overview.brief.result.failed') : attempt.kind === 'creating' ? t('overview.brief.result.creating') : t('overview.brief.result.created', { title: attempt.title })}</h4>
      <StatusPill value={status.tone} label={t(status.labelKey)} />
    </div>
    <p className="submit-result-detail" data-testid="brief-result-detail">{detail}</p>
    {!failed && <div className="submit-result-facts">
      <span><small>{t('overview.brief.result.statusLabel')}</small><b data-testid="brief-result-status">{t(status.labelKey)}</b></span>
      {attempt.kind === 'filed' && <span><small>{t('overview.brief.result.commandId')}</small><b>{attempt.commandId}</b></span>}
      {submission.brief !== null && <span><small>{t('overview.brief.result.briefId')}</small><b data-testid="brief-result-brief">{readString(submission.brief['briefId'], '—')}</b></span>}
      {progress !== null && <span><small>{t('overview.brief.result.workItems')}</small><b>{t('overview.brief.result.progress', { completed: progress.completed, total: progress.total })}</b></span>}
      {status.stage === 'decomposing' && attempt.kind === 'filed' && <span><small>{t('status.working')}</small><b>{t('overview.brief.result.steps', { steps: attempt.steps })}</b></span>}
      {workflow !== null && <span><small>{t('overview.brief.result.workflow')}</small><b data-testid="brief-result-workflow">{readString(workflow['title'], t('common.untitledWorkflow'))}</b></span>}
    </div>}
    {submission.items.length > 0 && <ul className="submit-result-items" data-testid="brief-result-items">
      {submission.items.map((item) => {
        const display = taskStatus(item.status);
        return <li key={item.taskId}>
          <span className="submit-result-task"><b>{item.title === '' ? t('common.untitledTask') : item.title}</b><small>{t('overview.brief.result.taskId')} <code data-testid="brief-result-task-id">{item.taskId}</code></small></span>
          <span className="submit-result-where">{item.positionId === '' ? t('status.unassigned') : positionTitle(positions, item.positionId)}</span>
          <StatusPill value={display.tone} label={statusLabel(display, i18n)} />
          <button type="button" className="link" onClick={() => control.openResults(item.taskId)}>{t('overview.brief.result.openTask')}</button>
        </li>;
      })}
    </ul>}
    {approval !== null && gate !== null && <div className="submit-result-gate" data-testid="brief-result-gate">
      <span className="field-label">{t('overview.brief.result.gate')}</span>
      <p>{t('overview.brief.result.gateDetail', { instance: readString(gate['instanceId'], '—'), step: readString(approval['stepId'], '—'), count: readNumber(approval['requiredCount'], 0) })}</p>
      <button type="button" className="primary" onClick={() => control.navigate('Approvals')}>{t('overview.brief.result.goApprovals')}</button>
    </div>}
    {!failed && submission.brief !== null && workflow === null && <p className="muted submit-result-note">{t('overview.brief.result.noWorkflow')}</p>}
    {!failed && workflow !== null && <p className="muted submit-result-note" data-testid="brief-result-stepwise">{t('overview.brief.result.stepwise')}</p>}
    {!failed && workflow !== null && approval === null && status.stage === 'held' && <p className="muted submit-result-note">{t('overview.brief.result.awaitGate')}</p>}
    {!failed && <div className="button-row submit-result-actions">
      <button type="button" onClick={() => control.navigate('Tasks')}>{t('overview.brief.result.viewTasks')}</button>
      {workflow !== null && <button type="button" onClick={() => control.navigate('Workflows')}>{t('overview.brief.result.workflow')}</button>}
      {status.stage === 'held' && <button type="button" onClick={() => control.navigate('Runtime')}>{t('page.runtime.title')}</button>}
    </div>}
  </section>;
}
