import { nextCommandId } from './api';

/**
 * Every console action is a control command. Buttons never touch domain state: they build
 * the envelope the Control Plane expects and POST it to `/api/command`, which validates,
 * authorizes, executes and records the outcome in the event log like any other operator.
 */
export type Command = Record<string, unknown>;

export interface CommandContext {
  readonly companyId: string;
  readonly simTime: number;
}

/**
 * The human operator the console acts as. This milestone has no authentication, so the
 * identity is a fixed member of the organization — the Control Plane resolves it through
 * the same identity factory it uses for every other operator.
 */
export const OPERATOR = {
  operatorId: 'ceo-alex',
  displayName: 'Alex',
  positionId: 'ceo',
  kind: 'human',
} as const;

export const COMPANY_TARGET_TYPE = 'organization';

function envelope(ctx: CommandContext, reason: string): Command {
  const commandId = nextCommandId();
  return {
    commandId,
    actor: {
      operatorId: OPERATOR.operatorId,
      displayName: OPERATOR.displayName,
      positionId: OPERATOR.positionId,
      kind: OPERATOR.kind,
    },
    reason,
    correlationId: commandId,
    causationId: null,
    createdAtSim: ctx.simTime,
  };
}

export function simulationCommand(
  ctx: CommandContext,
  commandType: 'Simulation.Pause' | 'Simulation.Resume' | 'Simulation.Step',
  reason = 'operator action from console',
): Command {
  return {
    ...envelope(ctx, reason),
    commandType,
    target: { targetType: 'simulation', targetId: ctx.companyId },
  };
}

/** `Agent.Instruct`: the human hands an agent a mandate and the scheduler wakes it up. */
export function instructAgent(
  ctx: CommandContext,
  agentId: string,
  instruction: string,
  reason = 'operator instruction from console',
): Command {
  return {
    ...envelope(ctx, reason),
    commandType: 'Agent.Instruct',
    target: { targetType: 'agent', targetId: agentId },
    instruction,
  };
}

export interface WorkBriefInput {
  readonly title: string;
  readonly goal: string;
  /** Optional standing context; empty stays out of the command instead of arriving as `''`. */
  readonly context: string;
  /** Verification keys, one per entry — a brief without any is rejected by the Control Plane. */
  readonly verificationKeys: readonly string[];
  readonly priority?: number;
  readonly dueAtSim?: number;
}

/**
 * `Work.SubmitBrief` (M1.4 §5.7): the single entry point for organizational work. The brief
 * goes to the Chief Officer — the agent on the `ceo` seat — who decomposes it into work items
 * the dispatcher assigns, so the human states *what* must be true and the organization decides
 * *who* does it. `reason` is mandatory: every brief is an auditable command.
 */
export function submitWorkBrief(
  ctx: CommandContext,
  agentId: string,
  brief: WorkBriefInput,
  reason: string,
): Command {
  return {
    ...envelope(ctx, reason),
    commandType: 'Work.SubmitBrief',
    target: { targetType: 'agent', targetId: agentId },
    workBrief: {
      title: brief.title,
      goal: brief.goal,
      ...(brief.context === '' ? {} : { context: brief.context }),
      verificationKeys: [...brief.verificationKeys],
      ...(brief.priority === undefined ? {} : { priority: brief.priority }),
      ...(brief.dueAtSim === undefined ? {} : { dueAtSim: brief.dueAtSim }),
    },
  };
}

/** What the brief form holds — raw strings, exactly as the operator typed them. */
export interface BriefFormValue {
  readonly title: string;
  readonly goal: string;
  readonly context: string;
  readonly keys: string;
  readonly reason: string;
  readonly priority: string;
  readonly dueAtSim: string;
}

/** Which field refused the draft; the page maps it to one sentence. */
export type BriefProblem = 'title' | 'keys' | 'reason' | 'priority' | 'due';

export type BriefDraft =
  | { readonly ok: true; readonly brief: WorkBriefInput; readonly reason: string }
  | { readonly ok: false; readonly problem: BriefProblem };

/** `''` → undefined (leave it out of the command); anything else unparsable → null. */
function briefInteger(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * Turn what the operator typed into the one command M1.4 allows, or name the field that is
 * not good enough yet. Splitting the acceptance keys and parsing the optional numbers here
 * keeps the whole validation in one pure, DOM-free place: the page only renders the sentence
 * a `problem` stands for.
 */
export function buildWorkBrief(form: BriefFormValue): BriefDraft {
  const title = form.title.trim();
  const goal = form.goal.trim();
  const keys = form.keys
    .split(/[\n,]/)
    .map((key) => key.trim())
    .filter((key) => key !== '');
  const reason = form.reason.trim();
  if (title === '' || goal === '') return { ok: false, problem: 'title' };
  if (keys.length === 0) return { ok: false, problem: 'keys' };
  if (reason === '') return { ok: false, problem: 'reason' };
  const priority = briefInteger(form.priority);
  if (priority === null || (priority !== undefined && (priority < 1 || priority > 9))) {
    return { ok: false, problem: 'priority' };
  }
  const dueAtSim = briefInteger(form.dueAtSim);
  if (dueAtSim === null || (dueAtSim !== undefined && dueAtSim < 0)) return { ok: false, problem: 'due' };
  return {
    ok: true,
    reason,
    brief: {
      title,
      goal,
      context: form.context.trim(),
      verificationKeys: keys,
      ...(priority === undefined ? {} : { priority }),
      ...(dueAtSim === undefined ? {} : { dueAtSim }),
    },
  };
}

export interface CreateAgentInput {
  readonly employeeId: string;
  readonly name: string;
  readonly positionId: string;
  readonly employeeNo: string;
  readonly responsibilities: readonly string[];
  readonly traits: readonly string[];
  readonly cognitionProfileId: string;
  readonly templateEmployeeId: string;
  /**
   * Sent when the operator typed in a position the chart does not have yet: the command then
   * creates the seat (`positionId`, slugged from the title) together with the agent.
   */
  readonly newPosition?: {
    readonly departmentId: string;
    readonly title: string;
    readonly capabilities: readonly string[];
  };
}

/**
 * `Agent.Create` (M1.3): a new AI employee. The identity, the position and the mandate are the
 * operator's; the rest of the 8-layer structure is resolved from the template by the Runtime.
 * The command targets the organization — the roster is what changes.
 */
export function createAgent(ctx: CommandContext, input: CreateAgentInput): Command {
  return {
    ...envelope(ctx, `agent created from console: ${input.name} (${input.employeeId})`),
    commandType: 'Agent.Create',
    target: { targetType: COMPANY_TARGET_TYPE, targetId: ctx.companyId },
    employeeId: input.employeeId,
    name: input.name,
    positionId: input.positionId,
    ...(input.employeeNo === '' ? {} : { employeeNo: input.employeeNo }),
    responsibilities: [...input.responsibilities],
    ...(input.traits.length === 0 ? {} : { traits: [...input.traits] }),
    ...(input.cognitionProfileId === '' ? {} : { cognitionProfileId: input.cognitionProfileId }),
    ...(input.templateEmployeeId === '' ? {} : { templateEmployeeId: input.templateEmployeeId }),
    ...(input.newPosition === undefined
      ? {}
      : {
          newPosition: {
            departmentId: input.newPosition.departmentId,
            title: input.newPosition.title.trim(),
            capabilities: [...input.newPosition.capabilities],
          },
        }),
  };
}

/** `Agent.Archive` (M1.3): close an employment. Nothing is deleted, and the reason is audited. */
export function archiveAgent(ctx: CommandContext, agentId: string, reason: string): Command {
  return {
    ...envelope(ctx, reason),
    commandType: 'Agent.Archive',
    target: { targetType: 'agent', targetId: agentId },
  };
}

export function setAgentPaused(
  ctx: CommandContext,
  agentId: string,
  paused: boolean,
  reason = 'operator action from console',
): Command {
  return {
    ...envelope(ctx, reason),
    commandType: paused ? 'Agent.Pause' : 'Agent.Resume',
    target: { targetType: 'agent', targetId: agentId },
  };
}

/**
 * `Organization.InjectTask`: a real task in the TaskService.
 *
 * Routing is one of two explicit choices, never both: a `positionId` dispatches to a seat the
 * way M1.0 always did, `requiredSkills` hands the task to the M1.6 capability matcher, which
 * picks the best available holder of the declared capabilities. The console sends whichever
 * mode the operator picked — the command never carries an empty version of the other.
 */
export function injectTask(
  ctx: CommandContext,
  input: {
    readonly title: string;
    readonly goal: string;
    readonly detail: string;
    readonly positionId?: string;
    readonly requiredSkills?: readonly string[];
  },
  /**
   * Why this task exists. `Organization.InjectTask` always audited a reason, and §5.7 makes
   * the operator state it explicitly: an injected task is a direct dispatch that bypasses the
   * CEO's decomposition, so the human owns the justification on the record.
   */
  reason = 'task injected from console',
): Command {
  const seat = input.positionId ?? '';
  const skills = input.requiredSkills ?? [];
  return {
    ...envelope(ctx, reason),
    commandType: 'Organization.InjectTask',
    target: { targetType: COMPANY_TARGET_TYPE, targetId: ctx.companyId },
    title: input.title,
    goal: input.goal,
    ...(input.detail === '' ? {} : { detail: input.detail }),
    ...(seat === '' ? {} : { positionId: seat }),
    ...(seat === '' && skills.length > 0 ? { requiredSkills: [...skills] } : {}),
  };
}

export function workflowDecision(
  ctx: CommandContext,
  instanceId: string,
  decision: 'approve' | 'reject',
  reason: string,
): Command {
  return {
    ...envelope(ctx, reason),
    commandType: decision === 'approve' ? 'Workflow.Approve' : 'Workflow.Reject',
    target: { targetType: 'workflow', targetId: instanceId },
  };
}

export function taskCancel(ctx: CommandContext, taskId: string): Command {
  return {
    ...envelope(ctx, 'task cancelled from console'),
    commandType: 'Task.Cancel',
    target: { targetType: 'task', targetId: taskId },
  };
}

/**
 * `Task.Delete`: remove the task. The Control Plane decides the cascade — a task filed under a
 * workflow takes its instance with it — so the button states only the intent.
 */
export function taskDelete(ctx: CommandContext, taskId: string): Command {
  return {
    ...envelope(ctx, 'task deleted from console'),
    commandType: 'Task.Delete',
    target: { targetType: 'task', targetId: taskId },
  };
}

/** `Workflow.Delete`: remove the instance and every task it owns. */
export function workflowDelete(ctx: CommandContext, instanceId: string): Command {
  return {
    ...envelope(ctx, 'workflow deleted from console'),
    commandType: 'Workflow.Delete',
    target: { targetType: 'workflow', targetId: instanceId },
  };
}

export function taskReassign(
  ctx: CommandContext,
  taskId: string,
  positionId: string,
): Command {
  return {
    ...envelope(ctx, `task reassigned to position ${positionId}`),
    commandType: 'Task.Reassign',
    target: { targetType: 'task', targetId: taskId },
    positionId,
  };
}

export function taskRequestReview(ctx: CommandContext, taskId: string): Command {
  return {
    ...envelope(ctx, 'review requested from console'),
    commandType: 'Task.RequestReview',
    target: { targetType: 'task', targetId: taskId },
  };
}

/**
 * `Task.AssignToAgent` (M1.6): put the task on a named agent, or — when no agent is named —
 * let the capability matcher re-run against the task's own `requiredSkills`. The command
 * carries `agentId` only in the first case; the second is deliberately empty, because the
 * requirements to match on belong to the task record, not to the button press.
 */
export function taskAssignToAgent(
  ctx: CommandContext,
  taskId: string,
  input: { readonly agentId?: string } = {},
): Command {
  const agentId = input.agentId ?? '';
  return {
    ...envelope(ctx, agentId === '' ? 'task matched by capability from console' : `task assigned to agent ${agentId} from console`),
    commandType: 'Task.AssignToAgent',
    target: { targetType: 'task', targetId: taskId },
    ...(agentId === '' ? {} : { agentId }),
  };
}
