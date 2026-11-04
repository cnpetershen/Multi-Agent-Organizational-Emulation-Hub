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

export function buildCognitionPrompt(context: CognitionContext): string {
  const { state, inputEvent, simTime } = context;
  const agenda = state.agenda
    .map((item, index) => `${index}. ${JSON.stringify(item)}`)
    .join('\n');
  const workCatalog = renderWorkCatalog(context);

  return [
    'Respond only with the required JSON object.',
    '',
    '## Current state',
    `Simulation time: ${simTime}`,
    `Employment status: ${state.employment}`,
    `Presence: ${state.presence}`,
    `Current cycle: ${state.currentCycleId ?? '(none)'}`,
    `State version: ${state.version}`,
    'Agenda:',
    agenda === '' ? '(empty)' : agenda,
    '',
    '## Organization',
    renderOrganization(context),
    ...(workCatalog === null ? [] : ['', workCatalog]),
    '',
    '## Plan conventions',
    ...(workCatalog === null
      ? []
      : [
          '- `DispatchWork` args `{"positionId": "...", "title": "...", "goal": "...", "detail?": "...", "requiredSkills?": ["..."], "requiredOutputKeys": ["..."], "priority?": 1..9, "dueAtSim?": <sim>}` assign exactly one work item to a seat from the Work catalog. `requiredOutputKeys` is mandatory and must name what the output will be judged on; use one step per work item.',
        ]),
    '- `CreateProposal` args `{"workflowId": "..."}` start a registered workflow template.',
    '- `CreateProposal` args `{"capabilities": ["implementation", "testing"]}` ask the organization to generate a workflow from capability ids: each id is a kind of work (`product_requirement`, `technical_design`, `implementation`, `testing`, `marketing`), matched to seats via `Position.capabilities` — never via position titles. When no template fits an instruction, analyse the goal and list only the capabilities the work needs.',
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
    JSON.stringify(
      {
        interpretation: 'string, one short paragraph',
        considerations: 'array of non-empty strings, 1..12 entries',
        conclusion: 'string, one short paragraph',
        confidence: 'number between 0 and 1',
        plan: {
          goal: 'string',
          doneWhen: 'string',
          steps: [
            {
              action: `one of [${ACTION_SPACE}]`,
              args: 'object',
              reasonRef: 'integer index into considerations',
            },
          ],
        },
      },
      null,
      2,
    ),
  ].join('\n');
}
