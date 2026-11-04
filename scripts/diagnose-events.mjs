// Diagnostic: summarize task lifecycle outcomes from a real event log.
// Usage: node scripts/diagnose-events.mjs <events.jsonl>
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const file = process.argv[2];
if (!file) {
  console.error('usage: node diagnose-events.mjs <events.jsonl>');
  process.exit(1);
}

const typeCounts = new Map();
const tasks = new Map(); // taskId -> {created, assigned, accepted, started, submitted, completed, rejected, blocked, events:[]}
const failures = new Map(); // reason code -> count
const actionFailures = new Map();
const employeeStats = new Map();
const resultKeys = new Map();
let lines = 0;

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

function task(id) {
  if (!tasks.has(id)) tasks.set(id, { id, ev: [] });
  return tasks.get(id);
}
function emp(id) {
  if (!employeeStats.has(id)) {
    employeeStats.set(id, {
      id, cycles: 0, steps: 0, failures: 0, submitted: 0, assigned: 0, started: 0,
      reasonCodes: new Map(),
    });
  }
  return employeeStats.get(id);
}

const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  lines += 1;
  let e;
  try { e = JSON.parse(line); } catch { bump(failures, 'UNPARSEABLE_LINE'); continue; }
  bump(typeCounts, e.type);
  const p = e.payload ?? {};
  const t = e.type;

  if (t === 'Task.Created') {
    const k = task(p.taskId);
    k.created = { title: p.title, goal: p.goal, assign: p.assignment, by: p.createdById,
      requiredSkills: p.requiredSkills, verification: p.verification, atSim: e.occurredAtSim };
    bump(resultKeys, `task.assignment.kind=${p.assignment?.kind}:${p.assignment?.positionId ?? p.assignment?.capability ?? ''}`);
  } else if (t === 'Task.Assigned') {
    const k = task(p.taskId); k.assigned = p;
    const who = p.assignment?.assigneeEmployeeId ?? p.assignment?.positionId ?? 'unknown';
    bump(resultKeys, `assigned->${who}`);
    if (p.assignment?.assigneeEmployeeId) emp(p.assignment.assigneeEmployeeId).assigned += 1;
  } else if (t === 'Task.Accepted') { task(p.taskId).accepted = p; }
  else if (t === 'Task.Started') {
    task(p.taskId).started = p;
    const who = p.employeeId ?? p.actorId ?? e.actorId;
    if (who) emp(who).started += 1;
  } else if (t === 'Task.Submitted') {
    task(p.taskId).submitted = p;
    const who = e.actorId;
    emp(who).submitted += 1;
    const d = p.submission?.data;
    if (d && typeof d === 'object') bump(resultKeys, `submit.data.keys=${Object.keys(d).sort().join('|')}`);
    const a = p.submission?.artifacts;
    if (Array.isArray(a)) bump(resultKeys, `submit.artifacts=${a.length}`);
  } else if (t === 'Task.Completed') task(p.taskId).completed = p;
  else if (t === 'Task.Rejected') { task(p.taskId).rejected = p; bump(failures, `Task.Rejected:${String(p.reason).slice(0, 60)}`); }
  else if (t === 'Task.Blocked') { task(p.taskId).blocked = p; bump(failures, `Task.Blocked:${String(p.reason).slice(0, 60)}`); }
  else if (t === 'Runtime.CycleFinished') {
    const who = p.employeeId ?? e.actorId;
    if (who) { const s = emp(who); s.cycles += 1; s.steps += p.stepsExecuted ?? 0; }
    if (p.outcome && p.outcome !== 'ok') bump(failures, `CycleFinished.outcome=${p.outcome}`);
  } else if (t === 'Runtime.PlanFailed' || t === 'Runtime.StepFailed' || t === 'Runtime.CycleFailed') {
    const code = p.code ?? p.failure?.code ?? 'unknown';
    bump(failures, `${t}:${code}`);
    const who = p.employeeId ?? e.actorId;
    if (who) { const s = emp(who); s.failures += 1; bump(s.reasonCodes, `${t}:${code}`); }
  }
  if (/Fail|Reject|Block|Error|Denied/i.test(t)) {
    const code = p.code ?? p.reason ?? p.decision ?? '';
    bump(actionFailures, `${t} :: ${String(code).slice(0, 80)}`);
  }
  const who2 = p.employeeId ?? e.actorId;
  if (who2 && (t.startsWith('Runtime.'))) {
    const s = emp(who2);
    if (t === 'Runtime.CycleStarted') s.cycles += 0;
  }
}

const top = (m, n = 40) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

console.log(`file: ${file}`);
console.log(`lines: ${lines}`);
console.log('\n=== event type counts ===');
for (const [k, v] of top(typeCounts, 60)) console.log(String(v).padStart(8), k);

console.log('\n=== Task lifecycle (per task) ===');
for (const k of tasks.values()) {
  const created = k.created ?? {};
  const asg = k.assigned?.assignment ?? created.assign ?? {};
  const who = k.started?.employeeId ?? asg.assigneeEmployeeId ?? asg.positionId ?? asg.capability ?? '?';
  const state = k.completed ? 'COMPLETED' : k.submitted ? (k.rejected ? 'REJECTED' : 'SUBMITTED') : k.blocked ? 'BLOCKED' : k.started ? 'STARTED' : k.accepted ? 'ACCEPTED' : k.assigned ? 'ASSIGNED' : 'CREATED';
  console.log(
    `${k.id} [${state}] who=${who} title=${JSON.stringify(String(created.title ?? '').slice(0, 40))} keys=${JSON.stringify(created.verification?.requiredOutputKeys ?? null)}`,
  );
}

console.log('\n=== per-employee ===');
for (const s of [...employeeStats.values()].sort((a, b) => b.cycles - a.cycles)) {
  if (s.cycles === 0 && s.assigned === 0 && s.submitted === 0) continue;
  console.log(`${s.id} cycles=${s.cycles} steps=${s.steps} assigned=${s.assigned} started=${s.started} submitted=${s.submitted} failures=${s.failures}`);
}

console.log('\n=== failure / anomaly aggregates ===');
for (const [k, v] of top(failures, 60)) console.log(String(v).padStart(8), k);

console.log('\n=== result/assignment keys ===');
for (const [k, v] of top(resultKeys, 60)) console.log(String(v).padStart(8), k);
