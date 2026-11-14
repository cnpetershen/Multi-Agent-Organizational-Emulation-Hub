import { useMemo } from 'react';
import type { Row, TaskRecord } from '../api';
import type { ConsoleControl } from '../control';
import {
  buildDeliveryPackage,
  filesByStep,
  packageTaskIds,
  type PackageFile,
} from '../delivery-package';
import { useI18n, type MessageKey } from '../i18n';
import { useTaskRecords } from '../useTaskRecords';
import { createZip, zipNameOf } from '../zip';
import { DocumentPreview } from './DocumentPreview';
import { Model3DViewer } from './Model3DViewer';

/**
 * The delivery package card: one hand-over, every artifact.
 *
 * It deliberately does not start a second preview server. The page already has the live product
 * preview above; this panel is the *map* of what was delivered — a playable game slot, the
 * document sheet, a 3D asset stage and the complete file list — plus a real ZIP of the package.
 * A game slot links up to the live preview, so there is one runtime and one truth.
 */

function sanitizeFolder(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s-]+|[.\s-]+$/g, '')
    .slice(0, 60) || 'delivery';
}

function save(name: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadFile(file: PackageFile): void {
  save(file.path.split(/[\\/]/).pop() ?? 'artifact', file.content, 'text/plain;charset=utf-8');
}

const KIND_KEYS: Readonly<Record<string, MessageKey>> = {
  game: 'package.kind.game',
  document: 'package.kind.document',
  '3d': 'package.kind.3d',
  code: 'package.kind.code',
  report: 'package.kind.report',
};

function PackageBadge({ kind }: { kind: string }) {
  const { t } = useI18n();
  return <span className={`package-kind kind-${kind}`}>{t(KIND_KEYS[kind] ?? 'package.kind.report')}</span>;
}

export function DeliveryPackage({
  task,
  workflow,
  control,
}: {
  readonly task: TaskRecord;
  readonly workflow: Row | null;
  readonly control: ConsoleControl;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const ids = useMemo(() => packageTaskIds(workflow, task), [workflow, task]);
  const fetched = useTaskRecords(ids, control.refreshToken);
  const pkg = useMemo(
    () => buildDeliveryPackage(workflow, task, fetched.records),
    [workflow, task, fetched.records],
  );

  const game = pkg.items.find((item) => item.taskId === pkg.gameTaskId) ?? null;
  const documentItem = pkg.items.find((item) => item.taskId === pkg.documentTaskId) ?? null;
  const documentTask = documentItem === null
    ? null
    : fetched.records[documentItem.taskId] ?? (documentItem.taskId === task.taskId ? task : null);
  const threeItem = pkg.items.find((item) => item.taskId === pkg.threeTaskId) ?? null;
  const groups = filesByStep(pkg.files);
  const previewCount = (game === null ? 0 : 1)
    + (documentItem === null ? 0 : 1)
    + (pkg.modelAsset === null && threeItem === null ? 0 : 1);

  const scrollToPreview = (): void => {
    document.getElementById('result-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const downloadAll = (): void => {
    const entries = groups.flatMap((group) => group.files.map((file) => ({
      path: `${sanitizeFolder(group.stepTitle)}/${file.path}`,
      content: file.content,
    })));
    if (entries.length === 0) return;
    const zip = createZip(entries);
    const blob = new Blob([zip.buffer as ArrayBuffer], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = zipNameOf(pkg.title);
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="delivery-package" aria-label={t('package.kicker')}>
      <header className="package-head">
        <div className="package-head-copy">
          <span className="package-kicker">{t('package.kicker')}</span>
          <h2>{pkg.title}</h2>
          <p>
            {i18n.status(pkg.status)}
            <span>·</span>
            {pkg.steps.total === 0 ? t('package.standalone') : t('package.steps', { done: pkg.steps.done, total: pkg.steps.total })}
            <span>·</span>
            {t('package.members', { count: pkg.members.length })}
          </p>
          <div className="package-kinds">
            {pkg.kinds.map((kind) => <PackageBadge key={kind} kind={kind} />)}
          </div>
        </div>
        <div className="package-head-actions">
          <span className="package-count">{t('package.filesCount', { count: pkg.files.length })}</span>
          <button type="button" className="primary" disabled={pkg.files.length === 0} onClick={downloadAll}>
            {t('package.downloadAll')}
          </button>
        </div>
      </header>

      {fetched.loading && pkg.files.length === 0 && (
        <div className="package-loading">{t('package.loading')}</div>
      )}
      {!fetched.loading && pkg.files.length === 0 && (
        <div className="package-loading">{t('package.empty')}</div>
      )}
      {fetched.error !== null && pkg.files.length > 0 && (
        <div className="package-partial">{t('package.partial')}</div>
      )}

      <div className={`package-grid${previewCount <= 1 ? ' solo' : ''}`}>
        {game !== null && (
          <article className="package-card package-card-game">
            <header>
              <span className="package-card-icon" data-kind="game">▶</span>
              <div><b>{t('package.game')}</b><small>{game.title}</small></div>
            </header>
            <div className="package-game-art" aria-hidden="true">
              <span className="package-game-tile">×</span>
              <span className="package-game-tile">○</span>
              <span className="package-game-tile">○</span>
              <span className="package-game-tile">×</span>
              <span className="package-game-tile">×</span>
              <span className="package-game-tile">○</span>
              <span className="package-game-tile">○</span>
              <span className="package-game-tile">×</span>
              <span className="package-game-tile">○</span>
              <i className="package-game-scan" />
            </div>
            <p>{t('package.gameHint')}</p>
            <div className="package-card-actions">
              <button type="button" className="primary" onClick={scrollToPreview}>{t('package.runPreview')}</button>
              <button type="button" className="ghost" onClick={() => control.openResults(game.taskId)}>{t('package.openDelivery')}</button>
            </div>
          </article>
        )}

        {documentItem !== null && documentTask !== null && (
          <article className="package-card package-card-doc">
            <header>
              <span className="package-card-icon" data-kind="document">▤</span>
              <div><b>{t('package.document')}</b><small>{documentItem.title}</small></div>
            </header>
            <div className="package-doc-stage">
              <DocumentPreview task={documentTask} />
            </div>
            <div className="package-card-actions">
              <button type="button" className="ghost" onClick={() => control.openResults(documentItem.taskId)}>
                {t('package.openDocument')}
              </button>
            </div>
          </article>
        )}

        {pkg.modelAsset !== null && (
          <article className="package-card package-card-3d">
            <header>
              <span className="package-card-icon" data-kind="3d">◇</span>
              <div><b>{t('package.threeD')}</b><small>{pkg.modelAsset.path}</small></div>
            </header>
            <Model3DViewer
              model={pkg.modelAsset.model}
              label={pkg.modelAsset.path.split(/[\\/]/).pop() ?? pkg.modelAsset.path}
            />
            <p>{t('package.threeDHint')}</p>
            {threeItem !== null && (
              <div className="package-card-actions">
                <button type="button" className="primary" onClick={scrollToPreview}>{t('package.openScene')}</button>
              </div>
            )}
          </article>
        )}

        {pkg.modelAsset === null && threeItem !== null && (
          <article className="package-card package-card-3d">
            <header>
              <span className="package-card-icon" data-kind="3d">◇</span>
              <div><b>{t('package.threeD')}</b><small>{threeItem.title}</small></div>
            </header>
            <div className="package-three-art" aria-hidden="true"><i /><i /><i /><i /><i /><i /></div>
            <p>{t('package.threeDHint')}</p>
            <div className="package-card-actions">
              <button type="button" className="primary" onClick={scrollToPreview}>{t('package.openScene')}</button>
            </div>
          </article>
        )}

        <article className="package-card package-card-files">
          <header>
            <span className="package-card-icon" data-kind="files">▦</span>
            <div><b>{t('package.files')}</b><small>{t('package.filesHint')}</small></div>
          </header>
          <div className="package-file-groups">
            {groups.map((group) => (
              <div className="package-file-group" key={group.stepId}>
                <b>{workflow === null && group.stepTitle === 'delivery' ? t('package.standalone') : group.stepTitle}</b>
                {group.files.map((file) => (
                  <div className="package-file" key={`${file.taskId}:${file.path}`}>
                    <span className="package-file-name" title={file.path}>{file.path}</span>
                    <span className="package-file-lang">{file.language || 'text'}</span>
                    <button type="button" onClick={() => downloadFile(file)}>{t('package.download')}</button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}
