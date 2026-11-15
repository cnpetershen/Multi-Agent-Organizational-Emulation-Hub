import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { parseRows } from '../api';
import {
  buildAssignmentGraph,
  groupEmployeesByDepartment,
  groupSeatsByDepartment,
  parseAssignmentEmployees,
  parseAssignmentInstances,
  parseAssignmentSeats,
  type AssignmentEmployee,
  type AssignmentNode,
  type AssignmentSeat,
} from '../assignment-canvas';
import {
  workflowAssignmentOverride,
  workflowConfirmStart,
  workflowDecision,
  type CommandContext,
} from '../commands';
import { AgentAvatar, PageIntro, StatusPill } from '../components';
import type { ConsoleControl } from '../control';
import { statusLabel, workflowStatus } from '../status';
import { useJson } from '../hooks';
import { useI18n } from '../i18n';

/**
 * The orchestration canvas (M2.2 approval-gate pass).
 *
 * The command path is unchanged: a CEO-generated workflow is a draft; a human confirms it here,
 * and any not-yet-entered task step can be pinned to a named employee. What changed is *when*
 * the intent is admitted: dragging a person or an open seat onto a node opens an approval gate
 * in the node inspector. Only approving that gate stages the pin; the kernel still re-checks
 * everything when the staged changes are committed.
 *
 * The surface is a dark studio with the team and the open seats on the left, a pannable and
 * zoomable node graph in the middle, and the node inspector (with the gate) on the right.
 */

const EXECUTABLE_STATUSES = new Set(['defined', 'onboarding', 'active', 'on_leave']);
/** The drag payload prefix that distinguishes a seat (position) from an employee id. */
const SEAT_PREFIX = 'seat:';
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 1.6;

type AssignmentGate =
  | { readonly kind: 'employee'; readonly stepId: string; readonly employeeId: string }
  | { readonly kind: 'seat'; readonly stepId: string; readonly positionId: string };

function ctxOf(control: ConsoleControl): CommandContext {
  return { companyId: control.companyId, simTime: control.simTime };
}

function nodeGlyph(kind: string): string {
  if (kind === 'approval') return '✓';
  if (kind === 'task') return '◈';
  return '▣';
}

function nodeTone(status: string, draft: boolean): string {
  const code = status.trim().toLowerCase();
  if (draft) return 'warn';
  if (code === 'done' || code === 'completed') return 'ok';
  if (code === 'active' || code === 'running') return 'info';
  if (code === 'rejected' || code === 'blocked' || code === 'failed') return 'bad';
  return 'muted';
}

function matchesSearch(values: readonly string[], needle: string): boolean {
  if (needle === '') return true;
  return values.some((value) => value.toLowerCase().includes(needle));
}

function EmployeeCard({
  employee,
  chosen,
  onChoose,
  onDragStart,
  label,
}: {
  readonly employee: AssignmentEmployee;
  readonly chosen: boolean;
  readonly onChoose: () => void;
  readonly onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  readonly label: string;
}) {
  return (
    <button
      type="button"
      draggable
      className={`assignment-agent${chosen ? ' chosen' : ''}`}
      onDragStart={onDragStart}
      onClick={onChoose}
      title={`${employee.name} · ${employee.positionTitle}${employee.capabilities.length === 0 ? '' : ` · ${employee.capabilities.join(', ')}`}`}
    >
      <AgentAvatar name={employee.name} positionId={employee.positionId} positionTitle={employee.positionTitle} capabilities={employee.capabilities} kind={employee.kind} status={employee.status === 'on_leave' ? 'paused' : 'idle'} />
      <span className="assignment-agent-body">
        <b>{employee.name}</b>
        <small>{employee.positionTitle}{employee.departmentName === undefined || employee.departmentName === '' ? '' : ` · ${employee.departmentName}`}</small>
        <span className="assignment-caps">
          {employee.capabilities.length === 0
            ? <em>{label}</em>
            : employee.capabilities.slice(0, 2).map((capability) => <em key={capability}>{capability}</em>)}
        </span>
      </span>
      <span className="assignment-drag" aria-hidden="true">⠿</span>
    </button>
  );
}

function SeatCard({
  seat,
  chosen,
  onChoose,
  onDragStart,
  labels,
}: {
  readonly seat: AssignmentSeat;
  readonly chosen: boolean;
  readonly onChoose: () => void;
  readonly onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  readonly labels: { readonly vacant: string; readonly noCapability: string };
}) {
  return (
    <button
      type="button"
      draggable
      className={`assignment-seat${chosen ? ' chosen' : ''}`}
      onDragStart={onDragStart}
      onClick={onChoose}
      title={`${seat.title} · ${seat.departmentName}${seat.capabilities.length === 0 ? '' : ` · ${seat.capabilities.join(', ')}`}`}
    >
      <span className="assignment-seat-mark" aria-hidden="true">◇</span>
      <span className="assignment-agent-body">
        <b>{seat.title}</b>
        <small>{seat.departmentName}</small>
        <span className="assignment-caps">
          <em className="vacant">{labels.vacant}</em>
          {seat.capabilities.length === 0
            ? <em>{labels.noCapability}</em>
            : seat.capabilities.slice(0, 2).map((capability) => <em key={capability}>{capability}</em>)}
        </span>
      </span>
      <span className="assignment-drag" aria-hidden="true">⠿</span>
    </button>
  );
}

function StepNode({
  node,
  employee,
  selected,
  gated,
  dragOver,
  hasSod,
  chosenEmployeeId,
  chosenSeatId,
  onActivate,
  onDrop,
  onDragOver,
  onDragLeave,
}: {
  readonly node: AssignmentNode;
  readonly employee: AssignmentEmployee | null;
  readonly selected: boolean;
  readonly gated: boolean;
  readonly dragOver: boolean;
  readonly hasSod: boolean;
  readonly chosenEmployeeId: string | null;
  readonly chosenSeatId: string | null;
  readonly onActivate: () => void;
  readonly onDrop: (event: DragEvent<HTMLDivElement>) => void;
  readonly onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  readonly onDragLeave: () => void;
}) {
  const { t, status } = useI18n();
  const tone = nodeTone(node.step.status, node.tone === 'warn');
  const ready = node.adjustable && (chosenEmployeeId !== null || chosenSeatId !== null);
  return (
    <div
      className={`assignment-node tone-${tone}${selected ? ' selected' : ''}${node.adjustable ? ' editable' : ''}${dragOver ? ' drop-target' : ''}${gated ? ' gated' : ''}${ready ? ' ready' : ''}`}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
      data-status={node.step.status}
      data-kind={node.step.kind}
      role={node.adjustable ? 'button' : undefined}
      tabIndex={node.adjustable ? 0 : undefined}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="assignment-node-head">
        <span className="assignment-node-icon" data-kind={node.step.kind}>{nodeGlyph(node.step.kind)}</span>
        <div className="assignment-node-title">
          <b>{node.step.name}</b>
          <small>{node.step.stageName} · {status(node.step.status)}</small>
        </div>
        <span className="assignment-node-status" data-tone={tone}>{status(node.step.status)}</span>
      </div>
      <div className="assignment-node-body">
        {employee === null ? (
          <span className="assignment-node-unassigned">{t('canvas.unresolved')}</span>
        ) : (
          <span className="assignment-node-person">
            <AgentAvatar name={employee.name} positionId={employee.positionId} positionTitle={employee.positionTitle} capabilities={employee.capabilities} kind={employee.kind} status={employee.status === 'on_leave' ? 'paused' : 'idle'} size="xs" />
            <b>{employee.name}</b>
            <small>{employee.positionTitle}</small>
          </span>
        )}
        {node.step.capability !== null && <span className="assignment-node-cap">{node.step.capability}</span>}
        {node.staged && <span className="assignment-badge staged">{t('canvas.staged')}</span>}
        {!node.staged && node.step.overridden && <span className="assignment-badge pinned">{t('canvas.pinned')}</span>}
        {hasSod && <span className="assignment-badge sod">SoD</span>}
      </div>
      {node.adjustable ? (
        <span className="assignment-drop-hint">
          {dragOver ? t('canvas.dropNow') : ready ? t('canvas.gate.clickToOpen') : t('canvas.dropHere')}
        </span>
      ) : node.step.kind === 'task' ? (
        <span className="assignment-node-lock">{t('canvas.locked', { status: status(node.step.status) })}</span>
      ) : null}
    </div>
  );
}

export function WorkflowCanvasPage({ control }: { control: ConsoleControl }) {
  const i18n = useI18n();
  const { t } = i18n;
  const { snapshot } = control;
  const workflows = useJson('/api/workflows', parseRows, control.refreshToken);

  const instances = useMemo(
    () => parseAssignmentInstances(workflows.data ?? snapshot.workflows),
    [workflows.data, snapshot.workflows],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [staging, setStaging] = useState<Readonly<Record<string, string>>>({});
  const [reason, setReason] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [dragOverStep, setDragOverStep] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [chosenSeat, setChosenSeat] = useState<string | null>(null);
  const [gate, setGate] = useState<AssignmentGate | null>(null);
  const [gateCandidate, setGateCandidate] = useState('');
  const [search, setSearch] = useState('');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ readonly x: number; readonly y: number; readonly panX: number; readonly panY: number } | null>(null);
  const movedRef = useRef(false);

  const selected = instances.find((entry) => entry.instanceId === selectedId) ?? instances[0] ?? null;

  // A different instance means a different graph, gate, staging area and viewport.
  useEffect(() => {
    setStaging({});
    setReason('');
    setRefusal(null);
    setReviewing(false);
    setDragOverStep(null);
    setChosen(null);
    setChosenSeat(null);
    setGate(null);
    setGateCandidate('');
    setSelectedStepId(null);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [selected?.instanceId]);

  const employees = useMemo(
    () => parseAssignmentEmployees(snapshot.employees, snapshot.positions, snapshot.departments)
      .filter((employee) => EXECUTABLE_STATUSES.has(employee.status)),
    [snapshot.employees, snapshot.positions, snapshot.departments],
  );
  const employeeById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee])), [employees]);
  const seats = useMemo(
    () => parseAssignmentSeats(snapshot.positions, snapshot.employees, snapshot.departments),
    [snapshot.positions, snapshot.employees, snapshot.departments],
  );
  const seatById = useMemo(() => new Map(seats.map((seat) => [seat.positionId, seat])), [seats]);
  const vacantSeats = useMemo(() => seats.filter((seat) => seat.vacant), [seats]);
  const departmentSeats = useMemo(() => groupSeatsByDepartment(seats), [seats]);

  const needle = search.trim().toLowerCase();
  const visibleEmployees = useMemo(
    () => employees.filter((employee) =>
      matchesSearch([employee.name, employee.positionTitle, employee.departmentName ?? '', ...employee.capabilities], needle)),
    [employees, needle],
  );
  const teamGroups = useMemo(() => groupEmployeesByDepartment(visibleEmployees), [visibleEmployees]);
  const visibleVacancies = useMemo(
    () => vacantSeats.filter((seat) => matchesSearch([seat.title, seat.departmentName, ...seat.capabilities], needle)),
    [vacantSeats, needle],
  );
  const vacancyGroups = useMemo(() => groupSeatsByDepartment(visibleVacancies), [visibleVacancies]);

  const graph = useMemo(
    () => selected === null ? null : buildAssignmentGraph(selected, { staging, selectedStepId }),
    [selected, staging, selectedStepId],
  );
  const activeNode = graph === null
    ? null
    : graph.nodes.find((node) => node.step.stepId === graph.selectedStepId) ?? graph.nodes[0] ?? null;

  const effectiveOf = (node: AssignmentNode): AssignmentEmployee | null =>
    node.effectiveEmployeeId === null ? null : employeeById.get(node.effectiveEmployeeId) ?? null;

  const sodWarnings = useMemo(() => {
    const byEmployee = new Map<string, string[]>();
    for (const node of graph?.nodes ?? []) {
      if (node.effectiveEmployeeId === null) continue;
      const list = byEmployee.get(node.effectiveEmployeeId) ?? [];
      list.push(node.step.stepId);
      byEmployee.set(node.effectiveEmployeeId, list);
    }
    return new Map([...byEmployee.entries()].filter(([, stepIds]) => stepIds.length > 1));
  }, [graph]);

  const gateStep = gate === null ? null : selected?.steps.find((step) => step.stepId === gate.stepId) ?? null;
  const gateSeat = gate?.kind === 'seat' ? seatById.get(gate.positionId) ?? null : null;
  const gateEmployee = gate?.kind === 'employee' ? employeeById.get(gate.employeeId) ?? null : null;
  /**
   * A vacant seat cannot be written as an override. Offer the teammates who already declare a
   * matching capability first, then the rest of the roster; hiring is the other way out.
   */
  const gateCandidates = useMemo(() => {
    if (gate === null || gate.kind !== 'seat') return [];
    const wanted = new Set([
      ...(gateSeat?.capabilities ?? []),
      ...(gateStep?.capability === null || gateStep?.capability === undefined ? [] : [gateStep.capability]),
    ]);
    return [...employees].sort((left, right) => {
      const leftMatch = left.capabilities.some((capability) => wanted.has(capability)) ? 0 : 1;
      const rightMatch = right.capabilities.some((capability) => wanted.has(capability)) ? 0 : 1;
      return leftMatch - rightMatch || left.name.localeCompare(right.name);
    });
  }, [employees, gate, gateSeat, gateStep]);
  const candidateId = gateCandidate !== ''
    ? gateCandidate
    : gateCandidates[0]?.id ?? '';

  const stageEntries = Object.entries(staging);
  const stagedCount = stageEntries.length;
  const sodCount = sodWarnings.size;

  const stageStep = (stepId: string, employeeId: string): void => {
    const step = selected?.steps.find((entry) => entry.stepId === stepId) ?? null;
    if (step === null || step.kind !== 'task' || step.status !== 'pending') return;
    setStaging((current) => ({ ...current, [stepId]: employeeId }));
    setRefusal(null);
    setSelectedStepId(stepId);
  };

  const unstageStep = (stepId: string): void => {
    setStaging((current) => {
      const next = { ...current };
      delete next[stepId];
      return next;
    });
  };

  const openEmployeeGate = (stepId: string, employeeId: string): void => {
    const step = selected?.steps.find((entry) => entry.stepId === stepId) ?? null;
    if (step === null || step.kind !== 'task' || step.status !== 'pending') return;
    if (!employeeById.has(employeeId)) return;
    setGate({ kind: 'employee', stepId, employeeId });
    setGateCandidate('');
    setSelectedStepId(stepId);
    setChosen(null);
    setChosenSeat(null);
  };

  const openSeatGate = (stepId: string, positionId: string): void => {
    const step = selected?.steps.find((entry) => entry.stepId === stepId) ?? null;
    if (step === null || step.kind !== 'task' || step.status !== 'pending') return;
    if (!seatById.has(positionId)) return;
    setGate({ kind: 'seat', stepId, positionId });
    setGateCandidate('');
    setSelectedStepId(stepId);
    setChosen(null);
    setChosenSeat(null);
  };

  const approveGate = (): void => {
    if (gate === null) return;
    if (gate.kind === 'employee') {
      stageStep(gate.stepId, gate.employeeId);
      setGate(null);
      return;
    }
    if (candidateId !== '') {
      stageStep(gate.stepId, candidateId);
      setGate(null);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>, node: AssignmentNode): void => {
    event.preventDefault();
    setDragOverStep(null);
    if (!node.adjustable) return;
    const payload = event.dataTransfer.getData('text/plain');
    if (payload.startsWith(SEAT_PREFIX)) openSeatGate(node.step.stepId, payload.slice(SEAT_PREFIX.length));
    else if (payload !== '') openEmployeeGate(node.step.stepId, payload);
    setChosen(null);
    setChosenSeat(null);
  };

  const activateNode = (node: AssignmentNode): void => {
    if (movedRef.current) {
      movedRef.current = false;
      return;
    }
    if (node.adjustable && chosenSeat !== null) openSeatGate(node.step.stepId, chosenSeat);
    else if (node.adjustable && chosen !== null) openEmployeeGate(node.step.stepId, chosen);
    else {
      setGate(null);
      setSelectedStepId(node.step.stepId);
    }
  };

  const reset = (): void => {
    setStaging({});
    setReason('');
    setRefusal(null);
  };

  const resetView = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const fitView = (): void => {
    const viewport = viewportRef.current;
    if (viewport === null || graph === null) return;
    const rect = viewport.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const next = Math.min((rect.width - 48) / graph.width, (rect.height - 48) / graph.height, 1.1);
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
    setPan({ x: 0, y: 0 });
  };

  const onViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    movedRef.current = false;
    if ((event.target as HTMLElement).closest('[data-assignment-node], button, select, input, textarea, .assignment-canvas-tools') !== null) return;
    dragRef.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onViewportPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true;
    setPan({ x: drag.panX + dx, y: drag.panY + dy });
  };

  const onViewportPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  // React's wheel listener is passive at the root, so `preventDefault` there would be ignored
  // and the page would scroll while zooming. A native non-passive listener owns the gesture.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      setZoom((value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value + (event.deltaY > 0 ? -0.08 : 0.08))));
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [selected?.instanceId]);

  const commitChanges = async (): Promise<void> => {
    if (selected === null || submitting) return;
    // M3.4: a planning draft is confirmed on the plan canvas, never here. This button used to
    // call `Workflow.ConfirmStart` (which enters stage 1 and creates tasks); for a planned draft
    // that is M3.5's "start execution", so it must not be reachable from M3.3/M3.4.
    if (selected.planned) {
      setReviewing(false);
      control.navigate('PlanCanvas');
      return;
    }
    if (stagedCount === 0 && !selected.draft) {
      setReviewing(false);
      return;
    }
    setSubmitting(true);
    setRefusal(null);
    try {
      if (stagedCount > 0) {
        const overrides = stageEntries.map(([stepId, employeeId]) => ({
          stepId,
          employeeId,
          ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
        }));
        const overrideOutcome = await control.runDetailed(
          workflowAssignmentOverride(
            ctxOf(control),
            selected.instanceId,
            overrides,
            reason.trim() === '' ? 'assignment override from the orchestration canvas' : reason.trim(),
            selected.eventCount,
          ),
          t('canvas.accepted'),
          null,
        );
        if (!overrideOutcome.ok) {
          setRefusal(overrideOutcome.failure ?? t('common.unknownError'));
          return;
        }
      }
      if (selected.draft) {
        const confirmOutcome = await control.runDetailed(
          workflowConfirmStart(
            ctxOf(control),
            selected.instanceId,
            reason.trim() === '' ? 'draft confirmed from the orchestration canvas' : reason.trim(),
          ),
          t('canvas.confirmed'),
          null,
        );
        if (!confirmOutcome.ok) {
          setRefusal(confirmOutcome.failure ?? t('common.unknownError'));
          return;
        }
      }
      setStaging({});
      setReason('');
      setRefusal(null);
      setReviewing(false);
    } finally {
      setSubmitting(false);
    }
  };

  const decideWorkflow = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (selected === null || deciding) return;
    setDeciding(true);
    try {
      const ok = await control.run(
        workflowDecision(
          ctxOf(control),
          selected.instanceId,
          decision,
          reason.trim() === '' ? `${decision} of ${selected.title} from the orchestration canvas` : reason.trim(),
        ),
        decision === 'approve'
          ? t('feedback.approved', { title: selected.title })
          : t('feedback.rejected', { title: selected.title }),
      );
      if (ok) {
        await control.releaseHold(true);
        setReason('');
      }
    } finally {
      setDeciding(false);
    }
  };

  const statusDisplay = selected === null ? null : workflowStatus(selected.status);
  const commitDisabled = submitting || (selected !== null && !selected.draft && stagedCount === 0);
  const activeEmployee = activeNode === null ? null : effectiveOf(activeNode);
  const activeSod = activeNode !== null && activeNode.effectiveEmployeeId !== null && sodWarnings.has(activeNode.effectiveEmployeeId);
  const workflowGateOpen = selected?.approval?.status === 'open';
  const gateSod = gateEmployee !== null && sodWarnings.has(gateEmployee.id);
  const staffedSeats = seats.length - vacantSeats.length;

  return (
    <div className="stack assignment-page">
      <PageIntro
        eyebrow={t('canvas.eyebrow')}
        title={t('canvas.title')}
        description={t('canvas.description')}
        actions={<span className="page-count">{t('canvas.pageCount', { count: instances.length })}</span>}
      />

      {workflows.status === 'failed' && workflows.data === null ? (
        <div className="assignment-empty">
          <span className="assignment-empty-icon">!</span>
          <b>{t('canvas.loadFailed')}</b>
          <p>{workflows.error ?? t('common.unknownError')}</p>
        </div>
      ) : selected === null || graph === null ? (
        <div className="assignment-empty">
          <span className="assignment-empty-icon">◇</span>
          <b>{t('canvas.noInstance')}</b>
          <p>{t('canvas.noInstanceHint')}</p>
        </div>
      ) : (
        <section className="assignment-studio">
          <header className="assignment-top">
            <div className="assignment-top-left">
              <span className="assignment-emblem" aria-hidden="true"><i /></span>
              <div>
                <span className="assignment-kicker">{t('canvas.studioKicker')}</span>
                <div className="assignment-title-row">
                  <h2>{selected.title}</h2>
                  {selected.draft && <span className="assignment-chip draft">{t('canvas.draftTag')}</span>}
                  {selected.paused === true && <span className="assignment-chip draft">{t('canvas.paused')}</span>}
                </div>
                <p>{selected.goal === '' ? t('common.noGoal') : selected.goal}</p>
              </div>
            </div>
            <div className="assignment-top-right">
              <label className="assignment-instance">
                <span>{t('canvas.instance')}</span>
                <select value={selected.instanceId} onChange={(event) => setSelectedId(event.target.value)}>
                  {instances.map((instance) => (
                    <option key={instance.instanceId} value={instance.instanceId}>
                      {instance.title}{instance.draft ? ` · ${t('canvas.draftTag')}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              {statusDisplay !== null && <StatusPill value={statusDisplay.tone} label={statusLabel(statusDisplay, i18n)} />}
            </div>
          </header>

          <div className="assignment-body">
            <div className="assignment-palette" role="region" aria-label={t('canvas.roster')}>
              <div className="assignment-palette-head">
                <div className="assignment-palette-label">
                  <span className="field-label">{t('canvas.roster')}</span>
                  <b>{employees.length}</b>
                </div>
                <div className="assignment-search">
                  <span aria-hidden="true">⌕</span>
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t('canvas.searchPlaceholder')}
                    aria-label={t('canvas.searchTeam')}
                  />
                </div>
                <p>{t('canvas.rosterHint')}</p>
              </div>
              <div className="assignment-team">
                {visibleVacancies.length > 0 && (
                  <section className="assignment-seat-section" aria-label={t('canvas.vacantSeats')}>
                    <header className="assignment-seat-head">
                      <span>{t('canvas.vacantSeats')}</span>
                      <b>{visibleVacancies.length}</b>
                    </header>
                    {vacancyGroups.map((group) => (
                      <div className="assignment-dept" key={group.departmentId === '' ? '__none' : group.departmentId}>
                        <span className="assignment-dept-label">{group.departmentName === '' ? t('canvas.noDepartment') : group.departmentName}</span>
                        {group.seats.map((seat) => (
                          <SeatCard
                            key={seat.positionId}
                            seat={seat}
                            chosen={chosenSeat === seat.positionId}
                            labels={{ vacant: t('canvas.vacantBadge'), noCapability: t('canvas.noCapability') }}
                            onChoose={() => {
                              setChosenSeat((current) => current === seat.positionId ? null : seat.positionId);
                              setChosen(null);
                            }}
                            onDragStart={(event) => {
                              event.dataTransfer.setData('text/plain', `${SEAT_PREFIX}${seat.positionId}`);
                              event.dataTransfer.effectAllowed = 'move';
                              setChosenSeat(seat.positionId);
                              setChosen(null);
                            }}
                          />
                        ))}
                      </div>
                    ))}
                    <p className="assignment-seat-hint">{t('canvas.vacantSeatsHint')}</p>
                  </section>
                )}

                {visibleEmployees.length === 0 && visibleVacancies.length === 0 ? (
                  <p className="assignment-team-empty">{t('canvas.searchEmpty')}</p>
                ) : (
                  teamGroups.map((group) => (
                    <section className="assignment-dept" key={group.departmentId === '' ? '__none' : group.departmentId}>
                      <span className="assignment-dept-label">{group.departmentName === '' ? t('canvas.noDepartment') : group.departmentName}</span>
                      {group.employees.map((employee) => (
                        <EmployeeCard
                          key={employee.id}
                          employee={employee}
                          chosen={chosen === employee.id}
                          label={t('canvas.noCapability')}
                          onChoose={() => {
                            setChosen((current) => current === employee.id ? null : employee.id);
                            setChosenSeat(null);
                          }}
                          onDragStart={(event) => {
                            event.dataTransfer.setData('text/plain', employee.id);
                            event.dataTransfer.effectAllowed = 'move';
                            setChosen(employee.id);
                            setChosenSeat(null);
                          }}
                        />
                      ))}
                    </section>
                  ))
                )}
              </div>
              <div className="assignment-palette-foot">
                <span className="assignment-legend"><i data-kind="task" />{t('canvas.legend.task')}</span>
                <span className="assignment-legend"><i data-kind="approval" />{t('canvas.legend.approval')}</span>
                <span className="assignment-legend"><i data-kind="delivery" />{t('canvas.legend.delivery')}</span>
              </div>
            </div>

            <div className="assignment-center">
              <div className="assignment-board-head">
                <div>
                  <span className="field-label">{t('canvas.flowLabel')}</span>
                  <b>{t('canvas.nodesCount', { count: graph.nodes.length })}</b>
                </div>
                <span className="assignment-board-meta">
                  {t('canvas.stagesCount', { count: graph.stages.length })}
                  {selected.draft ? ` · ${t('canvas.pendingConfirm')}` : ''}
                </span>
              </div>

              {selected.draft && (
                <div className="assignment-draft-banner" role="status">
                  <span className="assignment-draft-dot" aria-hidden="true" />
                  <div>
                    <b>{t('canvas.draftReady')}</b>
                    <small>{t('canvas.draftReadyDetail')}</small>
                  </div>
                </div>
              )}
              {selected.status.toLowerCase() === 'completed' && (
                <div className="assignment-draft-banner done" role="status">
                  <span className="assignment-draft-dot" aria-hidden="true" />
                  <div><b>{t('canvas.nothingEditable')}</b></div>
                </div>
              )}

              {departmentSeats.length > 0 && (
                <div className={`assignment-org${selected.draft ? ' draft' : ''}`} aria-label={t('canvas.orgStructure')}>
                  <div className="assignment-org-head">
                    <span className="field-label">{t('canvas.orgStructure')}</span>
                    <small>{t('canvas.orgSummary', { departments: departmentSeats.length, staffed: staffedSeats, seats: seats.length, vacant: vacantSeats.length })}</small>
                  </div>
                  <div className="assignment-org-list">
                    {departmentSeats.map((department) => (
                      <div className="assignment-org-dept" key={department.departmentId === '' ? '__none' : department.departmentId}>
                        <b>{department.departmentName === '' ? t('canvas.noDepartment') : department.departmentName}</b>
                        <span>{t('canvas.orgSeatCount', { staffed: department.staffed, total: department.seats.length })}</span>
                        {department.vacant > 0 && <i>{t('canvas.orgOpenCount', { count: department.vacant })}</i>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div
                className={`assignment-viewport${dragging ? ' dragging' : ''}`}
                ref={viewportRef}
                onPointerDown={onViewportPointerDown}
                onPointerMove={onViewportPointerMove}
                onPointerUp={onViewportPointerUp}
                onPointerCancel={onViewportPointerUp}
                onPointerLeave={onViewportPointerUp}
              >
                <div className="assignment-canvas-tools">
                  <button type="button" aria-label={t('canvas.zoomOut')} onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - 0.1))}>−</button>
                  <span>{Math.round(zoom * 100)}%</span>
                  <button type="button" aria-label={t('canvas.zoomIn')} onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + 0.1))}>+</button>
                  <button type="button" onClick={fitView}>{t('canvas.fitView')}</button>
                  <button type="button" onClick={resetView}>{t('canvas.resetView')}</button>
                </div>
                <div
                  className="assignment-world"
                  style={{
                    ['--pan-x' as string]: `${pan.x}px`,
                    ['--pan-y' as string]: `${pan.y}px`,
                    ['--zoom' as string]: String(zoom),
                  } as CSSProperties}
                >
                  <div className="assignment-board canvas-board" style={{ width: graph.width, height: graph.height }}>
                    <svg
                      className="assignment-edges"
                      viewBox={`0 0 ${graph.width} ${graph.height}`}
                      preserveAspectRatio="none"
                      aria-hidden="true"
                    >
                      {graph.edges.map((edge) => (
                        <path
                          key={edge.id}
                          d={edge.d}
                          className={`assignment-edge tone-${edge.tone}${edge.active ? ' active' : ''}${edge.crossesStage ? ' cross' : ''}${edge.feedback ? ' feedback' : ''}`}
                          data-condition={edge.condition ?? undefined}
                        />
                      ))}
                    </svg>

                    {graph.stages.map((stage) => (
                      <div
                        className="assignment-stage"
                        key={stage.stageId}
                        style={{ top: stage.top, height: stage.height }}
                      >
                        <span className="assignment-stage-index">{stage.index + 1}</span>
                        <b>{stage.stageName}</b>
                        <small>{t('canvas.steps', { done: stage.done, total: stage.total })}</small>
                      </div>
                    ))}

                    {graph.nodes.map((node) => (
                      <StepNode
                        key={node.step.stepId}
                        node={node}
                        employee={effectiveOf(node)}
                        selected={activeNode?.step.stepId === node.step.stepId}
                        gated={gate?.stepId === node.step.stepId}
                        dragOver={dragOverStep === node.step.stepId}
                        hasSod={node.effectiveEmployeeId !== null && sodWarnings.has(node.effectiveEmployeeId)}
                        chosenEmployeeId={chosen}
                        chosenSeatId={chosenSeat}
                        onActivate={() => activateNode(node)}
                        onDrop={(event) => onDrop(event, node)}
                        onDragOver={(event) => {
                          if (!node.adjustable) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'move';
                          setDragOverStep(node.step.stepId);
                        }}
                        onDragLeave={() => setDragOverStep((current) => current === node.step.stepId ? null : current)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="assignment-inspector" role="complementary" aria-label={t('canvas.inspector')}>
              <div className="assignment-inspector-head">
                <span className="field-label">{t('canvas.inspector')}</span>
                {activeNode !== null && <span className="assignment-node-index">{activeNode.index + 1}/{graph.nodes.length}</span>}
              </div>

              {workflowGateOpen && selected.approval !== null && selected.approval !== undefined && (
                <div className="assignment-gate workflow" role="status">
                  <div className="assignment-gate-head">
                    <span className="assignment-gate-mark" aria-hidden="true">✓</span>
                    <div>
                      <span className="assignment-kicker">{t('canvas.gate.kicker')}</span>
                      <b>{t('canvas.gate.workflowTitle')}</b>
                    </div>
                  </div>
                  <p>{t('canvas.gate.workflowDetail', {
                    granted: String(selected.approval.grantedBy.length),
                    required: String(selected.approval.requiredCount),
                    step: selected.approval.stepId,
                  })}</p>
                  <p className="assignment-gate-note">{t('canvas.gate.decideHint')}</p>
                  <div className="assignment-gate-actions">
                    <button type="button" className="primary" disabled={deciding} onClick={() => void decideWorkflow('approve')}>
                      {deciding ? t('common.submitting') : t('canvas.gate.approve')}
                    </button>
                    <button type="button" className="ghost" disabled={deciding} onClick={() => void decideWorkflow('reject')}>
                      {t('canvas.gate.reject')}
                    </button>
                  </div>
                </div>
              )}

              {gate !== null && gateStep !== null && (
                <div className={`assignment-gate ${gate.kind}`} role="dialog" aria-label={gate.kind === 'employee' ? t('canvas.gate.assignmentTitle') : t('canvas.gate.vacancyTitle')}>
                  <div className="assignment-gate-head">
                    <span className="assignment-gate-mark" aria-hidden="true">{gate.kind === 'employee' ? '✓' : '◇'}</span>
                    <div>
                      <span className="assignment-kicker">{t('canvas.gate.kicker')}</span>
                      <b>{gate.kind === 'employee' ? t('canvas.gate.assignmentTitle') : t('canvas.gate.vacancyTitle')}</b>
                    </div>
                    <button
                      type="button"
                      className="assignment-gate-close"
                      aria-label={t('canvas.gate.close')}
                      onClick={() => setGate(null)}
                    >×</button>
                  </div>

                  {gate.kind === 'employee' && gateEmployee !== null ? (
                    <>
                      <p>{t('canvas.gate.assignmentDetail', { employee: gateEmployee.name, step: gateStep.name })}</p>
                      <div className="assignment-assignee-card gate-card">
                        <AgentAvatar name={gateEmployee.name} positionId={gateEmployee.positionId} positionTitle={gateEmployee.positionTitle} capabilities={gateEmployee.capabilities} kind={gateEmployee.kind} status={gateEmployee.status === 'on_leave' ? 'paused' : 'idle'} />
                        <div>
                          <b>{gateEmployee.name}</b>
                          <small>{gateEmployee.positionTitle}{gateEmployee.departmentName === undefined || gateEmployee.departmentName === '' ? '' : ` · ${gateEmployee.departmentName}`}</small>
                          <span>{gateEmployee.capabilities.slice(0, 4).join(' · ') || t('canvas.noCapability')}</span>
                        </div>
                        {gateSod && <span className="assignment-badge sod">SoD</span>}
                      </div>
                      {gateSod && (
                        <p className="assignment-sod">{t('canvas.gate.sod', { employee: gateEmployee.name })}</p>
                      )}
                      <p className="assignment-gate-note">{t('canvas.gate.recheck')}</p>
                      <div className="assignment-gate-actions">
                        <button type="button" className="primary" onClick={approveGate}>{t('canvas.gate.approveAssignment')}</button>
                        <button type="button" className="ghost" onClick={() => setGate(null)}>{t('canvas.gate.cancel')}</button>
                      </div>
                    </>
                  ) : gate.kind === 'seat' && gateSeat !== null ? (
                    <>
                      <p>{t('canvas.gate.vacancyDetail', { seat: gateSeat.title, step: gateStep.name })}</p>
                      <div className="assignment-gate-facts">
                        <div><span>{t('canvas.gate.seat')}</span><b>{gateSeat.title}</b></div>
                        <div><span>{t('canvas.gate.department')}</span><b>{gateSeat.departmentName === '' ? t('canvas.noDepartment') : gateSeat.departmentName}</b></div>
                        <div><span>{t('canvas.capabilityLabel')}</span><b>{gateSeat.capabilities.join(', ') || t('canvas.noCapability')}</b></div>
                      </div>
                      {gateCandidates.length === 0 ? (
                        <p className="assignment-gate-empty">{t('canvas.gate.noCandidate')}</p>
                      ) : (
                        <label className="assignment-select-assignee">
                          <span>{t('canvas.gate.candidate')}</span>
                          <select value={candidateId} onChange={(event) => setGateCandidate(event.target.value)}>
                            {gateCandidates.map((employee) => (
                              <option key={employee.id} value={employee.id}>
                                {employee.name} · {employee.positionTitle}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <p className="assignment-gate-note">{t('canvas.gate.recheck')}</p>
                      <div className="assignment-gate-actions">
                        <button type="button" className="primary" disabled={candidateId === ''} onClick={approveGate}>
                          {t('canvas.gate.stageCandidate')}
                        </button>
                        <button type="button" className="ghost" onClick={() => control.navigate('Agents')}>
                          {t('canvas.gate.openHiring')}
                        </button>
                      </div>
                      <button type="button" className="assignment-gate-cancel" onClick={() => setGate(null)}>
                        {t('canvas.gate.cancel')}
                      </button>
                    </>
                  ) : null}
                </div>
              )}

              {activeNode === null ? (
                <div className="assignment-inspector-empty">
                  <b>{t('canvas.noSelection')}</b>
                  <p>{t('canvas.noSelectionHint')}</p>
                </div>
              ) : (
                <>
                  <div className="assignment-inspector-title">
                    <span className="assignment-node-icon large" data-kind={activeNode.step.kind}>{nodeGlyph(activeNode.step.kind)}</span>
                    <div>
                      <h3>{activeNode.step.name}</h3>
                      <p>{activeNode.step.stageName} · {i18n.status(activeNode.step.status)}</p>
                    </div>
                  </div>

                  <div className="assignment-facts">
                    <div><span>{t('canvas.nodeKind')}</span><b>{activeNode.step.kind}</b></div>
                    <div><span>{t('canvas.stageLabel')}</span><b>{activeNode.step.stageName}</b></div>
                    <div><span>{t('canvas.capabilityLabel')}</span><b>{activeNode.step.capability ?? t('canvas.noCapability')}</b></div>
                    <div><span>{t('canvas.statusLabel')}</span><b>{i18n.status(activeNode.step.status)}</b></div>
                    <div><span>{t('canvas.rolesLabel')}</span><b>{activeNode.step.requiredRoles.length === 0 ? '—' : activeNode.step.requiredRoles.join(', ')}</b></div>
                    <div><span>{t('canvas.authorityLabel')}</span><b>{activeNode.step.requiredAuthority === null ? '—' : `${activeNode.step.requiredAuthority.domain} ≥ L${String(activeNode.step.requiredAuthority.level)}`}</b></div>
                  </div>

                  <div className="assignment-assignee">
                    <span className="field-label">{t('canvas.assignee')}</span>
                    {activeEmployee === null ? (
                      <p className="assignment-unassigned">{t('canvas.unresolved')}</p>
                    ) : (
                      <div className="assignment-assignee-card">
                        <AgentAvatar name={activeEmployee.name} positionId={activeEmployee.positionId} positionTitle={activeEmployee.positionTitle} capabilities={activeEmployee.capabilities} kind={activeEmployee.kind} status={activeEmployee.status === 'on_leave' ? 'paused' : 'idle'} />
                        <div>
                          <b>{activeEmployee.name}</b>
                          <small>{activeEmployee.positionTitle}</small>
                          <span>{activeEmployee.capabilities.slice(0, 3).join(' · ') || t('canvas.noCapability')}</span>
                        </div>
                        {activeNode.staged && <span className="assignment-badge staged">{t('canvas.staged')}</span>}
                        {!activeNode.staged && activeNode.step.overridden && <span className="assignment-badge pinned">{t('canvas.pinned')}</span>}
                        {activeNode.staged && (
                          <button type="button" className="assignment-undo" onClick={() => unstageStep(activeNode.step.stepId)}>
                            {t('canvas.undo')}
                          </button>
                        )}
                      </div>
                    )}
                    {activeNode.adjustable && (
                      <>
                        <label className="assignment-select-assignee">
                          <span>{t('canvas.chooseEmployee')}</span>
                          <select
                            value={activeNode.effectiveEmployeeId ?? ''}
                            onChange={(event) => {
                              if (event.target.value === '') unstageStep(activeNode.step.stepId);
                              else openEmployeeGate(activeNode.step.stepId, event.target.value);
                            }}
                          >
                            <option value="">{t('canvas.unresolved')}</option>
                            {employees.map((employee) => (
                              <option key={employee.id} value={employee.id}>{employee.name} · {employee.positionTitle}</option>
                            ))}
                          </select>
                        </label>
                        <p className="assignment-drop-note">{t('canvas.dropHint')}</p>
                      </>
                    )}
                    {!activeNode.adjustable && (
                      <p className="assignment-drop-note">{t('canvas.lockedHint')}</p>
                    )}
                    {activeSod && (
                      <p className="assignment-sod">
                        {t('canvas.sodWarningDetail', { employee: activeEmployee?.name ?? activeNode.effectiveEmployeeId ?? '' })}
                      </p>
                    )}
                  </div>

                  <div className="assignment-kernel-note">
                    <b>{t('canvas.kernelChecks')}</b>
                    <p>{t('canvas.kernelNote')}</p>
                  </div>

                  <div className="assignment-inspector-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={commitDisabled}
                      onClick={() => setReviewing(true)}
                    >
                      {selected.planned ? t('canvas.openPlanCanvas') : selected.draft ? t('canvas.confirmDraft', { count: stagedCount }) : t('canvas.review', { count: stagedCount })}
                    </button>
                    <button type="button" className="ghost" disabled={stagedCount === 0} onClick={reset}>
                      {t('canvas.discard')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>

          <footer className="assignment-composer">
            <div className="assignment-composer-state">
              <b>{stagedCount === 0 ? t('canvas.nothingStaged') : t('canvas.stagedCount', { count: stagedCount })}</b>
              {sodCount > 0 && <small>{t('canvas.sodSummary', { count: sodCount })}</small>}
            </div>
            <label className="assignment-reason">
              <span>{t('canvas.reasonLabel')}</span>
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t('canvas.reasonPlaceholder')}
              />
            </label>
            <button
              type="button"
              className="primary assignment-commit"
              disabled={commitDisabled}
              onClick={() => setReviewing(true)}
            >
              {selected.planned ? t('canvas.openPlanCanvas') : selected.draft ? t('canvas.confirmDraft', { count: stagedCount }) : t('canvas.review', { count: stagedCount })}
            </button>
            <button type="button" className="ghost assignment-reset" disabled={stagedCount === 0} onClick={reset}>
              {t('canvas.discard')}
            </button>
          </footer>
        </section>
      )}

      {reviewing && selected !== null && graph !== null && (
        <div className="assignment-modal-backdrop" role="presentation" onClick={() => setReviewing(false)}>
          <div
            className="assignment-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('canvas.diffTitle')}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="assignment-kicker">{t('canvas.reviewKicker')}</span>
                <h2>{t('canvas.diffTitle')}</h2>
              </div>
              <button type="button" className="assignment-modal-close" onClick={() => setReviewing(false)}>×</button>
            </header>
            <p className="assignment-modal-intro">{t('canvas.diffIntro')}</p>

            {stagedCount === 0 ? (
              <div className="assignment-draft-review">
                <b>{selected.draft ? t('canvas.draftReady') : t('canvas.noChanges')}</b>
                <p>{selected.draft ? t('canvas.draftReadyDetail') : t('canvas.noChangesHint')}</p>
              </div>
            ) : (
              <div className="assignment-diff-list">
                {stageEntries.map(([stepId, employeeId]) => {
                  const step = selected.steps.find((entry) => entry.stepId === stepId);
                  const fromId = step?.assigneeEmployeeId ?? null;
                  const from = fromId === null ? null : employeeById.get(fromId) ?? null;
                  const to = employeeById.get(employeeId) ?? null;
                  const warned = sodWarnings.has(employeeId);
                  return (
                    <div className="assignment-diff-row" key={stepId}>
                      <div className="assignment-diff-person">
                        <AgentAvatar name={from?.name} positionId={from?.positionId} positionTitle={from?.positionTitle} capabilities={from?.capabilities} kind={from?.kind} status={from === null ? 'vacant' : 'idle'} size="xs" />
                        <span><b>{step?.name ?? stepId}</b><small>{t('canvas.from', { name: from?.name ?? t('canvas.unresolved') })}</small></span>
                      </div>
                      <span className="assignment-diff-arrow">→</span>
                      <div className="assignment-diff-person">
                        <AgentAvatar name={to?.name} positionId={to?.positionId} positionTitle={to?.positionTitle} capabilities={to?.capabilities} kind={to?.kind} status={to === null ? 'vacant' : 'idle'} size="xs" />
                        <span><b>{to?.name ?? employeeId}</b><small>{to?.positionTitle ?? ''}</small></span>
                      </div>
                      {warned && <p className="assignment-diff-warning">{t('canvas.sodWarningDetail', { employee: to?.name ?? employeeId })}</p>}
                    </div>
                  );
                })}
              </div>
            )}

            <label className="assignment-modal-reason">
              <span>{t('canvas.reasonLabel')}</span>
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={t('canvas.reasonPlaceholder')}
                rows={2}
              />
            </label>
            {refusal !== null && <div className="assignment-refusal" role="alert">{t('canvas.kernelRefusal', { issues: refusal })}</div>}
            <div className="assignment-modal-actions">
              <button type="button" className="primary" disabled={submitting} onClick={() => void commitChanges()}>
                {submitting
                  ? t('common.submitting')
                  : selected.planned
                    ? t('canvas.openPlanCanvas')
                    : selected.draft
                      ? t('canvas.confirmDraft', { count: stagedCount })
                      : t('canvas.confirm', { count: stagedCount })}
              </button>
              <button type="button" className="ghost" onClick={() => setReviewing(false)}>{t('common.cancel')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
