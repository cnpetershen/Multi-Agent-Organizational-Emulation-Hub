import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { messageOf, readString, requestJson, type Row } from '../api';
import type { ConsoleControl } from '../control';
import {
  executionStatusTone,
  parseExecution,
  parseExecutionList,
  taskStatusTone,
  type ExecutionView,
} from '../execution';
import { useI18n, type MessageKey } from '../i18n';
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  layoutPlan,
  parsePlan,
  parsePlanList,
  parsePlanRecord,
  type PlanNodeView,
  type PlanRecordView,
  type PlanView,
} from '../plan';

/**
 * M3.4 · 可视化调整画布与人工方案确认。
 *
 * The dark deck is the interaction: nodes are dragged, selected and edited; edges show the DAG;
 * the inspector edits a node; the right rail validates, versions and confirms. The plan document
 * is the truth. Confirmation never calls the kernel's start/confirm path, so no Task is created.
 */

interface NodePosition {
  readonly x: number;
  readonly y: number;
}

function employeeMap(control: ConsoleControl): ReadonlyMap<string, Row> {
  return new Map(
    control.snapshot.employees.map((row) => [readString(row['employeeId'], ''), row]),
  );
}

function employeeName(control: ConsoleControl, employeeId: string | null): string {
  if (employeeId === null) return '';
  const row = control.snapshot.employees.find(
    (employee) => readString(employee['employeeId'], '') === employeeId,
  );
  return row === undefined ? employeeId : readString(row['name'], employeeId);
}

function employeeCapabilities(
  control: ConsoleControl,
  employeeId: string,
): readonly string[] {
  const employee = employeeMap(control).get(employeeId);
  if (employee === undefined) return [];
  const positionId = readString(employee['positionId'], '');
  const position = control.snapshot.positions.find(
    (row) => readString(row['positionId'], readString(row['id'], '')) === positionId,
  );
  const fromPosition = Array.isArray(position?.['capabilities'])
    ? (position?.['capabilities'] as readonly unknown[]).map((entry) => readString(entry, ''))
    : [];
  const fromEmployee = Array.isArray(employee['expertise'])
    ? (employee['expertise'] as readonly unknown[]).map((entry) => readString(entry, ''))
    : [];
  return [...fromPosition, ...fromEmployee].filter((entry) => entry !== '');
}

function capableEmployees(control: ConsoleControl, capability: string | null): readonly Row[] {
  const employees = control.snapshot.employees.filter((employee) => {
    const status = readString(employee['status'], 'active');
    return status !== 'offboarded' && status !== 'archived';
  });
  if (capability === null) return employees;
  return employees.filter((employee) => {
    const id = readString(employee['employeeId'], '');
    return employeeCapabilities(control, id).includes(capability);
  });
}

function capabilityLabel(capability: string | null): string {
  return capability === null ? '' : capability.replace(/_/g, ' ');
}

function splitLines(text: string, max = 20): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const line of text.split('\n')) {
    const value = line.replace(/\s+/g, ' ').trim();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    list.push(value);
    if (list.length >= max) break;
  }
  return list;
}

function parsePositions(text: string): string[] {
  return splitLines(text, 20);
}

function withNode(
  nodes: readonly PlanNodeView[],
  nodeId: string,
  patch: Partial<PlanNodeView>,
): PlanNodeView[] {
  return nodes.map((node) => (node.nodeId === nodeId ? { ...node, ...patch } : node));
}

function nodeBlockingIssues(
  nodes: readonly PlanNodeView[],
  control: ConsoleControl,
): readonly string[] {
  const issues: string[] = [];
  const ids = new Set(nodes.map((node) => node.nodeId));
  for (const node of nodes) {
    if (node.title.trim() === '') issues.push(`${node.nodeId}:title`);
    if (node.goal.trim() === '') issues.push(`${node.nodeId}:goal`);
    if (node.inputs.length === 0) issues.push(`${node.nodeId}:input`);
    if (node.outputs.length === 0) issues.push(`${node.nodeId}:output`);
    if (node.acceptance.length === 0) issues.push(`${node.nodeId}:acceptance`);
    if (node.kind === 'task') {
      if (node.employeeId === null) issues.push(`${node.nodeId}:employee`);
      else if (
        node.capability !== null &&
        !employeeCapabilities(control, node.employeeId).includes(node.capability)
      ) {
        issues.push(`${node.nodeId}:capability`);
      }
    }
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) issues.push(`${node.nodeId}:dependency`);
    }
  }
  // Cycle check (Kahn).
  const remaining = new Set(ids);
  let progressed = true;
  while (remaining.size > 0 && progressed) {
    progressed = false;
    for (const node of nodes) {
      if (!remaining.has(node.nodeId)) continue;
      if (node.dependsOn.every((dependency) => !remaining.has(dependency))) {
        remaining.delete(node.nodeId);
        progressed = true;
      }
    }
  }
  if (remaining.size > 0) issues.push('cycle');
  return issues;
}

export function PlanCanvasPage({ control }: { control: ConsoleControl }) {
  const i18n = useI18n();
  const { t } = i18n;
  const [plans, setPlans] = useState<ReturnType<typeof parsePlanList>>([]);
  const [record, setRecord] = useState<PlanRecordView | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [nodes, setNodes] = useState<readonly PlanNodeView[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [positions, setPositions] = useState<ReadonlyMap<string, NodePosition>>(new Map());
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [execution, setExecution] = useState<ExecutionView | null>(null);
  const dragRef = useRef<{ nodeId: string; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const plan: PlanView | null = useMemo(() => {
    if (record === null) return null;
    const version = selectedVersion ?? record.currentVersion;
    return record.versions.find((entry) => entry.version === version) ?? record.versions.at(-1) ?? null;
  }, [record, selectedVersion]);

  const editable = plan !== null && plan.version === record?.currentVersion;
  const selectedNode = nodes.find((node) => node.nodeId === selectedNodeId) ?? null;
  const layout = useMemo(() => (plan === null ? null : layoutPlan({ ...plan, nodes })), [plan, nodes]);
  const layoutWidth = layout?.width ?? 0;
  const localIssues = useMemo(() => nodeBlockingIssues(nodes, control), [nodes, control]);
  const dirty = plan !== null && JSON.stringify(nodes) !== JSON.stringify(plan.nodes);
  const savedBlocking = plan?.validation.blockingCount ?? 0;
  const confirmDisabled =
    !editable || plan?.status === 'confirmed' || busy !== null || localIssues.length > 0 || savedBlocking > 0;
  const blockingIssues = Math.max(savedBlocking, localIssues.length);
  const cycleNodes = new Set(layout?.edges.filter((edge) => edge.cycle).flatMap((edge) => [edge.from, edge.to]) ?? []);

  const resetPositions = useCallback((next: PlanView): void => {
    const boxes = layoutPlan(next).boxes;
    setPositions(new Map([...boxes.entries()].map(([id, box]) => [id, { x: box.x, y: box.y }])));
  }, []);

  useEffect(() => {
    const viewport = canvasRef.current;
    if (viewport === null || layoutWidth <= 0) return;
    const fit = Math.min(1, (viewport.clientWidth - 24) / layoutWidth);
    setZoom(Math.max(0.45, Number(fit.toFixed(2))));
  }, [layoutWidth, record?.planId, plan?.version]);

  const openPlan = useCallback(async (planId: string): Promise<void> => {
    setBusy('open');
    setError(null);
    try {
      const raw = await requestJson(`/api/plans/${encodeURIComponent(planId)}`);
      const next = parsePlanRecord(raw);
      setRecord(next);
      const current = next.versions.find((entry) => entry.version === next.currentVersion) ?? next.versions.at(-1) ?? null;
      setSelectedVersion(current?.version ?? null);
      setNodes(current?.nodes ?? []);
      setSelectedNodeId(current?.nodes[0]?.nodeId ?? null);
      if (current !== null) resetPositions(current);
      const executions = parseExecutionList(await requestJson('/api/executions'));
      setExecution(
        executions.find(
          (entry) =>
            entry.planId === next.planId &&
            entry.planVersion === (current?.version ?? next.currentVersion),
        ) ?? null,
      );
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, [resetPositions]);

  const loadList = useCallback(async (): Promise<void> => {
    try {
      const listed = await requestJson('/api/plans');
      const next = parsePlanList(listed);
      setPlans(next);
      if (next.length > 0 && record === null) await openPlan(next[0]?.planId ?? '');
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [openPlan, record]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const selectVersion = (version: number): void => {
    if (record === null) return;
    const chosen = record.versions.find((entry) => entry.version === version);
    if (chosen === undefined) return;
    setSelectedVersion(chosen.version);
    setNodes(chosen.nodes);
    setSelectedNodeId(chosen.nodes[0]?.nodeId ?? null);
    resetPositions(chosen);
  };

  const submitPlan = async (): Promise<PlanView | null> => {
    if (record === null || plan === null) return null;
    const raw = await requestJson(`/api/plans/${encodeURIComponent(record.planId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseVersion: plan.version,
        nodes: nodes.map((node) => ({
          nodeId: node.nodeId,
          title: node.title,
          goal: node.goal,
          inputs: [...node.inputs],
          outputs: [...node.outputs],
          acceptance: [...node.acceptance],
          employeeId: node.employeeId,
          dependsOn: [...node.dependsOn],
        })),
      }),
    });
    return (raw as { readonly version?: unknown }).version === undefined ? null : parsePlan(raw);
  };

  const save = async (): Promise<void> => {
    if (record === null || plan === null) return;
    setBusy('save');
    setError(null);
    try {
      const saved = await submitPlan();
      if (saved === null) return;
      await openPlan(record.planId);
      setNote('');
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async (): Promise<void> => {
    if (record === null || plan === null || !editable || plan.status !== 'draft') return;
    setBusy('confirm');
    setError(null);
    try {
      const version = dirty ? (await submitPlan())?.version : plan.version;
      if (version === undefined || version === null) return;
      await requestJson(`/api/plans/${encodeURIComponent(record.planId)}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseVersion: version, note: note.trim() === '' ? undefined : note.trim() }),
      });
      await openPlan(record.planId);
      setNote('');
    } catch (cause) {
      setError(messageOf(cause));
      await openPlan(record.planId);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (execution === null || (execution.status !== 'running' && execution.status !== 'paused')) return;
    const timer = window.setInterval(() => {
      void requestJson(`/api/executions/${encodeURIComponent(execution.executionId)}`)
        .then((raw) => setExecution(parseExecution(raw)))
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [execution?.executionId, execution?.status]);

  const start = async (): Promise<void> => {
    if (record === null || plan === null || plan.status !== 'confirmed' || execution !== null) return;
    setBusy('start');
    setError(null);
    try {
      const raw = await requestJson(`/api/plans/${encodeURIComponent(record.planId)}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseVersion: plan.version }),
      });
      setExecution(parseExecution(raw));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const patchSelected = (patch: Partial<PlanNodeView>): void => {
    if (selectedNodeId === null || !editable) return;
    setNodes((current) => withNode(current, selectedNodeId, patch));
  };

  const toggleDependency = (dependency: string): void => {
    if (selectedNode === null || !editable) return;
    const has = selectedNode.dependsOn.includes(dependency);
    patchSelected({
      dependsOn: has
        ? selectedNode.dependsOn.filter((entry) => entry !== dependency)
        : [...selectedNode.dependsOn, dependency],
    });
  };

  const onNodePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, node: PlanNodeView): void => {
    event.stopPropagation();
    setSelectedNodeId(node.nodeId);
    const position = positions.get(node.nodeId);
    if (position === undefined) return;
    dragRef.current = {
      nodeId: node.nodeId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onNodePointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    const dx = (event.clientX - drag.startX) / zoom;
    const dy = (event.clientY - drag.startY) / zoom;
    setPositions((current) => {
      const next = new Map(current);
      next.set(drag.nodeId, { x: Math.max(0, drag.originX + dx), y: Math.max(0, drag.originY + dy) });
      return next;
    });
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  if (plans.length === 0) {
    return (
      <div className="plan-canvas-page">
        <div className="plan-canvas-empty">
          <h2>{t('canvasPlan.emptyTitle')}</h2>
          <p>{t('canvasPlan.emptyHint')}</p>
          <button type="button" className="primary" onClick={() => control.navigate('Planning')}>
            {t('canvasPlan.backToPlanning')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="plan-canvas-page">
      <div className="plan-canvas-top">
        <div className="plan-canvas-title">
          <p>{t('canvasPlan.eyebrow')}</p>
          <h2>{plan?.title ?? t('canvasPlan.title')}</h2>
          {plan !== null && (
            <span>
              v{plan.version} · {t(`planning.status.${plan.status}` as MessageKey)} ·{' '}
              {t('canvasPlan.requirementVersion', { version: plan.requirementVersion })}
            </span>
          )}
        </div>
        <div className="plan-canvas-actions">
          <select
            aria-label={t('canvasPlan.planSwitch')}
            value={record?.planId ?? ''}
            onChange={(event) => void openPlan(event.target.value)}
          >
            {plans.map((entry) => (
              <option key={entry.planId} value={entry.planId}>
                {entry.title} · v{entry.version}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => control.navigate('Planning')}>
            {t('canvasPlan.backToPlanning')}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!editable || busy !== null || !dirty}
            onClick={() => void save()}
          >
            {busy === 'save' ? t('canvasPlan.saving') : t('canvasPlan.save')}
          </button>
          <button
            type="button"
            className="confirm"
            disabled={confirmDisabled}
            onClick={() => void confirm()}
            data-testid="plan-confirm"
          >
            {busy === 'confirm' ? t('canvasPlan.confirming') : t('canvasPlan.confirm')}
          </button>
        </div>
      </div>

      {error !== null && <div className="plan-canvas-error" role="alert">{error}</div>}

      {plan?.status === 'confirmed' && (
        <div className="plan-canvas-confirmed">
          <b>{t('canvasPlan.confirmedTitle')}</b>
          <span>
            {t('canvasPlan.confirmedMeta', {
              by: plan.confirmedBy ?? '—',
              at: plan.confirmedAt ?? '—',
              version: plan.version,
            })}
          </span>
          {plan.confirmationNote !== null && <span>{plan.confirmationNote}</span>}
          <span className="plan-canvas-no-exec">
            {execution === null ? t('canvasPlan.confirmedNoExec') : t('canvasPlan.confirmedNoExecStarted')}
          </span>
          <span className="plan-canvas-no-exec">{t('canvasPlan.confirmedEdit')}</span>
        </div>
      )}

      <div className="plan-canvas-body">
        <div className="plan-canvas-stage">
          <div className="plan-canvas-toolbar">
            <span>{t('canvasPlan.dragHint')}</span>
            <div>
              <button type="button" onClick={() => setZoom((value) => Math.max(0.5, Number((value - 0.1).toFixed(2))))}>−</button>
              <span>{Math.round(zoom * 100)}%</span>
              <button type="button" onClick={() => setZoom((value) => Math.min(1.6, Number((value + 0.1).toFixed(2))))}>+</button>
              <button type="button" onClick={() => plan !== null && resetPositions(plan)}>{t('canvasPlan.resetLayout')}</button>
            </div>
          </div>
          <div className="plan-canvas-viewport" ref={canvasRef}>
            {layout !== null && plan !== null && (
              <div
                className="plan-canvas-board"
                style={{
                  width: layout.width * zoom,
                  height: layout.height * zoom,
                }}
              >
                <div
                  className="plan-canvas-scaled"
                  style={{
                    width: layout.width,
                    height: layout.height,
                    transform: `scale(${String(zoom)})`,
                    transformOrigin: 'top left',
                  }}
                >
                <svg className="plan-canvas-edges" width={layout.width} height={layout.height} aria-hidden="true">
                  <defs>
                    <marker id="plan-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="#5f7487" />
                    </marker>
                    <marker id="plan-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="#d07878" />
                    </marker>
                  </defs>
                  {layout.edges.map((edge) => {
                    const from = positions.get(edge.from);
                    const to = positions.get(edge.to);
                    if (from === undefined || to === undefined) return null;
                    const x1 = from.x + NODE_WIDTH;
                    const y1 = from.y + NODE_HEIGHT / 2;
                    const x2 = to.x;
                    const y2 = to.y + NODE_HEIGHT / 2;
                    const mid = (x1 + x2) / 2;
                    return (
                      <path
                        key={`${edge.from}-${edge.to}`}
                        d={`M ${String(x1)} ${String(y1)} C ${String(mid)} ${String(y1)}, ${String(mid)} ${String(y2)}, ${String(x2)} ${String(y2)}`}
                        fill="none"
                        stroke={edge.cycle ? '#d07878' : '#5f7487'}
                        strokeWidth={edge.cycle ? 2 : 1.4}
                        strokeDasharray={edge.cycle ? '5 4' : undefined}
                        markerEnd={edge.cycle ? 'url(#plan-arrow-bad)' : 'url(#plan-arrow)'}
                      />
                    );
                  })}
                </svg>
                {nodes.map((node) => {
                  const position = positions.get(node.nodeId);
                  if (position === undefined) return null;
                  const isSelected = node.nodeId === selectedNodeId;
                  const isCycle = cycleNodes.has(node.nodeId);
                  return (
                    <button
                      key={node.nodeId}
                      type="button"
                      className={`plan-node kind-${node.kind}${isSelected ? ' selected' : ''}${isCycle ? ' cycle' : ''}${node.employeeId === null && node.kind === 'task' ? ' unassigned' : ''}`}
                      style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                      onPointerDown={(event) => onNodePointerDown(event, node)}
                      onPointerMove={onNodePointerMove}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                      onDoubleClick={() => setSelectedNodeId(node.nodeId)}
                    >
                      <span className="plan-node-kind">
                        {node.kind === 'approval' ? t('canvasPlan.kindApproval') : capabilityLabel(node.capability)}
                      </span>
                      <b>{node.title}</b>
                      <span className="plan-node-owner">
                        {node.kind === 'approval'
                          ? t('canvasPlan.humanGate')
                          : node.employeeId === null
                            ? t('canvasPlan.unassigned')
                            : employeeName(control, node.employeeId)}
                      </span>
                      <span className="plan-node-dep">
                        {node.inputs.length}→{node.outputs.length}
                      </span>
                    </button>
                  );
                })}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="plan-canvas-rail">
          {selectedNode !== null && (
            <section className="plan-inspector">
              <div className="plan-section-head">
                <h3>{t('canvasPlan.inspector')}</h3>
                <span>{selectedNode.kind === 'approval' ? t('canvasPlan.kindApproval') : capabilityLabel(selectedNode.capability)}</span>
              </div>
              <label>
                <span>{t('canvasPlan.nodeTitle')}</span>
                <input value={selectedNode.title} disabled={!editable} onChange={(event) => patchSelected({ title: event.target.value })} />
              </label>
              <label>
                <span>{t('canvasPlan.nodeGoal')}</span>
                <textarea rows={2} value={selectedNode.goal} disabled={!editable} onChange={(event) => patchSelected({ goal: event.target.value })} />
              </label>
              {selectedNode.kind === 'task' && (
                <label>
                  <span>{t('canvasPlan.owner')}</span>
                  <select
                    value={selectedNode.employeeId ?? ''}
                    disabled={!editable}
                    onChange={(event) => patchSelected({ employeeId: event.target.value === '' ? null : event.target.value })}
                  >
                    <option value="">{t('canvasPlan.unassigned')}</option>
                    {capableEmployees(control, selectedNode.capability).map((employee) => {
                      const id = readString(employee['employeeId'], '');
                      return (
                        <option key={id} value={id}>
                          {readString(employee['name'], id)}
                        </option>
                      );
                    })}
                    {selectedNode.employeeId !== null &&
                      !capableEmployees(control, selectedNode.capability).some(
                        (employee) => readString(employee['employeeId'], '') === selectedNode.employeeId,
                      ) && (
                        <option value={selectedNode.employeeId}>
                          {employeeName(control, selectedNode.employeeId)} · {t('canvasPlan.notCapable')}
                        </option>
                      )}
                  </select>
                </label>
              )}
              <label>
                <span>{t('canvasPlan.inputs')}</span>
                <textarea rows={3} value={selectedNode.inputs.join('\n')} disabled={!editable} onChange={(event) => patchSelected({ inputs: parsePositions(event.target.value) })} />
              </label>
              <label>
                <span>{t('canvasPlan.outputs')}</span>
                <textarea rows={2} value={selectedNode.outputs.join('\n')} disabled={!editable} onChange={(event) => patchSelected({ outputs: parsePositions(event.target.value) })} />
              </label>
              <label>
                <span>{t('canvasPlan.acceptance')}</span>
                <textarea rows={3} value={selectedNode.acceptance.join('\n')} disabled={!editable} onChange={(event) => patchSelected({ acceptance: parsePositions(event.target.value) })} />
              </label>
              <div className="plan-deps">
                <span>{t('canvasPlan.dependsOn')}</span>
                {nodes
                  .filter((node) => node.nodeId !== selectedNode.nodeId)
                  .map((node) => (
                    <label key={node.nodeId} className="plan-dep">
                      <input
                        type="checkbox"
                        checked={selectedNode.dependsOn.includes(node.nodeId)}
                        disabled={!editable}
                        onChange={() => toggleDependency(node.nodeId)}
                      />
                      {node.title}
                    </label>
                  ))}
              </div>
            </section>
          )}

          <section className="plan-validation">
            <div className="plan-section-head">
              <h3>{t('canvasPlan.validation')}</h3>
              <span className={blockingIssues > 0 ? 'bad' : 'ok'}>
                {blockingIssues > 0
                  ? t('canvasPlan.blocking', { count: blockingIssues })
                  : t('canvasPlan.ready')}
              </span>
            </div>
            {localIssues.length > 0 && (
              <p className="plan-issue blocking">{t('canvasPlan.localIssues', { count: localIssues.length })}</p>
            )}
            {plan?.validation.issues.map((issue, index) => (
              <p key={`${issue.code}-${String(index)}`} className={`plan-issue ${issue.severity}`}>
                {t(`canvasPlan.issue.${issue.code}` as MessageKey)}
                {issue.nodeIds.length > 0 && (
                  <span>
                    {' '}
                    ·{' '}
                    {issue.nodeIds
                      .map((id) => nodes.find((node) => node.nodeId === id)?.title ?? '')
                      .filter((title) => title !== '')
                      .join('、')}
                  </span>
                )}
              </p>
            ))}
          </section>

          <section className="plan-versions">
            <div className="plan-section-head">
              <h3>{t('canvasPlan.versions')}</h3>
            </div>
            <label>
              <span>{t('canvasPlan.confirmNote')}</span>
              <textarea rows={2} value={note} disabled={!editable} onChange={(event) => setNote(event.target.value)} />
            </label>
            <ul>
              {[...(record?.versions ?? [])].reverse().map((version) => (
                <li key={version.version}>
                  <button
                    type="button"
                    className={version.version === plan?.version ? 'active' : ''}
                    onClick={() => selectVersion(version.version)}
                  >
                    <b>
                      v{version.version} · {t(`planning.status.${version.status}` as MessageKey)}
                    </b>
                    {version.change !== null && (
                      <span>
                        {t('canvasPlan.change', {
                          renamed: version.change.renamed,
                          reassigned: version.change.reassigned,
                          deps: version.change.dependenciesChanged,
                          content: version.change.contentChanged,
                        })}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="plan-summary">
            <h3>{t('canvasPlan.summary')}</h3>
            <span>{t('canvasPlan.summaryNodes', { count: plan?.summary.nodeCount ?? 0 })}</span>
            <span>{t('canvasPlan.summaryTasks', { count: plan?.summary.taskCount ?? 0 })}</span>
            <span>{t('canvasPlan.summaryEmployees', { count: plan?.summary.employeeCount ?? 0 })}</span>
            {plan !== null && plan.summary.deliverables.length > 0 && (
              <div className="plan-deliverables">
                <span>{t('canvasPlan.deliverables')}</span>
                {[...new Set(plan.summary.deliverables)].slice(0, 6).map((deliverable) => (
                  <em key={deliverable}>{deliverable}</em>
                ))}
              </div>
            )}
            <span className="plan-no-task">{t('canvasPlan.noTask')}</span>
          </section>
        </div>
      </div>

      {plan?.status === 'confirmed' && (
        <section className="plan-execution-panel">
          <div className="plan-execution-head">
            <div>
              <p>{t('canvasPlan.executionEyebrow')}</p>
              <h3>{t('canvasPlan.execution')}</h3>
            </div>
            {execution !== null && (
              <span className={`plan-exec-status ${executionStatusTone(execution.status)}`}>
                {t(`canvasPlan.executionStatus.${execution.status}` as MessageKey)}
              </span>
            )}
          </div>

          {execution === null ? (
            <div className="plan-start">
              <div className="plan-start-summary">
                <span>{t('canvasPlan.startSummaryVersion', { plan: plan.version, confirmed: plan.confirmedAt ?? '—' })}</span>
                <span>{t('canvasPlan.startSummaryTasks', { tasks: plan.summary.taskCount, employees: plan.summary.employeeCount })}</span>
                <span>{t('canvasPlan.startSummaryDeliverables', { deliverables: [...new Set(plan.summary.deliverables)].slice(0, 4).join('、') || '—' })}</span>
              </div>
              <button
                type="button"
                className="plan-start-button"
                disabled={busy !== null}
                onClick={() => void start()}
                data-testid="plan-start"
              >
                {busy === 'start' ? t('canvasPlan.starting') : t('canvasPlan.startExecution')}
              </button>
              <p className="plan-start-hint">{t('canvasPlan.startHint')}</p>
            </div>
          ) : (
            <div className="plan-execution">
              <div className="plan-execution-meta">
                <span>{t('canvasPlan.executionProgress', { completed: execution.summary.completedCount, total: execution.summary.taskCount })}</span>
                <span>{t('canvasPlan.executionArtifacts', { count: execution.summary.artifacts.length })}</span>
                <button type="button" onClick={() => control.navigate('Theater')}>
                  {t('canvasPlan.openTheater')}
                </button>
                <button type="button" onClick={() => control.navigate('Tasks')}>
                  {t('canvasPlan.openTasks')}
                </button>
                {execution.approval?.status === 'open' && (
                  <button type="button" className="primary" onClick={() => control.navigate('DeliveryApproval')}>
                    {t('canvasPlan.openApproval')}
                  </button>
                )}
              </div>
              {execution.approval?.status === 'open' && (
                <div className="plan-execution-approval">
                  <b>{t('canvasPlan.executionAwaitingApproval')}</b>
                  <span>{t('canvasPlan.executionApprovalHint')}</span>
                </div>
              )}
              {execution.status === 'failed' && (
                <div className="plan-execution-failure">
                  {t('canvasPlan.executionFailed', { count: execution.summary.failedCount })}
                </div>
              )}
              <ol className="plan-exec-tasks">
                {execution.tasks.map((task) => (
                  <li key={task.taskId} className={`plan-exec-task status-${taskStatusTone(task.status)}`}>
                    <div className="plan-exec-task-head">
                      <b>{task.title}</b>
                      <span>{t(`canvasPlan.taskStatus.${task.status}` as MessageKey)}</span>
                    </div>
                    <small>
                      {task.assigneeName ?? t('canvasPlan.unassigned')} · {t('canvasPlan.attempt', { attempt: task.attempt, max: task.maxAttempts })}
                      {task.completedAtSim !== null ? ` · t${String(task.completedAtSim)}` : ''}
                    </small>
                    {task.result !== null && (
                      <>
                        <p>{task.result.summary}</p>
                        {task.result.artifacts.length > 0 && (
                          <div className="plan-exec-artifacts">
                            {task.result.artifacts.map((artifact) => (
                              <em key={artifact}>{artifact}</em>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    {task.rejectReason !== null && <p className="plan-exec-reason">{task.rejectReason}</p>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
