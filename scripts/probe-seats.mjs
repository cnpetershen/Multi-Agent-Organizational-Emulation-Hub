// Diagnostic: the PRE-FIX work-brief seat selection, reproduced exactly.
//
// Recorded as the falsification evidence for
// `docs/review/role-agents-cannot-complete-tasks.md` §2. The pre-fix planner read the
// `## Work catalog` section, sorted every seat by `open tasks` (ties by `positionId`) and took
// the first two — which in a company that has not hired yet are the alphabetically-first *empty*
// seats. This script re-runs that selection over the real chart, and then shows what the current
// planner does with the same prompt, so the before/after pair is visible in one command.
//
// Current behaviour: `scripts/probe-routing.mjs` (capability routing end to end).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { deterministicCognitionText } from '../apps/api/dist/deterministic-cognition.js';
import { loadOrganization } from '../packages/organization-model/dist/index.js';

const seedRoot = fileURLToPath(new URL('../agents/future-ai-lab/', import.meta.url));

const reader = {
  list(rel) {
    const dir = join(seedRoot, rel);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((e) => e.endsWith('.yaml') || e.endsWith('.yml'))
      .map((e) => `${rel}/${e}`)
      .sort();
  },
  read(rel) {
    const p = join(seedRoot, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  },
};

const result = loadOrganization(reader);
if (!result.ok) {
  console.error('load failed', JSON.stringify(result.error));
  process.exit(1);
}
const org = result.value;

// Same transform as toStarterOrganization in apps/api/src/composition.ts.
const rootPositions = new Set(
  org.positions.filter((p) => p.reportsToPositionId === null).map((p) => String(p.id)),
);
const starter = {
  ...org,
  employees: org.employees.filter((e) => rootPositions.has(String(e.positionId))),
};

const staffed = (organization) =>
  new Set(organization.employees.map((e) => String(e.positionId)));

console.log('full seed roster:', org.employees.map((e) => `${e.id}@${e.positionId}`).join(', '));
console.log('starter roster  :', starter.employees.map((e) => `${e.id}@${e.positionId}`).join(', '));
console.log('positions       :', starter.positions.length);

/* ------------------------------------------------------- the pre-fix algorithm, verbatim ---- */

const CATALOG_SECTION = '## Work catalog';
const SEAT_LINE = /^- ([^|]+?) \| ([^|]+?) \| dept [^|]+? \| authority \d+ \| open tasks (\d+)$/;

const FALLBACK_DISPATCH_SEATS = [
  { positionId: 'engineer', title: 'Engineer', openTaskCount: 0 },
  { positionId: 'qa', title: 'Qa', openTaskCount: 0 },
];

function workCatalogSeats(prompt) {
  const from = prompt.indexOf(CATALOG_SECTION);
  if (from < 0) return [];
  const seats = [];
  for (const line of prompt.slice(from).split('\n')) {
    if (line.startsWith('## ') && !line.startsWith(CATALOG_SECTION)) break;
    const match = SEAT_LINE.exec(line.trim());
    if (match === null) continue;
    seats.push({
      positionId: match[1].trim(),
      title: match[2].trim(),
      openTaskCount: Number(match[3]),
    });
  }
  return seats;
}

function dispatchSeats(catalog, actorSeat) {
  const others = catalog.filter((seat) => seat.positionId !== actorSeat);
  const pool = others.length >= 2 ? others : catalog;
  const sorted = [...pool].sort(
    (left, right) =>
      left.openTaskCount - right.openTaskCount ||
      (left.positionId < right.positionId ? -1 : left.positionId > right.positionId ? 1 : 0),
  );
  const picked = sorted.slice(0, 2);
  return picked.length === 2 ? picked : FALLBACK_DISPATCH_SEATS;
}

/* ------------------------------------------------------------------- the shared prompt ---- */

const catalogLines = starter.positions
  .map(
    (p) =>
      `- ${p.id} | ${p.title} | dept ${p.departmentId ?? '(none)'} | authority ${p.authorityLevel ?? 0} | open tasks 0`,
  )
  .join('\n');

const prompt = [
  'Company: Future AI Lab [future-ai-lab]',
  'Department: (none)',
  'Position: Chief Executive Officer [ceo]',
  'Position capabilities: strategy, org_design, capital_allocation',
  'Self: Alex [ceo-alex]',
  'Manager: (none)',
  '',
  '## Work catalog (what you may dispatch)',
  'Seats (positionId | title | department | authority | open tasks):',
  catalogLines,
  'Workflow templates (workflowId | title | steps | approval gates):',
  '- (none)',
  'In-flight workflow instances: 0',
  '',
  '## Input event',
  JSON.stringify({
    eventId: 'ctrl-evt-1',
    type: 'Control.WorkBriefed',
    actorId: 'ceo-alex',
    payload: {
      commandId: 'ui-1',
      operatorId: 'ceo-alex',
      reason: 'probe',
      agentId: 'ceo-alex',
      briefId: 'brief-1',
      title: '开发一个俄罗斯方块程序',
      goal: '前端Web SPA 后端用python，后端用来记录每次排名和得分',
      context: null,
      verificationKeys: ['多用户在线运行'],
      priority: null,
      dueAtSim: null,
    },
  }),
  '',
  '## Required JSON schema',
  '{}',
].join('\n');

/* ------------------------------------------------------------------------- before / after ---- */

const held = staffed(starter);
console.log('\n=== BEFORE (the defect) — planner picked two least-loaded seats ===');
for (const seat of dispatchSeats(workCatalogSeats(prompt), 'ceo')) {
  console.log(
    `DispatchWork -> ${seat.positionId} | ${held.has(seat.positionId) ? 'STAFFED' : 'VACANT'}`,
  );
}

console.log('\n=== AFTER (current) — same prompt, planner names no seat ===');
const parsed = JSON.parse(deterministicCognitionText({ prompt, system: 'You are Alex' }));
for (const step of parsed.plan.steps) {
  console.log(step.action, JSON.stringify(step.args));
}
console.log(
  '\nA `DispatchWork` to a VACANT seat is a task with `assigneeEmployeeId: null`:\n' +
    '`TaskService.assign` permits it, `eligibleAgentsFor` wakes nobody for it, so it sits\n' +
    '`assigned` forever with no event, no failure and no retry. That is the reported symptom.',
);
