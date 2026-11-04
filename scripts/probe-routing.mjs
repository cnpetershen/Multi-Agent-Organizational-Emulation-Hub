// Verify: does a work brief on a `starter` company now produce tracked, executable work?
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { deterministicCognitionText } from '../apps/api/dist/deterministic-cognition.js';
import { loadOrganization, resolveCapabilityAssignments } from '../packages/organization-model/dist/index.js';

const seedRoot = fileURLToPath(new URL('../agents/future-ai-lab/', import.meta.url));
const reader = {
  list(rel) {
    const dir = join(seedRoot, rel);
    return existsSync(dir)
      ? readdirSync(dir).filter((e) => e.endsWith('.yaml')).map((e) => `${rel}/${e}`).sort()
      : [];
  },
  read(rel) {
    const p = join(seedRoot, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  },
};
const org = loadOrganization(reader).value;
const starter = {
  ...org,
  employees: org.employees.filter(
    (e) => org.positions.find((p) => p.id === e.positionId)?.reportsToPositionId === null,
  ),
};

const seats = starter.positions
  .map((p) => `- ${p.id} | ${p.title} | dept ${p.departmentId ?? '(none)'} | authority ${p.authorityLevel ?? 0} | open tasks 0`)
  .join('\n');

function planFor(payload) {
  const prompt = [
    'Company: Future AI Lab [future-ai-lab]',
    'Position: Chief Executive Officer [ceo]',
    'Position capabilities: strategy, org_design, capital_allocation',
    'Self: Alex [ceo-alex]',
    '',
    '## Work catalog (what you may dispatch)',
    'Seats (positionId | title | department | authority | open tasks):',
    seats,
    'Workflow templates (workflowId | title | steps | approval gates):',
    '- (none)',
    'In-flight workflow instances: 0',
    '',
    '## Input event',
    JSON.stringify({ eventId: 'ctrl-evt-1', type: 'Control.WorkBriefed', actorId: 'ceo-alex', payload }),
    '',
    '## Required JSON schema',
    '{}',
  ].join('\n');
  return JSON.parse(deterministicCognitionText({ prompt, system: 'You are Alex' }));
}

const payload = {
  commandId: 'ui-1',
  operatorId: 'ceo-alex',
  reason: 'verify',
  agentId: 'ceo-alex',
  briefId: 'brief-1',
  title: '开发一个俄罗斯方块程序',
  goal: '前端Web SPA 后端用python，后端用来记录每次排名和得分',
  context: null,
  verificationKeys: ['多用户在线运行'],
  priority: null,
  dueAtSim: null,
};

const out = planFor(payload);
console.log('=== brief plan ===');
for (const step of out.plan.steps) console.log(step.action, JSON.stringify(step.args));

const caps = out.plan.steps[0].args.capabilities;
console.log('\ncapabilities requested:', JSON.stringify(caps));

for (const [label, organization] of [['LAB (full roster)', org], ['STARTER (CEO only)', starter]]) {
  const assignments = resolveCapabilityAssignments(organization, caps, { excludeSeatIds: ['ceo'] });
  const staffed = new Set(organization.employees.map((e) => String(e.positionId)));
  console.log(`\n${label}: plan = ${assignments.length === 0 ? 'NO WORKFLOW (no staffed seat declares any requested capability)' : ''}`);
  for (const a of assignments) {
    console.log(`  ${a.capability} -> ${a.positionId} ${staffed.has(String(a.positionId)) ? '(STAFFED, will execute)' : '(VACANT)'}${a.escalated ? ` escalated from ${a.matchedPositionId}` : ''}`);
  }
}

console.log('\nexecution-capable seats for this brief (starter):',
  resolveCapabilityAssignments(starter, caps, { excludeSeatIds: ['ceo'] }).length);
console.log('With the old seat-picking plan the brief went to:',
  JSON.stringify(['agent-engineer', 'ai-engineer']),
  '-> both VACANT -> assigneeEmployeeId null -> nobody woken -> task stuck at "assigned"');
