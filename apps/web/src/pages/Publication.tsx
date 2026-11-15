import { useCallback, useEffect, useState } from 'react';
import { messageOf, requestJson, type Row } from '../api';
import { Empty, PageIntro, Panel } from '../components';
import type { ConsoleControl } from '../control';
import { useI18n } from '../i18n';
import {
  currentPublicationVersion,
  parseChecks,
  parsePublicationRecord,
  parsePublications,
  type PublicationCheckView,
  type PublicationRecordView,
  type PublicationSummaryView,
  type PublicationVersionView,
} from '../publication';

/**
 * M3.8 publication workbench.
 *
 * A publication can only be created from an M3.7 confirmed promotion. Confirm and publish are two
 * separate explicit human actions; publishing writes a real local page/manifest and the page is
 * served by this API. No external platform claim is made.
 */

interface FormState {
  readonly title: string;
  readonly body: string;
  readonly channels: readonly string[];
  readonly attachments: string;
}
const EMPTY_FORM: FormState = { title: '', body: '', channels: ['local_page', 'local_manifest'], attachments: '' };
const CHANNELS = ['local_page', 'local_manifest', 'external_wechat'] as const;

function lines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}
function formOf(version: PublicationVersionView): FormState {
  return {
    title: version.content.title,
    body: version.content.body,
    channels: version.content.channels,
    attachments: version.content.attachments.join('\n'),
  };
}

export function PublicationPage({ control }: { control: ConsoleControl }) {
  const { t } = useI18n();
  const [promotions, setPromotions] = useState<readonly { promotionId: string; title: string; version: number; promotionVersion?: number }[]>([]);
  const [publications, setPublications] = useState<readonly PublicationSummaryView[]>([]);
  const [selectedPromotion, setSelectedPromotion] = useState<string | null>(null);
  const [record, setRecord] = useState<PublicationRecordView | null>(null);
  const [checks, setChecks] = useState<readonly PublicationCheckView[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const current = record === null ? null : currentPublicationVersion(record);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [promotionRaw, publicationRaw] = await Promise.all([
        requestJson('/api/promotions'),
        requestJson('/api/publications'),
      ]);
      const promotionList = Array.isArray((promotionRaw as Row)['promotions'])
        ? ((promotionRaw as Row)['promotions'] as readonly Row[])
        : [];
      const confirmed = promotionList
        .filter((entry) => entry['status'] === 'confirmed')
        .map((entry) => ({
          promotionId: String(entry['promotionId'] ?? ''),
          title: String(entry['title'] ?? ''),
          version: Number(entry['version'] ?? 1),
        }))
        .filter((entry) => entry.promotionId !== '');
      setPromotions(confirmed);
      const nextPublications = parsePublications(publicationRaw);
      setPublications(nextPublications);
      setSelectedPromotion((existing) =>
        existing !== null && confirmed.some((entry) => entry.promotionId === existing)
          ? existing
          : confirmed[0]?.promotionId ?? null,
      );
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);

  const openPublication = useCallback(async (promotionId: string): Promise<void> => {
    setError(null);
    const existing = publications.find((entry) => entry.promotionId === promotionId);
    if (existing === undefined) {
      setRecord(null);
      setChecks([]);
      setForm(EMPTY_FORM);
      return;
    }
    try {
      const raw = await requestJson(`/api/publications/${encodeURIComponent(existing.publicationId)}`);
      const next = parsePublicationRecord(raw);
      setRecord(next);
      const version = next === null ? null : currentPublicationVersion(next);
      if (version !== null) setForm(formOf(version));
      const preflight = await requestJson(`/api/publications/${encodeURIComponent(existing.publicationId)}/preflight`);
      setChecks(parseChecks(preflight));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [publications]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selectedPromotion !== null) void openPublication(selectedPromotion);
  }, [openPublication, selectedPromotion]);

  const create = async (): Promise<void> => {
    if (selectedPromotion === null) return;
    setBusy('create');
    setError(null);
    try {
      const raw = await requestJson('/api/publications', {
        method: 'POST',
        body: JSON.stringify({ promotionId: selectedPromotion }),
      });
      const next = parsePublicationRecord(raw);
      setRecord(next);
      const version = next === null ? null : currentPublicationVersion(next);
      if (version !== null) setForm(formOf(version));
      await load();
      await openPublication(selectedPromotion);
      setNotice(t('publication.createdNotice'));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    if (record === null || current === null) return;
    setBusy('save');
    setError(null);
    try {
      const updated = await requestJson(`/api/publications/${encodeURIComponent(record.publicationId)}`, {
        method: 'PUT',
        body: JSON.stringify({
          baseVersion: current.version,
          patch: {
            title: form.title,
            body: form.body,
            channels: form.channels,
            attachments: lines(form.attachments),
          },
        }),
      });
      const next = parsePublicationRecord(updated);
      setRecord(next);
      const version = next === null ? null : currentPublicationVersion(next);
      if (version !== null) setForm(formOf(version));
      const preflight = await requestJson(`/api/publications/${encodeURIComponent(record.publicationId)}/preflight`);
      setChecks(parseChecks(preflight));
      await load();
      setNotice(t('publication.savedNotice'));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async (): Promise<void> => {
    if (record === null || current === null) return;
    setBusy('confirm');
    setError(null);
    try {
      const updated = await requestJson(`/api/publications/${encodeURIComponent(record.publicationId)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ baseVersion: current.version, confirm: true }),
      });
      const next = parsePublicationRecord(updated);
      setRecord(next);
      const version = next === null ? null : currentPublicationVersion(next);
      if (version !== null) setForm(formOf(version));
      await load();
      setNotice(t('publication.confirmedNotice'));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const publish = async (): Promise<void> => {
    if (record === null || current === null) return;
    setBusy('publish');
    setError(null);
    try {
      const result = await requestJson(`/api/publications/${encodeURIComponent(record.publicationId)}/publish`, {
        method: 'POST',
        body: JSON.stringify({ baseVersion: current.version, confirm: true }),
      });
      const body = result as Row;
      const updated = body['record'] === undefined ? result : body['record'];
      const next = parsePublicationRecord(updated);
      setRecord(next);
      const version = next === null ? null : currentPublicationVersion(next);
      if (version !== null) setForm(formOf(version));
      await load();
      setNotice(t('publication.publishNotice'));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const pageUrl = current?.publicPath === null || current?.publicPath === undefined
    ? null
    : `${window.location.origin}${current.publicPath}`;
  const latestAttempt = current?.attempts[current.attempts.length - 1] ?? null;

  return (
    <div className="stack">
      <PageIntro
        eyebrow={t('publication.eyebrow')}
        title={t('page.publication.title')}
        description={t('publication.description')}
        actions={<span className="page-count">{t('publication.count', { count: promotions.length })}</span>}
      />
      {notice !== null && <p className="promotion-notice" role="status">{notice}</p>}
      {error !== null && <p className="form-error" role="alert">{error}</p>}
      <div className="publication-layout">
        <aside className="publication-rail">
          <Panel title={t('publication.confirmedPanel')} actions={<span className="muted">{t('publication.confirmedHint')}</span>}>
            {promotions.length === 0 ? (
              <Empty title={t('publication.noConfirmed')} hint={t('publication.noConfirmedHint')} />
            ) : (
              <div className="promotion-source-list">
                {promotions.map((promotion) => {
                  const publication = publications.find((entry) => entry.promotionId === promotion.promotionId);
                  return (
                    <button
                      key={promotion.promotionId}
                      type="button"
                      className={`promotion-source ${promotion.promotionId === selectedPromotion ? 'active' : ''}`}
                      onClick={() => setSelectedPromotion(promotion.promotionId)}
                    >
                      <strong>{promotion.title}</strong>
                      <small>{promotion.promotionId} · v{promotion.version}</small>
                      <span className={`promotion-state ${publication?.status ?? 'none'}`}>
                        {publication === undefined ? t('publication.notStarted') : `${publication.status} · v${publication.version}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Panel>
        </aside>

        <main className="publication-main">
          {selectedPromotion === null ? (
            <Empty title={t('publication.selectPromotion')} hint={t('publication.selectPromotionHint')} />
          ) : record === null ? (
            <Panel
              title={t('publication.startPanel')}
              actions={<button type="button" className="primary" disabled={busy !== null} onClick={() => { void create(); }}>{busy === 'create' ? t('common.submitting') : t('publication.create')}</button>}
            >
              <p className="muted">{t('publication.startHint')}</p>
            </Panel>
          ) : current === null ? (
            <Empty title={t('publication.loading')} />
          ) : (
            <>
              <Panel title={t('publication.sourcePanel')} actions={<span className="muted"><button type="button" className="link" onClick={() => control.navigate('Promotion')}>{t('publication.openPromotion')}</button></span>}>
                <div className="promotion-source-meta">
                  <span><small>{t('publication.sourcePromotion')}</small><b>{record.promotionId} v{record.promotionVersion}</b></span>
                  <span><small>{t('publication.sourceExecution')}</small><b>{record.executionId}</b></span>
                  <span><small>{t('publication.sourcePlan')}</small><b>{record.planId} v{record.planVersion}</b></span>
                  <span><small>{t('publication.sourceApproval')}</small><b>{record.approvalId}</b></span>
                  <span><small>{t('publication.sourceRequirement')}</small><b>{record.requirementId} v{record.requirementVersion}</b></span>
                </div>
                <p className="muted">{t('publication.traceHint', { by: record.approvedBy, promotionBy: record.promotionConfirmedBy, artifacts: record.sourceArtifacts.length })}</p>
              </Panel>

              {current.status === 'published' || current.status === 'partial' ? (
                <div className="publication-result" role="status">
                  <b>{current.status === 'published' ? t('publication.publishedBanner') : t('publication.partialBanner')}</b>
                  <span>{t('publication.resultMeta', { version: current.version, by: current.publishedBy ?? '—', at: current.publishedAt ?? '—' })}</span>
                  {pageUrl !== null && <a href={pageUrl} target="_blank" rel="noreferrer">{pageUrl}</a>}
                  <small>{t('publication.localOnly')}</small>
                </div>
              ) : null}

              <Panel title={t('publication.contentPanel')} actions={<span className="muted">{t('publication.contentHint')}</span>}>
                <div className="publication-form">
                  <label>{t('publication.title')}<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
                  <label>{t('publication.body')}<textarea value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} /></label>
                  <label>{t('publication.attachments')}<textarea value={form.attachments} onChange={(event) => setForm({ ...form, attachments: event.target.value })} /></label>
                </div>
                <div className="publication-channels">
                  {CHANNELS.map((channel) => (
                    <label key={channel} className={channel === 'external_wechat' ? 'unavailable' : ''}>
                      <input
                        type="checkbox"
                        checked={form.channels.includes(channel)}
                        onChange={(event) => setForm({
                          ...form,
                          channels: event.target.checked
                            ? [...form.channels, channel]
                            : form.channels.filter((entry) => entry !== channel),
                        })}
                      />
                      {t(`publication.channel.${channel}`)}
                      {channel === 'external_wechat' && <small>{t('publication.externalUnavailable')}</small>}
                    </label>
                  ))}
                </div>
              </Panel>

              <Panel title={t('publication.preflightPanel')} actions={<span className="muted">{t('publication.preflightHint')}</span>}>
                {checks.length === 0 ? <p className="muted">{t('publication.preflightEmpty')}</p> : (
                  <ul className="publication-checks">
                    {checks.map((check) => (
                      <li key={check.checkId} className={check.ok ? 'ok' : 'bad'}>
                        <b>{check.ok ? '✓' : '!'}</b>
                        <span>{check.label}</span>
                        <small>{check.detail}</small>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel title={t('publication.historyPanel')}>
                <div className="publication-versions">
                  {[...record.versions].reverse().map((version) => (
                    <div key={version.version} className={`publication-version ${version.version === record.currentVersion ? 'active' : ''}`}>
                      <b>v{version.version}</b>
                      <span>{version.status}</span>
                      <small>{version.updatedAt}</small>
                      {version.confirmedBy !== null && <small>{t('publication.confirmedBy', { by: version.confirmedBy })}</small>}
                    </div>
                  ))}
                </div>
                {latestAttempt !== null && (
                  <div className="publication-attempts">
                    <b>{t('publication.attempt', { attempt: latestAttempt.attempt, by: latestAttempt.requestedBy })}</b>
                    {latestAttempt.results.map((result) => (
                      <div key={result.channel} className={`publication-result-row ${result.status}`}>
                        <span>{t(`publication.channel.${result.channel}` as 'publication.channel.local_page')}</span>
                        <b>{result.status}</b>
                        <small>{result.url ?? result.error ?? '—'}</small>
                      </div>
                    ))}
                  </div>
                )}
                <p className="muted">{t('publication.historyHint')}</p>
              </Panel>

              <div className="publication-actions">
                <button type="button" className="primary" disabled={busy !== null || current.status === 'publishing'} onClick={() => { void save(); }}>
                  {busy === 'save' ? t('common.submitting') : t('publication.save')}
                </button>
                <button type="button" disabled={busy !== null || current.status !== 'draft'} onClick={() => { void confirm(); }}>
                  {busy === 'confirm' ? t('common.submitting') : t('publication.confirm')}
                </button>
                <button type="button" className="danger" disabled={busy !== null || current.status !== 'ready'} onClick={() => { void publish(); }}>
                  {busy === 'publish' ? t('common.submitting') : t('publication.publish')}
                </button>
                <small className="muted">{t('publication.publishHint')}</small>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
