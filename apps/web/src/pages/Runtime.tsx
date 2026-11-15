import { parseApprovals, parseRows, parseSimulation, readNumber, readString, type Row, type SimulationView } from '../api';
import { simulationCommand, type CommandContext } from '../commands';
import type { ConsoleControl } from '../control';
import { AgentAvatar, avatarStatusOf, Empty, EventLine, Panel, StatusPill, Submit, eventDetail } from '../components';
import { agentState, agentStateLabel, employeeName, isOpenApproval, positionTitle, stepProgress, taskById } from '../derive';
import { useJson } from '../hooks';
import { useI18n, type I18n } from '../i18n';
import '../runtime.css';

/**
 * The Runtime page is the company operations console: what the runtime is doing right now,
 * who is working, which work is in flight and which decisions are waiting for the operator.
 *
 * The controls are unchanged — Pause / Resume / Step are the same real `Simulation.*`
 * commands over `/api/command` the Control Plane executes and audits. Every value rendered
 * below is read from an API payload (`/api/simulation`, `/api/snapshot`, `/api/workflows`,
 * `/api/approvals`); the raw `/api/simulation` document is still one fold away under
 * Advanced Details, so the debug view did not disappear — it stopped being the whole page.
 */

function ctxOf(control: ConsoleControl): CommandContext {
  return { companyId: control.companyId, simTime: control.simTime };
}

/** Task and workflow statuses that still mean "this is live work". */
const FINISHED_STATUSES = new Set(['completed', 'cancelled', 'canceled', 'aborted', 'failed']);

function isLiveStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized !== '' && !FINISHED_STATUSES.has(normalized);
}

function gateOf(workflow: Row): Row {
  const approval = workflow['approval'];
  return typeof approval === 'object' && approval !== null && !Array.isArray(approval) ? (approval as Row) : {};
}

interface ActivityState {
  readonly label: string;
  readonly detail: string;
  readonly tone: string;
}

/**
 * What the *company* is doing, next to the *runtime* state: `Running`/`Paused` is the clock
 * (what Pause and Resume control), while the activity separates a busy company from one that
 * is running but has nothing queued — the `Idle` state an operator needs to see.
 */
function activityOf(input: {
  readonly paused: boolean;
  readonly activeTasks: number;
  readonly activeWorkflows: number;
  readonly queueDepth: number;
  readonly pendingWakeups: number;
}, i18n: I18n): ActivityState {
  if (input.paused) {
    return { label: i18n.t('runtime.activity.paused'), detail: i18n.t('runtime.activity.pausedDetail'), tone: 'warn' };
  }
  const queued = input.activeTasks + input.activeWorkflows + input.queueDepth + input.pendingWakeups;
  if (queued > 0) {
    return {
      label: i18n.t('runtime.activity.working'),
      detail: i18n.t('runtime.activity.workingDetail', {
        tasks: input.activeTasks,
        workflows: input.activeWorkflows,
        queue: input.queueDepth,
        wakeups: input.pendingWakeups,
      }),
      tone: 'ok',
    };
  }
  return { label: i18n.t('runtime.activity.idle'), detail: i18n.t('runtime.activity.idleDetail'), tone: 'muted' };
}

function briefOf(input: {
  readonly paused: boolean;
  readonly tick: number;
  readonly activeTasks: number;
  readonly activeWorkflows: number;
  readonly pendingWakeups: number;
  readonly queueDepth: number;
  readonly gates: number;
}, i18n: I18n): string {
  if (input.paused) {
    return i18n.t('runtime.brief.held', { tick: input.tick });
  }
  const inFlight = input.activeTasks + input.activeWorkflows;
  if (inFlight === 0 && input.pendingWakeups === 0 && input.queueDepth === 0) {
    return i18n.t('runtime.brief.idle', { tick: input.tick });
  }
  const parts = [i18n.tp('runtime.brief.workstreams', inFlight)];
  if (input.gates > 0) parts.push(i18n.tp('runtime.brief.decisions', input.gates));
  return i18n.t('runtime.brief.working', { parts: parts.join(' · ') });
}

/** The key/value facts of the raw payload, kept for the folded Advanced Details block. */
function runtimeFacts(view: SimulationView, i18n: I18n): readonly (readonly [string, string])[] {
  const raw = view.raw;
  const pausedAgents = Array.isArray(raw['pausedAgentIds'])
    ? (raw['pausedAgentIds'] as readonly unknown[]).map((id) => String(id)).join(', ')
    : '';
  const exceeded = Array.isArray(raw['lastTickExceeded'])
    ? (raw['lastTickExceeded'] as readonly unknown[]).map((item) => String(item)).join(', ')
    : '';
  return [
    [i18n.t('runtime.facts.status'), i18n.status(readString(raw['status'], view.paused ? 'paused' : 'running'))],
    [i18n.t('runtime.facts.tick'), String(view.tick)],
    [i18n.t('runtime.facts.simTime'), String(view.simTime)],
    [i18n.t('runtime.facts.tickDuration'), readString(raw['tickDuration'], '—')],
    [i18n.t('runtime.facts.queueDepth'), String(view.queueDepth)],
    [i18n.t('runtime.facts.pendingWakeups'), String(readNumber(raw['pendingWakeups']))],
    [i18n.t('runtime.facts.pausedAgents'), pausedAgents === '' ? i18n.t('runtime.facts.none') : pausedAgents],
    [i18n.t('runtime.facts.lastTick'), i18n.status(readString(raw['lastTickStatus'], '—'))],
    [i18n.t('runtime.facts.budgetOverruns'), exceeded === '' ? i18n.t('runtime.facts.none') : exceeded],
  ];
}

/** The agent's presence, unless it merely repeats the work state shown next to it. */
function presenceSuffix(presenceLabel: string): string {
  return presenceLabel === '' ? '' : ` · ${presenceLabel}`;
}

export function RuntimePage({ control }: { control: ConsoleControl }) {
  const i18n = useI18n();
  const { t } = i18n;
  const simulation = useJson('/api/simulation', parseSimulation, control.refreshToken);
  const workflows = useJson('/api/workflows', parseRows, control.refreshToken);
  const approvals = useJson('/api/approvals', parseApprovals, control.refreshToken);

  const { snapshot } = control;
  /**
   * `/api/simulation` is the authoritative read; while it is loading (or if it fails) the
   * runtime state the app already polls in `/api/snapshot` is shown instead, so the console
   * never renders an empty state it actually has — and never invents one it does not.
   */
  const live = simulation.data;
  const state = live ?? snapshot.simulation;
  const paused = state.paused;

  const workflowRows = workflows.data ?? snapshot.workflows;
  const gates = workflowRows.filter(isOpenApproval);
  const activeWorkflows = workflowRows.filter((workflow) => isLiveStatus(readString(workflow['status'], '')));
  const activeTasks = snapshot.tasks.filter((task) => isLiveStatus(readString(task['status'], '')));
  const escalations = approvals.data ?? [];
  const pendingWakeups = readNumber(state.raw['pendingWakeups']);
  const activity = activityOf({
    paused,
    activeTasks: activeTasks.length,
    activeWorkflows: activeWorkflows.length,
    queueDepth: state.queueDepth,
    pendingWakeups,
  }, i18n);
  const brief = briefOf({
    paused,
    tick: state.tick,
    activeTasks: activeTasks.length,
    activeWorkflows: activeWorkflows.length,
    pendingWakeups,
    queueDepth: state.queueDepth,
    gates: gates.length,
  }, i18n);

  const agentRows = snapshot.agents.map((agent) => {
    const taskId = readString(agent['currentTaskId'], '');
    const task = taskId === '' ? null : taskById(snapshot.tasks, taskId);
    const taskTitle = task === null ? '' : readString(task['title'], '');
    const workState = agentState(agent);
    const presence = readString(agent['presence'], '');
    return {
      id: readString(agent['employeeId'], ''),
      name: readString(agent['name'], t('common.agentFallback')),
      position: positionTitle(snapshot.positions, readString(agent['positionId'], '')),
      positionId: readString(agent['positionId'], ''),
      stateKind: workState.kind,
      presenceLabel: presence === '' || presence === 'idle' || presence === 'unknown' ? '' : i18n.presence(presence),
      chip: agentStateLabel(workState, '', i18n),
      tone: workState.tone,
      working: workState.kind === 'working',
      task: taskTitle,
    };
  });
  const workingAgents = agentRows.filter((agent) => agent.working).length;
  const approvalReadFailed = workflows.status === 'failed' || approvals.status === 'failed';
  const pendingTotal = gates.length + escalations.length;
  const events = snapshot.recentEvents;

  const toggleRuntime = (): void => {
    void control.run(
      simulationCommand(
        ctxOf(control),
        paused ? 'Simulation.Resume' : 'Simulation.Pause',
        'operator action from runtime page',
      ),
      paused ? t('feedback.runtimeResumed') : t('feedback.runtimePaused'),
    );
  };
  const stepOnce = (): void => {
    void control.run(
      simulationCommand(ctxOf(control), 'Simulation.Step', 'operator action from runtime page'),
      t('feedback.oneTickAdvanced'),
    );
  };

  return (
    <div className="stack runtime-console">
      <section className="runtime-hero" aria-label={t('runtime.ariaLabel')}>
        <div className="runtime-hero-main">
          <div className="runtime-state">
            <i className={`runtime-pulse ${paused ? 'paused' : 'live'}`} aria-hidden="true" />
            <strong>{paused ? t('runtime.state.paused') : t('runtime.state.running')}</strong>
            <span>
              {t('runtime.tickMeta', { tick: state.tick, simTime: state.simTime })}
            </span>
          </div>
          <p className="runtime-brief">{brief}</p>
          <div className="runtime-tags">
            <span className="runtime-tag">
              <small>{t('runtime.tags.company')}</small>
              <b>{snapshot.company.name}</b>
              <span>{control.companyId}</span>
            </span>
            <span className="runtime-tag">
              <small>{t('runtime.tags.tick')}</small>
              <b>{String(state.tick)}</b>
              <span>{t('runtime.tags.simTime', { simTime: state.simTime })}</span>
            </span>
            <span className={`runtime-tag activity-${activity.tone}`}>
              <small>{t('runtime.tags.activity')}</small>
              <b>{activity.label}</b>
              <span>{activity.detail}</span>
            </span>
            <span className="runtime-tag">
              <small>{t('runtime.tags.agents')}</small>
              <b>
                {t('runtime.tags.working', { working: workingAgents, total: agentRows.length })}
              </b>
              <span>
                {t('runtime.tags.queue', { queue: state.queueDepth, wakeups: pendingWakeups })}
              </span>
            </span>
          </div>
          {control.held && (
            <p className="runtime-note held" role="status">
              {t('runtime.heldNote')}
            </p>
          )}
          {simulation.error !== null && (
            <p className="runtime-note">
              {t('runtime.readFailed', { error: simulation.error })}
            </p>
          )}
        </div>
        <div className="runtime-hero-actions button-row">
          <button type="button" className="primary" onClick={toggleRuntime}>
            {paused ? t('common.resume') : t('common.pause')}
          </button>
          <Submit busy={false} disabled={!paused} onClick={stepOnce}>
            {t('runtime.stepOnce')}
          </Submit>
          <span className="runtime-hint">
            {paused ? t('runtime.stepHint') : t('runtime.pauseHint')}
          </span>
        </div>
      </section>

      <div className="runtime-columns">
        <Panel
          title={t('runtime.agents.panel')}
          actions={
            <span className="page-count">
              {t('runtime.agents.count', { working: workingAgents, idle: agentRows.length - workingAgents })}
            </span>
          }
        >
          {agentRows.length === 0 ? (
            <Empty title={t('common.noAgentsOnDuty')} hint={t('common.noAgentsHint')} />
          ) : (
            <div className="runtime-agents">
              {agentRows.map((agent) => (
                <article className="runtime-agent" key={agent.id}>
                  <AgentAvatar name={agent.name} positionId={agent.positionId} positionTitle={agent.position} status={avatarStatusOf(agent.stateKind)} />
                  <div className="runtime-agent-copy">
                    <div className="runtime-agent-top">
                      <b>{agent.name}</b>
                      <span className={`runtime-chip tone-${agent.tone}`}>{agent.chip}</span>
                    </div>
                    <span className="runtime-agent-role">
                      {agent.position}
                      {presenceSuffix(agent.presenceLabel)}
                    </span>
                    <small>{agent.task === '' ? t('status.available') : agent.task}</small>
                  </div>
                </article>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title={t('runtime.currentWork.panel')}
          actions={
            <button type="button" className="link" onClick={() => control.navigate('Workflows')}>
              {t('runtime.currentWork.open')}
            </button>
          }
        >
          <div className="runtime-work">
            <div className="runtime-work-group">
              <h4>{t('runtime.currentWork.workflows')}</h4>
              {activeWorkflows.length === 0 ? (
                <p className="runtime-empty">{t('runtime.currentWork.noWorkflows')}</p>
              ) : (
                activeWorkflows.slice(0, 4).map((workflow) => {
                  const instanceId = readString(workflow['instanceId'], '');
                  const progress = stepProgress(workflow);
                  const progressLabel = progress.total === 0 ? '' : t('workflows.steps', { done: progress.done, total: progress.total });
                  return (
                    <article className="runtime-work-row" key={instanceId}>
                      <div className="runtime-work-main">
                        <b>{readString(workflow['title'], t('common.untitledWorkflow'))}</b>
                        <span>
                          {t('runtime.currentWork.workRowMeta', {
                            stage: readString(workflow['stageId'], t('common.stagePlanning')),
                            progress: progressLabel === '' ? '' : ` · ${progressLabel}`,
                            events: readNumber(workflow['eventCount']),
                          })}
                        </span>
                      </div>
                      <StatusPill value={readString(workflow['status'], 'running')} label={i18n.status(readString(workflow['status'], 'running'))} />
                    </article>
                  );
                })
              )}
            </div>
            <div className="runtime-work-group">
              <h4>{t('runtime.currentWork.tasks')}</h4>
              {activeTasks.length === 0 ? (
                <p className="runtime-empty">{t('runtime.currentWork.noTasks')}</p>
              ) : (
                activeTasks.slice(0, 6).map((task) => {
                  const assignee = readString(task['assigneeEmployeeId'], '');
                  return (
                    <article className="runtime-work-row" key={readString(task['taskId'], '')}>
                      <div className="runtime-work-main">
                        <b>{readString(task['title'], t('common.untitledTask'))}</b>
                        <span>
                          {t('runtime.taskRowMeta', {
                            owner: assignee === '' ? t('common.unassigned') : employeeName(snapshot.employees, assignee),
                            attempt: readNumber(task['attempt']),
                            maxAttempts: readNumber(task['maxAttempts']),
                            events: readNumber(task['eventCount']),
                          })}
                        </span>
                      </div>
                      <StatusPill value={readString(task['status'], 'created')} label={i18n.status(readString(task['status'], 'created'))} />
                    </article>
                  );
                })
              )}
            </div>
          </div>
        </Panel>
      </div>

      <Panel
        title={t('runtime.approvals.panel')}
        actions={
          <button type="button" className="link" onClick={() => control.navigate('Approvals')}>
            {pendingTotal === 0 ? t('runtime.approvals.open') : t('runtime.approvals.decide', { count: pendingTotal })}
          </button>
        }
      >
        {approvalReadFailed ? (
          <Empty
            title={t('common.approvalInboxUnavailable')}
            hint={workflows.error ?? approvals.error ?? t('runtime.approvals.apiError')}
          />
        ) : pendingTotal === 0 ? (
          <Empty
            title={t('runtime.approvals.empty')}
            hint={t('runtime.approvals.emptyHint')}
          />
        ) : (
          <div className="runtime-approvals">
            {gates.map((workflow) => {
              const gate = gateOf(workflow);
              const granted = Array.isArray(gate['grantedBy']) ? (gate['grantedBy'] as readonly unknown[]).length : 0;
              return (
                <article className="runtime-approval" key={readString(workflow['instanceId'], '')}>
                  <div className="runtime-approval-main">
                    <span className="runtime-kicker">{readString(gate['stepId'], t('common.decisionStep'))}</span>
                    <b>{readString(workflow['title'], t('common.workflowFallback'))}</b>
                    <span>{readString(workflow['goal'], t('common.noObjective'))}</span>
                  </div>
                  <div className="runtime-approval-side">
                    <StatusPill value="Pending" label={t('status.pending')} />
                    <small>
                      {t('runtime.approvals.votes', { granted, required: readNumber(gate['requiredCount'], 1) })}
                    </small>
                  </div>
                </article>
              );
            })}
            {escalations.map((row) => (
              <article className="runtime-approval" key={readString(row['commandId'], '')}>
                <div className="runtime-approval-main">
                  <span className="runtime-kicker">{t('runtime.approvals.escalated')}</span>
                  <b>{readString(row['commandType'], t('approvals.escalations.commandFallback'))}</b>
                  <span>{readString(row['reason'], t('common.noReason'))}</span>
                </div>
                <div className="runtime-approval-side">
                  <StatusPill value="Pending" label={t('status.pending')} />
                  <small>{readString(row['escalateTo'], t('approvals.escalations.awaitingAuthority'))}</small>
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title={t('runtime.recent.panel')}
        actions={
          <button type="button" className="link" onClick={() => control.navigate('Events')}>
            {t('common.openActivity')}
          </button>
        }
      >
        {events.length === 0 ? (
          <Empty title={t('runtime.recent.empty')} hint={t('runtime.recent.emptyHint')} />
        ) : (
          events
            .slice(0, 8)
            .map((event) => (
              <EventLine
                key={readString(event['eventId'], String(readNumber(event['seq'])))}
                title={readString(event['type'])}
                detail={eventDetail(event)}
              />
            ))
        )}
      </Panel>

      <details className="runtime-advanced">
        <summary>
          <span className="runtime-advanced-title">{t('runtime.advanced.title')}</span>
          <span className="runtime-advanced-hint">
            {t('runtime.advanced.hint', { tick: state.tick, queue: state.queueDepth, wakeups: pendingWakeups })}
          </span>
        </summary>
        <div className="runtime-advanced-body">
          <div className="detail-grid">
            {runtimeFacts(state, i18n).map(([label, value]) => (
              <div key={label}>
                <span className="field-label">{label}</span>
                <p>{value === '' ? '—' : value}</p>
              </div>
            ))}
          </div>
          <pre>{JSON.stringify(state.raw, null, 2)}</pre>
        </div>
      </details>
    </div>
  );
}
