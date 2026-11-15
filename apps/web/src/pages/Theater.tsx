import { useEffect, useMemo, useState } from 'react';
import { readString, requestJson, type Row } from '../api';
import { simulationCommand } from '../commands';
import { AgentAvatar, PageIntro } from '../components';
import type { ConsoleControl } from '../control';
import { useI18n, type MessageKey } from '../i18n';
import {
  THEATER_STAGES,
  buildFeed,
  countByStage,
  filterByStage,
  groupSessions,
  parseTheaterHistory,
  recentActors,
  theaterEventVisible,
  type FeedItem,
  type TheaterEvent,
  type TheaterSession,
  type TheaterStage,
  type TheaterStageFilter,
} from '../theater';
import { useTheaterStream } from '../useTheaterStream';

/**
 * M3.2 · 协作剧场 / Collaboration Theater.
 *
 * The company as it works: the real AI employees, the messages they exchange, the tasks they
 * accept and hand off, the gates they wait on, and the seven business stages an event can prove.
 *
 * Three rules the page follows:
 *  - every card comes from an event on the company's own log; there is no scripted conversation;
 *  - the seven stages are a lens, not a taxonomy: a message or an operator pause has no stage and
 *    is shown as "not yet a business stage" rather than forced into one;
 *  - Pause/Resume call the real control command, and the label follows `snapshot.simulation.paused`,
 *    never a local animation.
 */

const OPEN_TASK_STATUSES = new Set(['assigned', 'accepted', 'started', 'blocked', 'submitted']);
const TRANSIENT_LIMIT = 400;

interface ReplayState {
  readonly correlationId: string;
  /** The real title from the session, or `''` when the events name no work. */
  readonly title: string;
  readonly events: readonly TheaterEvent[];
  readonly index: number;
  readonly playing: boolean;
  readonly speed: number;
}

function employeeRow(control: ConsoleControl, employeeId: string | null): Row | null {
  if (employeeId === null || employeeId === '') return null;
  return (
    control.snapshot.employees.find((row) => readString(row['employeeId'], '') === employeeId) ?? null
  );
}

function departmentName(control: ConsoleControl, departmentId: string): string {
  if (departmentId === '') return '';
  const row = control.snapshot.departments.find(
    (entry) =>
      readString(entry['departmentId'], readString(entry['id'], '')) === departmentId,
  );
  return row === undefined ? departmentId : readString(row['name'], departmentId);
}

function positionTitle(control: ConsoleControl, positionId: string): string {
  if (positionId === '') return '';
  const row = control.snapshot.positions.find(
    (entry) => readString(entry['positionId'], readString(entry['id'], '')) === positionId,
  );
  return row === undefined
    ? positionId
    : readString(row['title'], readString(row['name'], positionId));
}

function stageKey(stage: TheaterStage): MessageKey {
  return `theater.stages.${stage}` as MessageKey;
}

function statusTone(status: string): string {
  if (['completed', 'handled', 'granted', 'accepted'].includes(status)) return 'ok';
  if (['failed', 'declined', 'denied', 'aborted', 'cancelled', 'blocked', 'removed'].includes(status)) return 'bad';
  if (['requested', 'assigned', 'started', 'progress', 'submitted', 'reviewed'].includes(status)) return 'warn';
  return 'neutral';
}

/** A human-readable actor label. Unknown/system actors never leak a technical id into copy. */
function personLabel(control: ConsoleControl, employeeId: string | null, i18n: ReturnType<typeof useI18n>): string {
  if (employeeId === null || employeeId === '') return i18n.t('theater.system');
  const employee = employeeRow(control, employeeId);
  if (employee === null) return i18n.t('theater.unknownAgent');
  return readString(employee['name'], i18n.t('theater.unknownAgent'));
}

function personSubtitle(control: ConsoleControl, employeeId: string | null): string {
  const employee = employeeRow(control, employeeId);
  if (employee === null) return '';
  const position = positionTitle(control, readString(employee['positionId'], ''));
  const department = departmentName(control, readString(employee['departmentId'], ''));
  return [position, department].filter((part) => part !== '').join(' · ');
}

export function TheaterPage({ control }: { control: ConsoleControl }) {
  const i18n = useI18n();
  const { t } = i18n;
  const stream = useTheaterStream({ companyId: control.companyId, limit: TRANSIENT_LIMIT });
  const [stage, setStage] = useState<TheaterStageFilter>('all');
  const [replay, setReplay] = useState<ReplayState | null>(null);
  const [pending, setPending] = useState(false);

  const taskTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of control.snapshot.tasks) {
      const taskId = readString(task['taskId'], '');
      if (taskId !== '') map.set(taskId, readString(task['title'], ''));
    }
    return map;
  }, [control.snapshot.tasks]);

  const workflowTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const workflow of control.snapshot.workflows) {
      const instanceId = readString(workflow['instanceId'], '');
      if (instanceId !== '') map.set(instanceId, readString(workflow['title'], ''));
    }
    return map;
  }, [control.snapshot.workflows]);

  const openTaskByAssignee = useMemo(() => {
    const map = new Map<string, Row>();
    for (const task of control.snapshot.tasks) {
      const assignee = readString(task['assigneeEmployeeId'], '');
      if (assignee === '' || map.has(assignee)) continue;
      if (OPEN_TASK_STATUSES.has(readString(task['status'], ''))) map.set(assignee, task);
    }
    return map;
  }, [control.snapshot.tasks]);

  const displayEvents = replay === null ? stream.events : replay.events.slice(0, replay.index);
  const visibleEvents = displayEvents.filter(theaterEventVisible);
  const stageEvents = filterByStage(visibleEvents, stage);
  const counts = countByStage(visibleEvents);
  const feed = buildFeed(stageEvents, { taskTitles, workflowTitles });
  const actors = recentActors(visibleEvents);
  const sessions = groupSessions(stream.events.filter(theaterEventVisible));

  const paused = control.snapshot.simulation.paused;
  const streamLabel =
    stream.status === 'live'
      ? t('theater.live.live')
      : stream.status === 'reconnecting'
        ? t('theater.live.reconnecting')
        : stream.status === 'offline'
          ? t('theater.live.offline')
          : t('theater.live.connecting');

  const toggleRuntime = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    try {
      if (paused) {
        if (control.held) await control.releaseHold();
        else {
          await control.run(
            simulationCommand(
              { companyId: control.companyId, simTime: control.simTime },
              'Simulation.Resume',
              'theater: resume the company',
            ),
            t('theater.runtime.resumeDone'),
          );
        }
      } else {
        await control.run(
          simulationCommand(
            { companyId: control.companyId, simTime: control.simTime },
            'Simulation.Pause',
            'theater: pause the company',
          ),
          t('theater.runtime.pauseDone'),
        );
      }
    } finally {
      setPending(false);
    }
  };

  useEffect(() => {
    if (replay === null || !replay.playing) return;
    if (replay.index >= replay.events.length) return;
    const delay = Math.max(120, Math.round(900 / replay.speed));
    const timer = window.setTimeout(() => {
      setReplay((current) => {
        if (current === null || !current.playing) return current;
        return { ...current, index: Math.min(current.index + 1, current.events.length) };
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [replay]);

  const loadSession = async (session: TheaterSession): Promise<void> => {
    try {
      const raw = await requestJson(
        `/api/theater/history?correlationId=${encodeURIComponent(session.correlationId)}&limit=300`,
      );
      const history = parseTheaterHistory(raw);
      if (history.events.length === 0) return;
      setReplay({
        correlationId: session.correlationId,
        title: session.title,
        events: history.events,
        index: 1,
        playing: true,
        speed: 1,
      });
    } catch {
      control.setFeedback({ kind: 'error', title: t('theater.replay.loadFailed'), detail: null });
    }
  };

  const stagesProven = THEATER_STAGES.filter((entry) => (counts[entry] ?? 0) > 0).length;

  return (
    <div className="stack theater-shell">
      <PageIntro
        eyebrow={t('theater.eyebrow')}
        title={t('theater.title')}
        description={t('theater.description')}
        actions={
          <div className="theater-status">
            <span className={`theater-live theater-live-${stream.status}`}>
              <i /> {streamLabel}
            </span>
            <button
              type="button"
              className="theater-control"
              disabled={pending}
              onClick={() => void toggleRuntime()}
              data-testid="theater-runtime-toggle"
            >
              {paused ? t('theater.runtime.resume') : t('theater.runtime.pause')}
            </button>
            {control.held && <span className="theater-hold">{t('theater.runtime.hold')}</span>}
          </div>
        }
      />

      <div className="theater-page">
        {/* The canvas family (Network, Assignment canvas, Theater) keeps its metrics on the dark
            deck, not as light cards above it. */}
        <div className="theater-metrics">
          <div className="theater-metric"><b>{counts.all}</b><span>{t('theater.stat.events')}</span><small>{t('theater.stat.eventsDetail')}</small></div>
          <div className="theater-metric"><b>{control.snapshot.agents.length}</b><span>{t('theater.stat.agents')}</span><small>{t('theater.stat.agentsDetail')}</small></div>
          <div className="theater-metric"><b>{stagesProven}/7</b><span>{t('theater.stat.stages')}</span><small>{t('theater.stat.stagesDetail')}</small></div>
        </div>
        <section className="theater-stages" aria-label={t('theater.stages.title')}>
        <div className="theater-stage-head">
          <h3>{t('theater.stages.title')}</h3>
          <span>{t('theater.stages.hint')}</span>
        </div>
        <div className="theater-stage-rail">
          <button
            type="button"
            className={`theater-stage ${stage === 'all' ? 'active' : ''}`}
            onClick={() => setStage('all')}
          >
            {t('theater.stages.all')} <b>{counts.all}</b>
          </button>
          {THEATER_STAGES.map((entry) => (
            <button
              key={entry}
              type="button"
              className={`theater-stage theme-${entry} ${stage === entry ? 'active' : ''}`}
              onClick={() => setStage(entry)}
            >
              {t(stageKey(entry))} <b>{counts[entry]}</b>
            </button>
          ))}
          <button
            type="button"
            className={`theater-stage unclassified ${stage === 'unclassified' ? 'active' : ''}`}
            onClick={() => setStage('unclassified')}
          >
            {t('theater.stages.unclassified')} <b>{counts.unclassified}</b>
          </button>
        </div>
      </section>

      <div className="theater-body">
        <div className="theater-team" aria-label={t('theater.team.title')}>
          <div className="theater-side-head">
            <h3>{t('theater.team.title')}</h3>
            <span>{control.snapshot.agents.length}</span>
          </div>
          {control.snapshot.agents.length === 0 ? (
            <p className="theater-empty">{t('theater.team.empty')}</p>
          ) : (
            <ul className="theater-people">
              {control.snapshot.agents.map((agent) => {
                const employeeId = readString(agent['employeeId'], '');
                const employee = employeeRow(control, employeeId);
                const name = employee === null ? employeeId : readString(employee['name'], employeeId);
                const positionId = readString(employee?.['positionId'], readString(agent['positionId'], ''));
                const task =
                  openTaskByAssignee.get(employeeId) ??
                  (readString(agent['currentTaskId'], '') === ''
                    ? undefined
                    : control.snapshot.tasks.find(
                        (row) => readString(row['taskId'], '') === readString(agent['currentTaskId'], ''),
                      ));
                const pausedAgent = agent['paused'] === true;
                const working = task !== undefined;
                const live = !pausedAgent && (working || actors.has(employeeId));
                return (
                  <li
                    key={employeeId}
                    className={`theater-person ${live ? 'is-live' : ''} ${pausedAgent ? 'is-paused' : ''}`}
                  >
                    <AgentAvatar
                      name={name}
                      positionId={positionId}
                      status={pausedAgent ? 'paused' : live ? 'working' : 'idle'}
                      size="sm"
                    />
                    <div className="theater-person-copy">
                      <b>{name}</b>
                      <span>{personSubtitle(control, employeeId)}</span>
                      <small>
                        {pausedAgent
                          ? t('theater.team.paused')
                          : task === undefined
                            ? t('theater.team.idle')
                            : readString(task['title'], t('theater.team.working'))}
                      </small>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="theater-replay">
            <div className="theater-side-head">
              <h3>{t('theater.replay.title')}</h3>
              {replay === null ? null : (
                <button type="button" className="theater-text-button" onClick={() => setReplay(null)}>
                  {t('theater.replay.exit')}
                </button>
              )}
            </div>
            <p className="theater-side-hint">{t('theater.replay.description')}</p>
            {replay === null ? (
              sessions.length === 0 ? (
                <p className="theater-empty">{t('theater.replay.empty')}</p>
              ) : (
                <ul className="theater-sessions">
                  {sessions.slice(0, 8).map((session) => (
                    <li key={session.correlationId}>
                      <button type="button" onClick={() => void loadSession(session)}>
                        <b>{session.title === '' ? t('theater.session.untitled') : session.title}</b>
                        <span>
                          {t('theater.session.events', { count: session.count })} ·{' '}
                          {t('theater.session.last', { sim: session.toSim })}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <div className="theater-replay-active">
                <b>{replay.title === '' ? t('theater.session.untitled') : replay.title}</b>
                <div className="theater-replay-bar">
                  <button
                    type="button"
                    onClick={() => setReplay((current) => (current === null ? current : { ...current, playing: !current.playing }))}
                  >
                    {replay.playing ? t('theater.replay.pause') : t('theater.replay.play')}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setReplay((current) =>
                        current === null
                          ? current
                          : { ...current, playing: false, index: Math.min(current.index + 1, current.events.length) },
                      )
                    }
                  >
                    {t('theater.replay.step')}
                  </button>
                  <select
                    aria-label={t('theater.replay.speed')}
                    value={String(replay.speed)}
                    onChange={(event) =>
                      setReplay((current) =>
                        current === null ? current : { ...current, speed: Number(event.target.value) || 1 },
                      )
                    }
                  >
                    <option value="1">1×</option>
                    <option value="2">2×</option>
                    <option value="4">4×</option>
                  </select>
                </div>
                <span className="theater-progress">
                  {t('theater.replay.progress', {
                    current: Math.min(replay.index, replay.events.length),
                    total: replay.events.length,
                  })}
                </span>
                <span className="theater-live-note">{t('theater.replay.liveNote')}</span>
              </div>
            )}
          </div>
        </div>

        <section className="theater-feed" aria-label={t('theater.feed.title')}>
          <div className="theater-feed-head">
            <h3>
              {replay === null ? t('theater.feed.title') : t('theater.replay.title')}
              <span>{feed.length}</span>
            </h3>
            {stage !== 'all' && (
              <button type="button" className="theater-text-button" onClick={() => setStage('all')}>
                {t('theater.feed.all')}
              </button>
            )}
          </div>
          {feed.length === 0 ? (
            <div className="theater-empty-block">
              <b>{t('theater.feed.empty')}</b>
              <p>{t('theater.feed.emptyHint')}</p>
            </div>
          ) : (
            <ol className="theater-floor">
              {feed
                .slice()
                .reverse()
                .map((item) => (
                  <li key={item.key} className={`theater-card card-${item.kind}`}>
                    <FeedCard item={item} control={control} />
                  </li>
                ))}
            </ol>
          )}
        </section>
      </div>
      </div>
    </div>
  );
}

function FeedCard({ item, control }: { item: FeedItem; control: ConsoleControl }) {
  const i18n = useI18n();
  const { t } = i18n;

  if (item.kind === 'message') {
    const from = personLabel(control, item.fromId, i18n);
    const to = item.toIds.map((id) => personLabel(control, id, i18n)).join(', ');
    return (
      <>
        <div className="theater-card-head">
          <span className="theater-kind">{t('theater.feedType.message')}</span>
          <span className="theater-when">{t('theater.time', { sim: item.sim })}</span>
        </div>
        <b className="theater-line">
          {t('theater.message.fromTo', { from, to: to === '' ? t('theater.system') : to })}
        </b>
        {item.subject !== '' && <span className="theater-subject">{item.subject}</span>}
        <p className="theater-body-text">{item.body}</p>
        <div className="theater-card-foot">
          <span className={`pill ${statusTone(item.state === 'processed' ? 'handled' : item.state === 'failed' ? 'failed' : 'requested')}`}>
            {item.state === 'processed'
              ? t('theater.message.handled')
              : item.state === 'failed'
                ? t('theater.message.failed')
                : t('theater.message.awaiting')}
          </span>
          <span className="theater-meta">
            {item.messageType === 'response' ? t('theater.message.response') : t('theater.message.request')}
          </span>
        </div>
      </>
    );
  }

  if (item.kind === 'handoff') {
    const from = personLabel(control, item.fromId, i18n);
    const to = personLabel(control, item.toId, i18n);
    return (
      <>
        <div className="theater-card-head">
          <span className="theater-kind">{t('theater.feedType.handoff')}</span>
          <span className="theater-when">{t('theater.time', { sim: item.sim })}</span>
        </div>
        <b className="theater-line">
          {from} → {to}
        </b>
        {item.taskTitle !== '' && <span className="theater-subject">{item.taskTitle}</span>}
        {item.reason !== '' && (
          <p className="theater-body-text">
            <small>{t('theater.handoff.reason')}:</small> {item.reason}
          </p>
        )}
        {item.resultSummary !== null && item.resultSummary !== '' && (
          <p className="theater-body-text">
            <small>{t('theater.handoff.result')}:</small> {item.resultSummary}
          </p>
        )}
        <div className="theater-card-foot">
          <span className={`pill ${statusTone(item.status)}`}>
            {t(`theater.handoff.${item.status}` as MessageKey)}
          </span>
          {item.outcome !== null && <span className="theater-meta">{item.outcome}</span>}
        </div>
      </>
    );
  }

  if (item.kind === 'task') {
    const actor = personLabel(control, item.actorId, i18n);
    const assignee = personLabel(control, item.assigneeId, i18n);
    const title = item.taskTitle === '' ? t('theater.task.untitled') : item.taskTitle;
    const sentenceKey: MessageKey =
      item.status === 'assigned'
        ? 'theater.task.assigned'
        : item.status === 'started'
          ? 'theater.task.started'
          : item.status === 'progress'
            ? 'theater.task.progress'
            : item.status === 'submitted'
              ? 'theater.task.submitted'
              : item.status === 'reviewed'
                ? 'theater.task.reviewed'
                : item.status === 'completed'
                  ? 'theater.task.completed'
                  : item.status === 'blocked'
                    ? 'theater.task.blocked'
                    : item.status === 'failed'
                      ? 'theater.task.failed'
                      : item.status === 'cancelled'
                        ? 'theater.task.cancelled'
                        : item.status === 'removed'
                          ? 'theater.task.removed'
                          : 'theater.task.updated';
    return (
      <>
        <div className="theater-card-head">
          <span className="theater-kind">{t('theater.feedType.task')}</span>
          <span className="theater-when">{t('theater.time', { sim: item.sim })}</span>
        </div>
        <b className="theater-line">{t(sentenceKey, { actor, assignee, title })}</b>
      </>
    );
  }

  if (item.kind === 'requirement') {
    return (
      <>
        <div className="theater-card-head">
          <span className="theater-kind">{t('theater.feedType.requirement')}</span>
          <span className="theater-when">{t('theater.time', { sim: item.sim })}</span>
        </div>
        <b className="theater-line">
          {t(`theater.requirement.${item.status}` as MessageKey)} · {item.title} v{item.version}
        </b>
      </>
    );
  }

  if (item.kind === 'promotion') {
    return (
      <>
        <div className="theater-card-head">
          <span className="theater-kind">{t('theater.feedType.promotion')}</span>
          <span className="theater-when">{t('theater.time', { sim: item.sim })}</span>
        </div>
        <b className="theater-line">
          {t(`theater.promotion.${item.status}` as MessageKey)} · {item.title} v{item.version}
        </b>
      </>
    );
  }

  if (item.kind === 'publication') {
    return (
      <>
        <div className="theater-card-head">
          <span className="theater-kind">{t('theater.feedType.publication')}</span>
          <span className="theater-when">{t('theater.time', { sim: item.sim })}</span>
        </div>
        <b className="theater-line">
          {t(`theater.publication.${item.status}` as MessageKey)} · {item.publicationId} v{item.version}
        </b>
        {item.publicPath !== null && (
          <a className="theater-subject" href={item.publicPath} target="_blank" rel="noreferrer">
            {t('theater.publication.openPage')}
          </a>
        )}
      </>
    );
  }

  if (item.kind === 'approval') {
    const title = item.instanceTitle === '' ? t('theater.feedType.approval') : item.instanceTitle;
    return (
      <>
        <div className="theater-card-head">
          <span className="theater-kind">{t('theater.feedType.approval')}</span>
          <span className="theater-when">{t('theater.time', { sim: item.sim })}</span>
        </div>
        <b className="theater-line">
          {t(`theater.approval.${item.status}` as MessageKey)} · {title}
        </b>
      </>
    );
  }

  if (item.kind === 'workflow') {
    const title = item.instanceTitle === '' ? t('theater.feedType.workflow') : item.instanceTitle;
    return (
      <>
        <div className="theater-card-head">
          <span className="theater-kind">{t('theater.feedType.workflow')}</span>
          <span className="theater-when">{t('theater.time', { sim: item.sim })}</span>
        </div>
        <b className="theater-line">
          {t(`theater.workflow.${item.status}` as MessageKey)} · {title}
        </b>
      </>
    );
  }

  const label: MessageKey =
    item.type === 'Control.WorkBriefed'
      ? 'theater.brief.submitted'
      : item.type === 'Control.AgentInstructed'
        ? 'theater.brief.instructed'
        : item.type === 'Control.TaskInjected'
          ? 'theater.brief.injected'
          : item.type === 'Control.DelegationDecided'
            ? 'theater.brief.delegated'
            : item.type === 'Control.TaskReassigned'
              ? 'theater.brief.reassigned'
              : item.type === 'Control.AgentCreated'
                ? 'theater.brief.created'
                : item.type === 'Control.TaskReviewRequested'
                  ? 'theater.brief.review'
                  : item.type === 'Control.SimulationPaused'
                    ? 'theater.brief.paused'
                    : item.type === 'Control.SimulationResumed'
                      ? 'theater.brief.resumed'
                      : 'theater.feedType.brief';
  const agent = item.targetId === null ? '' : personLabel(control, item.targetId, i18n);
  return (
    <>
      <div className="theater-card-head">
        <span className="theater-kind">{t('theater.feedType.brief')}</span>
        <span className="theater-when">{t('theater.time', { sim: item.sim })}</span>
      </div>
      <b className="theater-line">{t(label, agent === '' ? undefined : { agent })}</b>
      {item.title !== '' && <span className="theater-subject">{item.title}</span>}
      <div className="theater-card-foot">
        <span className="theater-meta">{personLabel(control, item.actorId, i18n)}</span>
      </div>
    </>
  );
}
