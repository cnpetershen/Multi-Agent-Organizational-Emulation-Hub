import { useCallback, useEffect, useMemo, useState } from 'react';
import { messageOf, readString, requestJson, type Row } from '../api';
import { Empty, PageIntro, Panel, StatCard, StatusPill } from '../components';
import type { ConsoleControl } from '../control';
import { useI18n, type MessageKey } from '../i18n';
import {
  joinCapabilities,
  joinLines,
  parseOrchestration,
  parseOrchestrationList,
  parseRequirementList,
  parseRequirementPlan,
  parseRequirementRecord,
  splitCapabilities,
  splitLines,
  type OrchestrationView,
  type RequirementPlanView,
  type RequirementRecordView,
  type RequirementSummaryView,
} from '../planning';
/**
 * M3.3 · 规划台：需求沙盘 → 智能体编排。
 *
 * One guided page, because the two steps are one workflow: the requirement must be confirmed
 * before the orchestrator is allowed to read it, and the orchestration produces a canvas draft
 * that is *not* started. Every button maps to one explicit API state transition; nothing is
 * started, approved or executed from here.
 */

interface FormState {
  readonly title: string;
  readonly background: string;
  readonly audience: string;
  readonly constraints: string;
  readonly inScope: string;
  readonly outOfScope: string;
  readonly deliverables: string;
  readonly acceptance: string;
  readonly capabilities: string;
}

interface SandboxSessionRow {
  readonly sessionId: string;
  readonly topic: string;
  readonly turns: number;
  readonly startedAt: string;
}

const EMPTY_FORM: FormState = {
  title: '',
  background: '',
  audience: '',
  constraints: '',
  inScope: '',
  outOfScope: '',
  deliverables: '',
  acceptance: '',
  capabilities: '',
};

function formOf(plan: RequirementPlanView): FormState {
  return {
    title: plan.title,
    background: plan.background ?? '',
    audience: joinLines(plan.audience),
    constraints: joinLines(plan.constraints),
    inScope: joinLines(plan.scope.inScope),
    outOfScope: joinLines(plan.scope.outOfScope),
    deliverables: joinLines(plan.deliverables),
    acceptance: joinLines(plan.acceptanceCriteria),
    capabilities: joinCapabilities(plan.requiredCapabilities),
  };
}

function answersOf(plan: RequirementPlanView): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const clarification of plan.clarifications) {
    if (clarification.answer !== null) answers[clarification.id] = clarification.answer;
  }
  return answers;
}

function parseSessions(value: unknown): SandboxSessionRow[] {
  const row = typeof value === 'object' && value !== null ? (value as Row) : {};
  const list = Array.isArray(row['sessions']) ? (row['sessions'] as readonly unknown[]) : [];
  return list.map((entry) => {
    const session = typeof entry === 'object' && entry !== null ? (entry as Row) : {};
    return {
      sessionId: readString(session['sessionId'], ''),
      topic: readString(session['topic'], ''),
      turns: Array.isArray(session['turns']) ? (session['turns'] as readonly unknown[]).length : 0,
      startedAt: readString(session['startedAt'], ''),
    };
  });
}

function employeeName(control: ConsoleControl, employeeId: string | null): string {
  if (employeeId === null) return '';
  const row = control.snapshot.employees.find(
    (employee) => readString(employee['employeeId'], '') === employeeId,
  );
  return row === undefined ? employeeId : readString(row['name'], employeeId);
}

function capabilityName(capability: string): string {
  return capability.replace(/_/g, ' ');
}

/** Product-surface detail: no internal node/employee/capability ids, only names and titles. */
function safeConflictDetail(
  detail: string,
  orchestration: OrchestrationView,
  control: ConsoleControl,
): string {
  let text = detail;
  for (const node of orchestration.nodes) {
    text = text.split(node.nodeId).join(`「${node.title}」`);
  }
  for (const employeeId of orchestration.basis.employees) {
    text = text.split(employeeId).join(employeeName(control, employeeId));
  }
  for (const capability of orchestration.basis.capabilities) {
    text = text.split(capability).join(capabilityName(capability));
  }
  return text.replace(/\b(?:employee|task|node|step|stage|instance)-[a-z0-9_-]+\b/gi, '…');
}

export function PlanningPage({ control }: { control: ConsoleControl }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [requirements, setRequirements] = useState<readonly RequirementSummaryView[]>([]);
  const [sessions, setSessions] = useState<readonly SandboxSessionRow[]>([]);
  const [record, setRecord] = useState<RequirementRecordView | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [goal, setGoal] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [orchestration, setOrchestration] = useState<OrchestrationView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plan: RequirementPlanView | null = useMemo(() => {
    if (record === null) return null;
    const version = selectedVersion ?? record.currentVersion;
    return (
      record.versions.find((entry) => entry.version === version) ??
      record.versions.at(-1) ??
      null
    );
  }, [record, selectedVersion]);

  const editable = record !== null && plan !== null && plan.version === record.currentVersion;
  const dirty =
    plan !== null &&
    (JSON.stringify(form) !== JSON.stringify(formOf(plan)) ||
      JSON.stringify(answers) !== JSON.stringify(answersOf(plan)));

  const loadList = useCallback(async (): Promise<void> => {
    try {
      const listed = await requestJson('/api/requirements');
      setRequirements(parseRequirementList(listed));
      const sessionsBody = await requestJson('/api/sandbox/sessions');
      setSessions(parseSessions(sessionsBody));
    } catch {
      // The page can still analyze a new goal; the list being empty is not fatal.
    }
  }, []);

  const openRequirement = useCallback(async (requirementId: string, version?: number): Promise<void> => {
    setBusy('open');
    setError(null);
    try {
      const raw = await requestJson(`/api/requirements/${encodeURIComponent(requirementId)}`);
      const next = parseRequirementRecord(raw);
      setRecord(next);
      const current = next.versions.find((entry) => entry.version === next.currentVersion) ?? next.versions.at(-1) ?? null;
      const selected = version === undefined ? (current?.version ?? next.currentVersion) : version;
      const planToShow = next.versions.find((entry) => entry.version === selected) ?? current;
      setSelectedVersion(planToShow?.version ?? null);
      setForm(planToShow === null ? EMPTY_FORM : formOf(planToShow));
      setAnswers(planToShow === null ? {} : answersOf(planToShow));
      setGoal(planToShow?.source.goal ?? '');
      const orchestrations = parseOrchestrationList(await requestJson('/api/orchestrations'));
      const latest =
        orchestrations.find((entry) => entry.requirementId === requirementId) ?? null;
      setOrchestration(latest);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const analyze = async (): Promise<void> => {
    if (goal.trim() === '' && sessionId === '') {
      setError(t('planning.error.goalRequired'));
      return;
    }
    setBusy('analyze');
    setError(null);
    try {
      const analyzed = await requestJson('/api/requirements/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(goal.trim() === '' ? {} : { goal: goal.trim() }),
          ...(sessionId === '' ? {} : { sourceSessionId: sessionId }),
        }),
      });
      const plan = parseRequirementRecord({ ...(analyzed as Row), versions: [analyzed] });
      await loadList();
      await openRequirement(plan.requirementId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const submitPatch = async (
    requirementId: string,
    baseVersion: number,
  ): Promise<RequirementPlanView> => {
    const raw = await requestJson(`/api/requirements/${encodeURIComponent(requirementId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseVersion,
        patch: {
          title: form.title,
          background: form.background.trim() === '' ? null : form.background,
          audience: splitLines(form.audience, 20),
          constraints: splitLines(form.constraints, 30),
          inScope: splitLines(form.inScope, 30),
          outOfScope: splitLines(form.outOfScope, 30),
          deliverables: splitLines(form.deliverables, 20),
          acceptanceCriteria: splitLines(form.acceptance, 30),
          requiredCapabilities: splitCapabilities(form.capabilities),
          answers,
        },
      }),
    });
    return parseRequirementPlan(raw);
  };

  const save = async (): Promise<void> => {
    if (record === null || !editable) return;
    setBusy('save');
    setError(null);
    try {
      await submitPatch(record.requirementId, record.currentVersion);
      await loadList();
      await openRequirement(record.requirementId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async (): Promise<void> => {
    if (record === null || plan === null) return;
    setBusy('confirm');
    setError(null);
    try {
      // Confirmation must confirm what is on screen. Unsaved edits are written as a new
      // version first, then that exact version is confirmed.
      const version = dirty ? (await submitPatch(record.requirementId, record.currentVersion)).version : record.currentVersion;
      await requestJson(`/api/requirements/${encodeURIComponent(record.requirementId)}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version,
          answers,
          acknowledgeInferred: true,
        }),
      });
      await loadList();
      await openRequirement(record.requirementId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const orchestrate = async (): Promise<void> => {
    if (record === null || plan === null || plan.status !== 'confirmed') return;
    setBusy('orchestrate');
    setError(null);
    try {
      const raw = await requestJson('/api/orchestrations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requirementId: record.requirementId, version: plan.version }),
      });
      setOrchestration(parseOrchestration(raw));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const setField = (field: keyof FormState, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const openPlanCanvas = async (): Promise<void> => {
    if (orchestration === null) return;
    setBusy('canvas');
    setError(null);
    try {
      await requestJson('/api/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orchestrationId: orchestration.orchestrationId }),
      });
      control.navigate('PlanCanvas');
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const confirmedRequirements = requirements.filter((entry) => entry.status === 'confirmed').length;

  return (
    <div className="planning-page">
      <PageIntro
        eyebrow={t('planning.eyebrow')}
        title={t('planning.title')}
        description={t('planning.description')}
      />

      {/* Same three-card metric row as the other workbenches (Promotion, Publication). */}
      <div className="stat-grid planning-stats">
        <StatCard
          label={t('planning.stat.requirements')}
          value={requirements.length}
          detail={t('planning.stat.requirementsDetail', { count: confirmedRequirements })}
          tone="blue"
        />
        <StatCard
          label={t('planning.stat.sessions')}
          value={sessions.length}
          detail={t('planning.stat.sessionsDetail')}
          tone="neutral"
        />
        <StatCard
          label={t('planning.stat.nodes')}
          value={orchestration === null ? 0 : orchestration.nodes.length}
          detail={orchestration === null ? t('planning.stat.nodesNone') : t('planning.stat.nodesDetail', { count: orchestration.nodes.length })}
          tone={orchestration !== null && orchestration.status === 'ready' ? 'green' : 'amber'}
        />
      </div>

      {error !== null && <div className="planning-error" role="alert">{error}</div>}

      <div className="planning-grid">
        <div className="planning-list">
          <div className="planning-list-head">
            <h3>{t('planning.list.title')}</h3>
            <button type="button" onClick={() => { setRecord(null); setForm(EMPTY_FORM); setAnswers({}); setOrchestration(null); }}>
              {t('planning.list.new')}
            </button>
          </div>
          {requirements.length === 0 ? (
            <Empty title={t('planning.list.empty')} hint={t('planning.list.emptyHint')} />
          ) : (
            <ul>
              {requirements.map((entry) => (
                <li key={entry.requirementId}>
                  <button
                    type="button"
                    className={record?.requirementId === entry.requirementId ? 'active' : ''}
                    onClick={() => void openRequirement(entry.requirementId)}
                  >
                    <b>{entry.title || t('planning.untitled')}</b>
                    <span>
                      v{entry.version} · {t(`planning.status.${entry.status}` as MessageKey)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="planning-main">
          <Panel title={t('planning.analyze.title')}>
            <div className="planning-form">
              <label>
                <span>{t('planning.analyze.goal')}</span>
                <textarea
                  value={goal}
                  rows={3}
                  placeholder={t('planning.analyze.goalHint')}
                  onChange={(event) => setGoal(event.target.value)}
                  disabled={busy !== null}
                />
              </label>
              <label>
                <span>{t('planning.analyze.session')}</span>
                <select value={sessionId} onChange={(event) => setSessionId(event.target.value)} disabled={busy !== null}>
                  <option value="">{t('planning.analyze.sessionNone')}</option>
                  {sessions.map((session) => (
                    <option key={session.sessionId} value={session.sessionId}>
                      {session.topic} · {t('planning.analyze.sessionTurns', { count: session.turns })}
                    </option>
                  ))}
                </select>
              </label>
              <div className="planning-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy !== null || (goal.trim() === '' && sessionId === '')}
                  onClick={() => void analyze()}
                >
                  {busy === 'analyze' ? t('planning.analyzing') : t('planning.analyze.action')}
                </button>
              </div>
            </div>
          </Panel>

          {plan !== null && record !== null && (
            <Panel
              title={t('planning.plan.title')}
              actions={
                <span className="planning-plan-meta">
                  v{plan.version} · <StatusPill value={plan.status} label={t(`planning.status.${plan.status}` as MessageKey)} />
                </span>
              }
            >
              <div className="planning-source">
                <span>{t('planning.plan.sourceGoal')}</span>
                <p>{plan.source.goal}</p>
              </div>
              <div className="planning-provenance">
                <b>{t('planning.plan.provenance')}</b>
                <span>
                  {t('planning.plan.mode')}: {t(`planning.mode.${plan.provenance.mode}` as MessageKey)}
                </span>
                <span>{t('planning.plan.inferredNote')}</span>
              </div>

              {plan.clarifications.length > 0 && (
                <div className="planning-clarifications">
                  <h4>{t('planning.clarify.title')}</h4>
                  {plan.clarifications.map((clarification) => (
                    <div key={clarification.id} className={`planning-question ${clarification.blocking ? 'blocking' : ''}`}>
                      <div>
                        <b>{clarification.question}</b>
                        {clarification.blocking && clarification.status === 'open' ? (
                          <span className="pill warn">{t('planning.clarify.blocking')}</span>
                        ) : clarification.status === 'answered' ? (
                          <span className="pill ok">{t('planning.clarify.answered')}</span>
                        ) : null}
                      </div>
                      <p>{clarification.why}</p>
                      <textarea
                        rows={2}
                        value={answers[clarification.id] ?? ''}
                        placeholder={t('planning.clarify.answer')}
                        onChange={(event) =>
                          setAnswers((current) => ({ ...current, [clarification.id]: event.target.value }))
                        }
                        disabled={!editable}
                      />
                    </div>
                  ))}
                </div>
              )}

              <div className="planning-fields">
                <label>
                  <span>{t('planning.field.title')}</span>
                  <input value={form.title} onChange={(event) => setField('title', event.target.value)} disabled={!editable} />
                </label>
                <label className="wide">
                  <span>{t('planning.field.background')}</span>
                  <textarea rows={2} value={form.background} onChange={(event) => setField('background', event.target.value)} disabled={!editable} />
                </label>
                <label>
                  <span>{t('planning.field.audience')}</span>
                  <textarea rows={3} value={form.audience} onChange={(event) => setField('audience', event.target.value)} disabled={!editable} />
                </label>
                <label>
                  <span>{t('planning.field.constraints')}</span>
                  <textarea rows={3} value={form.constraints} onChange={(event) => setField('constraints', event.target.value)} disabled={!editable} />
                </label>
                <label>
                  <span>{t('planning.field.inScope')}</span>
                  <textarea rows={3} value={form.inScope} onChange={(event) => setField('inScope', event.target.value)} disabled={!editable} />
                </label>
                <label>
                  <span>{t('planning.field.outOfScope')}</span>
                  <textarea rows={3} value={form.outOfScope} onChange={(event) => setField('outOfScope', event.target.value)} disabled={!editable} />
                </label>
                <label>
                  <span>{t('planning.field.deliverables')}</span>
                  <textarea rows={4} value={form.deliverables} onChange={(event) => setField('deliverables', event.target.value)} disabled={!editable} />
                </label>
                <label>
                  <span>{t('planning.field.acceptance')}</span>
                  <textarea rows={4} value={form.acceptance} onChange={(event) => setField('acceptance', event.target.value)} disabled={!editable} />
                </label>
                <label className="wide">
                  <span>{t('planning.field.capabilities')}</span>
                  <input value={form.capabilities} onChange={(event) => setField('capabilities', event.target.value)} disabled={!editable} />
                </label>
              </div>

              {plan.risks.length > 0 && (
                <div className="planning-risks">
                  <h4>{t('planning.field.risks')}</h4>
                  {plan.risks.map((risk, index) => (
                    <div key={`${risk.risk}-${String(index)}`} className={`planning-risk severity-${risk.severity}`}>
                      <b>{risk.risk}</b>
                      {risk.mitigation !== null && <span>{risk.mitigation}</span>}
                    </div>
                  ))}
                </div>
              )}

              <div className="planning-versionbar">
                <label>
                  <span>{t('planning.plan.versions')}</span>
                  <select
                    value={String(plan.version)}
                    onChange={(event) => {
                      const version = Number(event.target.value);
                      const selected = record.versions.find((entry) => entry.version === version);
                      if (selected === undefined) return;
                      setSelectedVersion(selected.version);
                      setForm(formOf(selected));
                      setAnswers(answersOf(selected));
                      setGoal(selected.source.goal);
                    }}
                  >
                    {[...record.versions].reverse().map((version) => (
                      <option key={version.version} value={String(version.version)}>
                        v{version.version} · {t(`planning.status.${version.status}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="planning-actions">
                  {!editable && <span className="planning-readonly">{t('planning.readonly')}</span>}
                  <button type="button" className="primary" disabled={!editable || busy !== null || !dirty} onClick={() => void save()}>
                    {busy === 'save' ? t('planning.saving') : t('planning.save')}
                  </button>
                  {plan.status !== 'confirmed' && (
                    <button
                      type="button"
                      className="primary"
                      disabled={!editable || busy !== null}
                      onClick={() => void confirm()}
                      data-testid="planning-confirm"
                    >
                      {busy === 'confirm' ? t('planning.confirming') : t('planning.confirm')}
                    </button>
                  )}
                </div>
              </div>
              {plan.status === 'needs_clarification' && (
                <p className="planning-hint">{t('planning.confirmHint')}</p>
              )}
            </Panel>
          )}

          {plan !== null && plan.status === 'confirmed' && (
            <Panel
              title={t('planning.orchestration.title')}
              actions={
                orchestration === null ? null : (
                  <span className={`pill ${orchestration.status === 'ready' ? 'ok' : 'warn'}`}>
                    {t(`planning.orchestration.status.${orchestration.status}` as MessageKey)}
                  </span>
                )
              }
            >
              <p className="planning-hint">{t('planning.orchestration.description')}</p>
              <div className="planning-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={busy !== null}
                  onClick={() => void orchestrate()}
                  data-testid="planning-orchestrate"
                >
                  {busy === 'orchestrate' ? t('planning.orchestration.generating') : t('planning.orchestration.generate')}
                </button>
                {orchestration !== null && (
                  <button type="button" disabled={busy !== null} onClick={() => void openPlanCanvas()}>
                    {t('planning.orchestration.openCanvas')}
                  </button>
                )}
              </div>
              <p className="planning-no-start">{t('planning.orchestration.noStart')}</p>

              {orchestration !== null && (
                <div className="planning-orchestration">
                  <div className="planning-basis">
                    <span>{t('planning.orchestration.requirementVersion', { version: orchestration.requirementVersion })}</span>
                    <span>{t('planning.orchestration.orchestrationVersion', { version: orchestration.version })}</span>
                    <span>{t('planning.orchestration.basis', { capabilities: orchestration.basis.capabilities.map(capabilityName).join('、') })}</span>
                    {orchestration.workflowInstanceId !== null && (
                      <span>{t('planning.orchestration.draftReady')}</span>
                    )}
                  </div>

                  {orchestration.conflicts.length > 0 && (
                    <div className="planning-conflicts">
                      <h4>{t('planning.orchestration.conflicts')}</h4>
                      {orchestration.conflicts.map((conflict, index) => (
                        <div key={`${conflict.code}-${String(index)}`} className={`planning-conflict ${conflict.severity}`}>
                          <b>{t(`planning.conflict.${conflict.code}` as MessageKey)}</b>
                          <span>{safeConflictDetail(conflict.detail, orchestration, control)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <ol className="planning-nodes">
                    {orchestration.nodes.map((node) => (
                      <li key={node.nodeId} className={`planning-node kind-${node.kind} status-${node.status}`}>
                        <div className="planning-node-head">
                          <b>{node.title}</b>
                          <span className="planning-node-order">#{node.order + 1}</span>
                        </div>
                        <div className="planning-node-meta">
                          {node.kind === 'approval' ? (
                            <span>{t('planning.node.humanGate')}</span>
                          ) : node.employeeId === null ? (
                            <span className="pill bad">{t('planning.node.unassigned')}</span>
                          ) : (
                            <span>{t('planning.node.owner')}: {employeeName(control, node.employeeId)}</span>
                          )}
                          {node.dependsOn.length > 0 && (
                            <span>
                              {t('planning.node.dependsOn')}:{' '}
                              {node.dependsOn
                                .map((dependency) => {
                                  const source = orchestration.nodes.find((entry) => entry.nodeId === dependency);
                                  return source === undefined ? '—' : `「${source.title}」`;
                                })
                                .join('、')}
                            </span>
                          )}
                        </div>
                        <div className="planning-node-grid">
                          <span><small>{t('planning.node.inputs')}</small>{node.inputs.join('；') || '—'}</span>
                          <span><small>{t('planning.node.outputs')}</small>{node.outputs.join('；') || '—'}</span>
                          <span><small>{t('planning.node.acceptance')}</small>{node.acceptance.join('；') || '—'}</span>
                        </div>
                      </li>
                    ))}
                  </ol>

                  {orchestration.missingCapabilities.length > 0 && (
                    <p className="planning-missing">
                      {t('planning.orchestration.missing', {
                        capabilities: orchestration.missingCapabilities.map(capabilityName).join('、'),
                      })}
                    </p>
                  )}
                </div>
              )}
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
