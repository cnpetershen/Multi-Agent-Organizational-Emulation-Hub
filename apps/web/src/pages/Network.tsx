import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  parseLlm,
  parseRows,
  parseTaskRecord,
  readNumber,
  readString,
  type LlmView,
  type Row,
} from '../api';
import { PageIntro, StatusPill } from '../components';
import { DocumentPreview } from '../components/DocumentPreview';
import { HoloCore } from '../components/HoloCore';
import type { ConsoleControl } from '../control';
import { documentPreviewOf, isPlayableGame } from '../document-preview';
import { useJson } from '../hooks';
import { useI18n } from '../i18n';
import {
  buildNetworkModel,
  nodeById,
  showcaseDeliveries,
  NETWORK_HEIGHT,
  NETWORK_WIDTH,
  type NetworkAgentNode,
  type NetworkDeliverableNode,
  type NetworkModel,
  type NetworkWorkflowNode,
} from '../network';
import { usePreview } from '../preview-hook';
import { previewFrameUrl, previewLabelKey, previewTone } from '../preview';
import { deliverableKind } from '../results';

/**
 * Network — the company as one live canvas.
 *
 * The other pages answer "what is in the company" (lists) and "what is this instance doing"
 * (the assignment canvas). This page answers the question a founder actually carries around:
 * *how is the company wired right now?* Agents sit on an inner ring, workflow branches on a
 * middle ring, and delivered outcomes on the outer ring — every edge is one of the three real
 * relationships the event-sourced runtime knows: reports-to, runs-on, delivered-from.
 *
 * The 3D core is a decorative visualization with one pointer shortcut: hovering freezes it, and a
 * beacon click selects the same agent the left-hand card selects. It is not a separate data view —
 * everything it gestures at is also printed in the header, the inspector and the delivery theatre,
 * so the page still reads with motion off, on a low-end machine, or in a screen reader.
 */

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.slice(0, 1).toUpperCase())
    .join('');
}

function percentOf(done: number, total: number): number {
  return total <= 0 ? 0 : Math.round((done / total) * 100);
}

function glyphKindOf(title: string): 'game' | 'document' | 'code' {
  if (/game|tetris|snake|tac|toe|chess|棋|游戏|canvas|playable/i.test(title)) return 'game';
  if (/requirement|design|report|document|spec|brief|docx?|文档|需求|设计|报告|说明/i.test(title)) return 'document';
  return 'code';
}

const GLYPHS = { game: '▶', document: '¶', code: '</>' } as const;

function positionStyle(node: { readonly x: number; readonly y: number }): CSSProperties {
  return {
    left: `${(node.x / NETWORK_WIDTH) * 100}%`,
    top: `${(node.y / NETWORK_HEIGHT) * 100}%`,
  };
}

/* --- The canvas ----------------------------------------------------------- */

function AgentNode({
  node,
  selected,
  onSelect,
}: {
  readonly node: NetworkAgentNode;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const { presence } = useI18n();
  const presenceLabel = presence(node.presence);
  return (
    <button
      type="button"
      data-network-node
      data-testid={`network-agent-${node.id}`}
      className={`net-node net-agent tone-${node.tone}${selected ? ' selected' : ''}`}
      style={positionStyle(node)}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.id);
      }}
      title={`${node.name} · ${node.positionTitle}`}
    >
      <span className="net-avatar" data-working={node.working}>{initialsOf(node.name)}</span>
      <span className="net-agent-copy">
        <b>{node.name}</b>
        <small>{node.positionTitle}</small>
      </span>
      <span className="net-presence" data-working={node.working} title={presenceLabel}>
        <i />
        <em>{presenceLabel}</em>
      </span>
    </button>
  );
}

function WorkflowNode({
  node,
  selected,
  onSelect,
}: {
  readonly node: NetworkWorkflowNode;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const { t, status } = useI18n();
  const percent = percentOf(node.progress.done, node.progress.total);
  return (
    <button
      type="button"
      data-network-node
      data-testid={`network-workflow-${node.id}`}
      className={`net-node net-workflow tone-${node.tone}${selected ? ' selected' : ''}`}
      style={positionStyle(node)}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.id);
      }}
      title={node.title}
    >
      <span className="net-workflow-row">
        <i className="net-state-dot" />
        <b>{node.title}</b>
      </span>
      <span className="net-workflow-meta">
        {node.draft ? t('network.draft') : status(node.status)}
        <span>{node.progress.done}/{node.progress.total}</span>
      </span>
      <span className="net-bar" aria-hidden="true"><i style={{ width: `${percent}%` }} /></span>
      <span className="net-node-badges">
        {node.draft && <span className="net-badge warn">{t('network.badge.draft')}</span>}
        {node.gateOpen && <span className="net-badge bad">{t('network.badge.gate')}</span>}
      </span>
    </button>
  );
}

function DeliverableNode({
  node,
  selected,
  onSelect,
}: {
  readonly node: NetworkDeliverableNode;
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}) {
  const { status } = useI18n();
  const glyph = glyphKindOf(node.title);
  return (
    <button
      type="button"
      data-network-node
      data-testid={`network-delivery-${node.id}`}
      className={`net-node net-delivery${selected ? ' selected' : ''}`}
      data-kind={glyph}
      style={positionStyle(node)}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.id);
      }}
      title={node.title}
    >
      <span className="net-delivery-mark">{GLYPHS[glyph]}</span>
      <span className="net-delivery-copy">
        <b>{node.title}</b>
        <small>{node.roleTitle === '' ? status(node.status) : node.roleTitle} · t{node.completedAtSim}</small>
      </span>
    </button>
  );
}

/* --- Inspector ------------------------------------------------------------ */

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="net-fact">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function LiveInspector({
  control,
  model,
  llm,
}: {
  readonly control: ConsoleControl;
  readonly model: NetworkModel;
  readonly llm: LlmView | null;
}) {
  const { t } = useI18n();
  const { snapshot } = control;
  const events = snapshot.recentEvents.slice(0, 8);
  return (
    <div className="net-inspector-body">
      <span className="network-kicker">{t('network.inspector.live')}</span>
      <h3>{t('network.inspector.orchestration')}</h3>
      <div className="net-facts">
        <Fact label={t('network.inspector.llm')} value={llm === null ? '—' : `${llm.mode ?? '—'} · ${llm.model ?? llm.provider ?? '—'}`} />
        <Fact label={t('network.inspector.calls')} value={llm === null ? '—' : String(llm.callCount)} />
        <Fact label={t('network.inspector.tick')} value={String(snapshot.simulation.tick)} />
        <Fact label={t('network.inspector.queue')} value={String(snapshot.simulation.queueDepth)} />
        <Fact label={t('network.stat.workflows')} value={String(model.stats.activeWorkflows)} />
        <Fact label={t('network.stat.gates')} value={String(model.stats.gates)} />
      </div>
      <div className="net-feed-head">
        <span className="field-label">{t('network.inspector.feed')}</span>
        <button type="button" className="link" onClick={() => control.navigate('Events')}>{t('network.openEvents')}</button>
      </div>
      {events.length === 0 ? (
        <p className="muted">{t('network.inspector.noFeed')}</p>
      ) : (
        <ul className="net-feed">
          {events.map((event) => (
            <li key={readString(event['eventId'], String(event['seq']))}>
              <i data-tone={readString(event['actorKind'], 'system')} />
              <span>
                <b>{readString(event['type'], '—')}</b>
                <small>{readString(event['actorId'], '—')} · t{readNumber(event['occurredAtSim'], 0)}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="net-inspector-actions">
        <button type="button" className="primary" onClick={() => control.navigate('Overview')}>{t('network.startWork')}</button>
        <button type="button" onClick={() => control.navigate('Canvas')}>{t('network.openCanvas')}</button>
      </div>
    </div>
  );
}

function AgentInspector({
  control,
  model,
  node,
}: {
  readonly control: ConsoleControl;
  readonly model: NetworkModel;
  readonly node: NetworkAgentNode;
}) {
  const { t, status, presence } = useI18n();
  const manager = node.managerId === null ? null : model.agents.find((agent) => agent.id === node.managerId) ?? null;
  const workflow = node.currentWorkflowInstanceId === null
    ? null
    : model.workflows.find((entry) => entry.id === node.currentWorkflowInstanceId) ?? null;
  return (
    <div className="net-inspector-body">
      <span className="network-kicker">{t('network.inspector.agent')}</span>
      <div className="net-inspector-head">
        <span className="net-avatar large" data-working={node.working}>{initialsOf(node.name)}</span>
        <div>
          <h3>{node.name}</h3>
          <p>{node.positionTitle}</p>
        </div>
      </div>
      <div className="net-facts">
        <Fact label={t('network.agent.department')} value={node.departmentName === '' ? '—' : node.departmentName} />
        <Fact label={t('network.agent.presence')} value={presence(node.presence)} />
        <Fact label={t('network.agent.status')} value={status(node.status)} />
        <Fact label={t('network.agent.reportsTo')} value={manager === null ? '—' : manager.name} />
        <Fact label={t('network.agent.currentWorkflow')} value={workflow === null ? '—' : workflow.title} />
      </div>
      <div className="net-task-note">
        <span className="field-label">{t('network.agent.currentTask')}</span>
        <p>{node.currentTaskTitle === '' ? t('network.agent.noTask') : node.currentTaskTitle}</p>
      </div>
      <div className="net-inspector-actions">
        <button type="button" className="primary" onClick={() => control.navigate('Agents')}>{t('network.openAgents')}</button>
        {node.currentTaskId !== null && (
          <button type="button" onClick={() => control.openResults(node.currentTaskId as string)}>{t('network.openDelivery')}</button>
        )}
      </div>
    </div>
  );
}

function WorkflowInspector({
  control,
  model,
  node,
}: {
  readonly control: ConsoleControl;
  readonly model: NetworkModel;
  readonly node: NetworkWorkflowNode;
}) {
  const { t, status } = useI18n();
  const owner = node.ownerEmployeeId === null ? null : model.agents.find((agent) => agent.id === node.ownerEmployeeId) ?? null;
  const seats = node.assigneeEmployeeIds
    .map((id) => model.agents.find((agent) => agent.id === id)?.name)
    .filter((name): name is string => name !== undefined);
  return (
    <div className="net-inspector-body">
      <span className="network-kicker">{t('network.inspector.workflow')}</span>
      <div className="net-inspector-head">
        <span className="net-workflow-mark" data-tone={node.tone}><i /></span>
        <div>
          <h3>{node.title}</h3>
          <p>{node.draft ? t('network.draft') : status(node.status)}</p>
        </div>
      </div>
      <p className="net-goal">{node.goal === '' ? t('common.noGoal') : node.goal}</p>
      <div className="net-facts">
        <Fact label={t('network.workflow.stage')} value={node.stageId === '' ? '—' : node.stageId} />
        <Fact label={t('network.workflow.progress')} value={`${node.progress.done}/${node.progress.total}`} />
        <Fact label={t('network.workflow.owner')} value={owner === null ? '—' : owner.name} />
        <Fact label={t('network.workflow.gate')} value={node.gateOpen ? t('network.workflow.gateOpen') : t('network.workflow.noGate')} />
      </div>
      <div className="net-task-note">
        <span className="field-label">{t('network.workflow.seats')}</span>
        <p>{seats.length === 0 ? '—' : seats.join(' · ')}</p>
      </div>
      <div className="net-inspector-actions">
        <button type="button" className="primary" onClick={() => control.navigate('Canvas')}>{t('network.openCanvas')}</button>
        <button type="button" onClick={() => control.navigate('Workflows')}>{t('network.openWorkflows')}</button>
      </div>
    </div>
  );
}

function DeliverableInspector({
  control,
  model,
  node,
  onPlay,
}: {
  readonly control: ConsoleControl;
  readonly model: NetworkModel;
  readonly node: NetworkDeliverableNode;
  readonly onPlay: (taskId: string) => void;
}) {
  const { t, status } = useI18n();
  const workflow = node.workflowInstanceId === null
    ? null
    : model.workflows.find((entry) => entry.id === node.workflowInstanceId) ?? null;
  return (
    <div className="net-inspector-body">
      <span className="network-kicker">{t('network.inspector.delivery')}</span>
      <div className="net-inspector-head">
        <span className="net-delivery-mark large" data-kind={glyphKindOf(node.title)}>{GLYPHS[glyphKindOf(node.title)]}</span>
        <div>
          <h3>{node.title}</h3>
          <p>{status(node.status)} · t{node.completedAtSim}</p>
        </div>
      </div>
      <div className="net-facts">
        <Fact label={t('network.delivery.role')} value={node.roleTitle === '' ? '—' : node.roleTitle} />
        <Fact label={t('network.delivery.workflow')} value={workflow === null ? t('network.delivery.standalone') : workflow.title} />
      </div>
      <div className="net-inspector-actions">
        <button type="button" className="primary" onClick={() => control.openResults(node.id)}>{t('network.openDelivery')}</button>
        <button type="button" onClick={() => onPlay(node.id)}>{t('network.rail.play')}</button>
      </div>
    </div>
  );
}

/* --- The delivery theatre ------------------------------------------------- */

function GameArt({ label }: { readonly label: string }) {
  return (
    <div className="theatre-game-art" aria-hidden="true">
      <span className="theatre-scan" />
      <span className="theatre-blocks">
        <i /><i /><i /><i /><i /><i /><i /><i /><i />
      </span>
      <span className="theatre-game-label">{label}</span>
    </div>
  );
}

function ShowcaseCard({
  task,
  control,
  onPlay,
}: {
  readonly task: Row;
  readonly control: ConsoleControl;
  readonly onPlay: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const taskId = readString(task['taskId'], '');
  const record = useJson(`/api/tasks/${encodeURIComponent(taskId)}`, parseTaskRecord, control.refreshToken);
  const data = record.data;

  if (data === null) {
    return (
      <article className="theatre-card skeleton">
        <b>{readString(task['title'], t('common.untitledTask'))}</b>
        <p className="muted">{record.error === null ? t('network.rail.loading') : t('network.rail.failed')}</p>
      </article>
    );
  }

  const kind = deliverableKind(data.result, data);
  const game = isPlayableGame(data);
  const doc = documentPreviewOf(data);
  if (game) {
    return (
      <article className="theatre-card theatre-game wide">
        <GameArt label={t('network.rail.live')} />
        <div className="theatre-copy">
          <span className="theatre-badge game">{t('network.rail.game')}</span>
          <h4>{data.title}</h4>
          <p>{t('network.rail.gameHint')}</p>
          <div className="theatre-actions">
            <button type="button" className="primary" onClick={() => onPlay(data.taskId)}>{t('network.rail.play')}</button>
            <button type="button" onClick={() => control.openResults(data.taskId)}>{t('network.rail.open')}</button>
          </div>
        </div>
      </article>
    );
  }

  if (kind === 'document' && doc !== null) {
    return (
      <article className="theatre-card theatre-doc">
        <div className="theatre-copy">
          <span className="theatre-badge document">{t('network.rail.document')}</span>
          <h4>{data.title}</h4>
        </div>
        <DocumentPreview task={data} compact />
        <div className="theatre-actions">
          <button type="button" className="primary" onClick={() => control.openResults(data.taskId)}>{t('network.rail.read')}</button>
        </div>
      </article>
    );
  }

  const kindLabel = kind === 'code'
    ? t('network.rail.code')
    : kind === '3d'
      ? t('network.rail.threeD')
      : t('network.rail.report');
  return (
    <article className="theatre-card">
      <div className="theatre-copy">
        <span className="theatre-badge" data-kind={kind}>{kindLabel}</span>
        <h4>{data.title}</h4>
        <p>{data.result?.summary ?? t('network.rail.noSummary')}</p>
      </div>
      <div className="theatre-actions">
        <button type="button" className="primary" onClick={() => control.openResults(data.taskId)}>{t('network.rail.open')}</button>
      </div>
    </article>
  );
}

function DeliveryTheatre({
  control,
  tasks,
  onPlay,
}: {
  readonly control: ConsoleControl;
  readonly tasks: readonly Row[];
  readonly onPlay: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const showcase = useMemo(() => showcaseDeliveries(tasks, 5), [tasks]);
  if (showcase.length === 0) return null;
  return (
    <section className="network-theatre">
      <header className="network-theatre-head">
        <div>
          <span className="network-kicker">{t('network.rail.kicker')}</span>
          <h3>{t('network.rail.title')}</h3>
        </div>
        <p>{t('network.rail.hint')}</p>
      </header>
      <div className="theatre-grid">
        {showcase.map((task) => (
          <ShowcaseCard
            key={readString(task['taskId'])}
            task={task}
            control={control}
            onPlay={onPlay}
          />
        ))}
      </div>
    </section>
  );
}

/* --- The live preview dialog ---------------------------------------------- */

function PreviewDialog({
  taskId,
  title,
  control,
  onClose,
}: {
  readonly taskId: string;
  readonly title: string;
  readonly control: ConsoleControl;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const preview = usePreview(taskId, control.refreshToken);
  const status = preview.status;
  const running = status !== null && status.available && status.state === 'running' && status.previewUrl !== null;
  const close = (): void => {
    preview.stop();
    onClose();
  };
  return (
    <div className="network-preview-backdrop" role="presentation" onClick={close}>
      <div className="network-preview" role="dialog" aria-modal="true" aria-label={t('network.preview.title')} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span className="network-kicker">{t('network.preview.title')}</span>
            <h3>{title !== '' ? title : status?.projectName ?? t('network.preview.starting')}</h3>
          </div>
          <div className="network-preview-actions">
            {status !== null && status.available && (
              <StatusPill value={previewTone(status.state)} label={t(previewLabelKey(status.state))} />
            )}
            <button type="button" className="ghost" onClick={close}>{t('common.close')}</button>
          </div>
        </header>
        <div className="network-preview-body">
          {status === null ? (
            <div className="loading-state"><span className="loading-bar" /><span>{t('network.preview.starting')}</span></div>
          ) : status.available === false ? (
            <div className="network-preview-empty">
              <p>{status.error ?? t('network.preview.unavailable')}</p>
              <button type="button" onClick={() => control.openResults(taskId)}>{t('network.openDelivery')}</button>
            </div>
          ) : running ? (
            <iframe
              title={t('network.preview.title')}
              src={status.previewUrl === null ? '' : previewFrameUrl(status.previewUrl, window.location.hostname)}
              allow="fullscreen"
            />
          ) : status.state === 'failed' ? (
            <div className="network-preview-empty">
              <p>{status.error ?? t('network.preview.unavailable')}</p>
            </div>
          ) : (
            <div className="loading-state"><span className="loading-bar" /><span>{t('network.preview.starting')}</span></div>
          )}
        </div>
        <footer>
          {status !== null && status.available && (
            <>
              <button type="button" className="primary" disabled={preview.busy || running} onClick={preview.start}>
                {t('results.preview.action.start')}
              </button>
              {running && <button type="button" disabled={preview.busy} onClick={preview.rerun}>{t('results.preview.action.rerun')}</button>}
              <button type="button" disabled={preview.busy || !running} onClick={preview.stop}>{t('results.preview.action.stop')}</button>
            </>
          )}
          <button type="button" onClick={() => control.openResults(taskId)}>{t('network.openDelivery')}</button>
          {preview.error !== null && <span className="preview-failure-text" role="alert">{preview.error}</span>}
        </footer>
      </div>
    </div>
  );
}

/* --- The page ------------------------------------------------------------- */

export function NetworkPage({ control }: { control: ConsoleControl }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { snapshot, refreshToken } = control;
  const workflows = useJson('/api/workflows', parseRows, refreshToken);
  const llm = useJson('/api/llm', parseLlm, refreshToken);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [motion, setMotion] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ readonly x: number; readonly y: number; readonly panX: number; readonly panY: number } | null>(null);

  const workflowRows = workflows.data ?? snapshot.workflows;
  const model = useMemo(
    () => buildNetworkModel({ snapshot, workflows: workflowRows, maxWorkflows: 7, maxDeliverables: 4, showAll }),
    [snapshot, workflowRows, showAll],
  );
  const selected = nodeById(model, selectedId);
  const playingTitle = playing === null
    ? ''
    : readString(snapshot.tasks.find((task) => readString(task['taskId'], '') === playing)?.['title'], '');

  const select = (id: string | null): void => setSelectedId(id);

  const resetView = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    const viewport = viewportRef.current;
    viewport?.style.setProperty('--tilt-x', '0deg');
    viewport?.style.setProperty('--tilt-y', '0deg');
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag !== null) {
      setPan({ x: drag.panX + event.clientX - drag.x, y: drag.panY + event.clientY - drag.y });
      return;
    }
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const rect = viewport.getBoundingClientRect();
    const relativeX = (event.clientX - rect.left) / Math.max(1, rect.width) - 0.5;
    const relativeY = (event.clientY - rect.top) / Math.max(1, rect.height) - 0.5;
    // A stronger tilt than a token wobble: with the nodes on real depth layers, this is what makes
    // the canvas read as a volume instead of a flat poster.
    viewport.style.setProperty('--tilt-y', `${(relativeX * 9).toFixed(2)}deg`);
    viewport.style.setProperty('--tilt-x', `${(-relativeY * 7).toFixed(2)}deg`);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest('[data-network-node], .network-toolbar, .network-load-note') !== null) return;
    dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  // React's wheel listener is passive at the root, so `preventDefault` there would be ignored
  // and the page would scroll while zooming. A native non-passive listener is the only way to
  // make the canvas own the gesture.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      setZoom((value) => Math.min(1.45, Math.max(0.7, value + (event.deltaY > 0 ? -0.08 : 0.08))));
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  const hidden = model.hiddenWorkflows;
  const llmView = llm.data;

  return (
    <div className="stack network-page">
      <PageIntro
        eyebrow={t('network.eyebrow')}
        title={t('network.title')}
        description={t('network.description')}
        actions={<span className="page-count">{t('network.pageCount', { agents: model.stats.agents, workflows: model.stats.workflows })}</span>}
      />

      <section className="network-deck">
        <header className="network-deck-top">
          <div className="network-deck-copy">
            <span className="network-kicker">{t('network.inspector.orchestration')}</span>
            <h2>{snapshot.company.name}</h2>
            <p>{t('network.deckHint', { active: model.stats.activeWorkflows, agents: model.stats.workingAgents })}</p>
            <div className="network-modes">
              <span className="network-mode" data-live={llmView?.mode ?? 'unknown'}>
                <i />{llmView === null ? '—' : `${llmView.mode ?? '—'} · ${llmView.model ?? llmView.provider ?? '—'}`}
              </span>
              <span>{t('network.inspector.calls')}: <b>{llmView === null ? '—' : llmView.callCount}</b></span>
              <span className="network-key"><i data-tone="reports" />{t('network.legend.reports')}</span>
              <span className="network-key"><i data-tone="runs" />{t('network.legend.flows')}</span>
            </div>
          </div>
          <div className="network-metrics">
            <div className="network-metric"><b>{model.stats.agents}</b><span>{t('network.stat.agents')}</span><small>{t('network.stat.agentsDetail', { count: model.stats.workingAgents })}</small></div>
            <div className="network-metric"><b>{model.stats.activeWorkflows}</b><span>{t('network.stat.workflows')}</span><small>{t('network.stat.workflowsDetail', { count: model.stats.workflows })}</small></div>
            <div className="network-metric" data-tone={model.stats.gates > 0 ? 'warn' : undefined}><b>{model.stats.gates}</b><span>{t('network.stat.gates')}</span><small>{t('network.stat.gatesDetail')}</small></div>
            <div className="network-metric"><b>{model.stats.completedTasks}</b><span>{t('network.stat.deliveries')}</span><small>{t('network.stat.deliveriesDetail')}</small></div>
          </div>
        </header>

        <div className="network-deck-body">
          <div
            className={`network-viewport${dragging ? ' dragging' : ''}${motion ? '' : ' still'}`}
            ref={viewportRef}
            onPointerMove={onPointerMove}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <div className="network-toolbar">
              <button type="button" onClick={() => setShowAll((value) => !value)} title={t('network.showAllHint')}>
                {showAll ? t('network.showLess') : t('network.showAll')}
                {hidden > 0 && !showAll && <b>{hidden}</b>}
              </button>
              <button type="button" onClick={() => setMotion((value) => !value)}>{motion ? t('network.motionOn') : t('network.motionOff')}</button>
              <button type="button" onClick={resetView}>{t('network.resetView')}</button>
              <span className="network-zoom">
                <button type="button" aria-label={t('network.zoomOut')} onClick={() => setZoom((value) => Math.max(0.7, value - 0.1))}>−</button>
                <span>{Math.round(zoom * 100)}%</span>
                <button type="button" aria-label={t('network.zoomIn')} onClick={() => setZoom((value) => Math.min(1.45, value + 0.1))}>+</button>
              </span>
            </div>

            <div
              className={`network-world${model.workflows.length > 8 ? ' dense' : ''}`}
              style={{
                ['--pan-x' as string]: `${pan.x}px`,
                ['--pan-y' as string]: `${pan.y}px`,
                ['--zoom' as string]: String(zoom),
              } as CSSProperties}
            >
              <svg className="network-edges" viewBox={`0 0 ${NETWORK_WIDTH} ${NETWORK_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
                {model.edges.map((edge) => (
                  <path
                    key={edge.id}
                    d={edge.d}
                    className={`net-edge ${edge.kind} tone-${edge.tone}${edge.animated ? ' animated' : ''}`}
                  />
                ))}
              </svg>

              <div
                className="net-core"
                data-network-node
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  select(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') select(null);
                }}
              >
                <HoloCore
                  agents={model.agents.map((agent) => ({ id: agent.id, name: agent.name, tone: agent.tone }))}
                  label={snapshot.company.name}
                  motion={motion}
                  selectedId={selected !== null && selected.kind === 'agent' ? selected.id : null}
                  onSelectAgent={select}
                  onClearSelection={() => select(null)}
                />
                <span className="net-core-label">
                  <b>{snapshot.company.name}</b>
                  <small>{t('network.core.label')}</small>
                </span>
              </div>

              {model.agents.map((node) => (
                <AgentNode key={node.id} node={node} selected={selectedId === node.id} onSelect={select} />
              ))}
              {model.workflows.map((node) => (
                <WorkflowNode key={node.id} node={node} selected={selectedId === node.id} onSelect={select} />
              ))}
              {model.deliverables.map((node) => (
                <DeliverableNode key={node.id} node={node} selected={selectedId === node.id} onSelect={select} />
              ))}
            </div>

            {workflows.status === 'failed' && workflows.data === null && (
              <p className="network-load-note" role="status">{t('network.loadFailed')}</p>
            )}
          </div>

          <div className="network-inspector" role="complementary" aria-label={t('network.inspector.title')}>
            {selected === null ? (
              <LiveInspector control={control} model={model} llm={llmView} />
            ) : selected.kind === 'agent' ? (
              <AgentInspector control={control} model={model} node={selected} />
            ) : selected.kind === 'workflow' ? (
              <WorkflowInspector control={control} model={model} node={selected} />
            ) : selected.kind === 'deliverable' ? (
              <DeliverableInspector control={control} model={model} node={selected} onPlay={setPlaying} />
            ) : (
              <LiveInspector control={control} model={model} llm={llmView} />
            )}
          </div>
        </div>
      </section>

      <DeliveryTheatre control={control} tasks={snapshot.tasks} onPlay={setPlaying} />

      {playing !== null && <PreviewDialog taskId={playing} title={playingTitle} control={control} onClose={() => setPlaying(null)} />}
    </div>
  );
}
