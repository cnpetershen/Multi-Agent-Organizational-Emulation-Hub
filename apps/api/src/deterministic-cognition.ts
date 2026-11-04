import type { LlmRequest } from '@maoeh/llm-gateway';
import { requiredCapabilitiesFor } from '@maoeh/organization-model';
import {
  capabilityDelivery,
  codeDelivery,
  deliveryShape,
  documentDelivery,
  oneLineGoal,
  reportDelivery,
  testDelivery,
  type DeliveryDraft,
} from './product-deliverables.js';

/**
 * Deterministic stand-in cognition for the composed runtime (M1.2-A).
 *
 * The repository ships exactly one LLM provider - the mock provider - so it *is* the
 * current production cognition substrate. The previous stand-in returned an empty plan,
 * which failed `cognitionOutputSchema` (`plan.steps` min 1) and turned every turn into a
 * `schema_violation`: the organization looked alive but never acted.
 *
 * This implementation reads the very same `request.prompt` a live model would read, so
 * the rest of the chain (authorization gate, closed Action Space, plan executor, task and
 * workflow state machines, event log) is exercised unchanged. Every answer satisfies
 * `cognitionOutputSchema`, `buildPlan` and the kernel plan bindings, so a turn can only
 * fail when the underlying operation legitimately refuses it.
 */

interface ParsedPrompt {
  readonly selfId: string;
  readonly positionId: string;
  /** The agent's own seat tags, from the prompt's `Position capabilities:` line. */
  readonly capabilities: readonly string[];
  /** Every seat the organization declares capabilities on, from the prompt's capability map. */
  readonly capabilitySeats: readonly CapabilitySeat[];
  readonly event: Readonly<Record<string, unknown>>;
}

/** One seat line of the prompt's capability map, parsed back into data. */
interface CapabilitySeat {
  readonly capability: string;
  /** Seat id; empty when the prompt carried a title without an id. */
  readonly positionId: string;
  readonly title: string;
  readonly staffed: boolean;
  /** Staffed seat this vacant seat escalates to for this viewer, or `null` when nobody covers it. */
  readonly coveredBy: string | null;
}

interface PlanStepDraft {
  readonly action: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly reasonRef: number;
}

interface PlanDraft {
  readonly interpretation: string;
  readonly considerations: readonly string[];
  readonly conclusion: string;
  readonly goal: string;
  readonly doneWhen: string;
  readonly steps: readonly PlanStepDraft[];
}

/**
 * What an executor hands back for one step.
 *
 * The stand-in cannot author a real model's work product, so it hands back a *goal-anchored*
 * delivery, shaped by what the step itself declares:
 *
 * - The step's verification names the output keys it is judged on (template workflows): produce
 *   exactly those keys, so the completion verdict is about content and never about a missing
 *   field.
 * - The step declares nothing (generated workflows): shape the delivery from the executor's own
 *   seat tags, so a frontend seat delivers code and a requirements seat delivers a document.
 *
 * Both paths quote the goal. Before this, every task in every workflow — a snake game, a churn
 * analysis, a release — submitted one constant object with no artifacts, which is why the console
 * could show a *finished* workflow that had delivered nothing at all.
 */
interface Deliverable {
  readonly summary: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly artifacts: readonly string[];
}

/**
 * How one *declared* output key is satisfied (template workflows).
 *
 * The keys the repository's workflows declare are answered by name, so those templates keep
 * passing their own deterministic verification. A key no workflow declares is answered with a
 * goal-anchored statement naming the key, so a step carrying a contract this stand-in has never
 * seen still submits something verifiable instead of failing the turn.
 */
function outputKeyValue(key: string, goal: string): string | readonly string[] {
  switch (key) {
    case 'problem':
      return `Problem to solve: ${goal}`;
    case 'success_criteria':
      return 'the delivery is reviewed and accepted by the responsible role';
    case 'approach':
      return 'deliver the smallest end-to-end slice first, then iterate on feedback';
    case 'risks':
      return ['acceptance criteria left implicit', 'scope growing past the instruction'];
    case 'recommendation':
      return 'proceed as scoped; the delivery is ready for review';
    case 'scope':
      return `In scope: ${goal}`;
    case 'architecture':
      return 'one module boundary per concern, with interfaces declared explicitly';
    case 'deliverable':
      return `the working result for: ${goal}`;
    case 'test_report':
      return 'every declared check passes';
    case 'release_notes':
      return `first version delivered for: ${goal}`;
    default:
      return `${key}: ${goal}`;
  }
}

/**
 * The delivery for one step, in the shape the step's contract or the executor's seat implies.
 * Every branch quotes the goal, and every branch declares the files it produced, so an owner
 * reading the delivery page sees what was made rather than a generic completion notice.
 */
/**
 * The delivery for one step, decided in this order:
 *
 * 1. **The step's declared output contract** (template workflows): answer exactly the keys the
 *    step is judged on, so the verdict is about content and never about a missing field.
 * 2. **The step's declared capability** (generated workflows): the *kind of work* decides the
 *    shape, so a `backend` step hands back a service and a `frontend` step hands back a page —
 *    even when one seat holds both steps because it declares both capabilities. The capability
 *    arrives on the wake-up event (`Task.Assigned`), the only place the executor can learn it.
 * 3. **The executor's own seat tags**: what a task that declared nothing still gets.
 */
function deliverableFor(input: {
  readonly goal: string;
  readonly title: string;
  readonly requiredOutputKeys: readonly string[];
  readonly capabilities: readonly string[];
  readonly capability: string | null;
}): Deliverable {
  const name = input.title.trim() === '' ? 'Delivery' : input.title.trim();
  const goal = oneLineGoal(input.goal, name);

  if (input.requiredOutputKeys.length > 0) {
    const data: Record<string, unknown> = {};
    for (const key of input.requiredOutputKeys) data[key] = outputKeyValue(key, goal);
    return {
      summary: `Produced ${input.requiredOutputKeys.join(', ')} for "${goal}".`,
      data: Object.freeze(data),
      artifacts: Object.freeze([]),
    };
  }

  const declared =
    input.capability === null
      ? null
      : capabilityDelivery({ capability: input.capability, goal: input.goal, title: name });
  const delivered =
    declared ?? seatDelivery({ name, goal, seatCapabilities: input.capabilities });
  return { summary: delivered.summary, data: delivered.data, artifacts: delivered.artifacts };
}

/** What a task that declared no capability of its own gets, from the executor's seat tags. */
function seatDelivery(input: {
  readonly name: string;
  readonly goal: string;
  readonly seatCapabilities: readonly string[];
}): DeliveryDraft {
  switch (deliveryShape(input.seatCapabilities)) {
    case 'code':
      return codeDelivery({
        name: input.name,
        goal: input.goal,
        seatCapabilities: input.seatCapabilities,
        leaderboard: false,
      });
    case 'test':
      return testDelivery(input.name, input.goal);
    case 'document':
      return documentDelivery(input.name, input.goal);
    default:
      return reportDelivery(input.name, input.goal);
  }
}

function section(prompt: string, start: string, end: string): string | null {
  const from = prompt.indexOf(start);
  if (from < 0) return null;
  const to = prompt.indexOf(end, from + start.length);
  if (to < 0) return null;
  return prompt.slice(from + start.length, to);
}

const CAPABILITY_MAP_HEADER =
  'Capabilities the company provides (capability: seats that declare it):';

/**
 * Reads the capability map back out of the prompt — the same text a live model reads. Seat lines
 * have the shape `- capability: Title [id] (vacant, covered by [seat])?`; a line the parser does
 * not understand keeps its capability but loses its seat, which can only ever *not* trigger a
 * hire (the fallback is the behaviour this stand-in had before A3).
 */
function parseCapabilitySeats(prompt: string): readonly CapabilitySeat[] {
  const start = prompt.indexOf(CAPABILITY_MAP_HEADER);
  if (start < 0) return Object.freeze([]);
  const seats: CapabilitySeat[] = [];
  for (const raw of prompt.slice(start + CAPABILITY_MAP_HEADER.length).split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (!line.startsWith('- ')) break;
    const body = line.slice(2);
    const colon = body.indexOf(': ');
    if (colon <= 0) continue;
    const capability = body.slice(0, colon).trim();
    if (capability === '') continue;
    // Seats are joined with ", " — but the vacancy marker itself contains ", covered by [",
    // so the split must leave that comma alone.
    for (const segment of body.slice(colon + 2).split(/,(?!\scovered by\s\[)/)) {
      const match = /^(.*?) \[([^\]]+)\]( \(vacant(?:, covered by \[([^\]]+)\])?\))?$/.exec(
        segment.trim(),
      );
      if (match === null) continue;
      const title = (match[1] ?? '').trim();
      const positionId = (match[2] ?? '').trim();
      if (title === '' || positionId === '') continue;
      seats.push(
        Object.freeze({
          capability,
          positionId,
          title,
          staffed: match[3] === undefined,
          coveredBy: match[4] ?? null,
        }),
      );
    }
  }
  return Object.freeze(seats);
}

/** Reads the parts of the cognition prompt this stand-in reasons about. */
export function parseCognitionPrompt(prompt: string): ParsedPrompt {
  const selfMatch = /^Self: .* \[([^\]]+)\]$/m.exec(prompt);
  const positionMatch = /^Position: .* \[([^\]]+)\]$/m.exec(prompt);
  const capabilitiesMatch = /^Position capabilities: (.+)$/m.exec(prompt);
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
  const declared = capabilitiesMatch?.[1]?.trim() ?? '';
  return {
    selfId: selfMatch?.[1] ?? '',
    positionId: positionMatch?.[1] ?? '',
    capabilities: Object.freeze(
      declared === '' || declared === '(none)'
        ? []
        : declared.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''),
    ),
    capabilitySeats: parseCapabilitySeats(prompt),
    event,
  };
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

function strArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : [];
}

function output(draft: PlanDraft): string {
  return JSON.stringify({
    interpretation: draft.interpretation,
    considerations: [...draft.considerations],
    conclusion: draft.conclusion,
    confidence: 0.86,
    plan: {
      goal: draft.goal,
      doneWhen: draft.doneWhen,
      steps: draft.steps.map((step) => ({
        action: step.action,
        args: { ...step.args },
        reasonRef: step.reasonRef,
      })),
    },
  });
}

/**
 * Acknowledge without a side effect. `Reflect` is in the Action Space and is bound to
 * the kernel's `noop`, so the turn emits no domain event and cannot disturb the log.
 */
function noOp(interpretation: string): string {
  return output({
    interpretation,
    considerations: ['Nothing in my remit needs a side effect right now.'],
    conclusion: 'Acknowledge the event and stay available.',
    goal: 'remain available',
    doneWhen: 'the event is acknowledged',
    steps: [{ action: 'Reflect', args: {}, reasonRef: 0 }],
  });
}

/**
 * Deterministic policy, in the order the minimal business chain needs it:
 *
 * 1. `Control.WorkBriefed` - a human handed this seat a work brief (M1.4): analyse the brief's
 *    goal into capabilities and start the capability-routed workflow, so the work becomes a
 *    gated instance instead of a flat board of tasks. This seat composes; it does not execute.
 *    A needed capability no seat can carry is not silently staffed: the plan emits
 *    `RecommendHire` *instead of* the proposal (A4) — the root approval chain decides, the
 *    objectives wait in a blocked task, and the kernel resumes the embedded proposal on a grant.
 * 2. `Control.AgentInstructed` - a human handed this agent a mandate: derive the
 *    capabilities it needs and start a generated workflow so the work becomes tracked.
 *    Unstaffable capabilities take the same approval-gated `RecommendHire` path.
 * 3. `Task.Assigned` - the workflow put a task on this agent's desk: accept, start and
 *    submit a goal-anchored delivery shaped by the step's output contract or the seat's tags.
 * 4. `Workflow.ApprovalRequested` - this agent sits on the gate: grant it.
 * 5. `Communication.MessageSent` - answer requests only (answering a response would let
 *    two employees ping-pong forever, which is a cognition policy choice).
 * 6. anything else - acknowledge.
 */
/**
 * What to call the work, taken from the instruction itself.
 *
 * The mandate's own first line is what the console, the workflow and the delivery page name this
 * piece of work. A constant title named every piece of work the same thing, so a snake-game
 * mandate and a churn analysis were indistinguishable the moment the operator looked away.
 */
function proposalTitle(instruction: string): string {
  const firstLine = instruction
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line !== '');
  const clean = firstLine ?? instruction.replace(/\s+/g, ' ').trim();
  if (clean === '') return 'Board directive';
  return clean.length <= 120 ? clean : `${clean.slice(0, 119)}…`;
}

/** One seat to staff, shaped to the `RecommendHire` → `agents.create` binding's contract. */
interface HireDraft {
  readonly positionId: string;
  readonly employeeId: string;
  readonly name: string;
  readonly responsibilities: readonly string[];
  readonly expertise: readonly string[];
  readonly reason: string;
}

/**
 * A stable id for the hire, derived from the seat: the binding caps it at 123 characters
 * because it prefixes `hire-` onto it for the control envelope's `commandId`.
 */
function hireEmployeeId(positionId: string): string {
  const cleaned = positionId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+$/, '');
  const base = (cleaned === '' ? 'seat' : cleaned).slice(0, 118);
  return `${base}-hire`;
}

/**
 * A3 (`role-agents-cannot-complete-tasks.md` §9): which seats must be staffed *before* the
 * workflow is proposed, because the capability router would find nobody to assign its work to.
 *
 * The coverage rule mirrors `resolveCapabilityAssignments` exactly, read off the prompt's
 * capability map: a capability is covered when some seat outside the viewer's own (a
 * dispatcher never holds its own dispatch) either is staffed or vacates up the `reports_to`
 * chain to a staffed manager — that is what `coveredBy` records. A capability with no such
 * seat cannot be scheduled at all, and *that* is the state this planner hires into: one
 * `RecommendHire` per seat, greedily picking the vacant seat that covers the most still-open
 * capabilities (ties by smallest seat id, so the choice is deterministic), never a seat whose
 * work a manager already covers, and never a seat the chart does not have.
 */
function hireDrafts(input: {
  readonly needed: readonly string[];
  readonly selfPositionId: string;
  readonly capabilitySeats: readonly CapabilitySeat[];
}): readonly HireDraft[] {
  const self = input.selfPositionId.trim();
  const covered = new Set<string>();
  const candidates = new Map<string, { title: string; capabilities: Set<string> }>();
  for (const seat of input.capabilitySeats) {
    if (seat.positionId === '' || seat.positionId === self) continue;
    const capability = seat.capability.trim().toLowerCase();
    if (capability === '') continue;
    if (seat.staffed || seat.coveredBy !== null) {
      covered.add(capability);
      continue;
    }
    const entry = candidates.get(seat.positionId) ?? {
      title: seat.title,
      capabilities: new Set<string>(),
    };
    entry.capabilities.add(capability);
    candidates.set(seat.positionId, entry);
  }

  const remaining = new Set(
    [...new Set(input.needed)]
      .map((capability) => capability.trim().toLowerCase())
      .filter((capability) => capability !== '' && !covered.has(capability)),
  );
  if (remaining.size === 0) return Object.freeze([]);

  const positionIds = [...candidates.keys()].sort();
  const picked: string[] = [];
  while (remaining.size > 0) {
    let bestId: string | null = null;
    let bestCover = 0;
    for (const positionId of positionIds) {
      if (picked.includes(positionId)) continue;
      const entry = candidates.get(positionId);
      if (entry === undefined) continue;
      let cover = 0;
      for (const capability of entry.capabilities) {
        if (remaining.has(capability)) cover += 1;
      }
      if (cover > bestCover) {
        bestId = positionId;
        bestCover = cover;
      }
    }
    if (bestId === null) break;
    picked.push(bestId);
    const entry = candidates.get(bestId);
    if (entry !== undefined) {
      for (const capability of entry.capabilities) remaining.delete(capability);
    }
  }

  const drafts: HireDraft[] = [];
  for (const positionId of picked) {
    const entry = candidates.get(positionId);
    if (entry === undefined) continue;
    const capabilities = [...entry.capabilities].sort();
    drafts.push(
      Object.freeze({
        positionId,
        employeeId: hireEmployeeId(positionId),
        name: entry.title,
        responsibilities: Object.freeze([
          `Carry the ${capabilities.join(', ')} work this seat declares for the organization`.slice(
            0,
            200,
          ),
        ]),
        expertise: Object.freeze(capabilities.map((capability) => capability.slice(0, 64))),
        reason: `No staffed seat and no staffed manager can carry ${capabilities.join(', ')}: fill seat "${positionId}" so the workflow proposed next has an executor.`,
      }),
    );
  }
  return Object.freeze(drafts);
}

/** The workflow proposal a hire carries into the gate: resumed by the kernel once the root grants. */
interface DeferredProposal {
  readonly briefRef: string;
  readonly proposal: {
    readonly capabilities: readonly string[];
    readonly title: string;
    readonly goal: string;
  };
}

function hireSteps(
  hires: readonly HireDraft[],
  reasonRef: number,
  deferred: DeferredProposal,
): readonly PlanStepDraft[] {
  return hires.map((hire) =>
    Object.freeze({
      action: 'RecommendHire',
      args: Object.freeze({
        positionId: hire.positionId,
        employeeId: hire.employeeId,
        name: hire.name,
        responsibilities: [...hire.responsibilities],
        expertise: [...hire.expertise],
        reason: hire.reason,
        briefRef: deferred.briefRef,
        proposal: Object.freeze({
          capabilities: [...deferred.proposal.capabilities],
          title: deferred.proposal.title,
          goal: deferred.proposal.goal,
        }),
      }),
      reasonRef,
    }),
  );
}

function hireConsideration(hires: readonly HireDraft[], needed: readonly string[]): string {
  const seats = hires.map((hire) => `"${hire.positionId}"`).join(', ');
  return `The organization cannot yet carry ${needed.join(', ')}: the seats that would take this work are vacant with nobody up the chain to cover them, so the hiring request for ${seats} goes up the root approval chain — the objectives wait in a blocked task and the proposal that follows is resumed once the root grants.`;
}

export function deterministicCognitionText(request: LlmRequest): string {
  const { selfId, positionId, capabilities, capabilitySeats, event } = parseCognitionPrompt(
    request.prompt,
  );
  const type = str(event, 'type') ?? '';
  const payload = payloadOf(event);

  if (type === 'Control.WorkBriefed') {
    const briefId = str(payload, 'briefId');
    const briefTitle = str(payload, 'title') ?? 'Untitled brief';
    const briefGoal = str(payload, 'goal') ?? briefTitle;
    // Capability routing, exactly as the mandate path does it: the brief's *goal text* is
    // analysed into the kinds of work it needs, and the kernel's capability router resolves
    // each one to a staffed seat. The brief must not pick seats itself.
    //
    // Picking seats here is what made a work brief unrunnable: the previous step list chose the
    // two least-loaded seats out of the whole chart, which in a company that has not hired yet
    // are empty ones. `TaskService` then assigned the work with `assigneeEmployeeId: null`
    // (nobody holds the seat), `eligibleAgentsFor` refuses to wake anybody for an assignment
    // with no assignee, and the task sat `assigned` forever: the board saw "work dispatched"
    // and nothing was ever produced. ADR/README state the routing rule as **capability → seat,
    // never a seat chosen by name or by load**, so this restores the documented path instead of
    // inventing a second one.
    //
    // A3/A4 close the remaining gap: when the brief needs a capability no seat can carry — every
    // declaring seat vacant and no staffed manager up the chain — a proposal alone still fails,
    // because the router finds nobody to assign the work to (in the starter company the plan
    // came back `null` and the turn died as `invalid_input`). A reactive "fail, hire, retry next
    // turn" cannot work either — `invalid_input` is not retryable — so the recommendation is the
    // whole plan: `RecommendHire` carries the deferred proposal, the kernel parks the objectives
    // in a blocked task and opens the root approval gate, and the resume places the work only
    // once a human grants the hire. That is A4: an agent recommends, the root decides, the
    // roster never moves under a pending request.
    const needed = requiredCapabilitiesFor(briefGoal);
    const hires = hireDrafts({ needed, selfPositionId: positionId, capabilitySeats });
    const proposal = {
      capabilities: [...needed],
      title: proposalTitle(briefTitle),
      goal: briefGoal,
    };
    const briefRef = briefId ?? str(event, 'eventId') ?? 'brief';
    const hiresFirst = hires.length > 0;
    const considerations = [
      'A work brief is a commitment, not a reply: it must leave this turn as tracked work with an owner and a gate.',
      `The brief needs ${needed.join(', ')}; the seats that declare those capabilities take it, and I hand it out rather than execute it.`,
      ...(hiresFirst ? [hireConsideration(hires, needed)] : []),
    ];
    return output({
      interpretation: `The board submitted the brief "${briefTitle}"${
        briefId === null ? '' : ` (${briefId})`
      } to ${selfId || 'me'}: ${oneLineGoal(briefGoal, briefTitle)}.`,
      considerations,
      conclusion: hiresFirst
        ? 'A seat nobody can carry must be staffed first, and only the root can decide that: the hiring request goes up the approval chain with the brief held behind it.'
        : 'Turn the brief into a capability-routed workflow so it becomes tracked, gated work.',
      goal: hiresFirst
        ? `the root decides the hiring request that unblocks "${briefTitle}"`
        : `the brief "${briefTitle}" becomes tracked work`,
      doneWhen: hiresFirst
        ? 'the hiring request waits on the root approval chain with the objectives held in a blocked task'
        : 'a workflow instance exists with an assigned task',
      steps: hiresFirst
        ? hireSteps(hires, considerations.length - 1, { briefRef, proposal })
        : [
            {
              action: 'CreateProposal',
              args: {
                capabilities: [...needed],
                title: proposal.title,
                goal: briefGoal,
              },
              reasonRef: 1,
            },
          ],
    });
  }

  if (type === 'Control.AgentInstructed') {
    const instruction = str(payload, 'instruction') ?? 'an operator instruction';
    // Capability routing, not a fixed template: analyse the mandate for the kinds of work it
    // needs and let the organization resolve each capability to a seat (never by title). A
    // capability nobody outside this seat can carry gets its seat staffed first, in the same
    // plan — the same A3 rule the work-brief path follows.
    const needed = requiredCapabilitiesFor(instruction);
    const hires = hireDrafts({ needed, selfPositionId: positionId, capabilitySeats });
    const proposal = {
      capabilities: [...needed],
      title: proposalTitle(instruction),
      goal: instruction,
    };
    const briefRef = str(event, 'eventId') ?? 'instruction';
    const hiresFirst = hires.length > 0;
    const considerations = [
      'A written instruction from the board is a first-class organizational input.',
      `The instruction needs ${needed.join(', ')}; the matching seats provide them, so a generated workflow becomes tracked work.`,
      ...(hiresFirst ? [hireConsideration(hires, needed)] : []),
    ];
    return output({
      interpretation: `The board instructed ${selfId || 'me'}: "${instruction}".`,
      considerations,
      conclusion: hiresFirst
        ? 'A seat nobody can carry must be staffed first, and only the root can decide that: the hiring request goes up the approval chain with the instruction held behind it.'
        : 'Turn the instruction into a workflow-backed piece of work.',
      goal: hiresFirst
        ? 'the root decides the hiring request that unblocks the instruction'
        : 'the instruction becomes tracked work',
      doneWhen: hiresFirst
        ? 'the hiring request waits on the root approval chain with the objectives held in a blocked task'
        : 'a workflow instance exists with an assigned task',
      steps: hiresFirst
        ? hireSteps(hires, considerations.length - 1, { briefRef, proposal })
        : [
            {
              action: 'CreateProposal',
              args: {
                capabilities: [...needed],
                title: proposal.title,
                goal: instruction,
              },
              reasonRef: 1,
            },
          ],
    });
  }

  if (type === 'Task.Assigned') {
    const taskId = str(payload, 'taskId');
    if (taskId === null) return noOp(`A ${type} event names no task for ${selfId || 'me'}.`);
    const title = str(payload, 'title') ?? '';
    // The wake-up event is the whole briefing: the task's goal, the output keys its step will be
    // judged on and this seat's own tags. All three shape what gets handed back.
    const deliverable = deliverableFor({
      goal: str(payload, 'goal') ?? '',
      title,
      requiredOutputKeys: strArray(payload, 'requiredOutputKeys'),
      capabilities,
      // The step's kind of work, restated on the event that woke this agent. `null` on every
      // task written before the field existed, and on work nobody labelled.
      capability: str(payload, 'capability'),
    });
    return output({
      interpretation: `Task ${taskId}${title === '' ? '' : ` "${title}"`} was assigned to ${selfId || 'me'}.`,
      considerations: [
        'The task is mine, open, and the next thing the workflow is waiting on.',
        `The delivery belongs to this seat: ${capabilities.length === 0 ? 'general delivery' : capabilities.join(', ')}.`,
        'Submitting the required output now is what moves the instance forward.',
      ],
      conclusion: 'Accept the task, start it and submit the work product.',
      goal: `${taskId} is submitted with a verifiable result`,
      doneWhen: 'the task carries a submitted result',
      steps: [
        { action: 'AcceptTask', args: { taskId }, reasonRef: 0 },
        { action: 'StartTask', args: { taskId }, reasonRef: 0 },
        {
          action: 'ProgressReport',
          args: {
            taskId,
            summary: deliverable.summary,
            data: deliverable.data,
            ...(deliverable.artifacts.length === 0
              ? {}
              : { artifacts: [...deliverable.artifacts] }),
          },
          reasonRef: 1,
        },
      ],
    });
  }

  if (type === 'Workflow.ApprovalRequested') {
    const instanceId = str(payload, 'instanceId');
    if (instanceId === null) return noOp('The approval request names no workflow instance.');
    const requiredRoles = strArray(payload, 'requiredRoles');
    return output({
      interpretation: `Workflow ${instanceId} is blocked on an approval I can decide.`,
      considerations: [
        'The instance cannot advance while the gate is open.',
        `My position${positionId === '' ? '' : ` (${positionId})`} ${
          requiredRoles.length === 0 ? 'may decide this gate' : `is among the required roles [${requiredRoles.join(', ')}]`
        }.`,
      ],
      conclusion: 'Grant the approval.',
      goal: `${instanceId} leaves the gate`,
      doneWhen: 'the approval is recorded as granted',
      steps: [
        { action: 'CastVote', args: { instanceId, decision: 'granted' }, reasonRef: 1 },
      ],
    });
  }

  if (type === 'Communication.MessageSent') {
    const sender = str(payload, 'senderId') ?? 'a colleague';
    const channelId = str(payload, 'channelId');
    if (str(payload, 'messageType') !== 'request') {
      return noOp(`Message from ${sender} is informational; no reply is required.`);
    }
    if (channelId === null) return noOp(`A message from ${sender} arrived with no channel.`);
    return output({
      interpretation: `${sender} sent ${selfId || 'me'} a message in ${channelId}.`,
      considerations: ['A request from a colleague deserves an explicit response.'],
      conclusion: 'Reply on the same channel.',
      goal: 'the sender knows the message was received',
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

  return noOp(
    `Event ${type === '' ? '(unreadable)' : type} does not require a side effect from ${selfId || 'me'}.`,
  );
}
