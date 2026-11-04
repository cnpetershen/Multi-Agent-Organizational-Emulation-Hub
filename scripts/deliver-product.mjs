// Drives the real API server over HTTP: hand the CEO the `ss` mandate, wait for the workflow,
// then materialise exactly what the organization delivered, file by file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3199';
const OUT = resolve('.tmp-diag/e2e/product');
const MANDATE = '开发一个俄罗斯方块程序\n前端Web SPA 后端用python，后端用来记录每次排名和得分';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(path, init) {
  const response = await fetch(BASE + path, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text === '' ? null : JSON.parse(text);
}

const command = {
  commandId: `e2e-instruct-${String(Date.now())}`,
  actor: { operatorId: 'ceo-alex', displayName: 'Alex', positionId: 'ceo', kind: 'human' },
  reason: 'board directive (e2e proof)',
  correlationId: `e2e-${String(Date.now())}`,
  causationId: null,
  createdAtSim: 0,
  commandType: 'Agent.Instruct',
  target: { targetType: 'agent', targetId: 'ceo-alex' },
  instruction: MANDATE,
};

const instructed = await json('/api/command', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(command),
});
console.log('instruct ->', instructed.status, instructed.failure ?? '');

let tasks = [];
for (let attempt = 0; attempt < 120; attempt += 1) {
  tasks = await json('/api/tasks');
  const done = tasks.length >= 3 && tasks.every((task) => ['completed', 'rejected', 'cancelled'].includes(task.status));
  if (done) break;
  await sleep(500);
}

const records = [];
for (const summary of tasks) {
  const record = await json('/api/tasks/' + encodeURIComponent(summary.taskId));
  records.push(record);
}

const report = { mandate: MANDATE, tasks: [], files: [] };
for (const record of records) {
  const data = record.result?.data ?? {};
  const files = Array.isArray(data.files) ? data.files : [];
  report.tasks.push({
    taskId: record.taskId,
    title: record.title,
    status: record.status,
    artifacts: record.result?.artifacts ?? [],
    summary: record.result?.summary ?? null,
    stack: data.stack ?? null,
    filePaths: files.map((entry) => entry.path),
  });
  for (const entry of files) {
    if (typeof entry?.path !== 'string' || typeof entry?.content !== 'string') continue;
    const target = join(OUT, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.content, 'utf8');
    report.files.push(entry.path);
  }
}

writeFileSync(resolve('.tmp-diag/e2e/delivery.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify(report, null, 2));
