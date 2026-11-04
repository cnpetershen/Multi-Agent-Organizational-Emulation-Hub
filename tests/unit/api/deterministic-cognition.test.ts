import { describe, expect, it } from 'vitest';
import { ACTIONS } from '@maoeh/shared-types';
import { buildPlan, cognitionOutputSchema } from '@maoeh/agent-cognition';
import { PLAN_ACTION_BINDINGS } from '@maoeh/kernel';
import type { LlmRequest } from '@maoeh/llm-gateway';

import {
  deterministicCognitionText,
  parseCognitionPrompt,
} from '../../../apps/api/src/deterministic-cognition';

interface TestEvent {
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/**
 * Mirrors `buildCognitionPrompt` (`packages/agent-cognition/src/prompts/cognition.ts`):
 * the stand-in must survive the real section markers, the real `Self`/`Position` lines and
 * the real event JSON shape, otherwise it would only be proven against a test-only prompt.
 *
 * `catalog` is the optional `## Work catalog` section the same prompt renders for a seat the
 * policy lets dispatch (M1.4 §5.6) — absent for everyone else, which is what the brief
 * fallback below has to cope with.
 *
 * `capabilityLines` is the rendered capability map (A3): seat ids in brackets, `(vacant)` for
 * a seat nobody carries, `(vacant, covered by [seat])` when its manager up the reporting chain
 * covers it. The default below is a staffed company — no seat needs hiring, which is the
 * premise every pre-A3 assertion keeps.
 */
const STAFFED_CAPABILITY_MAP: readonly string[] = [
  'Capabilities the company provides (capability: seats that declare it):',
  '- frontend: Frontend Engineer [frontend-engineer]',
  '- implementation: Software Engineer [engineer], Frontend Engineer [frontend-engineer]',
];

const BRIEF_CATALOG: readonly string[] = [
  '## Work catalog (what you may dispatch)',
  'Seats (positionId | title | department | authority | open tasks):',
  '- ceo | Chief Executive Officer | dept (none) | authority 5 | open tasks 0',
  '- engineer | Software Engineer | dept engineering | authority 3 | open tasks 1',
  '- qa | QA Engineer | dept engineering | authority 3 | open tasks 3',
  'Workflow templates (workflowId | title | steps | approval gates):',
  '- product-analysis | Product Analysis | steps 4 | approval gates 1',
  'In-flight workflow instances: 0',
];

function promptFor(
  event: TestEvent,
  capabilities = 'implementation, frontend',
  catalog: readonly string[] = [],
  capabilityLines: readonly string[] = STAFFED_CAPABILITY_MAP,
): string {
  return [
    'Respond only with the required JSON object.',
    '',
    '## Current state',
    'Simulation time: 7',
    'Employment status: active',
    'Presence: busy',
    'Current cycle: cycle-3',
    'State version: 4',
    'Agenda:',
    '(empty)',
    '',
    '## Organization',
    'Company: Future AI Lab [future-ai-lab]',
    'Department: (none)',
    'Position: Chief Executive Officer [ceo]',
    `Position capabilities: ${capabilities === '' ? '(none)' : capabilities}`,
    ...capabilityLines,
    'Self: Alex [ceo-alex]',
    'Manager: (none)',
    'Reports:',
    '- John [cto-john]',
    'Peers: (none)',
    'Colleagues: (none)',
    ...(catalog.length === 0 ? [] : ['', ...catalog]),
    '',
    '## Input event',
    JSON.stringify(
      {
        eventId: 'evt-7',
        type: event.type,
        actorId: 'ceo-alex',
        subjectId: 'ceo-alex',
        payload: event.payload ?? {},
        occurredAtSim: 7,
      },
      null,
      2,
    ),
    '',
    '## Required JSON schema',
    JSON.stringify({ interpretation: 'string', plan: { steps: [{ action: 'string' }] } }, null, 2),
  ].join('\n');
}

function requestFor(
  event: TestEvent,
  capabilities?: string,
  catalog?: readonly string[],
  capabilityLines?: readonly string[],
): LlmRequest {
  return {
    requestId: 'req-1',
    system: 'system',
    prompt: promptFor(event, capabilities, catalog, capabilityLines),
  };
}

function parse(
  event: TestEvent,
  capabilities?: string,
  catalog?: readonly string[],
  capabilityLines?: readonly string[],
) {
  const text = deterministicCognitionText(requestFor(event, capabilities, catalog, capabilityLines));
  const parsed = JSON.parse(text) as unknown;
  const schema = cognitionOutputSchema.safeParse(parsed);
  expect(schema.success, `${event.type}: ${JSON.stringify(schema.error?.issues ?? [])}`).toBe(true);
  if (!schema.success) throw new Error('unreachable');
  const output = schema.data;
  const plan = buildPlan({
    draft: output.plan,
    considerationsCount: output.considerations.length,
    idempotencySeed: 'req-1',
  });
  expect(plan.ok, event.type).toBe(true);
  if (!plan.ok) throw new Error('unreachable');
  return { output, plan: plan.value };
}

describe('deterministic cognition (M1.2-A root cause fix)', () => {
  it('reads the agent identity and input event out of the real prompt shape', () => {
    const parsed = parseCognitionPrompt(promptFor({ type: 'Control.AgentInstructed' }));
    expect(parsed.selfId).toBe('ceo-alex');
    expect(parsed.positionId).toBe('ceo');
    expect(parsed.capabilities).toEqual(['implementation', 'frontend']);
    expect(parsed.event['type']).toBe('Control.AgentInstructed');
  });

  it('answers a human instruction with a capability-routed workflow proposal (Human -> CEO)', () => {
    const { plan } = parse({
      type: 'Control.AgentInstructed',
      payload: { instruction: 'Own the churn problem.' },
    });
    expect(plan.steps.map((step) => step.action)).toEqual(['CreateProposal']);
    // No template is hardcoded: the CEO states *which kinds of work* this needs, and the
    // organization resolves each capability to a seat. A vague mandate falls back to the
    // core delivery chain (requirements -> design -> implementation -> testing).
    expect(plan.steps[0]?.args['capabilities']).toEqual([
      'product_requirement',
      'technical_design',
      'implementation',
      'testing',
    ]);
    expect(plan.steps[0]?.args['workflowId']).toBeUndefined();
    expect(String(plan.steps[0]?.args['goal'])).toBe('Own the churn problem.');
    // The work is named after the instruction, not a constant — the console, the workflow card
    // and the delivery page all read this title.
    expect(String(plan.steps[0]?.args['title'])).toBe('Own the churn problem.');
  });

  it('narrows the capabilities to what the instruction asks for', () => {
    const { plan } = parse({
      type: 'Control.AgentInstructed',
      payload: { instruction: '开发一个贪吃蛇 Demo，写好后要通过测试' },
    });
    expect(plan.steps[0]?.args['capabilities']).toEqual(['implementation', 'testing']);
  });

  it('answers an assigned task with accept, start and submit (CEO/CTO -> work)', () => {
    const { plan } = parse({
      type: 'Task.Assigned',
      payload: {
        taskId: 'task-4',
        title: 'Draft technical approach',
        goal: 'Complete step "Draft technical approach" of workflow "Product Analysis": Own the churn problem.',
        requiredOutputKeys: ['approach', 'risks'],
      },
    });
    expect(plan.steps.map((step) => step.action)).toEqual([
      'AcceptTask',
      'StartTask',
      'ProgressReport',
    ]);
    const submit = plan.steps[2];
    expect(submit?.args['taskId']).toBe('task-4');
    const data = submit?.args['data'] as Record<string, unknown> | undefined;
    // Exactly the keys the step declared it will be judged on — no more, no less — so the
    // step's own deterministic verification passes on the first submission.
    expect(Object.keys(data ?? {}).sort()).toEqual(['approach', 'risks']);
    expect(String(data?.['approach'])).toContain('smallest end-to-end slice');
  });

  it('answers the product-analysis intake contract key-for-key', () => {
    const { plan } = parse({
      type: 'Task.Assigned',
      payload: {
        taskId: 'task-1',
        title: 'Define analysis brief',
        goal: 'Complete step "Define analysis brief" of workflow "Product Analysis": Own the churn problem.',
        requiredOutputKeys: ['problem', 'success_criteria'],
      },
    });
    const data = plan.steps[2]?.args['data'] as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['problem', 'success_criteria']);
    expect(String(data['problem'])).toContain('Own the churn problem');
  });

  it('delivers a goal-anchored work product instead of one constant for every task', () => {
    // The regression the console showed as "the game produced nothing but a series of steps":
    // a generated-workflow step declares no output keys, so the delivery is shaped by the
    // executor's own seat tags and quotes the goal it was handed.
    const { plan } = parse({
      type: 'Task.Assigned',
      payload: {
        taskId: 'task-7',
        title: 'Frontend',
        goal: 'Complete step "Frontend" of workflow "贪吃蛇小游戏": 做一个Web 端的贪吃蛇小游戏',
      },
    });
    const submit = plan.steps[2];
    const data = submit?.args['data'] as Record<string, unknown>;
    const artifacts = submit?.args['artifacts'] as readonly string[] | undefined;
    expect(data['entrypoint']).toBe('frontend/index.html');
    expect(data['stack']).toEqual(['TypeScript', 'HTML5']);
    expect(artifacts).toEqual(['frontend/index.html', 'frontend/README.md']);
    // The instruction reaches the deliverable verbatim, which is what makes it *this* job.
    expect(JSON.stringify(data)).toContain('贪吃蛇小游戏');
    expect(String(submit?.args['summary'])).toContain('贪吃蛇小游戏');
    // A named game ships the game: a canvas board and a running game loop, not a page that only
    // renders the step's name (the reported "游戏没写出来").
    expect(String(data['content'])).toContain('<canvas id="board"');
    expect(String(data['content'])).toContain('requestAnimationFrame');
  });

  it('ships a playable Tetris page when the mandate names 俄罗斯方块', () => {
    const { plan } = parse({
      type: 'Task.Assigned',
      payload: {
        taskId: 'task-8',
        title: 'Implementation',
        goal: '开发一个俄罗斯方块程序\n前端Web SPA，后端记录每次排名和得分',
      },
    });
    const content = String((plan.steps[2]?.args['data'] as Record<string, unknown>)['content']);
    expect(content).toContain('<!doctype html');
    expect(content).toContain('<canvas id="board"');
    expect(content).toContain('var SHAPES');
    expect(content).toContain('function clearLines');
    expect(content).toContain('俄罗斯方块');
  });

  it('shapes a delivery no workflow contract declares into a report', () => {
    const { plan } = parse(
      {
        type: 'Task.Assigned',
        payload: { taskId: 'task-9', title: 'Ad hoc', goal: 'Look into the outage' },
      },
      '',
    );
    const data = plan.steps[2]?.args['data'] as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['findings', 'recommendation']);
    expect(JSON.stringify(data)).toContain('Look into the outage');
  });

  it('answers an approval gate with a granted vote (gate -> CEO)', () => {
    const { plan } = parse({
      type: 'Workflow.ApprovalRequested',
      payload: {
        instanceId: 'instance-2',
        stepId: 'design-gate',
        requiredRoles: ['ceo'],
      },
    });
    expect(plan.steps.map((step) => step.action)).toEqual(['CastVote']);
    expect(plan.steps[0]?.args['decision']).toBe('granted');
    expect(plan.steps[0]?.args['instanceId']).toBe('instance-2');
  });

  it('answers a colleague request once and stays quiet on responses', () => {
    const request = parse({
      type: 'Communication.MessageSent',
      payload: { senderId: 'cto-john', channelId: 'company-future-ai-lab', messageType: 'request' },
    });
    expect(request.plan.steps.map((step) => step.action)).toEqual(['SendMessage']);

    const response = parse({
      type: 'Communication.MessageSent',
      payload: { senderId: 'cto-john', channelId: 'company-future-ai-lab', messageType: 'response' },
    });
    expect(response.plan.steps.map((step) => step.action)).toEqual(['Reflect']);
  });

  it('acknowledges every other event instead of failing the turn', () => {
    for (const event of [
      { type: 'Workflow.InstanceCreated' },
      { type: 'Workflow.StepEntered' },
      { type: 'Task.ProgressReported' },
      { type: 'System.SimClockTicked' },
      { type: '' },
    ] as const) {
      const { plan } = parse(event);
      expect(plan.steps.map((step) => step.action)).toEqual(['Reflect']);
    }
  });

  it('stays schema-valid even when the prompt carries no parseable event', () => {
    const text = deterministicCognitionText({
      requestId: 'req-2',
      system: 'system',
      prompt: 'this is not a cognition prompt',
    });
    const schema = cognitionOutputSchema.safeParse(JSON.parse(text) as unknown);
    expect(schema.success).toBe(true);
  });

  it('only ever emits actions the closed Action Space and the kernel can execute', () => {
    const events = [
      { type: 'Control.AgentInstructed', payload: { instruction: 'go' } },
      {
        type: 'Control.WorkBriefed',
        payload: { briefId: 'brief-1', title: 'Brief', goal: 'Deliver', verificationKeys: ['done'] },
      },
      { type: 'Task.Assigned', payload: { taskId: 'task-1' } },
      { type: 'Workflow.ApprovalRequested', payload: { instanceId: 'instance-1' } },
      {
        type: 'Communication.MessageSent',
        payload: { senderId: 'cto-john', channelId: 'c', messageType: 'request' },
      },
      { type: 'Something.Else' },
    ];
    for (const event of events) {
      const { plan } = parse(event);
      for (const step of plan.steps) {
        expect(ACTIONS as readonly string[]).toContain(step.action);
        expect(Object.keys(PLAN_ACTION_BINDINGS)).toContain(step.action);
      }
    }
  });
});

/**
 * M1.4 acceptance 1/3: the composed runtime's cognition is the production mock, so a work
 * brief only becomes tracked work if `Control.WorkBriefed` decomposes here.
 *
 * The contract under test is **capability routing**, not seat naming: the brief's goal text is
 * analysed into the kinds of work it needs and the kernel's capability router resolves each one
 * to a staffed seat (ADR/README: capability → seat, never a seat picked by name). The earlier
 * contract — two `DispatchWork` steps onto the two least-loaded seats of the whole chart — was
 * the defect: in a company that had not hired yet those seats are empty, `TaskService` assigned
 * with `assigneeEmployeeId: null`, nobody was ever woken, and the brief produced nothing.
 * `tests/integration/starter-company-brief.test.ts` pins that end-to-end.
 */
describe('deterministic cognition: work brief decomposition (M1.4)', () => {
  const BRIEF = {
    commandId: 'cmd-brief-1',
    briefId: 'brief-1',
    agentId: 'ceo-alex',
    operatorId: 'operator-dana',
    reason: 'board wants the login feature this sprint',
    title: 'Login feature',
    goal: 'Ship the login feature this sprint',
    context: 'Handed over by the board.',
    verificationKeys: ['endpoint', 'test-report'],
    priority: 2,
    dueAtSim: 600,
  };

  it('routes the brief by capability instead of picking seats off the chart', () => {
    const { plan } = parse(
      { type: 'Control.WorkBriefed', payload: BRIEF },
      'implementation, frontend',
      BRIEF_CATALOG,
    );

    expect(plan.steps.map((step) => step.action)).toEqual(['CreateProposal']);
    const args = plan.steps[0]?.args ?? {};
    // No seat is named by this planner at all: the router owns the seat decision.
    expect(args['positionId']).toBeUndefined();
    expect(args['requiredOutputKeys']).toBeUndefined();
    // "Ship the login feature this sprint" carries no build/design/test cue in any language, so
    // a vague brief falls back to the core delivery chain — the same fallback a vague mandate gets.
    expect(args['capabilities']).toEqual([
      'product_requirement',
      'technical_design',
      'implementation',
      'testing',
    ]);
    expect(String(args['goal'])).toBe('Ship the login feature this sprint');
    expect(args['workflowId']).toBeUndefined();
  });

  it('derives the capabilities from the brief goal text, not from a fixed list', () => {
    const { plan } = parse(
      {
        type: 'Control.WorkBriefed',
        payload: { ...BRIEF, title: 'Tetris', goal: '做一个前端Web SPA 后端记分的小游戏' },
      },
      'implementation, frontend',
      BRIEF_CATALOG,
    );
    // frontend/backend pull in their parent `implementation` (SPECIALIZATION_PARENTS).
    expect(plan.steps[0]?.args['capabilities']).toEqual(['implementation', 'frontend', 'backend']);
    expect(String(plan.steps[0]?.args['title'])).toBe('Tetris');
  });

  it('never names a seat the catalog did not offer and never needs a catalog at all', () => {
    const withoutCatalog = parse({ type: 'Control.WorkBriefed', payload: BRIEF });
    const withCatalog = parse({ type: 'Control.WorkBriefed', payload: BRIEF }, '', BRIEF_CATALOG);
    // The seat decision lives in the kernel router, which reads the live chart, so the plan is
    // identical whether or not this prompt carried a dispatch catalogue.
    expect(withoutCatalog.plan.steps.map((step) => step.action)).toEqual(['CreateProposal']);
    expect(JSON.stringify(withoutCatalog.plan.steps)).toBe(
      JSON.stringify(withCatalog.plan.steps),
    );
  });

  it('stays schema-valid and reason-backed for every brief-shaped prompt', () => {
    const payloads = [
      BRIEF,
      { title: '', goal: '', verificationKeys: [] },
      { title: 'Only a title' },
      {},
    ];
    for (const payload of payloads) {
      const { output, plan } = parse(
        { type: 'Control.WorkBriefed', payload },
        'implementation, frontend',
        BRIEF_CATALOG,
      );
      expect(plan.steps.length).toBeGreaterThanOrEqual(1);
      for (const step of plan.steps) {
        expect(output.considerations[step.reasonRef]).toBeDefined();
        expect((step.args['capabilities'] as readonly string[]).length).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * A3 (`role-agents-cannot-complete-tasks.md` §9): a needed capability whose declaring seats are
 * all vacant — with no staffed manager up the reporting chain to cover them — cannot be routed
 * at all, and until A3 that failure was terminal (`invalid_input`, brief consumed, no retry).
 * The stand-in therefore emits `RecommendHire` for the seat *before* `CreateProposal` in the
 * same plan, mirroring the router's own coverage rule off the prompt's capability map: staffed
 * seat, or escalation to a staffed manager (`covered by`), both mean "no hire needed".
 */
describe('deterministic cognition: recommend hiring before the proposal (A3)', () => {
  // The starter company's delivery seats, exactly as `buildCognitionPrompt` renders them:
  // every seat that could carry a frontend/backend build is vacant with no cover. A seat that
  // declares several capabilities appears under each of them, like the live chart does.
  const VACANT_CAPABILITY_MAP: readonly string[] = [
    'Capabilities the company provides (capability: seats that declare it):',
    '- backend: Backend Engineer [backend-engineer] (vacant), Software Engineer [engineer] (vacant)',
    '- frontend: Software Engineer [engineer] (vacant), Frontend Engineer [frontend-engineer] (vacant)',
    '- implementation: Agent Engineer [agent-engineer] (vacant), Software Engineer [engineer] (vacant), Frontend Engineer [frontend-engineer] (vacant)',
  ];

  // Vacant, but the reporting chain escalates the work to a staffed manager — the router
  // resolves these without any hire, so the planner must not staff them either.
  const COVERED_CAPABILITY_MAP: readonly string[] = [
    'Capabilities the company provides (capability: seats that declare it):',
    '- implementation: Software Engineer [engineer] (vacant, covered by [cto])',
    '- testing: QA Engineer [qa] (vacant, covered by [cto])',
  ];

  it('parses seat ids, vacancy and cover back out of the prompt', () => {
    const parsed = parseCognitionPrompt(
      promptFor({ type: 'Control.WorkBriefed' }, 'implementation, frontend', [], VACANT_CAPABILITY_MAP),
    );
    expect(parsed.capabilitySeats).toEqual([
      {
        capability: 'backend',
        positionId: 'backend-engineer',
        title: 'Backend Engineer',
        staffed: false,
        coveredBy: null,
      },
      {
        capability: 'backend',
        positionId: 'engineer',
        title: 'Software Engineer',
        staffed: false,
        coveredBy: null,
      },
      {
        capability: 'frontend',
        positionId: 'engineer',
        title: 'Software Engineer',
        staffed: false,
        coveredBy: null,
      },
      {
        capability: 'frontend',
        positionId: 'frontend-engineer',
        title: 'Frontend Engineer',
        staffed: false,
        coveredBy: null,
      },
      {
        capability: 'implementation',
        positionId: 'agent-engineer',
        title: 'Agent Engineer',
        staffed: false,
        coveredBy: null,
      },
      {
        capability: 'implementation',
        positionId: 'engineer',
        title: 'Software Engineer',
        staffed: false,
        coveredBy: null,
      },
      {
        capability: 'implementation',
        positionId: 'frontend-engineer',
        title: 'Frontend Engineer',
        staffed: false,
        coveredBy: null,
      },
    ]);

    const covered = parseCognitionPrompt(
      promptFor({ type: 'Control.WorkBriefed' }, 'implementation', [], COVERED_CAPABILITY_MAP),
    );
    expect(covered.capabilitySeats).toEqual([
      {
        capability: 'implementation',
        positionId: 'engineer',
        title: 'Software Engineer',
        staffed: false,
        coveredBy: 'cto',
      },
      {
        capability: 'testing',
        positionId: 'qa',
        title: 'QA Engineer',
        staffed: false,
        coveredBy: 'cto',
      },
    ]);
  });

  it('recommends the one seat that covers every unstaffable capability, and defers the proposal', () => {
    const { output, plan } = parse(
      {
        type: 'Control.WorkBriefed',
        payload: { title: 'Tetris', goal: '做一个前端Web SPA 后端记分的小游戏' },
      },
      'implementation, frontend',
      [],
      VACANT_CAPABILITY_MAP,
    );
    // A4: the recommendation is the whole plan. The proposal rides inside it (as `proposal`) and
    // is resumed by the kernel only after the root grants the hire — emitting `CreateProposal`
    // here would route work to a seat that is still vacant (nobody to assign to), and emitting
    // `RecommendHire` no longer fills the seat either (it opens the approval gate).
    expect(plan.steps.map((step) => step.action)).toEqual(['RecommendHire']);

    const hire = plan.steps[0];
    // Greedy over the uncovered capabilities: `engineer` declares implementation + frontend +
    // backend, so one hire closes all three — never `agent-engineer`, which only adds one.
    expect(hire?.args).toMatchObject({
      positionId: 'engineer',
      employeeId: 'engineer-hire',
      name: 'Software Engineer',
      briefRef: 'evt-7',
    });
    expect(hire?.args['responsibilities']).toHaveLength(1);
    expect(String((hire?.args['responsibilities'] as readonly string[])[0])).toContain(
      'implementation',
    );
    expect(hire?.args['expertise']).toEqual(['backend', 'frontend', 'implementation']);
    expect(String(hire?.args['reason'])).toContain('"engineer"');
    // The hire is a first-class consideration, not an unexplained side effect.
    expect(output.considerations[hire?.reasonRef ?? -1]).toContain('"engineer"');
    // The deferred proposal the resume runs once the root grants: capability routing still
    // names no seat of its own, exactly like the standalone `CreateProposal` did.
    expect(hire?.args['proposal']).toMatchObject({
      capabilities: ['implementation', 'frontend', 'backend'],
      title: 'Tetris',
      goal: '做一个前端Web SPA 后端记分的小游戏',
    });
    expect((hire?.args['proposal'] as Record<string, unknown>)['positionId']).toBeUndefined();

    // And every emitted action is executable — `RecommendHire` is bound in the kernel (A1).
    expect(ACTIONS as readonly string[]).toContain('RecommendHire');
    expect(Object.keys(PLAN_ACTION_BINDINGS)).toContain('RecommendHire');
  });

  it('does not hire into a vacant seat a staffed manager already covers', () => {
    const { plan } = parse(
      {
        type: 'Control.AgentInstructed',
        payload: { instruction: '开发一个贪吃蛇 Demo，写好后要通过测试' },
      },
      'implementation, frontend',
      [],
      COVERED_CAPABILITY_MAP,
    );
    expect(plan.steps.map((step) => step.action)).toEqual(['CreateProposal']);
    expect(plan.steps[0]?.args['capabilities']).toEqual(['implementation', 'testing']);
  });

  it('hires nothing when the company already has staffed seats (lab seed shape)', () => {
    const { plan } = parse(
      {
        type: 'Control.WorkBriefed',
        payload: { title: 'Tetris', goal: '做一个前端Web SPA 后端记分的小游戏' },
      },
      'implementation, frontend',
      [],
      STAFFED_CAPABILITY_MAP,
    );
    expect(plan.steps.map((step) => step.action)).toEqual(['CreateProposal']);
  });
});
