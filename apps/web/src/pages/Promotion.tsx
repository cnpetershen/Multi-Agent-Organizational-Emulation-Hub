import { useCallback, useEffect, useMemo, useState } from 'react';
import { messageOf, requestJson, type Row } from '../api';
import { artifactContent, parseApprovalLists, parseExecutionReview, type ApprovalRecordView, type ExecutionReviewView } from '../approval';
import { Empty, PageIntro, Panel, StatCard, StatusPill } from '../components';
import type { ConsoleControl } from '../control';
import { useI18n } from '../i18n';
import {
  parsePromotionRecord,
  parsePromotions,
  type PromotionChannelView,
  type PromotionMaterialView,
  type PromotionPlanView,
  type PromotionRecordView,
  type PromotionSummaryView,
} from '../promotion';

/**
 * M3.7 promotion workbench.
 *
 * Only an approved M3.6 execution can seed a plan. The page edits the current draft, saves a new
 * version with baseVersion, and confirms it for M3.8; confirmation is preparation, not publishing.
 */

interface FormState {
  readonly title: string;
  readonly goal: string;
  readonly valueProposition: string;
  readonly audience: string;
  readonly audienceNeeds: string;
  readonly coreMessages: string;
  readonly schedule: string;
  readonly metrics: string;
  readonly risks: string;
  readonly channels: readonly PromotionChannelView[];
  readonly materials: readonly PromotionMaterialView[];
}

const EMPTY_FORM: FormState = {
  title: '',
  goal: '',
  valueProposition: '',
  audience: '',
  audienceNeeds: '',
  coreMessages: '',
  schedule: '',
  metrics: '',
  risks: '',
  channels: [],
  materials: [],
};

function lines(value: string): string[] {
  return value.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}
function joinLines(values: readonly string[]): string {
  return values.join('\n');
}
function formOf(plan: PromotionPlanView): FormState {
  return {
    title: plan.title,
    goal: plan.goal,
    valueProposition: plan.valueProposition,
    audience: joinLines(plan.audience),
    audienceNeeds: joinLines(plan.audienceNeeds),
    coreMessages: joinLines(plan.coreMessages),
    schedule: joinLines(plan.schedule),
    metrics: joinLines(plan.metrics),
    risks: joinLines(plan.risks),
    channels: plan.channels.map((channel) => ({ ...channel })),
    materials: plan.materials.map((material) => ({ ...material })),
  };
}
function patchOf(form: FormState): Row {
  return {
    title: form.title,
    goal: form.goal,
    valueProposition: form.valueProposition,
    audience: lines(form.audience),
    audienceNeeds: lines(form.audienceNeeds),
    coreMessages: lines(form.coreMessages),
    schedule: lines(form.schedule),
    metrics: lines(form.metrics),
    risks: lines(form.risks),
    channels: form.channels,
    materials: form.materials.map((material) => ({ ...material, source: 'human' })),
  };
}

export function PromotionPage({ control }: { control: ConsoleControl }) {
  const { t } = useI18n();
  const [approved, setApproved] = useState<readonly ApprovalRecordView[]>([]);
  const [promotions, setPromotions] = useState<readonly PromotionSummaryView[]>([]);
  const [selectedExecution, setSelectedExecution] = useState<string | null>(null);
  const [selectedPromotion, setSelectedPromotion] = useState<string | null>(null);
  const [review, setReview] = useState<ExecutionReviewView | null>(null);
  const [record, setRecord] = useState<PromotionRecordView | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [artifact, setArtifact] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const current = useMemo<PromotionPlanView | null>(() => {
    if (record === null) return null;
    return record.versions.find((entry) => entry.version === record.currentVersion) ?? record.versions[record.versions.length - 1] ?? null;
  }, [record]);
  const currentPromotion = promotions.find((entry) => entry.executionId === selectedExecution) ?? null;
  const artifactTask = review?.execution.tasks.find((task) => task.result?.artifacts.includes(artifact ?? '')) ?? null;
  const artifactBody = artifactTask?.result != null && artifact !== null
    ? artifactContent(artifactTask.result.data, artifact)
    : null;

  const loadSources = useCallback(async (): Promise<void> => {
    try {
      const [approvalRaw, promotionRaw] = await Promise.all([
        requestJson('/api/execution-approvals'),
        requestJson('/api/promotions'),
      ]);
      const nextApproved = parseApprovalLists(approvalRaw).approved;
      const nextPromotions = parsePromotions(promotionRaw);
      setApproved(nextApproved);
      setPromotions(nextPromotions);
      setSelectedExecution((existing) => {
        if (existing !== null && nextApproved.some((entry) => entry.executionId === existing)) return existing;
        return nextApproved[0]?.executionId ?? null;
      });
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);

  const openPromotion = useCallback(async (promotionId: string): Promise<void> => {
    setBusy('open');
    setError(null);
    try {
      const raw = await requestJson(`/api/promotions/${encodeURIComponent(promotionId)}`);
      const next = parsePromotionRecord(raw);
      setRecord(next);
      setSelectedPromotion(promotionId);
      const plan = next?.versions.find((entry) => entry.version === next.currentVersion) ?? next?.versions[next.versions.length - 1] ?? null;
      if (plan !== null) setForm(formOf(plan));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const openExecution = useCallback(async (executionId: string): Promise<void> => {
    setSelectedExecution(executionId);
    setRecord(null);
    setSelectedPromotion(null);
    setArtifact(null);
    setNotice(null);
    try {
      const raw = await requestJson(`/api/execution-approvals/${encodeURIComponent(executionId)}`);
      const next = parseExecutionReview(raw);
      setReview(next);
      const first = next.execution.summary.artifacts[0] ?? null;
      setArtifact(first);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, []);

  const openExisting = useCallback(async (promotionId: string): Promise<void> => {
    await openPromotion(promotionId);
  }, [openPromotion]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (selectedExecution !== null) void openExecution(selectedExecution);
  }, [openExecution, selectedExecution]);

  useEffect(() => {
    if (selectedExecution === null) return;
    const existing = promotions.find((entry) => entry.executionId === selectedExecution);
    if (existing !== undefined) {
      void openExisting(existing.promotionId);
    }
  }, [openExisting, promotions, selectedExecution]);

  const create = async (): Promise<void> => {
    if (selectedExecution === null) return;
    setBusy('create');
    setError(null);
    try {
      const raw = await requestJson('/api/promotions', {
        method: 'POST',
        body: JSON.stringify({ executionId: selectedExecution }),
      });
      const created = parsePromotionRecord({ promotionId: String((raw as Row)['promotionId'] ?? ''), currentVersion: Number((raw as Row)['version'] ?? 1), versions: [raw] });
      if (created !== null) {
        setRecord(created);
        setSelectedPromotion(created.promotionId);
        setForm(formOf(created.versions[0] as PromotionPlanView));
      }
      await loadSources();
      setNotice(t('promotion.createdNotice'));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    if (current === null || selectedPromotion === null) return;
    setBusy('save');
    setError(null);
    try {
      const raw = await requestJson(`/api/promotions/${encodeURIComponent(selectedPromotion)}`, {
        method: 'PUT',
        body: JSON.stringify({ baseVersion: current.version, patch: patchOf(form) }),
      });
      const saved = raw as PromotionPlanView;
      setRecord((existing) => existing === null ? existing : { ...existing, currentVersion: Number(saved.version), versions: [...existing.versions, saved] });
      setForm(formOf(saved));
      setNotice(t('promotion.savedNotice'));
      await loadSources();
    } catch (cause) {
      setError(messageOf(cause));
      await openExisting(selectedPromotion);
    } finally {
      setBusy(null);
    }
  };

  const confirm = async (): Promise<void> => {
    if (current === null || selectedPromotion === null) return;
    setBusy('confirm');
    setError(null);
    try {
      const raw = await requestJson(`/api/promotions/${encodeURIComponent(selectedPromotion)}/confirm`, {
        method: 'POST',
        body: JSON.stringify({ baseVersion: current.version }),
      });
      const confirmed = raw as PromotionPlanView;
      setRecord((existing) => existing === null ? existing : { ...existing, currentVersion: Number(confirmed.version), versions: [...existing.versions, confirmed] });
      setForm(formOf(confirmed));
      setNotice(t('promotion.confirmedNotice'));
      await loadSources();
    } catch (cause) {
      setError(messageOf(cause));
      await openExisting(selectedPromotion);
    } finally {
      setBusy(null);
    }
  };

  const update = (key: keyof FormState, value: string): void => {
    setForm((existing) => ({ ...existing, [key]: value }));
  };
  const updateChannel = (index: number, key: keyof PromotionChannelView, value: string): void => {
    setForm((existing) => ({
      ...existing,
      channels: existing.channels.map((channel, currentIndex) =>
        currentIndex === index ? { ...channel, [key]: value } : channel,
      ),
    }));
  };
  const updateMaterial = (index: number, key: keyof PromotionMaterialView, value: string): void => {
    setForm((existing) => ({
      ...existing,
      materials: existing.materials.map((material, currentIndex) =>
        currentIndex === index ? { ...material, [key]: value } : material,
      ),
    }));
  };

  return (
    <div className="stack promotion-page">
      <PageIntro
        eyebrow={t('promotion.eyebrow')}
        title={t('page.promotion.title')}
        description={t('promotion.description')}
        actions={<span className="page-count">{t('promotion.count', { count: approved.length })}</span>}
      />
      {notice !== null && <p className="promotion-notice" role="status">{notice}</p>}
      {error !== null && <p className="form-error" role="alert">{error}</p>}
      <div className="stat-grid workbench-stats">
        <StatCard label={t('promotion.statApproved')} value={approved.length} detail={t('promotion.approvedHint')} tone="blue" />
        <StatCard
          label={t('promotion.statVersions')}
          value={record?.versions.length ?? 0}
          detail={current === null ? t('promotion.noVersions') : `v${String(current.version)} · ${current.status}`}
          tone="neutral"
        />
        <StatCard
          label={t('promotion.stateLabel')}
          value={current === null ? t('promotion.notStarted') : current.status}
          detail={t('promotion.notPublished')}
          tone={current?.status === 'confirmed' ? 'green' : 'amber'}
        />
      </div>
      <div className="workbench-grid">
        <section className="workbench-rail">
          <Panel title={t('promotion.approvedPanel')}>
            {approved.length === 0 ? (
              <Empty title={t('promotion.noApproved')} hint={t('promotion.noApprovedHint')} />
            ) : (
              <div className="promotion-source-list">
                {approved.map((entry) => {
                  const promotion = promotions.find((item) => item.executionId === entry.executionId);
                  return (
                    <button
                      key={entry.executionId}
                      type="button"
                      className={`promotion-source ${entry.executionId === selectedExecution ? 'active' : ''}`}
                      onClick={() => { void openExecution(entry.executionId); }}
                    >
                      <strong>{entry.planId}</strong>
                      <small>{entry.executionId} · v{entry.planVersion}</small>
                      <span className={`promotion-state ${promotion?.status ?? 'none'}`}>
                        {promotion === undefined ? t('promotion.notStarted') : `${promotion.status} · v${promotion.version}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Panel>
          <Panel title={t('promotion.versionPanel')}>
            {record === null || record.versions.length === 0 ? (
              <Empty title={t('promotion.noVersions')} hint={t('promotion.noVersionsHint')} />
            ) : (
              <div className="promotion-versions">
                {[...record.versions].reverse().map((version) => (
                  <div key={version.version} className={`promotion-version ${version.version === record.currentVersion ? 'active' : ''}`}>
                    <b>v{version.version}</b>
                    <span>{version.status}</span>
                    <small>{version.updatedAt}</small>
                    {version.confirmedAt !== null && <small>{t('promotion.confirmedBy', { by: version.confirmedBy ?? '—' })}</small>}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </section>

        <section className="workbench-main">
          {selectedExecution === null || review === null ? (
            <Empty title={t('promotion.selectSource')} hint={t('promotion.selectSourceHint')} />
          ) : (
            <>
              <Panel title={t('promotion.sourcePanel')} actions={<StatusPill value="Completed" label={t('promotion.approved')} />}>
                <div className="promotion-source-meta">
                  <span><small>{t('promotion.sourcePlan')}</small><b>{review.plan?.title ?? review.execution.planTitle}</b></span>
                  <span><small>{t('promotion.sourcePlanVersion')}</small><b>v{review.execution.planVersion}</b></span>
                  <span><small>{t('promotion.sourceExecution')}</small><b>{review.execution.executionId}</b></span>
                  <span><small>{t('promotion.sourceApprovedBy')}</small><b>{approved.find((entry) => entry.executionId === selectedExecution)?.decidedBy ?? '—'}</b></span>
                </div>
                <p className="muted">{review.plan?.goal ?? review.execution.planTitle}</p>
                <div className="promotion-artifacts">
                  {review.execution.summary.artifacts.map((name) => (
                    <button key={name} type="button" className={`artifact-tab ${artifact === name ? 'active' : ''}`} onClick={() => setArtifact(name)}>
                      {name}
                    </button>
                  ))}
                </div>
                {artifactBody !== null && <pre className="promotion-artifact-preview">{artifactBody.slice(0, 4000)}</pre>}
                <div className="promotion-source-actions">
                  <button type="button" className="link" onClick={() => control.openResults(review.execution.tasks[0]?.taskId ?? '')} disabled={review.execution.tasks.length === 0}>{t('promotion.openResults')}</button>
                </div>
              </Panel>

              {currentPromotion === null && record === null ? (
                <Panel title={t('promotion.startPanel')} actions={<button type="button" className="primary" disabled={busy !== null} onClick={() => { void create(); }}>{busy === 'create' ? t('common.submitting') : t('promotion.create')}</button>}>
                  <p className="muted">{t('promotion.startHint')}</p>
                  <p className="muted">{t('promotion.contributorsHint')}</p>
                </Panel>
              ) : current === null ? (
                <Empty title={t('promotion.loading')} />
              ) : (
                <>
                  {current.status === 'confirmed' && (
                    <div className="promotion-confirmed" role="status">
                      <b>{t('promotion.confirmedBanner')}</b>
                      <span>{t('promotion.confirmedMeta', { by: current.confirmedBy ?? '—', at: current.confirmedAt ?? '—', version: current.version })}</span>
                      <small>{t('promotion.handoffReady')}</small>
                      {current.summaryText !== '' && <small>{current.summaryText}</small>}
                    </div>
                  )}
                  <Panel
                    title={t('promotion.strategyPanel')}
                    actions={<span className="muted">{current.status === 'confirmed' ? t('promotion.confirmedReadonly') : t('promotion.editingVersion', { version: current.version })}</span>}
                  >
                    <div className="promotion-form">
                      <label>{t('promotion.title')}<input value={form.title} onChange={(event) => update('title', event.target.value)} /></label>
                      <label>{t('promotion.goal')}<textarea value={form.goal} onChange={(event) => update('goal', event.target.value)} /></label>
                      <label>{t('promotion.value')}<textarea value={form.valueProposition} onChange={(event) => update('valueProposition', event.target.value)} /></label>
                      <label>{t('promotion.audience')}<textarea value={form.audience} onChange={(event) => update('audience', event.target.value)} /></label>
                      <label>{t('promotion.needs')}<textarea value={form.audienceNeeds} onChange={(event) => update('audienceNeeds', event.target.value)} /></label>
                      <label>{t('promotion.messages')}<textarea value={form.coreMessages} onChange={(event) => update('coreMessages', event.target.value)} /></label>
                    </div>
                    <div className="promotion-split">
                      <label>{t('promotion.schedule')}<textarea value={form.schedule} onChange={(event) => update('schedule', event.target.value)} /></label>
                      <label>{t('promotion.metrics')}<textarea value={form.metrics} onChange={(event) => update('metrics', event.target.value)} /></label>
                      <label>{t('promotion.risks')}<textarea value={form.risks} onChange={(event) => update('risks', event.target.value)} /></label>
                    </div>
                  </Panel>

                  <Panel title={t('promotion.channelsPanel')} actions={<span className="muted">{t('promotion.channelsHint')}</span>}>
                    <div className="promotion-channels">
                      {form.channels.map((channel, index) => (
                        <div key={`${channel.channelId}-${String(index)}`} className="promotion-channel">
                          <input aria-label={t('promotion.channelName')} value={channel.name} onChange={(event) => updateChannel(index, 'name', event.target.value)} />
                          <input aria-label={t('promotion.channelType')} value={channel.contentType} onChange={(event) => updateChannel(index, 'contentType', event.target.value)} />
                          <textarea aria-label={t('promotion.channelReason')} value={channel.reason} onChange={(event) => updateChannel(index, 'reason', event.target.value)} />
                        </div>
                      ))}
                    </div>
                  </Panel>

                  <Panel title={t('promotion.materialsPanel')} actions={<span className="muted">{t('promotion.materialsHint')}</span>}>
                    <div className="promotion-materials">
                      {form.materials.map((material, index) => (
                        <article key={`${material.materialId}-${String(index)}`} className="promotion-material">
                          <div className="promotion-material-head">
                            <input aria-label={t('promotion.materialTitle')} value={material.title} onChange={(event) => updateMaterial(index, 'title', event.target.value)} />
                            <span className={`promotion-material-source ${material.source}`}>{material.source === 'human' ? t('promotion.human') : t('promotion.ai')}</span>
                          </div>
                          <small>{material.type} · {material.platform}</small>
                          <textarea aria-label={t('promotion.materialBody')} value={material.body} onChange={(event) => updateMaterial(index, 'body', event.target.value)} />
                        </article>
                      ))}
                    </div>
                  </Panel>

                  <Panel title={t('promotion.provenancePanel')}>
                    <div className="promotion-source-meta">
                      <span><small>{t('promotion.provenanceMode')}</small><b>{current.provenance.mode}</b></span>
                      <span><small>{t('promotion.provider')}</small><b>{current.provenance.provider ?? '—'}</b></span>
                      <span><small>{t('promotion.model')}</small><b>{current.provenance.model ?? '—'}</b></span>
                      <span><small>{t('promotion.artifacts')}</small><b>{current.provenance.approvedArtifacts.length}</b></span>
                    </div>
                    {current.contributors.length > 0 ? (
                      <div className="promotion-contributors">
                        {current.contributors.map((contributor) => (
                          <span key={contributor.employeeId}>{contributor.name} · {contributor.role}</span>
                        ))}
                      </div>
                    ) : <p className="muted">{t('promotion.noContributors')}</p>}
                    <p className="muted">{t('promotion.contributorsHint')}</p>
                    <small>{t('promotion.humanEdits', { fields: current.provenance.humanEdits.join(', ') || '—' })}</small>
                  </Panel>

                  <div className="promotion-actions">
                    <button type="button" className="primary" disabled={busy !== null} onClick={() => { void save(); }}>
                      {busy === 'save' ? t('common.submitting') : t('promotion.save')}
                    </button>
                    <button type="button" disabled={busy !== null || current.status === 'confirmed'} onClick={() => { void confirm(); }}>
                      {busy === 'confirm' ? t('common.submitting') : t('promotion.confirm')}
                    </button>
                    {current.status === 'confirmed' && <small className="muted">{t('promotion.notPublished')}</small>}
                  </div>
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
