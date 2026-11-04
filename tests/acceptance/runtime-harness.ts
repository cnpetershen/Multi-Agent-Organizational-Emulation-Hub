/**
 * M1.0 Runtime Acceptance harness.
 *
 * This file adds **no runtime**. It composes the existing kernel (`@maoeh/kernel`),
 * the existing seed (`agents/future-ai-lab`, `workflows/`), the existing cognition
 * executor and the existing M1.0 control plane through `tests/helpers/control-fixtures`,
 * and then only *observes* - one tick at a time - what the real chain does:
 *
 *   Simulation -> Scheduler -> Agent Runtime -> Cognition -> Task -> Workflow
 *   -> Communication -> EventStore -> Control Plane
 *
 * The LLM is a deterministic *mechanics* double (`acceptanceCognition`), not the production
 * cognition: these scenarios assert on transitions (pause/resume, recovery parity, approval
 * gates), so they deliberately pin the template `product-analysis` workflow and a constant work
 * product. The production cognition is `apps/api/src/deterministic-cognition.ts`; a mandate's
 * real, goal-anchored delivery is proven by
 * `tests/acceptance/game-mandate-deliverable.test.ts`. Everything else on the chain is the real
 * code path.
 */
import type { EmployeeId, OrgEvent } from '@maoeh/shared-types';
import type { LlmRequest } from '@maoeh/llm-gateway';
import type { PermissionPolicy } from '@maoeh/permission-system';
import type { SimulationTickResult, SimulationTickStatus } from '@maoeh/kernel';
import type { ControlActor, ControlCommand, ControlTargetType } from '@maoeh/organization-control';
import type { AgentTurnRecord } from '@maoeh/kernel';

import { companyChannelId, DEFAULT_AGENT_POLICY } from '@maoeh/kernel';
import {
  OPERATOR_EMPLOYEE_ID,
  OPERATOR_POSITION_ID,
  collectEvents,
  createControlHarness,
  humanDecidableWorkflowDefinitions,
  loadSeedOrganizationWithOperators,
  type ControlHarness,
} from '../helpers/control-fixtures';
import { loadSeedWorkflows } from '../helpers/simulation-fixtures';

/** The company-wide channel every fresh simulation boots with (M1.0.1 K1). */
export const COMPANY_CHANNEL_ID = companyChannelId('future-ai-lab');

/**
 * Agent policy (unchanged from the kernel default) plus the M1.0 control grants for the
 * human board operator. Nothing is denied, so both the AI employees and the human
 * operator keep the authority the seed organization gives them.
 */
export const ACCEPTANCE_POLICY: PermissionPolicy = Object.freeze({
  grants: Object.freeze([
    ...DEFAULT_AGENT_POLICY.grants,
    { subject: { kind: 'position', positionId: OPERATOR_POSITION_ID }, action: 'ControlSimulation', resource: '*' },
    { subject: { kind: 'position', positionId: OPERATOR_POSITION_ID }, action: 'ControlAgent', resource: '*' },
    { subject: { kind: 'position', positionId: OPERATOR_POSITION_ID }, action: 'ControlWorkflow', resource: '*' },
    { subject: { kind: 'position', positionId: OPERATOR_POSITION_ID }, action: 'ControlTask', resource: '*' },
    { subject: { kind: 'position', positionId: OPERATOR_POSITION_ID }, action: 'InjectOrganizationInput', resource: '*' },
  ] as PermissionPolicy['grants']),
  denies: Object.freeze([]),
});

/* ------------------------------------------------------------------ cognition ---- */

interface ParsedPrompt {
  readonly selfId: string;
  readonly event: Readonly<Record<string, unknown>>;
}

function section(prompt: string, start: string, end: string): string | null {
  const from = prompt.indexOf(start);
  if (from < 0) return null;
  const to = prompt.indexOf(end, from + start.length);
  if (to < 0) return null;
  return prompt.slice(from + start.length, to);
}

export function parseCognitionPrompt(prompt: string): ParsedPrompt {
  const selfMatch = /^Self: .* \[([^\]]+)\]$/m.exec(prompt);
  const raw = section(prompt, '## Input event\n', '\n\n## Required JSON schema');
  let event: Readonly<Record<string, unknown>> = {};
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw.trim());
      if (typeof parsed === 'object' && parsed !== null) {
        event = parsed as Readonly<Record<string, unknown>>;
      }
    } catch {
      event = {};
    }
  }
  return { selfId: selfMatch?.[1] ?? '', event };
}

function payloadOf(event: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const payload = event['payload'];
  return typeof payload === 'object' && payload !== null
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

function str(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function strArray(record: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * The constant work product this mechanics double submits for every task.
 *
 * Scenarios here assert on lifecycle and parity, never on content, so one constant keeps the
 * traces easy to read. The production executor shapes its delivery per mandate — see
 * `apps/api/src/deterministic-cognition.ts` and `game-mandate-deliverable.test.ts`.
 */
const TASK_OUTPUT_DATA: Readonly<Record<string, unknown>> = Object.freeze({
  problem: 'churn is rising',
  success_criteria: 'root causes identified',
  approach: 'phased rollout',
  risks: ['capacity'],
  recommendation: 'ship the analysis',
});

function output(input: {
  readonly interpretation: string;
  readonly considerations: readonly string[];
  readonly conclusion: string;
  readonly goal: string;
  readonly doneWhen: string;
  readonly steps: readonly {
    readonly action: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly reasonRef: number;
  }[];
}): string {
  return JSON.stringify({
    interpretation: input.interpretation,
    considerations: [...input.considerations],
    conclusion: input.conclusion,
    confidence: 0.82,
    plan: {
      goal: input.goal,
      doneWhen: input.doneWhen,
      steps: input.steps.map((step) => ({ ...step })),
    },
  });
}

const NO_OP = (interpretation: string): string =>
  output({
    interpretation,
    considerations: ['Nothing in my remit needs a side effect right now.'],
    conclusion: 'Acknowledge and stay available.',
    goal: 'remain available',
    doneWhen: 'the event is acknowledged',
    steps: [{ action: 'UpdatePresence', args: { presence: 'idle' }, reasonRef: 0 }],
  });

/**
 * A deterministic stand-in for a competent employee. It reads the same cognition prompt a
 * real model would read and answers with the same JSON contract, so the *runtime* chain
 * under test (authorization gate, plan executor, task/workflow services, event store) is
 * exercised exactly as it would be with a live provider.
 */
export function acceptanceCognition(request: LlmRequest): string {
  const { selfId, event } = parseCognitionPrompt(request.prompt);
  const type = str(event, 'type') ?? '';
  const payload = payloadOf(event);

  if (type === 'Workflow.ApprovalRequested') {
    const requiredRoles = strArray(payload, 'requiredRoles');
    const instanceId = str(payload, 'instanceId');
    if (instanceId === null) return NO_OP('The approval request names no workflow instance.');
    return output({
      interpretation: `Workflow ${instanceId} is blocked on an approval I can decide.`,
      considerations: [
        'The instance cannot progress while the gate is open.',
        `My role is among [${requiredRoles.join(', ')}].`,
      ],
      conclusion: 'Grant the approval.',
      goal: `${instanceId} leaves the gate`,
      doneWhen: 'the approval is recorded as granted',
      steps: [{ action: 'CastVote', args: { instanceId, decision: 'granted' }, reasonRef: 0 }],
    });
  }

  if (type === 'Control.AgentInstructed') {
    const instruction = str(payload, 'instruction') ?? 'an operator instruction';
    return output({
      interpretation: `The board instructed me: "${instruction}".`,
      considerations: [
        'A written instruction from the board is a first-class organizational input.',
        'The existing product-analysis workflow is how this company turns a mandate into work.',
      ],
      conclusion: 'Turn the instruction into a workflow-backed piece of work.',
      goal: 'the instruction becomes tracked work',
      doneWhen: 'a workflow instance exists with an assigned intake task',
      steps: [
        {
          action: 'CreateProposal',
          args: {
            workflowId: 'product-analysis',
            title: 'Board directive',
            goal: instruction,
          },
          reasonRef: 0,
        },
      ],
    });
  }

  const taskId = str(payload, 'taskId');
  if (taskId !== null && type.startsWith('Task.')) {
    return output({
      interpretation: `Task ${taskId} is on my desk (${type}).`,
      considerations: [
        'The task is assigned to me and is not finished.',
        'Working it is what moves the workflow forward.',
      ],
      conclusion: 'Accept, start and submit the work product.',
      goal: `${taskId} is submitted with a verifiable result`,
      doneWhen: 'the task carries a submitted result',
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

  if (type === 'Communication.MessageSent') {
    const sender = str(payload, 'senderId') ?? 'a colleague';
    const channelId = str(payload, 'channelId');
    // Only requests are answered. Answering a response would make two employees ping-pong
    // forever, which is a cognition policy choice, not something the kernel should decide.
    if (str(payload, 'messageType') !== 'request') {
      return NO_OP(`Message from ${sender} is informational; no reply is required.`);
    }
    if (channelId === null) return NO_OP(`A message from ${sender} arrived with no channel.`);
    return output({
      interpretation: `${sender} sent me a message in ${channelId}.`,
      considerations: ['A request from a colleague deserves an explicit response.'],
      conclusion: 'Reply on the same channel.',
      goal: 'the sender knows I received the message',
      doneWhen: 'a response message is on the channel',
      steps: [
        {
          action: 'SendMessage',
          args: {
            channelId,
            recipientIds: [sender],
            subject: 're: your message',
            body: 'Received and noted.',
            messageType: 'response',
          },
          reasonRef: 0,
        },
      ],
    });
  }

  return NO_OP(`Event ${type} does not require a side effect from ${selfId}.`);
}

/** Workflow definitions whose approval gates the human operator may also decide. */
export const HUMAN_DECIDABLE_WORKFLOWS = humanDecidableWorkflowDefinitions(loadSeedWorkflows());

/* -------------------------------------------------------------------- harness ---- */

export interface AcceptanceOptions {
  readonly llmText?: (request: LlmRequest) => string;
  /** Swap the seed approval gates for operator-decidable ones (Scenario G). */
  readonly humanDecidableApprovals?: boolean;
  readonly budget?: Parameters<typeof createControlHarness>[0]['budget'];
}

export interface AcceptanceHarness {
  readonly control: ControlHarness;
  readonly organization: ReturnType<typeof loadSeedOrganizationWithOperators>;
  operator(): ControlActor;
  execute(
    commandType: ControlCommand['commandType'],
    overrides?: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<ControlHarness['plane']['control']['execute']>>>;
}

export async function createAcceptanceHarness(
  options: AcceptanceOptions = {},
): Promise<AcceptanceHarness> {
  const organization = loadSeedOrganizationWithOperators();
  const control = await createControlHarness({
    organization,
    policy: ACCEPTANCE_POLICY,
    llmText: options.llmText ?? acceptanceCognition,
    ...(options.humanDecidableApprovals === true
      ? { workflowDefinitions: HUMAN_DECIDABLE_WORKFLOWS }
      : {}),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  });

  const actor = (): ControlActor =>
    Object.freeze({
      operatorId: OPERATOR_EMPLOYEE_ID as EmployeeId,
      displayName: 'Dana',
      positionId: OPERATOR_POSITION_ID,
      kind: 'human' as const,
    });

  return {
    control,
    organization,
    operator: actor,
    execute: (commandType, overrides = {}) => {
      const { targetId, targetType, ...rest } = overrides as {
        readonly targetId?: string;
        readonly targetType?: ControlTargetType;
        readonly [key: string]: unknown;
      };
      const command = control.command(commandType, {
        ...(targetId === undefined ? {} : { targetId }),
        ...(targetType === undefined ? {} : { targetType }),
        ...rest,
      } as never);
      return control.plane.control.execute(command);
    },
  };
}

/* ------------------------------------------------------------------- observer ---- */

export interface TaskChange {
  readonly taskId: string;
  readonly from: string | null;
  readonly to: string;
}

export interface WorkflowChange {
  readonly instanceId: string;
  readonly from: string | null;
  readonly to: string;
  readonly activeSteps: readonly string[];
}

export interface AgentStateChange {
  readonly employeeId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly presence: string;
  readonly currentCycleId: string | null;
}

export interface TickTrace {
  readonly tickNumber: number;
  readonly simTime: number;
  readonly status: SimulationTickStatus;
  readonly inputEvents: readonly OrgEvent[];
  readonly scheduledWakeups: number;
  readonly enqueuedWakeups: number;
  readonly dispatchLimit: number;
  readonly turns: readonly AgentTurnRecord[];
  readonly retries: readonly AgentTurnRecord[];
  readonly llmCalls: number;
  readonly emittedEvents: readonly OrgEvent[];
  readonly taskChanges: readonly TaskChange[];
  readonly workflowChanges: readonly WorkflowChange[];
  readonly communicationEvents: readonly OrgEvent[];
  readonly controlEvents: readonly OrgEvent[];
  readonly stateChanges: readonly AgentStateChange[];
  readonly pendingWakeupsAfter: number;
  readonly totalWakeupRecordsAfter: number;
  readonly budgetExceeded: readonly string[];
}

/**
 * Reads the running simulation and turns each tick into an observation record. It never
 * writes to the simulation: every read goes through the public kernel surface.
 */
export function createObserver(harness: AcceptanceHarness) {
  const { simulation } = harness.control;
  let llmCallsBefore = 0;

  const snapshotTasks = (): ReadonlyMap<string, string> =>
    new Map(simulation.taskStore.all().map((task) => [task.taskId, task.status]));

  const snapshotWorkflows = (): ReadonlyMap<string, WorkflowChange> =>
    new Map(
      simulation.instanceStore.all().map((instance) => [
        instance.instanceId,
        {
          instanceId: instance.instanceId,
          from: instance.status,
          to: instance.status,
          activeSteps: Object.freeze([...instance.activeStepIds]),
        },
      ]),
    );

  const snapshotStates = (): ReadonlyMap<string, AgentStateChange> =>
    new Map(
      [...simulation.agents.keys()].map((employeeId) => {
        const state = simulation.stateStore.load(employeeId);
        return [
          String(employeeId),
          {
            employeeId: String(employeeId),
            fromVersion: state.version,
            toVersion: state.version,
            presence: state.presence,
            currentCycleId: state.currentCycleId,
          },
        ];
      }),
    );

  let tasksBefore = snapshotTasks();
  let workflowsBefore = snapshotWorkflows();
  let statesBefore = snapshotStates();

  return {
    /** Capture the pre-tick view. Call immediately before `simulation.tick()`. */
    beforeTick(): void {
      llmCallsBefore = harness.control.harness.provider.callCount;
      tasksBefore = snapshotTasks();
      workflowsBefore = snapshotWorkflows();
      statesBefore = snapshotStates();
    },

    /**
     * Capture the post-tick view. Reads the event log *after* the append so the input
     * range `(cursorBefore, cursor]` is sliced from the authoritative stream.
     */
    async observe(result: SimulationTickResult): Promise<TickTrace> {
      const tasksAfter = snapshotTasks();
      const workflowsAfter = snapshotWorkflows();
      const statesAfter = snapshotStates();

      const eventsAfter = await collectEvents(simulation.eventStore);
      const inputEvents = eventsAfter.slice(result.cursorBefore, result.cursor);

      const taskChanges: TaskChange[] = [];
      for (const [taskId, status] of tasksAfter) {
        const before = tasksBefore.get(taskId) ?? null;
        if (before === status) continue;
        taskChanges.push({ taskId, from: before, to: status });
      }

      const workflowChanges: WorkflowChange[] = [];
      for (const [instanceId, after] of workflowsAfter) {
        const before = workflowsBefore.get(instanceId) ?? null;
        if (before !== null && before.to === after.to && before.activeSteps.join(',') === after.activeSteps.join(',')) {
          continue;
        }
        workflowChanges.push({
          instanceId,
          from: before === null ? null : before.to,
          to: after.to,
          activeSteps: after.activeSteps,
        });
      }

      const stateChanges: AgentStateChange[] = [];
      for (const [employeeId, after] of statesAfter) {
        const before = statesBefore.get(employeeId) ?? null;
        if (before !== null && before.toVersion === after.toVersion) continue;
        stateChanges.push({
          employeeId,
          fromVersion: before === null ? 0 : before.fromVersion,
          toVersion: after.toVersion,
          presence: after.presence,
          currentCycleId: after.currentCycleId,
        });
      }

      const byPredicate = (predicate: (event: OrgEvent) => boolean): readonly OrgEvent[] =>
        Object.freeze(result.emittedEvents.filter(predicate));

      return {
        tickNumber: result.tickNumber,
        simTime: result.simTime,
        status: result.status,
        inputEvents: Object.freeze([...inputEvents]),
        scheduledWakeups: result.scheduledWakeupCount,
        enqueuedWakeups: result.wakeupCount,
        dispatchLimit: result.dispatchLimit,
        turns: result.turns,
        retries: Object.freeze(result.turns.filter((turn) => turn.reason === 'RETRY')),
        llmCalls: harness.control.harness.provider.callCount - llmCallsBefore,
        emittedEvents: result.emittedEvents,
        taskChanges: Object.freeze(taskChanges),
        workflowChanges: Object.freeze(workflowChanges),
        communicationEvents: byPredicate((event) => event.type.startsWith('Communication.')),
        controlEvents: byPredicate((event) => event.type.startsWith('Control.')),
        stateChanges: Object.freeze(stateChanges),
        pendingWakeupsAfter: simulation.scheduler.pending().length,
        totalWakeupRecordsAfter: simulation.scheduler.queue().length,
        budgetExceeded: result.budget.exceeded,
      };
    },
  };
}

/* ------------------------------------------------------------------ rendering ---- */

export function renderTickTrace(trace: TickTrace): string {
  const lines: string[] = [];
  lines.push(`Tick ${String(trace.tickNumber)} (simTime=${String(trace.simTime)}) status=${trace.status}`);
  lines.push(
    `  Wakeups    scheduled=${String(trace.scheduledWakeups)} enqueued=${String(trace.enqueuedWakeups)} dispatchLimit=${String(trace.dispatchLimit)} pendingAfter=${String(trace.pendingWakeupsAfter)} queueRecords=${String(trace.totalWakeupRecordsAfter)}`,
  );
  lines.push(`  LLM calls  ${String(trace.llmCalls)}`);
  lines.push(`  Input      ${trace.inputEvents.length === 0 ? '(none)' : ''}`);
  for (const event of trace.inputEvents) {
    lines.push(`    <- ${event.eventId} ${event.type} actor=${event.actorId}`);
  }
  lines.push(`  Agent turns ${trace.turns.length === 0 ? '(none)' : ''}`);
  for (const turn of trace.turns) {
    lines.push(
      `    * ${turn.employeeId} cycle=${turn.cycleId} wake=${turn.reason} src=${String(turn.sourceEventId)} status=${turn.status} llm=${String(turn.llmCalls)} events=${String(turn.emittedEventCount)}${turn.failureCode === null ? '' : ` failure=${turn.failureCode}`}`,
    );
  }
  lines.push(`  Emitted events ${trace.emittedEvents.length}`);
  for (const event of trace.emittedEvents) {
    lines.push(`    -> ${event.eventId} seq=${String(event.seq)} ${event.type}`);
  }
  lines.push(`  Task changes ${trace.taskChanges.length === 0 ? '(none)' : ''}`);
  for (const change of trace.taskChanges) {
    lines.push(`    # ${change.taskId}: ${change.from ?? '(new)'} -> ${change.to}`);
  }
  lines.push(`  Workflow changes ${trace.workflowChanges.length === 0 ? '(none)' : ''}`);
  for (const change of trace.workflowChanges) {
    lines.push(
      `    % ${change.instanceId}: ${change.from ?? '(new)'} -> ${change.to} active=[${change.activeSteps.join(',')}]`,
    );
  }
  lines.push(`  Agent state ${trace.stateChanges.length === 0 ? '(none)' : ''}`);
  for (const change of trace.stateChanges) {
    lines.push(
      `    @ ${change.employeeId}: v${String(change.fromVersion)} -> v${String(change.toVersion)} presence=${change.presence} cycle=${String(change.currentCycleId)}`,
    );
  }
  if (trace.budgetExceeded.length > 0) {
    lines.push(`  BUDGET EXCEEDED: ${trace.budgetExceeded.join(',')}`);
  }
  return lines.join('\n');
}
