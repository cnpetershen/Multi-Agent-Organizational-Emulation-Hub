import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CorrelationId, OrgEvent, SimTime } from '@maoeh/shared-types';
import type { AgentDefinition, AgentDefinitionSourceReader } from '@maoeh/agent-definition';
import { loadAgentDefinitions } from '@maoeh/agent-definition';
import type { CognitionProfile, CognitionSourceReader } from '@maoeh/agent-cognition';
import { createCognitionExecutor, loadCognitionProfiles } from '@maoeh/agent-cognition';
import type { LlmGateway, LlmRequest } from '@maoeh/llm-gateway';
import { createLlmGateway, createMockLlmProvider } from '@maoeh/llm-gateway';
import type { EventStore } from '@maoeh/event-store';
import type { Identity } from '@maoeh/identity-system';
import { createIdentity } from '@maoeh/identity-system';
import type { Organization } from '@maoeh/organization-model';
import { loadOrganization } from '@maoeh/organization-model';
import type { CommandActor, PermissionPolicy } from '@maoeh/permission-system';
import { employeeActor } from '@maoeh/permission-system';
import type { SimulationBudget } from '@maoeh/runtime-scheduler';
import type {
  Simulation,
  SimulationConfigOptions,
  SimulationTickResult,
} from '@maoeh/kernel';
import { must, sim } from './workflow-fixtures';
import { createSimulation } from '@maoeh/kernel';
import type { WorkflowDefinition } from '@maoeh/workflow-engine';
import { loadWorkflowDefinitions } from '@maoeh/workflow-engine';
import { validOutput } from './cognition-fixtures';
import { seedRoot } from './communication-fixtures';
import { createNodeFsOrganizationReader } from './organization-readers';
import { createNodeFsWorkflowReader } from './workflow-readers';

const PRODUCT_ANALYSIS = 'product-analysis';

function createSourceReader(): AgentDefinitionSourceReader & CognitionSourceReader {
  return {
    async list(relativeDirectory) {
      const directory = join(seedRoot, relativeDirectory);
      if (!existsSync(directory)) return [];
      return readdirSync(directory)
        .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
        .map((entry) => `${relativeDirectory}/${entry}`)
        .sort();
    },
    async read(relativePath) {
      const filePath = join(seedRoot, relativePath);
      if (!existsSync(filePath)) return null;
      return readFileSync(filePath, 'utf8');
    },
  };
}

export function loadSeedOrganization(): Organization {
  const result = loadOrganization(createNodeFsOrganizationReader(seedRoot));
  if (!result.ok) {
    throw new Error(
      `seed organization failed: ${result.error.issues
        .map((issue) => `${issue.source}:${issue.reason}`)
        .join(', ')}`,
    );
  }
  return result.value;
}

export function loadSeedWorkflows(): readonly WorkflowDefinition[] {
  const result = loadWorkflowDefinitions(createNodeFsWorkflowReader(), '');
  if (!result.ok) {
    throw new Error(
      `seed workflows failed: ${result.error.issues
        .map((issue) => `${issue.field}: ${issue.reason}`)
        .join(', ')}`,
    );
  }
  return result.value;
}

/**
 * Mechanics double, not a delivery double.
 *
 * `planForPrompt` exists so runtime/workflow/state-machine tests have a deterministic executor;
 * its work product is intentionally a constant, because those tests assert on *transitions*
 * (accept → start → submit → complete, workflow advancement, replay parity), never on content.
 *
 * The production work product is shaped per mandate by `apps/api/src/deterministic-cognition.ts`,
 * and `tests/acceptance/game-mandate-deliverable.test.ts` is the acceptance claim that a real
 * mandate yields a goal-anchored, runnable delivery. Do not copy this constant into a test that
 * is about what an owner sees on the delivery page.
 */
const TASK_OUTPUT_DATA: Readonly<Record<string, unknown>> = Object.freeze({
  problem: 'churn is rising',
  success_criteria: 'root causes identified',
  approach: 'phased rollout',
  risks: ['capacity'],
  recommendation: 'ship the analysis',
});

function idFromPrompt(prompt: string, key: string): string | null {
  const match = new RegExp(`"${key}":\\s*"([^"]+)"`).exec(prompt);
  return match?.[1] ?? null;
}

function taskIdFromPrompt(prompt: string): string | null {
  return idFromPrompt(prompt, 'taskId');
}

export function planForPrompt(prompt: string): string {
  if (prompt.includes('Workflow.ApprovalRequested')) {
    const instanceId = idFromPrompt(prompt, 'instanceId');
    return validOutput({
      steps:
        instanceId === null
          ? []
          : [{ action: 'CastVote', args: { instanceId, decision: 'granted' }, reasonRef: 0 }],
    });
  }
  const taskId = taskIdFromPrompt(prompt);
  if (taskId === null) {
    return validOutput({ steps: [] });
  }
  return validOutput({
    steps: [
      { action: 'AcceptTask', args: { taskId }, reasonRef: 0 },
      { action: 'StartTask', args: { taskId }, reasonRef: 0 },
      {
        action: 'ProgressReport',
        args: { taskId, summary: 'work complete', data: TASK_OUTPUT_DATA },
        reasonRef: 1,
      },
    ],
  });
}

export interface SimulationHarnessOptions {
  readonly config?: SimulationConfigOptions;
  readonly budget?: Partial<SimulationBudget>;
  readonly eventStore?: EventStore;
  /**
   * Override the seed organization. M1.0 needs a human operator occupying a real
   * position, which the AI-employee-only seed does not contain.
   */
  readonly organization?: Organization;
  /** Override the seed workflow definitions (M1.0 human-decidable approval gates). */
  readonly workflowDefinitions?: readonly WorkflowDefinition[];
  /**
   * Override the mock LLM's prompt -> plan mapping. Defaults to `planForPrompt`, which only
   * understands task/approval prompts; control-plane tests need to script cognition for
   * operator-supplied input events. The formatter receives the full `LlmRequest`.
   */
  readonly llmText?: (request: LlmRequest) => string;
  /**
   * Override the agent permission policy handed to the kernel. M1.4 acceptance 4 needs a
   * deliberately granted seat to reach the dispatch scope gate (A2) instead of being stopped
   * by A1's authority threshold; every other test stays on `DEFAULT_AGENT_POLICY`.
   */
  readonly agentPolicy?: PermissionPolicy;
  /**
   * Narrow the seed's agent definitions to the roster the caller actually passed.
   *
   * The seed on disk defines six employees; a caller that hands in a smaller organization (a
   * `starter` company with only the CEO, `Agent.Create` scenarios that start from one seat) must
   * also drop the definitions of employees who are not in it — `agent-definition` fails the whole
   * load when a definition names an employee the organization does not contain.
   */
  readonly definitionsForRosterOnly?: boolean;
}

export interface SimulationHarness {
  readonly simulation: Simulation;
  readonly organization: Organization;
  readonly identity: Identity;
  readonly definitions: readonly AgentDefinition[];
  readonly profiles: readonly CognitionProfile[];
  readonly gateway: LlmGateway;
  readonly provider: ReturnType<typeof createMockLlmProvider>;
  actor(employeeId: string): CommandActor;
  startProductAnalysis(): Promise<string>;
  run(ticks: number): Promise<readonly SimulationTickResult[]>;
}

export async function createSimulationHarness(
  options: SimulationHarnessOptions = {},
): Promise<SimulationHarness> {
  const organization = options.organization ?? loadSeedOrganization();
  const identity = createIdentity(organization);
  const seedReader = createSourceReader();

  const profilesResult = await loadCognitionProfiles({ reader: seedReader });
  if (!profilesResult.ok) throw new Error('cognition profiles failed to load');
  const profiles = profilesResult.value;

  // `agent-definition` fails the *whole* load when a definition names an employee the
  // organization does not contain, so a narrowed roster has to narrow the source list too —
  // filtering the loaded result would be too late. The definition id is its file basename
  // (`agent-definitions/<employee>.yaml`), which is exactly the employee it belongs to.
  const rosterOnly = options.definitionsForRosterOnly;
  const reader =
    rosterOnly === undefined || rosterOnly === false
      ? seedReader
      : {
          ...seedReader,
          list: async (directory: string): Promise<readonly string[]> => {
            const listed = await seedReader.list(directory);
            if (directory !== 'agent-definitions') return listed;
            return listed.filter((path) => {
              const employee = path.slice(path.lastIndexOf('/') + 1).replace(/\.ya?ml$/, '');
              return organization.employees.some((entry) => String(entry.id) === employee);
            });
          },
        };

  const definitionsResult = await loadAgentDefinitions({
    reader,
    organization,
    cognitionProfileIds: profiles.map((profile) => profile.id),
  });
  if (!definitionsResult.ok) throw new Error('agent definitions failed to load');
  const definitions = definitionsResult.value;

  const provider = createMockLlmProvider({
    // `createMockLlmProvider` hands the formatter the whole `LlmRequest`; `planForPrompt` parses
    // its `prompt` string, so the default must unwrap it explicitly.
    text: options.llmText ?? ((request) => planForPrompt(request.prompt)),
  });
  const gateway = createLlmGateway({
    providers: [provider],
    defaultProvider: 'mock',
    now: () => 1,
  });
  const executor = createCognitionExecutor({ gateway });

  const simulation = await createSimulation({
    organization,
    agentDefinitions: definitions,
    cognitionProfiles: profiles,
    workflowDefinitions: options.workflowDefinitions ?? loadSeedWorkflows(),
    cognition: executor,
    policy: options.agentPolicy,
    config: {
      tickDuration: 1,
      startTick: 0,
      ...(options.config ?? {}),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    },
    ...(options.eventStore === undefined ? {} : { eventStore: options.eventStore }),
  });

  let correlationSeq = 0;

  const actor = (employeeId: string): CommandActor =>
    employeeActor(
      identity.actorContext(
        employeeId as never,
        `corr-harness-${(correlationSeq += 1)}` as CorrelationId,
      ),
    );

  return {
    simulation,
    organization,
    identity,
    definitions,
    profiles,
    gateway,
    provider,
    actor,
    async startProductAnalysis() {
      const operation = must(
        simulation.workflow.start({
          workflowId: PRODUCT_ANALYSIS,
          actor: actor('ceo-alex'),
          simTime: sim(0),
          title: 'Analyze the market',
          goal: 'Explain the competitive landscape',
        }),
        'product-analysis start',
      );
      await simulation.inject(operation.events);
      return operation.instance.instanceId;
    },
    async run(ticks) {
      const results: SimulationTickResult[] = [];
      for (let index = 0; index < ticks; index += 1) {
        results.push(await simulation.tick());
      }
      return results;
    },
  };
}

export function eventsOfType(events: readonly OrgEvent[], type: string): readonly OrgEvent[] {
  return events.filter((event) => event.type === type);
}

export function tickSimTime(tickNumber: number): SimTime {
  return sim(tickNumber);
}
