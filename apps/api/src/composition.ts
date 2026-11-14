import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentDefinitions, type AgentDefinitionSourceReader } from '@maoeh/agent-definition';
import { createCognitionExecutor, loadCognitionProfiles, type CognitionSourceReader } from '@maoeh/agent-cognition';
import { createFileEventStore, type FileEventStore } from '@maoeh/event-store';
import { createLlmGatewayFromConfig, createMockLlmProvider, loadLlmGatewayConfig, type LlmGateway } from '@maoeh/llm-gateway';
import { createSimulation, createKernelControlPlane, recoverControlPlane, startTickDriver, type Simulation, type TickDriver, type TickDriverOptions } from '@maoeh/kernel';
import { loadOrganization, type Organization, type OrganizationSourceReader, type OwnedOrganization } from '@maoeh/organization-model';
import { createAuthzService } from '@maoeh/permission-system';
import { controlPolicyForPosition, type ControlPlane, type ControlQuery } from '@maoeh/organization-control';
import { loadWorkflowDefinitions, type WorkflowSourceReader } from '@maoeh/workflow-engine';
import { createApiHandler, type ApiRuntime, type ContentStudioApi, type OwnershipApi, type PreviewApi, type SandboxApi } from './api-adapter.js';
import { createContentStudio, type ContentStudioInput } from './content-studio.js';
import { contentStudioPage } from './content-studio-page.js';
import { createSandboxService } from './sandbox-session.js';
import { sandboxPage } from './sandbox-page.js';
import { deterministicCognitionText } from './deterministic-cognition.js';
import { createOwnershipStore, type CreateCompanyInput, type OwnershipResult, type OwnershipStore } from './ownership-store.js';
import { deliveryFilesFromData, productNameOf } from './preview-plan.js';
import { PreviewRuntime, type ArtifactFile, type PreviewRecipe } from './preview-runtime.js';
import { translateDocument } from './translation.js';

/**
 * Preview Runtime composition (M1.6 preview).
 *
 * A delivery is a *product*, and the workflow that produced it split that product across steps:
 * `run.py` from the wiring step, `client/index.html` from the front end, `server/app.py` from the
 * back end. Starting "the artifact of one task" therefore cannot work — a single step's slice is
 * not a runnable project — so a preview composes the whole thing.
 *
 * This is the only layer that knows the workflow, which is why the recipe lives here and the
 * runner stays ignorant of the organization: the runner is handed a private copy of the product
 * and a plan, and never reaches into the runtime.
 */
export const PREVIEW_TOTAL_BYTES_CAP = 10 * 1024 * 1024;

/**
 * Where a preview's private working copy of a delivery lives.
 *
 * Deliberately inside the checkout (`.maoeh/preview/<taskId>/`) rather than in the OS temp
 * directory or in `deliverables/`: it is discoverable when something goes wrong, it survives
 * long enough for a person to inspect a failed run, and it can never overwrite the artifact the
 * organization actually delivered. An explicit override exists for tests and for an operator who
 * keeps state elsewhere.
 */
export function previewWorkspaceRoot(): string {
  const configured = process.env['MAOEH_PREVIEW_ROOT'];
  if (configured !== undefined && configured.trim() !== '') return resolve(configured.trim());
  return fileURLToPath(new URL('../../../', import.meta.url));
}

/**
 * Every delivered file of one task, in delivery order.
 *
 * The recovery rules live in `preview-plan.ts` because they are part of "what is this artifact":
 * a live model may deliver `{ "index.html": "<!doctype html>…" }` instead of a `files[]` list, and
 * a planner that only knows the richer shape reports a real, playable game as "no files".
 */
function filesOfTask(task: { readonly result: { readonly data: Readonly<Record<string, unknown>> } | null }): readonly ArtifactFile[] {
  return task.result === null ? [] : deliveryFilesFromData(task.result.data);
}

/**
 * The product a preview should run, resolved from any one of its tasks.
 *
 * The workflow's own title names the product (`Complete step "X" of workflow "Y": …`), which is
 * what the console shows over the running page; an unparsable goal degrades to the task title.
 * Reading a sibling that fails is recorded in `skipped` rather than aborting: a preview of four
 * of five delivered steps is still worth having, as long as nobody is told it is all of them.
 */
export function buildPreviewRecipe(query: ControlQuery, taskId: string): PreviewRecipe | null {
  const anchor = query.getTask(taskId);
  if (anchor === null) return null;
  const title = anchor.title.trim();

  const steps: readonly { readonly taskId: string; readonly title: string }[] =
    anchor.workflowInstanceId === null
      ? [{ taskId: anchor.taskId, title }]
      : (query.getWorkflow(anchor.workflowInstanceId)?.stepStates ?? [])
        .filter((step) => step.taskId !== null)
        .map((step) => ({ taskId: String(step.taskId), title: '' }));

  const sources: { taskId: string; title: string; files: number }[] = [];
  const skipped: { taskId: string; reason: string }[] = [];
  const files: ArtifactFile[] = [];
  const seen = new Set<string>();
  let bytes = 0;

  for (const step of steps) {
    const task = query.getTask(step.taskId);
    if (task === null) {
      skipped.push({ taskId: step.taskId, reason: 'the task belongs to this product but is no longer in the runtime' });
      continue;
    }
    const counted = filesOfTask(task).flatMap((file) => {
      if (seen.has(file.path)) return [];
      if (bytes + file.content.length > PREVIEW_TOTAL_BYTES_CAP) {
        const limitMb = String(Math.round(PREVIEW_TOTAL_BYTES_CAP / (1024 * 1024)));
        skipped.push({ taskId: step.taskId, reason: `the product is larger than the ${limitMb} MB preview limit` });
        return [];
      }
      seen.add(file.path);
      bytes += file.content.length;
      files.push(file);
      return [file];
    });
    if (counted.length > 0) sources.push({ taskId: task.taskId, title: task.title, files: counted.length });
  }

  return {
    files: Object.freeze(files.map((file) => Object.freeze({ ...file }))),
    // A standalone delivery has no workflow title to read the product name out of; its own task
    // title is the honest heading. Only a workflow step unwraps the generated goal wrapper.
    title: anchor.workflowInstanceId === null
      ? (title === '' ? anchor.taskId : title)
      : productNameOf(anchor.goal, title === '' ? anchor.taskId : title),
    taskId: anchor.taskId,
    sources: Object.freeze(sources.map((source) => Object.freeze({ ...source }))),
    skipped: Object.freeze(skipped.map((entry) => Object.freeze({ ...entry }))),
  };
}

/**
 * The Preview Runtime for one composed company: one child process and one dynamic port per
 * running preview, all of them under this company's own preview directory.
 */
export function createPreviewApi(query: ControlQuery, workspaceRoot: string): PreviewApi & { dispose: () => Promise<void> } {
  const runner = new PreviewRuntime(
    { getPreviewRecipe: async (taskId) => buildPreviewRecipe(query, taskId) },
    { workspaceRoot },
  );
  return {
    status: (taskId) => runner.status(taskId),
    start: (taskId) => runner.start(taskId),
    stop: (taskId) => runner.stop(taskId),
    dispose: () => runner.dispose(),
  };
}

const seedRoot = fileURLToPath(new URL('../../../agents/future-ai-lab/', import.meta.url));
const workflowsRoot = fileURLToPath(new URL('../../../workflows/', import.meta.url));

/**
 * The company's state directory — deliberately **outside the repository**.
 *
 * Company state must not live where repository operations happen: a `pnpm install` purge, a
 * `git clean`, deleting the checkout, or a developer (or agent) tidying up the working tree must
 * never be able to destroy the agents an operator hired. Per-user application data is the place
 * for it, and `MAOEH_EVENT_LOG` can still point anywhere (tests and the e2e use that).
 */
export function defaultStateDir(): string {
  const windows = process.env['LOCALAPPDATA'];
  const xdg = process.env['XDG_STATE_HOME'];
  return process.platform === 'win32' && windows !== undefined && windows !== ''
    ? join(windows, 'maoeh')
    : xdg !== undefined && xdg !== ''
      ? join(xdg, 'maoeh')
      : join(homedir(), '.local', 'state', 'maoeh');
}

/** Where the founder/company record lives between restarts — same rule as the event log. */
export function ownershipStorePath(): string {
  return join(defaultStateDir(), 'companies.json');
}

/**
 * Which ownership file this process uses.
 *
 * Mirrors `resolveEventLogPath` on purpose: an explicit `eventLogPath` (tests, e2e, CI) means
 * "this run is isolated", so its founder/company record is isolated with it and a test can never
 * write a developer's real `companies.json`. `MAOEH_OWNERSHIP` overrides the path the same way
 * `MAOEH_EVENT_LOG` overrides the log — a path points the record at that file, `off` / `memory` /
 * empty keeps it in memory (a server that must not touch the real record at all).
 */
export function resolveOwnershipStorePath(explicitEventLog?: string | null): string | null {
  if (explicitEventLog !== undefined) return null;
  const configured = process.env['MAOEH_OWNERSHIP'];
  if (configured === undefined) return ownershipStorePath();
  const value = configured.trim();
  if (value === '' || value === 'off' || value === 'memory') return null;
  return resolve(value);
}

export function defaultEventLogPath(): string {
  return join(defaultStateDir(), 'future-ai-lab', 'events.jsonl');
}

/**
 * Where the company's event log lives between restarts.
 *
 * The log *is* the durability boundary: the kernel replays it on boot, so agents created from the
 * console (and every task, workflow, message and pause) come back instead of resetting to the
 * seed. `MAOEH_EVENT_LOG` overrides the path; `off` / `memory` / an empty value keeps the run
 * in-memory, which is what the tests and the e2e use so each run is isolated. Delete the file to
 * start over from the seed.
 */
export function resolveEventLogPath(explicit: string | null | undefined): string | null {
  if (explicit !== undefined) return explicit;
  const configured = process.env['MAOEH_EVENT_LOG'];
  if (configured === undefined) return defaultEventLogPath();
  const value = configured.trim();
  if (value === '' || value === 'off' || value === 'memory') return null;
  return resolve(value);
}

/**
 * The same resolution, but for a *named* company (M1.5): every company owns its own log, so one
 * founder's hires never replay into another company.
 *
 * The configured path (an explicit `eventLogPath`, else `MAOEH_EVENT_LOG`, else the default) is
 * where the *lab* company's history lives — it is the file the platform was already writing. Any
 * other company gets `<that directory>/<organizationId>/events.jsonl`, which keeps a shared
 * override (tests, e2e, CI) from leaking one company's events into the next, and keeps every new
 * company's memory in the same place the override pointed at instead of in the real state
 * directory. An in-memory run (`off` / `memory` / `null`) stays in-memory for every company.
 */
export function resolveCompanyEventLogPath(company: OwnedOrganization, explicit: string | null | undefined): string | null {
  const configured = resolveEventLogPath(explicit);
  if (configured === null) return null;
  if (company.seed === 'lab') return configured;
  return join(dirname(configured), String(company.id), 'events.jsonl');
}
const readTree = (directory: string): string[] => existsSync(join(seedRoot, directory)) ? readdirSync(join(seedRoot, directory)).filter((name) => name.endsWith('.yaml') || name.endsWith('.yml')).map((name) => `${directory}/${name}`).sort() : [];
const readSeedFile = (path: string): string | null => existsSync(join(seedRoot, path)) ? readFileSync(join(seedRoot, path), 'utf8') : null;
const reader = { list: async (directory: string) => readTree(directory), read: async (path: string) => readSeedFile(path) } satisfies AgentDefinitionSourceReader & CognitionSourceReader;
const workflowReader = { list: (directory: string) => { const root = join(workflowsRoot, directory); if (!existsSync(root)) return []; return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => readdirSync(join(root, e.name)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).map((f) => e.name + '/' + f)); }, read: (path: string) => existsSync(join(workflowsRoot, path)) ? readFileSync(join(workflowsRoot, path), 'utf8') : null } satisfies WorkflowSourceReader;

/**
 * The seed organization as *this* company: the identity lines of `company.yaml` are replaced by
 * the founder's own company name and id, everything else (chart, roster, cognition) comes from
 * the same seed the Future AI Lab is built from. The seed file stays untouched on disk — a
 * company name is runtime state, not repository content.
 */
function companyIdentityText(text: string, id: string, name: string): string {
  const body = text.split(/\r?\n/).filter((line) => !/^(id|name):/.test(line)).join('\n');
  return `id: ${JSON.stringify(id)}\nname: ${JSON.stringify(name)}\n${body}`;
}

function organizationReaderFor(company: OwnedOrganization): OrganizationSourceReader {
  return {
    list: (directory: string) => readTree(directory),
    read: (path: string) => {
      const text = readSeedFile(path);
      if (text === null || path !== 'company.yaml') return text;
      return companyIdentityText(text, String(company.id), company.name);
    },
  };
}

/**
 * A newly founded company opens with the seat at the top of the chart — its CEO — and an
 * organization chart it can hire into. Every other employee in the seed is dropped; the agent
 * definitions are narrowed to the surviving roster, because a definition whose employee does not
 * exist is a load failure (`agent-definition` contract), not an unused file.
 */
function toStarterOrganization(organization: Organization): Organization {
  const rootPositions = new Set(
    organization.positions
      .filter((position) => position.reportsToPositionId === null)
      .map((position) => String(position.id)),
  );
  organization.employees = organization.employees.filter((employee) => rootPositions.has(String(employee.positionId)));
  return organization;
}

function definitionReaderFor(organization: Organization): AgentDefinitionSourceReader & CognitionSourceReader {
  const employees = new Set(organization.employees.map((employee) => String(employee.id)));
  return {
    list: async (directory: string) => {
      const entries = readTree(directory);
      if (directory !== 'agent-definitions') return entries;
      return entries.filter((path) => {
        const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.ya?ml$/, '');
        return employees.has(base);
      });
    },
    read: async (path: string) => readSeedFile(path),
  };
}

export interface ComposedRuntime {
  readonly simulation: Simulation;
  readonly api: ApiRuntime;
  /** The company this runtime runs: what the console shows as "my company". */
  readonly organizationId: OwnedOrganization['id'];
  /** Absolute path of the durable event log, or `null` when this runtime is in-memory only. */
  readonly eventLogPath: string | null;
  /** Why a configured log could not be opened, when the runtime fell back to memory. */
  readonly eventLogFailure: string | null;
  /**
   * The gateway this runtime thinks with, exposed read-only for tools that must borrow it instead
   * of building a second one (the sandbox session uses it so `/api/llm` counts those calls too).
   */
  readonly gateway: LlmGateway;
}

export interface ComposedRuntimeOptions {
  /** Override the log path; `null` forces a throwaway in-memory run. Defaults to `MAOEH_EVENT_LOG`. */
  readonly eventLogPath?: string | null;
  /**
   * M1.9: drafts wait for the human's confirm on the canvas. Defaults to `true` (the console's
   * behavior); tests opt out to keep the pre-existing autonomous loop intact.
   */
  readonly requirePlanConfirmation?: boolean;
  /**
   * Which founder's which company this runtime is. Defaults to an isolated in-memory record
   * seeded with `Guest Founder` + `Future AI Lab`, so a test (or an `eventLogPath` run) never
   * reads a developer's real ownership file. The server passes its own store.
   */
  readonly ownership?: OwnershipStore;
}

export async function createComposedRuntime(options: ComposedRuntimeOptions = {}): Promise<ComposedRuntime> {
  const ownership = options.ownership ?? createOwnershipStore({ path: null });
  ownership.ensureDefaults();
  const ownershipState = ownership.state();
  const company = ownershipState.organizations.find((entry) => entry.id === ownershipState.activeOrganizationId);
  if (company === undefined) throw new Error('ownership record has no active company');
  const eventLogPath = resolveCompanyEventLogPath(company, options.eventLogPath);
  let eventStore: FileEventStore | null = null;
  let eventLogFailure: string | null = null;
  if (eventLogPath !== null) {
    try {
      eventStore = createFileEventStore({ path: eventLogPath });
    } catch (error) {
      // A state directory that cannot be written (permissions, a read-only home) must degrade to
      // an in-memory company with a loud banner, not take the whole API down.
      const reason = error instanceof Error ? error.message : String(error);
      eventLogFailure = `${eventLogPath}: ${reason}`;
    }
  }
  const organizationResult = loadOrganization(organizationReaderFor(company)); if (!organizationResult.ok) throw new Error('organization load failed');
  const organization = organizationResult.value;
  // M1.5: the company on screen is the company the founder owns — name, id and owner all come
  // from the ownership record, never from the seed file.
  organization.company.ownerId = company.ownerId;
  if (company.seed === 'starter') toStarterOrganization(organization);
  const profilesResult = await loadCognitionProfiles({ reader }); if (!profilesResult.ok) throw new Error('cognition profile load failed');
  const definitionsResult = await loadAgentDefinitions({ reader: definitionReaderFor(organization), organization, cognitionProfileIds: profilesResult.value.map((profile) => profile.id) }); if (!definitionsResult.ok) throw new Error('agent definition load failed');
  const workflowsResult = loadWorkflowDefinitions(workflowReader, ''); if (!workflowsResult.ok) throw new Error('workflow load failed');
  /**
   * The mock provider answers with the same JSON contract a live model would return, derived from
   * the prompt itself: a stand-in that returns an empty plan fails `cognitionOutputSchema` and
   * turns every turn into a `schema_violation`, which is how the console came to show a running
   * organization that never did anything.
   *
   * It is still the default substrate. `loadLlmGatewayConfig` yields `mode: 'mock'` unless the
   * environment explicitly asks for a live model, so an operator who sets no LLM variable at all
   * sees no change.
   *
   * The mock is built here rather than inside the factory because `/llm` reports its call
   * counter, and `now` is pinned to a constant so ledger timestamps stay deterministic exactly as
   * they were before configuration existed.
   */
  const provider = createMockLlmProvider({ text: deterministicCognitionText });
  const llmConfig = loadLlmGatewayConfig(process.env);
  if (!llmConfig.ok) {
    // Refusing to boot beats the alternative: answering from the mock while the operator believes
    // a real model is thinking is indistinguishable from success at every layer above.
    throw new Error(
      `LLM configuration is invalid — ${llmConfig.error.issues
        .map((issue) => `${issue.field} ${issue.reason}`)
        .join('; ')}`,
    );
  }
  const llmProviderConfig = llmConfig.value.providers[0];
  const assembled = createLlmGatewayFromConfig(llmConfig.value, {
    createMockProvider: () => provider,
    now: () => 1,
  });
  if (!assembled.ok) {
    throw new Error(
      `LLM gateway could not be assembled — ${assembled.error.issues
        .map((issue) => `${issue.field} ${issue.reason}`)
        .join('; ')}`,
    );
  }
  // Counts gateway calls, which is what `/llm` reports when a live provider is in use. In mock
  // mode the mock's own counter is reported instead, so that number keeps its existing meaning.
  let liveCallCount = 0;
  const gateway: LlmGateway = {
    generate: (input) => {
      liveCallCount += 1;
      return assembled.value.generate(input);
    },
  };
  const cognition = createCognitionExecutor({ gateway });
  // M1.9: the console waits for the human's confirm on the canvas — capability-generated
  // workflows start parked as drafts until then. Tests opt out via ComposedRuntimeOptions.
  const simulation = await createSimulation({
    organization,
    agentDefinitions: definitionsResult.value,
    cognitionProfiles: profilesResult.value,
    workflowDefinitions: workflowsResult.value,
    cognition,
    config: { tickDuration: 1, startTick: 0 },
    requirePlanConfirmation: options.requirePlanConfirmation ?? true,
    ...(eventStore === null ? {} : { eventStore }),
  });
  const operator = organization.employees[0]; if (operator === undefined) throw new Error('organization has no operator');
  /**
   * 一鱼多吃's real generator: the same gateway the organization thinks with, one call per
   * platform, attributed to the founder's seat. It is a tool, not an agent cycle — it writes no
   * event — but it is not anonymous either: the call carries an actor context and is counted by
   * `/api/llm`, and the response labels mock output as mock.
   */
  const contentStudio = createContentStudio({
    gateway,
    provenance: llmConfig.value.mode === 'live' ? 'live' : 'mock',
    provider: llmConfig.value.defaultProvider,
    model: llmProviderConfig === undefined ? null : llmProviderConfig.model,
    actorContext: simulation.identity.actorContext(operator.id, 'corr-content-studio' as never),
  });
  const plane = createKernelControlPlane({ simulation, authz: createAuthzService({ organization, policy: controlPolicyForPosition(String(operator.positionId)) }), registry: simulation.registry, eventStore: simulation.eventStore });
  await recoverControlPlane(plane.control, plane.audit, simulation.eventStore);
  return {
    simulation,
    organizationId: company.id,
    api: {
      control: plane.control,
      query: plane.control.query,
      tick: () => simulation.tick(),
      llm: () => ({
        callCount: llmConfig.value.mode === 'mock' ? provider.callCount : liveCallCount,
        provider: llmConfig.value.defaultProvider,
        mode: llmConfig.value.mode,
        ...(llmProviderConfig === undefined ? {} : { model: llmProviderConfig.model }),
      }),
      content: {
        page: contentStudioPage,
        generate: (input) => contentStudio.generate(input),
      },
    },
    eventLogPath: eventStore === null ? null : eventLogPath,
    eventLogFailure,
    gateway,
  };
}

export interface StartApiServerOptions {
  /** Tick driver tuning; the driver itself is owned by the server. */
  readonly tick?: TickDriverOptions;
  /** Event log path override; `null` runs without persistence. See `resolveEventLogPath`. */
  readonly eventLogPath?: string | null;
  /** M1.9: forwarded to `createComposedRuntime`. Defaults to `true`. */
  readonly requirePlanConfirmation?: boolean;
}

export async function startApiServer(
  port = Number(process.env.PORT ?? 3001),
  options: StartApiServerOptions = {},
): Promise<{ close: () => Promise<void>; runtime: ComposedRuntime; port: number; driver: TickDriver }> {
  // An explicit event log path (tests, e2e, CI) means "this run is isolated", so the ownership
  // record is isolated with it; the default boot owns the real file beside the event logs.
  const ownership = createOwnershipStore({ path: resolveOwnershipStorePath(options.eventLogPath) });
  /**
   * M1.9: the console confirms generated plans on the canvas by default. Headless harnesses
   * (the e2e scripts, a CI boot) may opt out with `MAOEH_REQUIRE_PLAN_CONFIRMATION=0` and keep
   * the pre-M1.9 autonomous loop; an explicit option always wins over the environment.
   */
  const requirePlanConfirmation = options.requirePlanConfirmation
    ?? (process.env['MAOEH_REQUIRE_PLAN_CONFIRMATION'] === '0' ? false : undefined);
  const runtimeOptions = {
    ...(options.eventLogPath === undefined ? {} : { eventLogPath: options.eventLogPath }),
    ...(requirePlanConfirmation === undefined ? {} : { requirePlanConfirmation }),
    ownership,
  };
  let runtime = await createComposedRuntime(runtimeOptions);
  const tickOptions = options.tick ?? {};
  let driver = startTickDriver(runtime.simulation, tickOptions);
  describeRuntime(runtime);
  // A company switch swaps the simulation, the control plane and the driver together: requests
  // wait on `gate` so a snapshot can never read half of one company and half of another.
  let gate: Promise<unknown> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = gate.then(task, task);
    gate = next.then(() => undefined, () => undefined);
    return next;
  };
  const switchCompany = async (): Promise<void> => {
    driver.stop();
    // The old company's previews belong to the old company: stop them before the new runtime
    // exists, so no child process outlives the company it was started for.
    await previewRunner.dispose();
    runtime = await createComposedRuntime(runtimeOptions);
    previewRunner = createPreviewApi(runtime.api.query, previewWorkspaceRoot());
    describeRuntime(runtime);
    driver = startTickDriver(runtime.simulation, tickOptions);
  };
  const ownershipApi: OwnershipApi = {
    state: () => ownership.state(),
    createCompany: async (input: CreateCompanyInput): Promise<OwnershipResult> => {
      const result = ownership.createCompany(input);
      if (result.ok && result.organization.id !== runtime.organizationId) await enqueue(switchCompany);
      return result;
    },
    activate: async (organizationId: string): Promise<OwnershipResult> => {
      const result = ownership.activate(organizationId);
      if (result.ok && result.organization.id !== runtime.organizationId) await enqueue(switchCompany);
      return result;
    },
  };
  // The engine behind Resume: without it the scheduler flag flips but nothing ticks, so
  // the console keeps rendering a simulation that never advances on its own.
  const controlPlaneFor = (current: ComposedRuntime): ControlPlane => {
    const inner = current.api.control;
    return {
      execute: async (command) => {
        const outcome = await inner.execute(command);
        driver.kick();
        return outcome;
      },
      hydrate: (events) => inner.hydrate(events),
      query: inner.query,
      state: () => inner.state(),
    };
  };
  // A control command is new work for the organization (an instruction, an injected task,
  // a resume). Kick the driver so it lands on the next tick instead of waiting out the
  // idle interval.
  // One preview runner per composed runtime, so a company switch never lets a preview of the
  // previous company answer for the new one. The previous runner is disposed (and its child
  // processes killed) as soon as it is replaced, because nothing can reach it any more.
  let previewRunner = createPreviewApi(runtime.api.query, previewWorkspaceRoot());
  const composedPreview: PreviewApi = {
    status: (taskId) => previewRunner.status(taskId),
    start: (taskId) => previewRunner.start(taskId),
    stop: (taskId) => previewRunner.stop(taskId),
  };
  /**
   * The workbench follows the current runtime, like every other read here. It is a thin forwarder
   * rather than a captured instance so a company switch can never leave the page generating under
   * the previous company's composition (the gateway itself is per runtime).
   */
  const currentContent = () => {
    const content = runtime.api.content;
    if (content === undefined) throw new Error('this runtime has no content studio');
    return content;
  };
  const forwardedContent: ContentStudioApi = {
    page: () => currentContent().page(),
    generate: (input: ContentStudioInput) => currentContent().generate(input),
  };
  /**
   * 赛博沙盘 runs on its own composed runtime with its own event log.
   *
   * That isolation is the design, not a shortcut: a session injects real `Communication.MessageSent`
   * facts, and injecting them into the live company would wake its agents and start a second,
   * unscripted conversation on top of the session. The demo company's log is never written.
   */
  const sandboxStateDir = join(defaultStateDir(), 'sandbox');
  let sandboxRuntime: Promise<ComposedRuntime> | null = null;
  const ensureSandboxRuntime = (): Promise<ComposedRuntime> => {
    if (sandboxRuntime === null) {
      sandboxRuntime = createComposedRuntime({
        eventLogPath: join(sandboxStateDir, 'events.jsonl'),
        requirePlanConfirmation: false,
      }).catch((error: unknown) => {
        // An unwritable state directory must not take the workbench down; the session still runs,
        // it just does not survive a restart — and the failure is announced.
        console.warn(`[sandbox] falling back to an in-memory session log: ${String(error)}`);
        return createComposedRuntime({ eventLogPath: null, requirePlanConfirmation: false });
      });
    }
    return sandboxRuntime;
  };
  const sandboxService = createSandboxService({
    runtime: () => ensureSandboxRuntime(),
    gateway: () => runtime.gateway,
    provenance: () => (runtime.api.llm?.().mode === 'live' ? 'live' : 'mock'),
    provider: () => runtime.api.llm?.().provider ?? null,
    model: () => runtime.api.llm?.().model ?? null,
    sessionsDir: sandboxStateDir,
  });
  const sandboxApi: SandboxApi = {
    page: sandboxPage,
    start: (input) => sandboxService.start(input),
    list: (limit) => sandboxService.list(limit),
    get: (sessionId) => sandboxService.get(sessionId),
  };
  const api: ApiRuntime = {
    get control() { return controlPlaneFor(runtime); },
    get query() { return runtime.api.query; },
    content: forwardedContent,
    sandbox: sandboxApi,
    tick: async () => {
      const tick = runtime.api.tick;
      return tick === undefined ? { error: 'tick is unavailable' } : await tick();
    },
    llm: () => runtime.api.llm?.() ?? { callCount: 0 },
    ownership: ownershipApi,
    // The query resolves against the *current* runtime, so a company switch also switches which
    // company's deliveries can be previewed. Previews of the previous company are stopped by
    // their own idle reaper and never answer for the new one.
    preview: {
      status: (taskId) => composedPreview.status(taskId),
      start: (taskId) => composedPreview.start(taskId),
      stop: (taskId) => composedPreview.stop(taskId),
    },
    translate: (input) => translateDocument(input),
  };
  const handler = createApiHandler(api);
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = `http://${request.headers.host ?? 'localhost'}${request.url ?? '/'}`; const body = Buffer.concat(chunks);
    const apiRequest = new Request(url, { method: request.method ?? 'GET', headers: request.headers as Record<string, string>, ...(body.length === 0 || request.method === 'GET' || request.method === 'HEAD' ? {} : { body }) });
    await gate;
    const apiResponse = await handler(apiRequest); response.statusCode = apiResponse.status; apiResponse.headers.forEach((value, key) => response.setHeader(key, value)); response.end(Buffer.from(await apiResponse.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(port, resolve)); const address = server.address(); const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  return {
    get runtime() { return runtime; },
    port: actualPort,
    get driver() { return driver; },
    close: async () => {
      driver.stop();
      // Every preview is a real child process holding a real port, so the shutdown does not
      // complete until they are gone. This is awaited rather than fired and forgotten: a caller
      // that closes the server and immediately exits (a test, a supervisor, Ctrl+C) would
      // otherwise leave a serving process behind, and a process whose only job was to stop it.
      await previewRunner.dispose();
      // Keep-alive sockets from fetch-based clients otherwise hold `close()` open until
      // they time out, which hangs a graceful shutdown.
      const closing = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      return closing;
    },
  };
}

/**
 * Say out loud which company this is, where its memory lives and how much of it came back:
 * "my agents disappeared" is answered by this line, an in-memory run says so instead of
 * silently forgetting everything, and a company switch announces itself the same way.
 */
function describeRuntime(runtime: ComposedRuntime): void {
  const recovered = runtime.simulation.recovery;
  const employees = runtime.simulation.organization.employees.length;
  const company = runtime.simulation.organization.company.name;
  console.log(
    runtime.eventLogPath === null
      ? runtime.eventLogFailure === null
        ? `[api] company: ${company} — event log: in-memory (nothing survives a restart)`
        : `[api] company: ${company} — event log: in-memory — could not open ${runtime.eventLogFailure}`
      : `[api] company: ${company} — event log: ${runtime.eventLogPath} (recovered ${String(recovered.eventCount)} events, ${String(employees)} employees)`,
  );
}
