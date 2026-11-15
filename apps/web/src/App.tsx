import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { messageOf, parseCommandOutcome, parseSnapshot, requestJson, type Feedback, type Snapshot } from './api';
import { simulationCommand, type Command, type CommandContext } from './commands';
import { FeedbackBanner, LoadError, Panel } from './components';
import { type CommandRun, type ConsoleControl, type Page } from './control';
import { isOpenApproval } from './derive';
import { useJson } from './hooks';
import { useI18n, type MessageKey } from './i18n';
import { LanguageSwitch } from './i18n/LanguageSwitch';
import { AgentsPage } from './pages/Agents';
import { NetworkPage } from './pages/Network';
import { ApprovalsPage } from './pages/Approvals';
import { DeliveryApprovalsPage } from './pages/DeliveryApprovals';
import { PromotionPage } from './pages/Promotion';
import { PublicationPage } from './pages/Publication';
import { CommunicationsPage } from './pages/Communications';
import { DeliverablesPage } from './pages/Deliverables';
import { EventsPage } from './pages/Events';
import { OverviewPage } from './pages/Overview';
import { PlanningPage } from './pages/Planning';
import { PlanCanvasPage } from './pages/PlanCanvas';
import { Foundry } from './pages/Foundry';
import { ResultsPage } from './pages/Results';
import { RuntimePage } from './pages/Runtime';
import { TasksPage } from './pages/Tasks';
import { TheaterPage } from './pages/Theater';
import { WorkflowCanvasPage } from './pages/WorkflowCanvas';
import { WorkflowsPage } from './pages/Workflows';
import { clearSession, readSession, signIn, writeSession, type CompanySession } from './ownership';
import { resultsPath, useRoute } from './router';
import './console.css';
import './canvas.css';
import './network.css';
import './document.css';
import './delivery-package.css';
import './phase1.css';
import './phase2.css';
import './phase3.css';
import './phase4.css';
import './phase5.css';
import './phase6.css';
import './hiring.css';
import './deliverables.css';
import './foundry.css';
import './results.css';
import './roles.css';
import './theater.css';
import './planning.css';
import './plan-canvas.css';
import './delivery-approval.css';
import './promotion.css';
import './publication.css';

const POLL_INTERVAL_MS = 2500;
const SUCCESS_FEEDBACK_MS = 8000;

type NavGroup = { readonly labelKey: MessageKey; readonly items: readonly Page[] };
const NAV_GROUPS: readonly NavGroup[] = [
  { labelKey: 'nav.group.company', items: ['Overview', 'Network', 'Agents'] },
  { labelKey: 'nav.group.work', items: ['Planning', 'Deliverables', 'Tasks', 'Workflows', 'Canvas'] },
  { labelKey: 'nav.group.decisions', items: ['Approvals', 'DeliveryApproval', 'Promotion', 'Publication'] },
  { labelKey: 'nav.group.activity', items: ['Theater', 'Communications', 'Events'] },
  { labelKey: 'nav.group.system', items: ['Runtime'] },
];

/** Page identity is the `Page` union; every visible page string is a key into the locale. */
const PAGE_KEYS: Readonly<Record<Page, { readonly title: MessageKey; readonly label: MessageKey }>> = {
  Overview: { title: 'page.overview.title', label: 'page.overview.label' },
  Network: { title: 'page.network.title', label: 'page.network.label' },
  Agents: { title: 'page.agents.title', label: 'page.agents.label' },
  Deliverables: { title: 'page.deliverables.title', label: 'page.deliverables.label' },
  Planning: { title: 'page.planning.title', label: 'page.planning.label' },
  PlanCanvas: { title: 'page.planCanvas.title', label: 'page.planCanvas.label' },
  Tasks: { title: 'page.tasks.title', label: 'page.tasks.label' },
  Workflows: { title: 'page.workflows.title', label: 'page.workflows.label' },
  Canvas: { title: 'page.canvas.title', label: 'page.canvas.label' },
  Approvals: { title: 'page.approvals.title', label: 'page.approvals.label' },
  DeliveryApproval: { title: 'page.deliveryApproval.title', label: 'page.deliveryApproval.label' },
  Promotion: { title: 'page.promotion.title', label: 'page.promotion.label' },
  Publication: { title: 'page.publication.title', label: 'page.publication.label' },
  Communications: { title: 'page.communications.title', label: 'page.communications.label' },
  Theater: { title: 'page.theater.title', label: 'page.theater.label' },
  Runtime: { title: 'page.runtime.title', label: 'page.runtime.label' },
  Events: { title: 'page.events.title', label: 'page.events.label' },
};

/**
 * "Paused for gate review" is a real console state: the operator holds the runtime so approval
 * decisions arrive before the company acts again. It used to live only in a `useRef`, which any
 * reload silently dropped — leaving the kernel paused while every page believed the opposite,
 * with approvals unable to unpause it. It is now persisted per company, next to the session.
 */
const SIDEBAR_COLLAPSED_KEY = 'maoeh.sidebar.collapsed';
/**
 * The rail collapses to a 78px icon strip. Remembered per browser, not per company: it is a
 * workspace preference, and switching company must not flip the layout back.
 */
const readPersistedCollapsed = (): boolean => {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
};
const persistCollapsed = (value: boolean): void => {
  try {
    if (value) window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1');
    else window.localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
  } catch {
    /* private mode — the rail still collapses for this visit */
  }
};

const heldStorageKey = (companyId: string): string => `maoeh.held.${companyId}`;
const readPersistedHold = (companyId: string): boolean => {
  try {
    return window.localStorage.getItem(heldStorageKey(companyId)) === '1';
  } catch {
    return false;
  }
};
const persistHold = (companyId: string, value: boolean): void => {
  try {
    if (value) window.localStorage.setItem(heldStorageKey(companyId), '1');
    else window.localStorage.removeItem(heldStorageKey(companyId));
  } catch {
    /* private mode / storage full — the hold degrades to session-local, never to a stuck kernel */
  }
};

export function App() {
  const i18n = useI18n();
  const { t } = i18n;
  const [page, setPage] = useState<Page>('Overview');
  const { route, push } = useRoute();
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [held, setHeld] = useState<boolean>(() => readPersistedHold(readSession()?.organizationId ?? ''));
  const [refreshToken, setRefreshToken] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => readPersistedCollapsed());
  const heldRef = useRef(held);
  /** True while `held` came from storage and has not yet been checked against the live runtime. */
  const adoptRef = useRef(held);
  const setHeldBoth = useCallback((value: boolean): void => {
    heldRef.current = value;
    setHeld(value);
    const companyId = readSession()?.organizationId ?? '';
    if (companyId !== '') persistHold(companyId, value);
  }, []);

  // M1.5 · which company this tab has open. Without one the console never renders: the
  // founder meets the gate first, and only an entered company reaches the shell below.
  const [session, setSession] = useState<CompanySession | null>(() => readSession());
  const [sessionStatus, setSessionStatus] = useState<'checking' | 'gate' | 'ready'>(() =>
    readSession() === null ? 'gate' : 'checking',
  );
  // Which face of the gate to open when the console hands control back: the landing hero, or
  // the founder form directly (the footer's "New company" action).
  const [gateIntent, setGateIntent] = useState<'hero' | 'create'>('hero');
  const activeOrganizationId = session?.organizationId ?? null;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // A stored session is a claim, not a credential: the API confirms the company still exists
  // and takes the runtime there, or the claim is dropped and the founder is back at the gate.
  useEffect(() => {
    if (activeOrganizationId === null) {
      setSessionStatus('gate');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const membership = await signIn(activeOrganizationId);
        if (cancelled) return;
        const current = sessionRef.current;
        if (current !== null && current.founderName !== membership.user.name) {
          const refreshed = { ...current, founderName: membership.user.name };
          writeSession(refreshed);
          setSession(refreshed);
        }
        // Reloading lost the gate-hold in memory: restore it from storage so approvals can
        // actually resume the runtime instead of silently doing nothing. The restore is marked
        // as adopted so the reconciliation effect can drop it if the kernel is already running.
        adoptRef.current = true;
        setHeldBoth(readPersistedHold(activeOrganizationId));
        setSessionStatus('ready');
      } catch {
        if (cancelled) return;
        clearSession();
        setSession(null);
        setSessionStatus('gate');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeOrganizationId, setHeldBoth]);

  const enterCompany = useCallback((next: CompanySession): void => {
    writeSession(next);
    setSession(next);
    setSessionStatus('ready');
    setGateIntent('hero');
  }, []);

  const leaveCompany = useCallback((): void => {
    clearSession();
    setSession(null);
    setSessionStatus('gate');
    setGateIntent('hero');
    setSidebarOpen(false);
    setFeedback(null);
    push('/');
  }, [push]);

  /**
   * "New company" from the console footer: leave the current company and land on the gate with
   * the creation form already open. The gate is still the only place a company is founded — this
   * only saves the founder from hunting for the entry in the first place.
   */
  const startNewCompany = useCallback((): void => {
    leaveCompany();
    setGateIntent('create');
  }, [leaveCompany]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) setRefreshToken((value) => value + 1);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    document.title = t('app.documentTitle');
  }, [t]);

  useEffect(() => {
    persistCollapsed(sidebarCollapsed);
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (feedback === null || feedback.kind !== 'success') return;
    const timer = window.setTimeout(() => setFeedback(null), SUCCESS_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const snapshotState = useJson('/api/snapshot', parseSnapshot, refreshToken);
  const snapshot: Snapshot | null = snapshotState.data;
  const context: CommandContext | null = snapshot === null ? null : { companyId: snapshot.company.id, simTime: snapshot.simulation.simTime };

  const runDetailed = useCallback(async (command: Command, success: string | null, detail?: string | null): Promise<CommandRun> => {
    if (success !== null) setFeedback({ kind: 'pending', title: t('feedback.submitting'), detail: null });
    try {
      const payload = await requestJson('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) });
      const outcome = parseCommandOutcome(payload);
      if (outcome.status !== 'accepted') {
        const failure = `${outcome.commandType} ${outcome.status}${outcome.failure === null ? '' : ` — ${outcome.failure}`}`;
        setFeedback({ kind: 'error', title: t('feedback.commandFailed'), detail: failure });
        setRefreshToken((value) => value + 1);
        return { ok: false, failure };
      }
      if (success !== null) setFeedback({ kind: 'success', title: success, detail: detail ?? null });
      setRefreshToken((value) => value + 1);
      return { ok: true, failure: null };
    } catch (cause) {
      const failure = messageOf(cause);
      setFeedback({ kind: 'error', title: t('app.dataUnavailableShort'), detail: failure });
      return { ok: false, failure };
    }
  }, [t]);

  const run = useCallback(async (command: Command, success: string | null, detail?: string | null): Promise<boolean> => {
    return (await runDetailed(command, success, detail)).ok;
  }, [runDetailed]);

  const beginHold = useCallback(async (): Promise<CommandRun> => {
    if (heldRef.current) return { ok: true, failure: null };
    if (snapshot?.simulation.paused === true) {
      setHeldBoth(true);
      return { ok: true, failure: null };
    }
    if (context === null) return { ok: false, failure: t('app.dataUnavailableShort') };
    const paused = await runDetailed(simulationCommand(context, 'Simulation.Pause', 'operator holds the runtime for gate review'), t('feedback.runtimeHeld'));
    if (paused.ok) setHeldBoth(true);
    return paused;
  }, [context, runDetailed, snapshot, setHeldBoth, t]);

  const releaseHold = useCallback(async (silent = false): Promise<boolean> => {
    if (!heldRef.current) return true;
    setHeldBoth(false);
    if (context === null) return false;
    return run(simulationCommand(context, 'Simulation.Resume', 'operator released the runtime'), silent ? null : t('feedback.runtimeResumed'));
  }, [context, run, setHeldBoth, t]);

  // Navigating anywhere in the shell leaves the delivery route: the pages all live on the
  // console's own path, and only a delivered result owns a deep link.
  const navigate = useCallback((target: Page): void => { push('/'); setPage(target); setSidebarOpen(false); }, [push]);
  const openResults = useCallback((taskId: string): void => { push(resultsPath(taskId)); setSidebarOpen(false); }, [push]);
  const snapshotRefresh = (): void => setRefreshToken((value) => value + 1);
  const control: ConsoleControl | null = snapshot === null || context === null ? null : {
    snapshot, refreshToken, companyId: snapshot.company.id, simTime: snapshot.simulation.simTime, held, run, runDetailed, navigate, openResults, beginHold, releaseHold, setFeedback,
  };
  const simulation = snapshot?.simulation ?? null;
  const connected = snapshotState.error === null && snapshot !== null;

  /**
   * Reconcile a hold that was restored from storage.
   *
   * The hold is a console-side flag persisted per company, so a tab that was closed while a gate
   * was open reopens "held". If the gate has since been decided elsewhere — another page, another
   * tab, or before this one loaded — the kernel is already running again, and keeping the flag
   * left the banner telling the operator to go decide an approval that was already decided.
   *
   * Only a flag adopted from storage is reconciled (`adoptRef`), never one set by `beginHold` in
   * this tab: that would race the pause command it is about to send.
   */
  useEffect(() => {
    if (!adoptRef.current) return;
    if (snapshot === null || simulation === null) return;
    adoptRef.current = false;
    if (simulation.paused) return;
    const openGates = snapshot.workflows.filter((workflow) => isOpenApproval(workflow) && workflow['executionPlan'] !== true).length;
    if (openGates === 0) setHeldBoth(false);
  }, [snapshot, simulation, setHeldBoth]);

  const runtimeLabel = held ? t('shell.runtimeHeld') : simulation?.paused ? t('shell.runtimePaused') : t('shell.runtimeLive');
  const runtimeDescription = held ? t('shell.stateHeld') : simulation?.paused ? t('shell.statePaused') : t('shell.stateRunning');
  // The delivery route is part of the Deliverables section: the sidebar keeps highlighting it
  // and the topbar names the view the operator is actually looking at.
  const activeNav: Page = route.kind === 'results' ? 'Deliverables' : page;
  const heading: MessageKey = route.kind === 'results' ? 'page.results.title' : PAGE_KEYS[page].title;
  const founderName = session?.founderName ?? '';

  // Gate first: no entered company, no console. The splash only covers the brief moment a
  // stored session is being re-confirmed by the API.
  if (sessionStatus === 'gate') return <Foundry onEntered={enterCompany} initialView={gateIntent === 'create' ? 'founder' : 'hero'} />;
  if (sessionStatus === 'checking') {
    return (
      <div className="foundry foundry-boot">
        <div className="loading-state">
          <span className="loading-bar" />
          <span>{t('app.loadingWorkspace')}</span>
        </div>
      </div>
    );
  }

  return <div className={`shell${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
    <div className={`scrim ${sidebarOpen ? 'visible' : ''}`} onClick={() => setSidebarOpen(false)} aria-hidden="true" />
    <aside className={sidebarOpen ? 'open' : ''}>
      <div className="brand-row">
        <div className="brand">{t('app.brand')} <span>{t('app.brandSuffix')}</span></div>
        <button
          className="sidebar-collapse"
          type="button"
          aria-label={sidebarCollapsed ? t('nav.expand') : t('nav.collapse')}
          aria-expanded={!sidebarCollapsed}
          title={sidebarCollapsed ? t('nav.expand') : t('nav.collapse')}
          onClick={() => setSidebarCollapsed((value) => !value)}
        >
          {sidebarCollapsed ? '»' : '«'}
        </button>
        <button className="sidebar-close" type="button" onClick={() => setSidebarOpen(false)} aria-label={t('nav.closeMenu')}>×</button>
      </div>
      <div className="company-block"><span className="company-mark">{snapshot?.company.name.slice(0, 1) ?? 'C'}</span><div><strong>{snapshot?.company.name ?? t('app.companyFallback')}</strong><span>{t('app.tagline')}</span>{founderName !== '' && <span className="founder-line">{founderName}</span>}</div></div>
      <nav aria-label={t('nav.ariaLabel')}>{NAV_GROUPS.map((group) => <div className="nav-group" key={group.labelKey}><span className="nav-label">{t(group.labelKey)}</span>{group.items.map((item) => <button className={item === activeNav ? 'active' : ''} key={item} onClick={() => navigate(item)} title={t(PAGE_KEYS[item].title)} aria-label={t(PAGE_KEYS[item].title)}><span className={`nav-icon nav-${item.toLowerCase()}`} aria-hidden="true" /><span className="nav-text">{t(PAGE_KEYS[item].title)}</span>{item === 'Approvals' && <span className="nav-count" data-count={snapshot?.workflows.filter((workflow) => isOpenApproval(workflow) && workflow['executionPlan'] !== true).length || undefined} aria-hidden="true" />}</button>)}</div>)}</nav>
      <div className="side-foot"><i className="connection-dot" data-connected={connected} /><span className="side-connection-text">{connected ? t('shell.connected') : t('shell.disconnected')}</span><span className={`side-runtime ${simulation?.paused || held ? 'paused' : 'running'}`}>{runtimeLabel}</span><button type="button" className="founder-switch" onClick={leaveCompany} title={t('foundry.switchCompany')}><span className="founder-switch-text">{t('foundry.switchCompany')}</span></button><button type="button" className="founder-switch founder-new" onClick={startNewCompany} title={t('foundry.newCompany')}><span className="founder-switch-text">{t('foundry.newCompany')}</span></button></div>
    </aside>
    <main>
      <header className="topbar"><div className="topbar-left"><button className="menu-toggle" type="button" onClick={() => setSidebarOpen(true)} aria-label={t('nav.openMenu')}>☰</button><div><p className="eyebrow">{snapshot?.company.name ?? t('app.eyebrowFallback')}</p><h1>{t(heading)}</h1></div></div><div className="topbar-right"><span className={`connection-status ${connected ? 'connected' : 'offline'}`}><i />{connected ? t('shell.statusConnected') : t('shell.statusOffline')}</span>{simulation !== null && <span className="runtime-status"><b>{runtimeDescription}</b><span>{t('shell.tick', { tick: simulation.tick })}</span></span>}<LanguageSwitch /><button type="button" className="topbar-refresh" onClick={snapshotRefresh}>{t('common.refresh')}</button></div></header>
      <FeedbackBanner feedback={feedback} />
      <section className="content">{control === null ? <Panel title={t(PAGE_KEYS[page].label)}>{snapshotState.error !== null ? <LoadError message={t('app.dataUnavailable')} onRetry={snapshotState.reload} /> : <div className="loading-state"><span className="loading-bar" /><span>{t('app.loadingWorkspace')}</span></div>}</Panel> : route.kind === 'results' ? <ResultsPage control={control} taskId={route.taskId} /> : renderPage(page, control)}</section>
    </main>
  </div>;
}

function renderPage(page: Page, control: ConsoleControl): ReactNode {
  switch (page) {
    case 'Overview': return <OverviewPage control={control} />;
    case 'Network': return <NetworkPage control={control} />;
    case 'Agents': return <AgentsPage control={control} />;
    case 'Deliverables': return <DeliverablesPage control={control} />;
    case 'Planning': return <PlanningPage control={control} />;
    case 'PlanCanvas': return <PlanCanvasPage control={control} />;
    case 'Tasks': return <TasksPage control={control} />;
    case 'Workflows': return <WorkflowsPage control={control} />;
    case 'Canvas': return <WorkflowCanvasPage control={control} />;
    case 'Approvals': return <ApprovalsPage control={control} />;
    case 'DeliveryApproval': return <DeliveryApprovalsPage control={control} />;
    case 'Promotion': return <PromotionPage control={control} />;
    case 'Publication': return <PublicationPage control={control} />;
    case 'Communications': return <CommunicationsPage control={control} />;
    case 'Theater': return <TheaterPage control={control} />;
    case 'Runtime': return <RuntimePage control={control} />;
    case 'Events': return <EventsPage control={control} />;
    default: return <OverviewPage control={control} />;
  }
}
