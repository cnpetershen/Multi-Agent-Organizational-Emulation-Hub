import { useCallback, useEffect, useRef, useState } from 'react';
import { parseRows, parseTaskRecord, parseWorkBriefs, readString } from '../api';
import { instructAgent, taskReassign, type CommandContext } from '../commands';
import { AgentAvatar, Empty, LoadError, PageIntro, Panel, StatusPill } from '../components';
import { DeliveryPackage } from '../components/DeliveryPackage';
import { ResultApprovalPanel } from '../components/ResultApproval';
import { DocumentPreview } from '../components/DocumentPreview';
import type { ConsoleControl } from '../control';
import { isOpenApproval, positionTitle, workflowById } from '../derive';
import { isPlayableGame } from '../document-preview';
import { resultSourceOf } from '../results-source';
import { useJson } from '../hooks';
import { useI18n, type MessageKey } from '../i18n';
import { previewActions, previewFrameUrl, previewLabelKey, previewNotices, previewTone, type PreviewActionKind } from '../preview';
import { usePreview } from '../preview-hook';
import {
  contributions,
  creatorLabel,
  deliverableFile,
  deliverableKind,
  deliverableView,
  deliveredFiles,
  fileName,
  resultsState,
  taskJourney,
  workflowJourney,
  workflowStepTasks,
  type Contribution,
  type DeliveredFile,
  type DeliverableFact,
  type DeliverableKind,
  type DeliverableView,
  type JourneyStep,
} from '../results';

/**
 * `/results/:taskId` — the delivery centre.
 *
 * The page answers one question in the owner's language: *my AI company took this goal, did
 * the work, and here is what it hands back to me.* Seven blocks, in the order a person reads
 * them — who delivered, what happened, the artifact itself, the whole product the workflow
 * produced, the roles behind it, the journey they took, and what to do next.
 *
 * What it deliberately never shows: agent ids, ticks, runtime state, events, nodes, workflow
 * traces or raw payloads. Those live on Runtime / Events / Workflows; repeating them here
 * would turn a delivery into a log.
 *
 * One block is conditional: when the delivery is a runnable web app, the project itself runs in
 * a preview panel above the artifact. Every other delivery keeps the seven blocks above, in the
 * same order — the preview is the only thing `available: false` removes.
 */

const KIND_LABELS: Readonly<Record<DeliverableKind, MessageKey>> = {
  game: 'results.deliverable.kind.game',
  '3d': 'results.deliverable.kind.3d',
  code: 'results.deliverable.kind.code',
  document: 'results.deliverable.kind.document',
  report: 'results.deliverable.kind.report',
};

const JOURNEY_MARKS: Readonly<Record<JourneyStep['state'], string>> = {
  done: '✓',
  current: '●',
  pending: '○',
  stopped: '!',
};

/** No workflow in this system defines more steps than this, so the panel renders them all. */
const PRODUCT_STEP_CAP = 6;

function ctxOf(control: ConsoleControl): CommandContext {
  return { companyId: control.companyId, simTime: control.simTime };
}

/** One labelled piece of delivered content: prose, a bullet list, or a small key/value block. */
function Fact({ fact }: { fact: DeliverableFact }) {
  return (
    <div className="fact-item">
      <b>{fact.label}</b>
      {Array.isArray(fact.value) ? (
        <ul className="deliverable-rows">
          {fact.value.map((entry, index) => (
            <li key={`${entry}-${String(index)}`}>{entry}</li>
          ))}
        </ul>
      ) : (
        <p className="deliverable-text">{fact.value}</p>
      )}
    </div>
  );
}

function Facts({ facts }: { facts: readonly DeliverableFact[] }) {
  return (
    <div className="fact-grid">
      {facts.map((fact) => (
        <Fact fact={fact} key={fact.label} />
      ))}
    </div>
  );
}

function JourneyMark({ state }: { state: JourneyStep['state'] }) {
  return <i aria-hidden="true">{JOURNEY_MARKS[state]}</i>;
}

/**
 * The media type a delivered file downloads as. Extensions, not a sniffed body: the executor
 * already declared its language, and a wrong guess would hand the owner a `.py` their editor
 * opens as plain prose anyway. Anything unrecognized is text rather than an octet-stream, so the
 * browser shows it instead of forcing a binary save.
 */
const DOWNLOAD_TYPES: Readonly<Record<string, string>> = {
  py: 'text/plain;charset=utf-8',
  js: 'text/plain;charset=utf-8',
  mjs: 'text/plain;charset=utf-8',
  ts: 'text/plain;charset=utf-8',
  tsx: 'text/plain;charset=utf-8',
  jsx: 'text/plain;charset=utf-8',
  sh: 'text/plain;charset=utf-8',
  css: 'text/plain;charset=utf-8',
  sql: 'text/plain;charset=utf-8',
  yml: 'text/plain;charset=utf-8',
  yaml: 'text/plain;charset=utf-8',
  json: 'application/json;charset=utf-8',
  html: 'text/html;charset=utf-8',
  htm: 'text/html;charset=utf-8',
  md: 'text/markdown;charset=utf-8',
  markdown: 'text/markdown;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
};

function downloadType(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');
  if (dot === -1) return 'text/plain;charset=utf-8';
  return DOWNLOAD_TYPES[name.slice(dot + 1).toLowerCase()] ?? 'text/plain;charset=utf-8';
}

/** The same save-to-disk path the final-deliverable download uses: one blob, one anchor, revoked. */
function saveFile(name: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * The files one step handed over, each saveable under its own name.
 *
 * Shared by the step this page is about and by its siblings, so a delivered file is downloadable
 * from whichever card the owner opened — including the card that delivered it. A path with no
 * text is left off: saving a zero-byte file would be mistaken for the deliverable.
 */
function StepFiles({ files, control }: { files: readonly DeliveredFile[]; control: ConsoleControl }) {
  const { t } = useI18n();
  if (files.length === 0) {
    return (
      <p className="deliverable-text muted product-step-note">{t('results.deliverable.filesEmpty')}</p>
    );
  }
  const download = (path: string, content: string): void => {
    const name = fileName(path);
    if (name === '') return;
    saveFile(name, content, downloadType(path));
    control.setFeedback({ kind: 'success', title: t('results.deliverable.downloadReady'), detail: name });
  };
  return (
    <ul className="product-files">
      {files.map((file) => (
        <li key={file.path}>
          <span className="product-file-path">{file.path}</span>
          <button type="button" onClick={() => download(file.path, file.content)}>
            {t('results.product.download')}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * One sibling step of the same workflow, fetched in its own component because a hook cannot run
 * inside the map that renders the steps. It is therefore also the thing that can fail alone: a
 * step whose record 404s shows one muted line while the deliveries around it stay readable.
 */
function ProductStep({
  taskId,
  control,
  onFiles,
}: {
  taskId: string;
  control: ConsoleControl;
  /** How many files this step delivered, so the panel's hint can count the whole product. */
  onFiles: (taskId: string, count: number) => void;
}) {
  const { t } = useI18n();
  const record = useJson(`/api/tasks/${encodeURIComponent(taskId)}`, parseTaskRecord, control.refreshToken);
  const task = record.data;
  // Only a file with text is a download: a path the delivery named but never carried would save
  // a zero-byte file the owner would mistake for the deliverable, so it is left off the list.
  const files = task === null ? [] : deliveredFiles(task).filter((file) => file.content !== '');
  const counted = useRef(false);
  useEffect(() => {
    if (task === null || counted.current) return;
    counted.current = true;
    onFiles(taskId, files.length);
  }, [task, taskId, files.length, onFiles]);

  if (task === null) {
    return (
      <div className="deliverable-block">
        <div className="product-step-head">
          <b>{t('common.untitledTask')}</b>
        </div>
        <p className="deliverable-text muted product-step-note">
          {record.error === null ? t('results.product.loading') : t('results.product.failed')}
        </p>
      </div>
    );
  }
  return (
    <div className="deliverable-block">
      <div className="product-step-head">
        <b>{task.title}</b>
      </div>
      <StepFiles files={files} control={control} />
    </div>
  );
}

/**
 * The delivered project itself, running — the panel that makes a delivery checkable instead of
 * merely readable.
 *
 * It renders nothing for a delivery that is not a runnable web app (`available: false`) or one
 * the preview runtime does not know (`404`), so the page keeps its shape for every other kind of
 * delivery. It renders a single line when the preview could not be *read*, because silently
 * dropping the panel would look like the feature was never there.
 *
 * The `<iframe>` deliberately carries no `sandbox` attribute and `allow="fullscreen"`: the project
 * is served from its own local origin, and the delivered game only works if its own scripts run
 * and its canvas keeps keyboard focus. A sandbox that permits scripts *and* same-origin is no
 * sandbox at all, so the honest choice is to frame the operator's own project plainly.
 */
function PreviewPanel({ taskId, control }: { taskId: string; control: ConsoleControl }) {
  const { t, tp } = useI18n();
  const preview = usePreview(taskId, control.refreshToken);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const status = preview.status;

  if (status === null) {
    if (preview.error === null) return null;
    return (
      <Panel title={t('results.preview.panel')} className="result-preview">
        <section className="detail-section preview-body">
          <p className="preview-failure-text" role="alert">{preview.error}</p>
          <div className="button-row preview-actions">
            <button type="button" onClick={preview.reload}>{t('results.preview.error.retry')}</button>
          </div>
        </section>
      </Panel>
    );
  }
  if (!status.available) return null;

  const previewUrl = status.previewUrl;
  const running = status.state === 'running' && previewUrl !== null;
  const notices = previewNotices(status);
  // `requestFullscreen` is absent in a few embedded browsers; the guard keeps the button harmless.
  const fullscreen = (): void => {
    void frameRef.current?.requestFullscreen();
  };
  const handlers: Readonly<Record<PreviewActionKind, () => void>> = {
    start: preview.start,
    rerun: preview.rerun,
    stop: preview.stop,
    fullscreen,
  };

  return (
    <Panel
      title={status.projectName === '' ? t('results.preview.headingFallback') : status.projectName}
      className="result-preview"
      actions={<StatusPill value={previewTone(status.state)} label={t(previewLabelKey(status.state))} />}
    >
      <section className="detail-section preview-body">
        <span className="field-label">{t('results.preview.panel')}</span>
        <p className="preview-command">
          <span className="field-label">{t('results.preview.runCommand')}</span>
          <code>{status.runCommand}</code>
        </p>
        <p className="preview-hint muted">{t('results.preview.hint')}</p>

        {notices.sources > 0 && (
          <p className="preview-meta muted">{tp('results.preview.sources', notices.sources)}</p>
        )}
        {notices.wholeProduct && <p className="preview-note muted">{t('results.preview.wholeProduct')}</p>}
        {notices.skipped > 0 && (
          <p className="preview-warning" role="status">
            {tp('results.preview.skipped', notices.skipped, { reason: notices.skipReason })}
          </p>
        )}

        {running && (
          <div className="preview-frame" ref={frameRef}>
            <iframe
              title={t('results.preview.iframeTitle')}
              src={previewFrameUrl(previewUrl, window.location.hostname)}
              allow="fullscreen"
            />
          </div>
        )}
        {running && (
          <a
            className="preview-open-tab"
            href={previewFrameUrl(previewUrl, window.location.hostname)}
            target="_blank"
            rel="noreferrer"
          >
            {t('results.preview.openTab')}
          </a>
        )}

        {status.state === 'failed' && (
          <div className="preview-failure" role="alert">
            <b>{t('results.preview.error.title')}</b>
            <p>{status.error === null ? t('results.preview.unavailable') : status.error}</p>
          </div>
        )}

        {/* A start/stop that failed leaves the last good status on screen, so the reason is said
            here rather than swallowed. */}
        {preview.error !== null && (
          <p className="preview-failure-text" role="alert">{preview.error}</p>
        )}

        <div className="button-row preview-actions">
          {previewActions(status).map((action) => (
            <button
              key={action.kind}
              type="button"
              className={action.primary ? 'primary' : ''}
              disabled={preview.busy || action.disabled}
              // A stable handle for the end-to-end check: the visible label is localized copy, so
              // matching on it would make the check depend on the console's current language.
              data-testid={`preview-action-${action.kind}`}
              onClick={handlers[action.kind]}
            >
              {t(action.labelKey)}
            </button>
          ))}
        </div>
      </section>
    </Panel>
  );
}

export function ResultsPage({ control, taskId }: { control: ConsoleControl; taskId: string }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [busy, setBusy] = useState<'optimize' | 'retry' | null>(null);
  const record = useJson(`/api/tasks/${encodeURIComponent(taskId)}`, parseTaskRecord, control.refreshToken);
  const workflows = useJson('/api/workflows', parseRows, control.refreshToken);
  // F3: the source is read from the brief record, not inferred from the task title/goal.
  const briefs = useJson('/api/work-briefs', parseWorkBriefs, control.refreshToken);
  // Each sibling step counts its own files, so the "whole delivery" hint reports what the
  // operator can actually download. Declared *above* the loading return on purpose: a hook
  // below it would run only once the record arrives, which is exactly React's "rendered more
  // hooks than during the previous render".
  const [filesByTask, setFilesByTask] = useState<Readonly<Record<string, number>>>({});
  const noteFiles = useCallback((id: string, count: number): void => {
    setFilesByTask((previous) => (previous[id] === count ? previous : { ...previous, [id]: count }));
  }, []);
  const task = record.data;
  const { snapshot } = control;
  const back = (): void => control.navigate('Deliverables');

  if (task === null) {
    const missing = record.error !== null && record.error.includes('HTTP 404');
    return (
      <div className="stack result-page">
        <div className="result-back">
          <button type="button" className="link" onClick={back}>← {t('results.back')}</button>
        </div>
        <Panel title={t('page.results.label')} className="result-loading">
          {record.error === null ? (
            <div className="loading-state"><span className="loading-bar" /><span>{t('app.loadingWorkspace')}</span></div>
          ) : (
            <LoadError message={missing ? t('results.error.notFound') : t('results.error.failed')} onRetry={record.reload} />
          )}
        </Panel>
      </div>
    );
  }

  const state = resultsState(task.status);
  // A blocked task is not "failed, retry it": reassign/retry are rejected by the task domain on
  // purpose — the block is an explicit wait. The page says why and routes to the approver
  // instead of offering a command the kernel will refuse.
  const blockedReason = (task.blockedReason ?? '').trim();
  const isBlocked = task.status.trim().toLowerCase() === 'blocked';
  const blockedOnApproval = isBlocked && /^waiting_for_approval/i.test(blockedReason);
  const workflow = workflowById(workflows.data ?? snapshot.workflows, task.workflowInstanceId);
  const source = resultSourceOf(briefs.data ?? [], task.correlationId);
  const kind = deliverableKind(task.result, task);
  const view: DeliverableView = deliverableView(task, kind);
  const journey = workflow === null ? taskJourney(task.status) : workflowJourney(workflow);
  // The rest of the product the organization produced: the workflow's other delivered steps, in
  // step order. A workflow is capped at six steps by design, so the panel never paginates.
  const stepTasks = task.workflowInstanceId === null
    ? []
    : workflowStepTasks(workflow, task.taskId).slice(0, PRODUCT_STEP_CAP);
  // The step this page is about is part of the whole delivery too: its own files are listed (and
  // downloadable) beside its siblings', not only rendered as prose in the panel above.
  const ownFiles = task.result === null ? [] : deliveredFiles(task).filter((file) => file.content !== '');
  const productFiles =
    ownFiles.length + stepTasks.reduce((total, step) => total + (filesByTask[step.taskId] ?? 0), 0);
  const roles = contributions({
    positions: snapshot.positions,
    employees: snapshot.employees,
    positionId: task.positionId,
    assigneeEmployeeId: task.assigneeEmployeeId,
    producedBy: task.result?.producedBy ?? null,
    reviews: task.reviews,
  });
  const creator = creatorLabel(workflow, snapshot.employees, snapshot.positions);
  const gateOpen = workflow !== null && isOpenApproval(workflow);
  const finishedAt = task.completedAtSim === null
    ? t('results.header.notFinished')
    : t('results.header.simTime', { time: task.completedAtSim });
  const workflowTitle = workflow === null ? t('results.header.noWorkflow') : readString(workflow['title'], t('common.untitledWorkflow'));
  const execution = task.result !== null
    ? task.result.summary
    : state.kind === 'failed'
      ? t('results.summary.executionFailed')
      : task.status.trim() === '' || task.status.trim().toLowerCase() === 'created'
        ? t('results.summary.executionPending')
        : t('results.summary.executionRunning');
  const reason = task.rejectReason ?? task.blockedReason ?? t('common.noReason');
  const deliveredCount = task.result === null ? 0 : Object.keys(task.result.data).length + task.result.artifacts.length;
  const outcome = task.result !== null
    ? i18n.tp('results.summary.outcomeDelivered', deliveredCount, { count: deliveredCount })
    : state.kind === 'failed'
      ? t('results.summary.outcomeFailed', { reason })
      : t('results.summary.outcomeRunning');
  const delivererRole = roles.find((role) => role.lines.some((line) => line.labelKey === 'results.contribution.delivered'));
  const instructionAgent = delivererRole === undefined
    ? t('common.agentFallback')
    : delivererRole.roleTitle === '' ? delivererRole.personName : delivererRole.roleTitle;

  const scrollTo = (id: string): void => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const optimize = async (): Promise<void> => {
    const agent = task.result?.producedBy ?? '';
    if (agent === '' || busy !== null) return;
    setBusy('optimize');
    try {
      await control.run(
        instructAgent(ctxOf(control), agent, t('results.actions.optimizeInstruction', { title: task.title })),
        t('feedback.instructionSent', { agent: instructionAgent }),
      );
    } finally {
      setBusy(null);
    }
  };

  const retry = async (): Promise<void> => {
    const positionId = task.positionId;
    if (positionId === null || positionId === '' || busy !== null) return;
    setBusy('retry');
    try {
      await control.run(
        taskReassign(ctxOf(control), task.taskId, positionId),
        t('feedback.taskReassigned', { position: positionTitle(snapshot.positions, positionId) }),
      );
    } finally {
      setBusy(null);
    }
  };

  const download = (): void => {
    const file = deliverableFile(task, {
      goal: t('results.summary.goal'),
      summary: t('results.summary.execution'),
      files: t('results.deliverable.files'),
    });
    const blob = new Blob([file.text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    control.setFeedback({ kind: 'success', title: t('results.deliverable.downloadReady'), detail: file.filename });
  };

  return (
    <div className="stack result-page">
      <PageIntro
        eyebrow={t('results.eyebrow')}
        title={task.title}
        description={t('results.description')}
        actions={<button type="button" className="link" onClick={back}>← {t('results.back')}</button>}
      />

      {/* Header: the four facts an owner checks before reading anything else. */}
      <section className="result-hero">
        <div className="result-hero-top">
          <StatusPill value={state.tone} label={t(state.labelKey)} />
          <span className="result-hero-kind">{t(KIND_LABELS[kind])}</span>
        </div>
        <div className="result-meta">
          <span><small>{t('results.header.creator')}</small><b>{creator === '' ? t('results.header.creatorFallback') : creator}</b></span>
          <span><small>{t('results.header.completedAt')}</small><b>{finishedAt}</b></span>
          <span><small>{t('results.header.workflow')}</small><b>{workflowTitle}</b></span>
        </div>
      </section>

      {/* F3: a sandbox-derived brief is shown as a source card, not by regex-matching the
          title and embedding the workbench. The workbench itself stays at /api/sandbox. */}
      {source !== null && (
        <Panel
          title={t('results.source.panel')}
          className="result-source"
          actions={<a className="link" href="/api/sandbox" target="_blank" rel="noreferrer">{t('results.source.open')}</a>}
        >
          <div className="fact-grid">
            <div><span className="field-label">{t('results.source.session')}</span><p className="objective">{source.sessionId}</p></div>
            <div><span className="field-label">{t('results.source.brief')}</span><p className="objective">{source.briefId}</p></div>
            <div><span className="field-label">{t('results.source.title')}</span><p className="objective">{source.title}</p></div>
          </div>
          <p className="muted">{t('results.source.hint')}</p>
        </Panel>
      )}

      {/* M2: the gate is decided where the delivery is read, not on another page. */}
      <ResultApprovalPanel control={control} workflow={workflow} />

      <Panel title={t('results.summary.panel')} className="result-summary">
        <section className="detail-section">
          <span className="field-label">{t('results.summary.goal')}</span>
          <p className="objective">{task.goal}</p>
          {task.detail !== null && (
            <>
              <span className="field-label deliverable-sub-label">{t('results.summary.detail')}</span>
              <p className="objective">{task.detail}</p>
            </>
          )}
        </section>
        <section className="detail-section">
          <span className="field-label">{t('results.summary.execution')}</span>
          <p className="objective deliverable-summary">{execution}</p>
        </section>
        <section className="detail-section">
          <span className="field-label">{t('results.summary.outcome')}</span>
          <p className="objective deliverable-summary">{outcome}</p>
        </section>
      </Panel>

      {/* One hand-over: every step's artifact, the game/document/3D slots and a real ZIP. The live
          runtime stays below so a package never starts a second server. */}
      <DeliveryPackage task={task} workflow={workflow} control={control} />

      {/* The delivered project, running, above the artifact it delivered. A delivery that is not
          a runnable web app renders nothing here, so every other shape of page is unchanged. */}
      <div id="result-preview">
        <PreviewPanel taskId={taskId} control={control} />
      </div>

      <div id="final-deliverable" className="result-anchor">
        <Panel title={t('results.deliverable.panel')} className="result-deliverable">
          {task.result === null ? (
            <Empty title={t('results.deliverable.empty')} hint={t('results.deliverable.emptyHint')} />
          ) : (
            <section className="detail-section">
              <div className="deliverable-head">
                <span className={`deliverable-kind kind-${kind}`}>{t(KIND_LABELS[kind])}</span>
                {isPlayableGame(task) && (
                  <span className="deliverable-kind kind-game">{t('results.deliverable.playableGame')}</span>
                )}
                <div>
                  <h4>{view.name}</h4>
                  <p>{view.description}</p>
                </div>
              </div>

              {kind === 'game' && (
                <div className="deliverable-block deliverable-game">
                  <span className="field-label">{t('results.deliverable.playableGame')}</span>
                  <p className="deliverable-text">{t('results.deliverable.gameHint')}</p>
                  <button type="button" className="primary" onClick={() => scrollTo('result-preview')}>
                    {t('results.deliverable.runGame')}
                  </button>
                </div>
              )}

              {kind === '3d' && (
                <div className="deliverable-block deliverable-3d">
                  <span className="field-label">{t('results.deliverable.threeD')}</span>
                  <p className="deliverable-text">{t('results.deliverable.threeDHint')}</p>
                  <button type="button" className="primary" onClick={() => scrollTo('result-preview')}>
                    {t('results.deliverable.open3d')}
                  </button>
                </div>
              )}

              {kind === 'code' && (
                <div className="deliverable-block">
                  <span className="field-label">{t('results.deliverable.stack')}</span>
                  {view.stack.length === 0 ? (
                    <p className="deliverable-text muted">{t('results.deliverable.stackMissing')}</p>
                  ) : (
                    <ul className="chip-list">
                      {view.stack.map((entry) => <li key={entry}>{entry}</li>)}
                    </ul>
                  )}
                </div>
              )}

              {kind === 'document' && (
                <div className="deliverable-block">
                  <span className="field-label">{t('results.deliverable.preview')}</span>
                  <DocumentPreview task={task} fallback={view.preview} />
                </div>
              )}

              {view.conclusions.length > 0 && (
                <div className="deliverable-block">
                  <span className="field-label">{t('results.deliverable.conclusions')}</span>
                  <Facts facts={view.conclusions} />
                </div>
              )}

              {/* A playable game / 3D scene is shown by the live preview and its file chips. Dumping
                  the HTML source here makes the delivery read like a document again. */}
              {kind !== 'game' && kind !== '3d' && view.details.length > 0 && (
                <div className="deliverable-block">
                  <span className="field-label">{t('results.deliverable.details')}</span>
                  <Facts facts={view.details} />
                </div>
              )}

              <div className="deliverable-block">
                <span className="field-label">{t('results.deliverable.files')}</span>
                {view.files.length === 0 ? (
                  <p className="deliverable-text muted">{t('results.deliverable.filesEmpty')}</p>
                ) : (
                  <ul className="chip-list">
                    {view.files.map((file) => <li className="chip-file" key={file}>{file}</li>)}
                  </ul>
                )}
              </div>

              <div className="button-row deliverable-actions">
                {view.codeUrl !== null && <a className="primary" href={view.codeUrl} target="_blank" rel="noreferrer">{t('results.deliverable.viewCode')}</a>}
                {view.demoUrl !== null && <a href={view.demoUrl} target="_blank" rel="noreferrer">{t('results.deliverable.demo')}</a>}
                <button type="button" onClick={download}>{t('results.deliverable.download')}</button>
              </div>
            </section>
          )}
        </Panel>
      </div>

      {/* The whole product, not just this task's slice: this step's files first, then one block
          per sibling step, each fetched and downloaded on its own. A task that is not part of a
          workflow keeps the page exactly as it was. */}
      {task.workflowInstanceId !== null && (ownFiles.length > 0 || stepTasks.length > 0) && (
        <Panel
          title={t('results.product.panel')}
          className="result-product"
          actions={<span className="muted">{t('results.product.hint', { count: productFiles })}</span>}
        >
          <section className="detail-section">
            {ownFiles.length > 0 && (
              <div className="deliverable-block">
                <div className="product-step-head">
                  <b>{task.title}</b>
                </div>
                <StepFiles files={ownFiles} control={control} />
              </div>
            )}
            {stepTasks.map((step) => (
              <ProductStep key={step.taskId} taskId={step.taskId} control={control} onFiles={noteFiles} />
            ))}
          </section>
        </Panel>
      )}

      <Panel title={t('results.contribution.panel')} className="result-roles">
        {roles.length === 0 ? (
          <Empty title={t('results.contribution.empty')} hint={t('results.contribution.emptyHint')} />
        ) : (
          <section className="detail-section">
            <div className="role-grid">
              {roles.map((role: Contribution) => (
                <article className="role-card" key={`${role.roleTitle}|${role.personName}`}>
                  <div className="role-head">
                    <AgentAvatar name={role.personName} positionTitle={role.roleTitle} />
                    <div>
                      <b>{role.roleTitle === '' ? t('common.unassigned') : role.roleTitle}</b>
                      <span>{role.personName}</span>
                    </div>
                  </div>
                  <span className="field-label">{t('results.contribution.responsible')}</span>
                  <ul className="deliverable-rows">
                    {role.lines.map((line) => (
                      <li key={line.labelKey}>
                        {t(line.labelKey)}
                        {line.value === null ? '' : ` · ${i18n.status(line.value)}`}
                      </li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </section>
        )}
      </Panel>

      <div id="work-journey" className="result-anchor">
        <Panel
          title={t('results.journey.panel')}
          className="result-journey"
          actions={<span className="muted">{t('results.journey.hint')}</span>}
        >
          {journey.length === 0 ? (
            <Empty title={t('results.journey.empty')} hint={t('results.journey.emptyHint')} />
          ) : (
            <section className="detail-section">
              <ol className="journey">
                {journey.map((step) => (
                  <li className={`journey-step is-${step.state}`} key={step.key}>
                    <JourneyMark state={step.state} />
                    <span>{step.labelKey === null ? step.label : t(step.labelKey)}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </Panel>
      </div>

      <Panel title={t('results.actions.panel')} className="result-actions">
        <div className="result-actions-body">
          <p className="muted">
            {isBlocked
              ? t('results.actions.hintBlocked')
              : state.kind === 'running'
                ? t('results.actions.hintRunning')
                : state.kind === 'failed'
                  ? t('results.actions.hintFailed')
                  : t('results.actions.hintCompleted')}
          </p>
          <div className="button-row">
            {state.kind === 'completed' && (
              <>
                <button type="button" className="primary" onClick={() => scrollTo('final-deliverable')}>{t('results.actions.view')}</button>
                <button type="button" onClick={() => control.navigate('Tasks')}>{t('results.actions.newTask')}</button>
                {task.result !== null && (
                  <button type="button" disabled={busy !== null} onClick={() => void optimize()}>
                    {busy === 'optimize' ? t('common.submitting') : t('results.actions.optimize')}
                  </button>
                )}
              </>
            )}
            {state.kind === 'running' && (
              <button type="button" className="primary" onClick={() => scrollTo('work-journey')}>{t('results.actions.progress')}</button>
            )}
            {isBlocked && (
              <>
                <p className="muted">
                  {t('results.actions.blockedReasonLabel')}: {blockedReason === '' ? t('common.noReason') : blockedReason}
                </p>
                {blockedOnApproval ? (
                  <button type="button" className="primary" onClick={() => control.navigate('Approvals')}>
                    {t('results.actions.goToApprovals')}
                  </button>
                ) : null}
                <button type="button" onClick={() => control.navigate('Runtime')}>{t('results.actions.goToRuntime')}</button>
                <button type="button" onClick={() => control.navigate('Tasks')}>{t('results.actions.newTask')}</button>
              </>
            )}
            {!isBlocked && state.kind === 'failed' && (
              <>
                <button type="button" className="primary" disabled={busy !== null || task.positionId === null} onClick={() => void retry()}>
                  {busy === 'retry' ? t('common.submitting') : t('results.actions.retry')}
                </button>
                <button type="button" onClick={() => control.navigate('Tasks')}>{t('results.actions.newTask')}</button>
              </>
            )}
            {state.kind === 'cancelled' && (
              <button type="button" className="primary" onClick={() => control.navigate('Tasks')}>{t('results.actions.newTask')}</button>
            )}
            {gateOpen && <button type="button" onClick={() => control.navigate('Approvals')}>{t('deliverables.card.decide')}</button>}
          </div>
        </div>
      </Panel>
    </div>
  );
}
