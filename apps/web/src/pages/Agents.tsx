import { useState } from 'react';
import { parseRows, parseWorkBriefs, readNumber, readString, type Row } from '../api';
import { OPERATOR, archiveAgent, createAgent, instructAgent, setAgentPaused, type CommandContext } from '../commands';
import type { ConsoleControl } from '../control';
import { AgentAvatar, avatarStatusOf, DetailItem, DetailSection, Empty, EventLine, Field, PageIntro, Panel, StatCard, StatusPill, Submit, eventDetail } from '../components';
import { agentPillLabel, agentState, agentStateLabel, colleaguesOf, departmentHeadOf, departmentName, employeeLabel, employeeOf, expertiseOf, focusRef, isArchivedAgent, peersOf, positionCapabilities, positionTitle, reportsOf, taskById, vacantPositions, workflowById, capabilityLabel, CAPABILITY_IDS } from '../derive';
import { hiringRequests } from '../hiring';
import { useJson } from '../hooks';
import { useI18n, type I18n } from '../i18n';

/** A value the record has nothing to show for. */
const MISSING = '—';

function ctxOf(control: ConsoleControl): CommandContext { return { companyId: control.companyId, simTime: control.simTime }; }
function agentLabel(control: ConsoleControl, agent: Row): string { return `${positionTitle(control.snapshot.positions, readString(agent['positionId'], ''))} ${readString(agent['name'], '')}`.trim(); }
function lastActivity(events: readonly Row[], agentId: string): Row | null { for (const event of events) { if (readString(event['subjectId'], '') === agentId || readString(event['actorId'], '') === agentId) return event; } return null; }
/** The employee id the operator types is a stable slug — the same convention the seed uses. */
function slugify(text: string): string { return text.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48); }
/** Mandates are entered one per line; traits as a comma-separated list. */
function linesOf(text: string): readonly string[] { return text.split('\n').map((line) => line.trim()).filter((line) => line !== ''); }
function listOf(text: string): readonly string[] { return text.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''); }

/** Sentinel option: "type in a position the chart does not have yet". */
const NEW_POSITION = '__new_position__';
function lifecycleLabel(lifecycle: string, i18n: I18n): string { return lifecycle === 'archived' ? i18n.t('status.archived') : i18n.t('status.active'); }
/** `''` stays `''` so a caller can tell "not reported" from a real value. */
function textOf(value: unknown): string { return readString(value, ''); }
/** A missing value reads as the record's own "nothing here" mark, never as an empty cell. */
function orMissing(value: string): string { return value === '' ? MISSING : value; }
/** `Title · Name` per person; the record says "None" rather than rendering an empty row. */
function peopleLine(rows: readonly Row[], employees: readonly Row[], positions: readonly Row[], none: string): string {
  if (rows.length === 0) return none;
  return rows.map((row) => employeeLabel(employees, positions, readString(row['employeeId'], ''))).join(' · ');
}
/** The runtime state object `/api/agents` carries, or null when the agent has none. */
function runtimeOf(agent: Row): Row | null {
  const runtime = agent['runtime'];
  return typeof runtime === 'object' && runtime !== null && !Array.isArray(runtime) ? (runtime as Row) : null;
}
/** The pill only ever distinguishes archived / paused / working / idle — same contract as a card. */
function pillKindOf(stateKind: string): string {
  if (stateKind === 'archived' || stateKind === 'paused') return stateKind;
  return stateKind === 'working' ? 'working' : 'idle';
}
function kindLabel(kind: string, i18n: I18n): string {
  if (kind === 'agent') return i18n.t('agents.detail.kindAgent');
  if (kind === 'human') return i18n.t('agents.detail.kindHuman');
  return MISSING;
}

/**
 * The agent record.
 *
 * Grouped into identity / placement / runtime / current work / history so the reader can find a
 * fact instead of scanning one flat list. Every value still comes from the payload the console
 * already holds — the record adds no fields the API does not report, and a value the API omits
 * reads as `—` rather than being invented.
 */
function AgentRecord({ control, agent, history, onClose }: { control: ConsoleControl; agent: Row; history: readonly Row[]; onClose: () => void }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { snapshot } = control;
  const employeeId = readString(agent['employeeId'], '');
  const employee = employeeOf(snapshot.employees, employeeId);
  const runtime = runtimeOf(agent);
  const stateKind = readString(agent['stateKind'], 'idle');
  const lifecycle = readString(agent['lifecycle'], 'active');
  const task = taskById(snapshot.tasks, readString(agent['currentTaskId'], ''));
  const workflow = workflowById(snapshot.workflows, readString(agent['currentWorkflowInstanceId'], ''));
  /** Peers and colleagues come from the on-duty roster: an archived agent is off it. */
  const onDuty = snapshot.agents.filter((row) => !isArchivedAgent(row));
  const placed = [orMissing(textOf(agent['position'])), departmentName(snapshot.departments, readString(agent['departmentId'], ''))].filter((part) => part !== MISSING && part !== '').join(' · ');
  const capabilities = positionCapabilities(snapshot.positions, readString(agent['positionId'], ''));
  const expertise = expertiseOf(agent);
  /** §5.7: `Agent.Instruct` is a diagnostic, so it lives inside the record of the seat it hits. */
  const [instruction, setInstruction] = useState('');
  const [sending, setSending] = useState(false);
  const send = async (): Promise<void> => {
    const text = instruction.trim();
    if (employeeId === '') return;
    if (text === '') { control.setFeedback({ kind: 'error', title: t('feedback.instructionEmpty'), detail: t('agents.instructionEmptyDetail') }); return; }
    setSending(true);
    try {
      const sent = await control.run(instructAgent(ctxOf(control), employeeId, text), t('feedback.instructionSent', { agent: agentLabel(control, agent) }));
      if (sent) setInstruction('');
    } finally { setSending(false); }
  };
  return <Panel title={t('agents.detail.panel')} actions={<button type="button" className="link" onClick={onClose}>{t('agents.action.close')}</button>}>
    <div className="record-head">
      <AgentAvatar name={orMissing(textOf(agent['name']))} positionId={readString(agent['positionId'], '')} positionTitle={textOf(agent['position'])} status={avatarStatusOf(stateKind)} kind={textOf(agent['kind'])} />
      <div className="record-identity">
        <b>{orMissing(textOf(agent['name']))}</b>
        <span>{orMissing(placed)}</span>
      </div>
      <StatusPill value={pillKindOf(stateKind)} label={agentPillLabel(pillKindOf(stateKind), i18n)} />
    </div>

    <DetailSection title={t('agents.detail.section.identity')}>
      <DetailItem label={t('agents.detail.name')}>{orMissing(textOf(agent['name']))}</DetailItem>
      <DetailItem label={t('agents.detail.employeeId')}>{orMissing(employeeId)}</DetailItem>
      <DetailItem label={t('agents.detail.employeeNo')}>{orMissing(textOf(employee?.['employeeNo']))}</DetailItem>
      <DetailItem label={t('agents.detail.kind')}>{kindLabel(textOf(agent['kind']), i18n)}</DetailItem>
      <DetailItem label={t('agents.detail.position')}>{orMissing(textOf(agent['position']))}</DetailItem>
      <DetailItem label={t('agents.detail.capabilities')}>{capabilities.length === 0 ? t('agents.detail.none') : <ul className="chip-list">{capabilities.map((capability) => <li key={capability}>{capabilityLabel(capability, t)}</li>)}</ul>}</DetailItem>
      <DetailItem label={t('agents.detail.expertise')}>{expertise.length === 0 ? t('agents.detail.none') : <ul className="chip-list">{expertise.map((tag) => <li key={tag}>{capabilityLabel(tag, t)}</li>)}</ul>}</DetailItem>
      <DetailItem label={t('agents.detail.department')}>{orMissing(departmentName(snapshot.departments, readString(agent['departmentId'], '')))}</DetailItem>
    </DetailSection>

    <DetailSection title={t('agents.detail.section.placement')}>
      <DetailItem label={t('agents.detail.departmentHead')}>{orMissing(departmentHeadOf(snapshot.departments, snapshot.positions, snapshot.employees, readString(agent['departmentId'], '')))}</DetailItem>
      <DetailItem label={t('agents.detail.manager')}>{readString(agent['managerEmployeeId'], '') === '' ? t('common.unassigned') : employeeLabel(snapshot.employees, snapshot.positions, readString(agent['managerEmployeeId'], ''))}</DetailItem>
      <DetailItem label={t('agents.detail.reports')}>{peopleLine(reportsOf(snapshot.employees, employeeId), snapshot.employees, snapshot.positions, t('agents.detail.none'))}</DetailItem>
      <DetailItem label={t('agents.detail.peers')}>{peopleLine(peersOf(onDuty, agent), snapshot.employees, snapshot.positions, t('agents.detail.none'))}</DetailItem>
      <DetailItem label={t('agents.detail.colleagues')}>{peopleLine(colleaguesOf(onDuty, agent), snapshot.employees, snapshot.positions, t('agents.detail.none'))}</DetailItem>
    </DetailSection>

    <DetailSection title={t('agents.detail.section.runtime')}>
      <DetailItem label={t('agents.detail.lifecycle')}><StatusPill value={lifecycle} label={lifecycleLabel(lifecycle, i18n)} /></DetailItem>
      <DetailItem label={t('agents.detail.employment')}>{orMissing(i18n.status(textOf(agent['status'])))}</DetailItem>
      <DetailItem label={t('agents.detail.presence')}>{orMissing(i18n.presence(textOf(agent['presence'])))}</DetailItem>
      <DetailItem label={t('agents.detail.paused')}>{agent['paused'] === true ? t('agents.detail.yes') : t('agents.detail.no')}</DetailItem>
      <DetailItem label={t('agents.detail.cycle')}>{orMissing(textOf(runtime?.['currentCycleId']))}</DetailItem>
      <DetailItem label={t('agents.detail.focus')}>{orMissing(focusRef(runtime))}</DetailItem>
      <DetailItem label={t('agents.detail.updatedAt')}>{runtime === null ? MISSING : `t${String(readNumber(runtime['updatedAtSim']))}`}</DetailItem>
    </DetailSection>

    <DetailSection title={t('agents.detail.currentWork')}>
      <DetailItem label={t('agents.detail.task')}>{task === null ? t('status.available') : readString(task['title'], MISSING)}</DetailItem>
      <DetailItem label={t('agents.detail.taskStatus')}>{task === null ? MISSING : <StatusPill value={readString(task['status'], '')} />}</DetailItem>
      <DetailItem label={t('agents.detail.workflow')}>{workflow === null ? MISSING : readString(workflow['title'], MISSING)}</DetailItem>
      <DetailItem label={t('agents.detail.workflowStatus')}>{workflow === null ? MISSING : <StatusPill value={readString(workflow['status'], '')} />}</DetailItem>
    </DetailSection>

    <div className="detail-block record-advanced">
      <span className="field-label">{t('agents.detail.section.advanced')}</span>
      <b className="advanced-heading">{t('agents.detail.diagnostic')}</b>
      <p className="muted">{t('agents.detail.diagnosticHint')}</p>
      <Field label={t('agents.mandate.instruction')}>
        <textarea rows={3} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={t('agents.mandate.instructionPlaceholder')} />
      </Field>
      <div className="button-row"><Submit busy={sending} disabled={employeeId === ''} onClick={() => void send()}>{t('agents.mandate.send')}</Submit></div>
    </div>

    <div className="detail-block record-history"><span className="field-label">{t('agents.detail.history')}</span>{history.length === 0 ? <p className="muted">{t('agents.detail.noHistory')}</p> : history.map((event) => <EventLine key={readString(event['eventId'], String(event['seq']))} title={readString(event['type'])} detail={eventDetail(event)} />)}</div>
  </Panel>;
}

export function AgentsPage({ control }: { control: ConsoleControl }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { snapshot } = control;
  const events = useJson('/api/events?limit=80', parseRows, control.refreshToken);
  const workflows = useJson('/api/workflows', parseRows, control.refreshToken);
  const briefs = useJson('/api/work-briefs', parseWorkBriefs, control.refreshToken);
  // A5: an approved hiring request is how a seat became staffed — the same roster below already
  // shows the new person; this is only the sentence that says they arrived.
  const joined = hiringRequests(workflows.data ?? [], briefs.data ?? []).filter((request) => request.status === 'approved');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [name, setName] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [positionId, setPositionId] = useState('');
  const [positionMode, setPositionMode] = useState<'existing' | 'new'>('existing');
  const [newDepartmentId, setNewDepartmentId] = useState('');
  const [newPositionTitle, setNewPositionTitle] = useState('');
  const [newCapabilities, setNewCapabilities] = useState<readonly string[]>([]);
  const [employeeNo, setEmployeeNo] = useState('');
  const [responsibilities, setResponsibilities] = useState('');
  const [traits, setTraits] = useState('');
  const [templateEmployeeId, setTemplateEmployeeId] = useState('');
  const [creating, setCreating] = useState(false);

  const rows: readonly Row[] = snapshot.agents.map((agent) => {
    const id = readString(agent['employeeId'], '');
    const taskId = readString(agent['currentTaskId'], '');
    const task = taskId === '' ? null : taskById(snapshot.tasks, taskId);
    const state = agentState(agent);
    const activity = lastActivity(events.data ?? [], id);
    return { ...agent, position: positionTitle(snapshot.positions, readString(agent['positionId'], '')), capabilities: positionCapabilities(snapshot.positions, readString(agent['positionId'], '')), state: agentStateLabel(state, task === null ? '' : readString(task['title'], ''), i18n), stateKind: state.kind, lifecycle: readString(agent['lifecycle'], 'active'), task: task === null ? '' : readString(task['title'], ''), lastActivity: activity === null ? '' : readString(activity['type'], '') };
  });
  const onDuty = rows.filter((row) => !isArchivedAgent(row));
  const archived = rows.filter(isArchivedAgent);
  /** Every seat the chart declares — the team panel shows these alongside the people holding one. */
  const vacancies = vacantPositions(snapshot.positions, snapshot.employees);
  const detail = detailId === null ? null : rows.find((row) => readString(row['employeeId'], '') === detailId) ?? null;
  const archiveRow = archiveTarget === null ? null : rows.find((row) => readString(row['employeeId'], '') === archiveTarget) ?? null;
  const detailHistory = detail === null ? [] : (events.data ?? []).filter((event) => readString(event['subjectId'], '') === readString(detail['employeeId'], '')).slice(0, 6);
  const templateOptions = snapshot.agents.filter((agent) => !isArchivedAgent(agent)).map((agent) => ({ id: readString(agent['employeeId'], ''), label: `${positionTitle(snapshot.positions, readString(agent['positionId'], ''))} · ${readString(agent['name'], '')}` }));
  const positionOptions = snapshot.positions.map((position) => { const id = readString(position['positionId'], ''); const label = readString(position['title'], id); const staff = Array.isArray(position['employeeIds']) ? (position['employeeIds'] as readonly unknown[]).length : 0; return { id, label: staff === 0 ? t('tasks.create.unstaffed', { name: label }) : label }; });
  /** Filling a vacancy is hiring into a seat that already exists: pre-fill, then come here. */
  const startHire = (targetPositionId: string): void => {
    setPositionMode('existing');
    setPositionId(targetPositionId);
    document.getElementById('create-agent')?.scrollIntoView({ behavior: 'smooth' });
  };

  const changeName = (value: string): void => { setName(value); if (!idEdited) setEmployeeId(slugify(value)); };
  const togglePaused = async (agent: Row): Promise<void> => {
    const id = readString(agent['employeeId'], '');
    if (id === '') return;
    const paused = agent['paused'] === true;
    const label = agentLabel(control, agent);
    await control.run(setAgentPaused(ctxOf(control), id, !paused), paused ? t('feedback.agentResumed', { agent: label }) : t('feedback.agentPaused', { agent: label }));
  };
  const submitAgent = async (): Promise<void> => {
    const agentName = name.trim();
    const agentId = employeeId.trim();
    const mandates = linesOf(responsibilities);
    const isNewPosition = positionMode === 'new';
    const positionTitleTyped = newPositionTitle.trim();
    const positionKey = isNewPosition ? slugify(positionTitleTyped) : positionId;
    if (agentName === '' || agentId === '' || positionKey === '' || mandates.length === 0) {
      control.setFeedback({ kind: 'error', title: t('agents.create.required'), detail: t('agents.create.requiredDetail') });
      return;
    }
    if (isNewPosition && (newDepartmentId === '' || positionTitleTyped === '' || newCapabilities.length === 0)) {
      control.setFeedback({ kind: 'error', title: t('agents.create.newPositionRequired'), detail: t('agents.create.newPositionRequiredDetail') });
      return;
    }
    setCreating(true);
    try {
      const created = await control.run(
        createAgent(ctxOf(control), {
          employeeId: agentId,
          name: agentName,
          positionId: positionKey,
          employeeNo: employeeNo.trim(),
          responsibilities: mandates,
          traits: listOf(traits),
          cognitionProfileId: '',
          templateEmployeeId,
          ...(isNewPosition
            ? { newPosition: { departmentId: newDepartmentId, title: positionTitleTyped, capabilities: newCapabilities } }
            : {}),
        }),
        t('feedback.agentCreated', { agent: `${isNewPosition ? positionTitleTyped : positionTitle(snapshot.positions, positionKey)} ${agentName}` }),
      );
      if (created) {
        setName(''); setEmployeeId(''); setIdEdited(false); setEmployeeNo(''); setResponsibilities(''); setTraits(''); setTemplateEmployeeId('');
        setPositionMode('existing'); setPositionId(''); setNewDepartmentId(''); setNewPositionTitle(''); setNewCapabilities([]);
      }
    } finally { setCreating(false); }
  };
  const confirmArchive = async (): Promise<void> => {
    if (archiveRow === null) return;
    const id = readString(archiveRow['employeeId'], '');
    const reason = archiveReason.trim() === '' ? t('agents.archive.reasonDefault') : archiveReason.trim();
    const archivedOk = await control.run(archiveAgent(ctxOf(control), id, reason), t('feedback.agentArchived', { agent: readString(archiveRow['name'], id) }));
    if (archivedOk) { setArchiveTarget(null); setArchiveReason(''); if (detailId === id) setDetailId(id); }
  };
  const working = onDuty.filter((row) => readString(row['stateKind'], '') === 'working').length;
  const paused = onDuty.filter((row) => row['paused'] === true).length;
  return <div className="stack">
    <PageIntro eyebrow={t('agents.eyebrow')} title={t('page.agents.label')} description={t('agents.description')} actions={<span className="page-count">{t('agents.pageCount', { onDuty: onDuty.length, working })}</span>} />
    {joined.length > 0 && <div className="notice hiring-join" role="status">{joined.map((request) => <span key={request.instanceId}>{t('hiring.joined.line', { seat: request.seatTitle })}</span>)}</div>}
    <div className="stat-grid agent-stats"><StatCard label={t('agents.stat.onDuty')} value={onDuty.length} detail={t('agents.stat.onDutyDetail')} tone="green" /><StatCard label={t('agents.stat.workingNow')} value={working} detail={t('agents.stat.workingNowDetail')} tone="blue" /><StatCard label={t('agents.stat.paused')} value={paused} detail={t('agents.stat.pausedDetail')} tone="amber" /><StatCard label={t('agents.stat.archived')} value={archived.length} detail={t('agents.stat.archivedDetail')} tone="neutral" /></div>

    <Panel title={t('agents.create.panel')} actions={<span className="muted">{t('agents.create.hint')}</span>}>
      <div id="create-agent" className="form-grid agent-form">
        <Field label={t('agents.create.name')}><input value={name} onChange={(event) => changeName(event.target.value)} placeholder={t('agents.create.namePlaceholder')} /></Field>
        <Field label={t('agents.create.employeeId')} hint={t('agents.create.employeeIdHint')}><input value={employeeId} onChange={(event) => { setIdEdited(true); setEmployeeId(event.target.value); }} /></Field>
        <Field label={t('agents.create.position')}>
          <select value={positionMode === 'new' ? NEW_POSITION : positionId} onChange={(event) => {
            if (event.target.value === NEW_POSITION) { setPositionMode('new'); setPositionId(''); return; }
            setPositionMode('existing'); setPositionId(event.target.value);
          }}>
            <option value="">{t('common.selectPosition')}</option>
            <option value={NEW_POSITION}>{t('agents.create.positionNew')}</option>
            {positionOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </Field>
        {positionMode === 'new' && <>
          <Field label={t('agents.create.department')}>
            <select value={newDepartmentId} onChange={(event) => setNewDepartmentId(event.target.value)}>
              <option value="">{t('agents.create.selectDepartment')}</option>
              {snapshot.departments.map((department) => <option key={readString(department['departmentId'], '')} value={readString(department['departmentId'], '')}>{readString(department['name'], '')}</option>)}
            </select>
          </Field>
          <Field label={t('agents.create.positionTitle')} hint={t('agents.create.positionTitleHint')}>
            <input value={newPositionTitle} onChange={(event) => setNewPositionTitle(event.target.value)} placeholder={t('agents.create.positionTitlePlaceholder')} />
          </Field>
          <Field label={t('agents.create.capabilities')} hint={t('agents.create.capabilitiesHint')}>
            <div className="capability-row">
              {CAPABILITY_IDS.map((capability) => (
                <label key={capability}>
                  <input
                    type="checkbox"
                    checked={newCapabilities.includes(capability)}
                    onChange={(event) => setNewCapabilities(event.target.checked ? [...newCapabilities, capability] : newCapabilities.filter((entry) => entry !== capability))}
                  />
                  {capabilityLabel(capability, t)}
                </label>
              ))}
            </div>
          </Field>
        </>}
        <Field label={t('agents.create.employeeNo')}><input value={employeeNo} onChange={(event) => setEmployeeNo(event.target.value)} placeholder={t('agents.create.employeeNoPlaceholder')} /></Field>
        <Field label={t('agents.create.responsibilities')} hint={t('agents.create.responsibilitiesHint')}><textarea rows={3} value={responsibilities} onChange={(event) => setResponsibilities(event.target.value)} placeholder={t('agents.create.responsibilitiesPlaceholder')} /></Field>
        <Field label={t('agents.create.traits')}><input value={traits} onChange={(event) => setTraits(event.target.value)} placeholder={t('agents.create.traitsPlaceholder')} /></Field>
        <Field label={t('agents.create.template')} hint={t('agents.create.templateHint')}><select value={templateEmployeeId} onChange={(event) => setTemplateEmployeeId(event.target.value)}><option value="">{t('agents.create.templateAuto')}</option>{templateOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></Field>
        <div className="button-row"><Submit busy={creating} onClick={() => void submitAgent()}>{t('agents.create.submit')}</Submit></div>
      </div>
    </Panel>

    {detail !== null && <AgentRecord control={control} agent={detail} history={detailHistory} onClose={() => setDetailId(null)} />}

    {archiveRow !== null && <Panel title={t('agents.archive.panel')} actions={<span className="muted">{readString(archiveRow['name'], '')}</span>}>
      <div className="archive-row">
        <p className="muted">{t('agents.archive.hint')}</p>
        <Field label={t('agents.archive.reason')}><input value={archiveReason} onChange={(event) => setArchiveReason(event.target.value)} placeholder={t('agents.archive.reasonPlaceholder')} /></Field>
        <div className="button-row"><button type="button" className="primary" onClick={() => void confirmArchive()}>{t('agents.archive.confirm')}</button><button type="button" onClick={() => { setArchiveTarget(null); setArchiveReason(''); }}>{t('common.cancel')}</button></div>
      </div>
    </Panel>}

    <Panel title={t('agents.team.panel')} actions={<span className="muted">{t('agents.team.coverage', { staffed: onDuty.length, total: onDuty.length + vacancies.length })}</span>}>
      {onDuty.length === 0 && vacancies.length === 0 ? <Empty title={t('common.noAgentsOnDuty')} hint={t('common.noAgentsHint')} /> : <div className="people-grid">{onDuty.map((row) => { const id = readString(row['employeeId'], ''); const kind = readString(row['stateKind'], 'idle'); const pillKind = kind === 'paused' ? 'paused' : kind === 'working' ? 'working' : 'idle'; const self = id === OPERATOR.operatorId; const hasWork = readString(row['currentTaskId'], '') !== ''; const capabilities = Array.isArray(row['capabilities']) ? (row['capabilities'] as readonly string[]) : []; const expertise = expertiseOf(row); return <article className="person-card" key={id}><div className="person-top"><AgentAvatar name={readString(row['name'], t('common.agentFallback'))} positionId={readString(row['positionId'], '')} positionTitle={readString(row['position'], '')} status={avatarStatusOf(kind)} kind={readString(row['kind'], '')} /><div className="person-identity"><h3>{readString(row['name'], t('common.agentFallback'))}</h3><span>{readString(row['position'], t('common.agentFallback'))}</span></div><StatusPill value={pillKind} label={agentPillLabel(pillKind, i18n)} /></div><div className="person-work"><span className="field-label">{t('agents.person.currentWork')}</span><b>{readString(row['task'], '') === '' ? t('status.available') : readString(row['task'])}</b></div>{capabilities.length > 0 && <ul className="chip-list person-capabilities">{capabilities.map((capability) => <li key={capability}>{capabilityLabel(capability, t)}</li>)}</ul>}{expertise.length > 0 && <div className="person-expertise"><span className="field-label">{t('agents.person.expertise')}</span><ul className="chip-list">{expertise.map((tag) => <li key={tag}>{capabilityLabel(tag, t)}</li>)}</ul></div>}<div className="person-meta"><span>{t('agents.person.lastActivity')}</span><b>{readString(row['lastActivity'], t('common.noActivityShort'))}</b></div><div className="person-actions"><button type="button" onClick={() => void togglePaused(row)}>{row['paused'] === true ? t('common.resume') : t('common.pause')}</button><button type="button" className="primary" onClick={() => setDetailId(id)}>{t('agents.action.details')}</button><button type="button" disabled={self || hasWork} title={self ? t('agents.archive.self') : hasWork ? t('agents.archive.blockedRunning') : t('agents.archive.open')} onClick={() => { setArchiveTarget(id); setArchiveReason(''); }}>{t('agents.action.archive')}</button></div></article>; })}{vacancies.map((position) => { const id = readString(position['positionId'], ''); const title = readString(position['title'], id); const capabilities = positionCapabilities(snapshot.positions, id); const department = departmentName(snapshot.departments, readString(position['departmentId'], '')); return <article className="person-card vacancy-card" key={`vacancy-${id}`}><div className="person-top"><AgentAvatar positionId={id} positionTitle={title} capabilities={capabilities} status="vacant" /><div className="person-identity"><h3>{title}</h3><span>{department === '' ? t('agents.person.vacant') : department}</span></div><StatusPill value="vacant" label={t('agents.person.vacant')} /></div><div className="person-work"><span className="field-label">{t('agents.person.currentWork')}</span><b>{t('agents.person.noHolder')}</b></div>{capabilities.length > 0 && <ul className="chip-list person-capabilities">{capabilities.map((capability) => <li key={capability}>{capabilityLabel(capability, t)}</li>)}</ul>}<div className="person-actions"><button type="button" className="primary" onClick={() => startHire(id)}>{t('agents.person.hire')}</button></div></article>; })}</div>}
    </Panel>

    <Panel title={t('agents.archived.panel')} actions={<span className="muted">{t('agents.archived.hint')}</span>}>
      {archived.length === 0 ? <Empty title={t('agents.archived.empty')} hint={t('agents.archived.retained')} /> : <div className="archived-list">{archived.map((row) => { const id = readString(row['employeeId'], ''); return <div className="archived-row" key={id}><AgentAvatar name={readString(row['name'], t('common.agentFallback'))} positionId={readString(row['positionId'], '')} positionTitle={readString(row['position'], '')} status="archived" kind={readString(row['kind'], '')} /><div><b>{readString(row['name'], t('common.agentFallback'))}</b><span>{readString(row['position'], '')} · {readString(row['employeeId'], '')}</span></div><StatusPill value="archived" label={i18n.t('status.archived')} /><button type="button" className="link" onClick={() => setDetailId(id)}>{t('agents.action.details')}</button></div>; })}</div>}
    </Panel>

    <Panel title={t('agents.activity.panel')} actions={<button type="button" className="link" onClick={() => control.navigate('Events')}>{t('agents.activity.viewAll')}</button>}>
      {(events.data ?? []).length === 0 ? <Empty title={t('agents.activity.empty')} hint={t('agents.activity.emptyHint')} /> : (events.data ?? []).slice(0, 12).map((event) => <EventLine key={readString(event['eventId'], String(event['seq']))} title={readString(event['type'])} detail={eventDetail(event)} />)}
    </Panel>
  </div>;
}
