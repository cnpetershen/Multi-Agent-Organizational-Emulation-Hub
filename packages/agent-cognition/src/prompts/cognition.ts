import { ACTIONS } from '@maoeh/shared-types';
import type { CognitionContext } from '../context/cognition-context.js';

const ACTION_SPACE = ACTIONS.join(', ');

function renderMembers(
  title: string,
  members: readonly { id: string; name: string }[],
): string {
  if (members.length === 0) return `${title}: (none)`;
  return `${title}:\n${members.map((member) => `- ${member.name} [${member.id}]`).join('\n')}`;
}

/**
 * The organization's capability roll-up — "what can *we* do", as opposed to the agent's own
 * `Position capabilities` line ("what can *I* do").
 *
 * A planner that only knows its own tags cannot stack the capabilities the organization holds,
 * which is what left a task book decomposing into a single narrow step. Each seat carries its
 * id so the plan can name the exact seat to fill, and vacancy is split in two: `(vacant)` means
 * nobody — not even a staffed manager — can carry that seat's work, while
 * `(vacant, covered by [seat])` means the reporting chain already escalates it to someone who
 * can. Only the first kind leaves a capability with no executor and justifies a `RecommendHire`.
 */
function renderCapabilityMap(
  offers:
    | readonly {
        readonly capability: string;
        readonly seats: readonly {
          readonly id: string;
          readonly title: string;
          readonly staffed: boolean;
          readonly coveredBy?: string | null;
        }[];
      }[]
    | undefined,
): string {
  if (offers === undefined || offers.length === 0) {
    return 'Capabilities the company provides: (unknown)';
  }
  const lines = offers.map((offer) => {
    const seats =
      offer.seats.length === 0
        ? '(no seat)'
        : offer.seats
            .map((seat) => {
              const label = `${seat.title} [${seat.id}]`;
              if (seat.staffed) return label;
              const cover = seat.coveredBy;
              return cover === undefined || cover === null
                ? `${label} (vacant)`
                : `${label} (vacant, covered by [${cover}])`;
            })
            .join(', ');
    return `- ${offer.capability}: ${seats}`;
  });
  return ['Capabilities the company provides (capability: seats that declare it):', ...lines].join(
    '\n',
  );
}

function renderOrganization(context: CognitionContext): string {
  const { organization } = context;
  const capabilities =
    organization.position.capabilities === undefined ||
    organization.position.capabilities.length === 0
      ? '(none)'
      : organization.position.capabilities.join(', ');
  const lines = [
    `Company: ${organization.company.name} [${organization.company.id}]`,
    `Department: ${
      organization.department === null ? '(none)' : `${organization.department.name} [${organization.department.id}]`
    }`,
    `Position: ${organization.position.title} [${organization.position.id}]`,
    `Position capabilities: ${capabilities}`,
    renderCapabilityMap(organization.capabilityMap),
    `Self: ${organization.employee.name} [${organization.employee.id}]`,
    organization.manager === null
      ? 'Manager: (none)'
      : `Manager: ${organization.manager.name} [${organization.manager.id}]`,
    renderMembers('Reports', organization.reports),
    renderMembers('Peers', organization.peers),
    renderMembers('Colleagues', organization.colleagues),
  ];
  return lines.join('\n');
}

/**
 * The planner's dispatching view (M1.4 §5.6): seats with their live load, workflow templates,
 * and how many instances are in flight — rendered only for a seat whose `canDispatchWork` was
 * authorized by the real policy, so a non-manager never receives a catalogue it cannot use.
 */
function renderWorkCatalog(context: CognitionContext): string | null {
  const catalog = context.workCatalog;
  if (catalog === undefined || !catalog.canDispatchWork) return null;
  const seats = catalog.positions.map(
    (position) =>
      `- ${position.positionId} | ${position.title} | dept ${position.departmentId ?? '(none)'} | authority ${position.authorityLevel} | open tasks ${position.openTaskCount}`,
  );
  const templates =
    catalog.workflows.length === 0
      ? ['- (none)']
      : catalog.workflows.map(
          (workflow) =>
            `- ${workflow.workflowId} | ${workflow.title} | steps ${workflow.stepCount} | approval gates ${workflow.approvalGateCount}`,
        );
  return [
    '## Work catalog (what you may dispatch)',
    'Seats (positionId | title | department | authority | open tasks):',
    ...seats,
    'Workflow templates (workflowId | title | steps | approval gates):',
    ...templates,
    `In-flight workflow instances: ${catalog.inFlightWorkflows}`,
  ].join('\n');
}

/**
 * The conversation this agent can actually take part in (M-COMMUNICATION).
 *
 * Before this section existed, the executor implemented `SendMessage` and the policy allowed it,
 * but the prompt carried neither a channel id nor the message contract — so a live planner could
 * not produce a sendable message, and a real organization ran with zero communication events.
 * Rendering only channels the agent is a member of keeps every suggested send inside the
 * authorization the service already enforces.
 */
function renderCommunication(context: CognitionContext): string | null {
  const view = context.communication;
  if (view === undefined || view.channels.length === 0) return null;
  const channels = view.channels.map(
    (channel) =>
      `- ${channel.channelId} (${channel.channelType}) members: ${channel.memberIds.join(', ')}`,
  );
  const messages =
    view.recentMessages.length === 0
      ? ['(no messages on these channels yet)']
      : view.recentMessages.map(
          (message) =>
            `- t${String(message.createdAtSim)} ${message.senderId} → ${message.recipientIds.join(', ')} · ${
              message.messageType
            } · "${message.subject}": ${message.body}`,
        );
  return [
    '## Communication',
    'Channels you belong to (use the channelId exactly as written):',
    ...channels,
    'Recent messages (oldest first):',
    ...messages,
    'SendMessage args: {"channelId": "<a channel above>", "recipientIds": ["<employeeId from that channel>"], "subject": "<short subject>", "body": "<the actual message>", "messageType": "request" | "response"}',
    'Use SendMessage when a colleague has to supply something you cannot produce alone (a review, a decision, a piece of their work). Never list yourself as a recipient, never invent a channelId, and send at most one message per cycle.',
    'When the input event is a `Communication.MessageSent` with `messageType: "request"`, answer it with one SendMessage on the same `channelId` addressed to `senderId`, with `messageType: "response"`, and include the substance the sender asked for — not an empty acknowledgement.',
    'When the input event is a `Communication.MessageSent` with `messageType: "response"` and it answers something you asked, that is your input: use it to finish your own open task and submit the deliverable in this cycle. Do not reply again to acknowledge it; a second message is not a deliverable.',
    'Do not message a colleague in place of doing your own task, and do not send a message that only thanks someone.',
  ].join('\n');
}

export function buildCognitionPrompt(context: CognitionContext): string {
  const { state, inputEvent, simTime } = context;
  const agenda = state.agenda
    .map((item, index) => `${index}. ${JSON.stringify(item)}`)
    .join('\n');
  const workCatalog = renderWorkCatalog(context);
  const communication = renderCommunication(context);
  const openTasks = state.assignedTasks ?? [];
  const openTaskLines =
    openTasks.length === 0
      ? []
      : [
          '## Your open tasks (you are the assignee; do not re-accept an accepted task)',
          ...openTasks.map(
            (task, index) =>
              `${index + 1}. taskId=${task.taskId} | status=${task.status} | title=${task.title}\n   goal: ${task.goal}${
                task.allowedCommands === undefined || task.allowedCommands.length === 0
                  ? ''
                  : `\n   legal commands in this status: ${task.allowedCommands.join(', ')}`
              }`,
          ),
          // The machine is rendered per task, so the same rule holds for a task that is already
          // started and for one that is not — no hardcoded status list in the prompt.
          'A command outside a task’s `legal commands` list is refused with `invalid_transition`: if `submit` is not listed, transition the task into a status that lists it first (for example `StartTask` on an accepted task), and only then report the work.',
        ];

  return [
    'Respond only with the required JSON object.',
    '',
    '## Current state',
    `Simulation time: ${simTime}`,
    `Employment status: ${state.employment}`,
    `Presence: ${state.presence}`,
    `Current cycle: ${state.currentCycleId ?? '(none)'}`,
    `State version: ${state.version}`,
    ...openTaskLines,
    '## Non-negotiable submission rule',
    'When you use SubmitReport: the `data` object you send back MUST contain EVERY one of this task’s `requiredOutputKeys`, spelled exactly as listed — no synonyms, no aliases, no missing keys. Each value must be `true` (or a string when the key asks for a string, like a `qa_report`). This is how the deterministic verifier closes the task.',
    ...((state.assignedTasks ?? []).flatMap((task) =>
      task.verificationKeys && task.verificationKeys.length > 0
        ? [`For task ${task.taskId}: required verification keys are ${task.verificationKeys.join(', ')}`]
        : [],
    )),
    'Agenda:',
    agenda === '' ? '(empty)' : agenda,
    '',
    '## Organization',
    renderOrganization(context),
    ...(communication === null ? [] : ['', communication]),
    ...(workCatalog === null ? [] : ['', workCatalog]),
    '',
    '## Plan conventions',
    ...(workCatalog === null
      ? []
      : [
          '- `DispatchWork` args `{"positionId": "...", "title": "...", "goal": "...", "detail?": "...", "requiredSkills?": ["..."], "requiredOutputKeys": ["..."], "priority?": 1..9, "dueAtSim?": <sim>}` assign exactly one work item to a seat from the Work catalog. `requiredOutputKeys` is mandatory and must name what the output will be judged on; use one step per work item.',
        ]),
    '- `CreateProposal` args `{"workflowId": "..."}` start a registered workflow template.',
    '- `RequestCollaboration` records a tracked collaboration request: name the colleague\'s employeeId, the taskId of one of your open tasks, and a purpose. It is for a formal dependency that has to be on the record — use `SendMessage` for a quick question.',
    '- `CreateProposal` args `{"capabilities": ["implementation", "testing"]}` ask the organization to generate a workflow from capability ids: each id is a kind of work (`product_requirement`, `technical_design`, `implementation`, `testing`, `marketing`), matched to seats via `Position.capabilities` — never via position titles. When no template fits an instruction, analyse the goal and list only the capabilities the work needs.',
    '- A work brief (`Control.WorkBriefed`) that needs more than one capability or more than one stage is a workflow, not a pile of standalone tasks: answer it with `CreateProposal` so the generated draft waits on the assignment canvas. Use one `DispatchWork` only when the brief is genuinely one atomic item, and never replace a multi-stage brief with several `DispatchWork` steps.',
    '- When the input event is a `Task.Assigned` or `Task.Started` for a workflow step, you are the executor of that step: use `StartTask`, `ProduceArtifact`/`SubmitReport` and complete your own deliverable. Do not `DispatchWork` or `CreateProposal` from inside an assigned step; those actions belong to a manager decomposing an unassigned objective.',
    '- `RecommendHire` args `{"positionId": "...", "employeeId": "<positionId>-hire", "name": "...", "responsibilities": ["..."], "expertise?": ["..."], "reason?": "...", "briefRef?": "<the causal event id>", "proposal": {"capabilities": ["..."], "title": "...", "goal": "..."}}` ask the root to fill a seat the chart already has (its id comes from the capability map above). When a capability the goal needs sits only on an `(vacant)` seat with no `coveredBy`, this is your *whole* plan: emit only `RecommendHire` steps and no `CreateProposal` — the root approval chain decides, the objectives wait in a blocked task, and the kernel starts the proposal (carried in `proposal`) once the hire is granted.',
    '- Build the capability list from the organization list above: it is authoritative. A capability the company does not declare cannot be scheduled, so name the closest declared capability instead of one nobody provides.',
    '',
    '## Input event',
    JSON.stringify(
      {
        eventId: inputEvent.eventId,
        type: inputEvent.type,
        actorId: inputEvent.actorId,
        subjectId: inputEvent.subjectId,
        payload: inputEvent.payload,
        occurredAtSim: inputEvent.occurredAtSim,
      },
      null,
      2,
    ),
    '',
    '## Required JSON schema',
    'Rules the JSON must satisfy — DeepSeek respects examples over descriptions, so every',
    'expected field is shown with its real value type:',
    '- `reasonRef` is an integer index into `considerations` (0-based) and is MANDATORY for every step.',
    '- `steps[].action` must be one of these executor action codes:',
    `[${ACTION_SPACE}]`,
    '- `confidence` is a number between 0 and 1 (e.g. 0.72), not a string, not a percentage.',
    '- `steps[].args` must be an object matching the action you picked.',
    JSON.stringify(
      {
        interpretation: 'string, one short paragraph',
        considerations: ['string', 'string'],
        conclusion: 'string, one short paragraph',
        confidence: 0.72,
        plan: {
          goal: 'string',
          doneWhen: 'string',
          steps: [
            {
              action: 'DispatchWork',
              args: {
                positionId: 'engineer',
                title: 'string',
                goal: 'string',
                requiredOutputKeys: ['index.html'],
                priority: 3,
              },
              reasonRef: 0,
            },
          ],
        },
      },
      null,
      2,
    ),
  ].join('\n');
}
