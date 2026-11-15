// Real two-agent collaboration, end to end, against a real DeepSeek-backed API.
//
// Why a child process instead of in-process: the point is to prove the *shipped* composition —
// the same `apps/api/dist/index.js` the console runs, over real HTTP, writing a real event log —
// not a harness that imports internals and could accidentally assert a parallel code path.
//
// Isolation: `MAOEH_EVENT_LOG` points at this run's own directory, so the demo company's log is
// never touched. Everything this script records (messages, tasks, events) comes from the API or
// from the run's own log file.
//
// Usage: node scripts/verify-collaboration.mjs [--port 3199] [--timeout 240]
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = join(root, '.maoeh', 'audit', 'collaboration', `run-${stamp}`);
const eventLogPath = join(runDir, 'events.jsonl');
const serverLogPath = join(runDir, 'api.log');
mkdirSync(runDir, { recursive: true });

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const PORT = Number(argOf('--port', '3199'));
const TIMEOUT_MS = Number(argOf('--timeout', '240')) * 1000;
const BASE = `http://127.0.0.1:${String(PORT)}/api`;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function json(path, init) {
  const response = await fetch(BASE + path, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> HTTP ${String(response.status)}: ${text.slice(0, 400)}`);
  return text === '' ? null : JSON.parse(text);
}

const command = (commandType, fields, reason) => ({
  commandId: `audit-${commandType.replace(/\./g, '-').toLowerCase()}-${String(Date.now())}`,
  commandType,
  actor: { operatorId: 'ceo-alex', displayName: 'Alex (audit operator)', positionId: 'ceo', kind: 'human' },
  target: { targetType: 'organization', targetId: 'future-ai-lab' },
  reason,
  correlationId: `audit-corr-${stamp}`,
  causationId: null,
  createdAtSim: 0,
  ...fields,
});

/** The mandate is deliberately explicit: the design work cannot be finished without Mike's answer. */
const MANDATE_TITLE = '登录页会话方案（技术设计）';
const MANDATE_GOAL = [
  '为登录页设计会话方案，产出技术设计交付物。',
  '硬性要求：你必须先用 SendMessage 给 engineer-mike 发一条消息，请他对“会话存储位置、过期时间、刷新策略”给出具体建议；',
  '收到他的回复后，把你采纳的建议与他回复中的关键结论写进技术设计，然后提交这个任务。',
  '不要自己臆造他的答复，也不要跳过发消息这一步。',
].join('\n');

function log(message) {
  process.stdout.write(`${message}\n`);
}

const serverLogFd = openSync(serverLogPath, 'a');
const child = spawn(
  process.execPath,
  ['--env-file-if-exists=.env', join('apps', 'api', 'dist', 'index.js')],
  {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(PORT),
      MAOEH_EVENT_LOG: eventLogPath,
      MAOEH_OWNERSHIP: 'memory',
      MAOEH_REQUIRE_PLAN_CONFIRMATION: '0',
    },
    // A file descriptor, not a pipe: the API's own log (including raw cognition output) belongs in
    // the run directory, not in this script's stdout — and a pipe would need a reader for as long
    // as the server lives.
    stdio: ['ignore', serverLogFd, serverLogFd],
    detached: false,
  },
);

let exitCode = 1;
try {
  // 1. Wait for the isolated server to answer.
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await json('/llm');
      ready = true;
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!ready) throw new Error('isolated API did not start within 60s');
  const llm = await json('/llm');
  log(`[1/6] isolated API up — llm mode=${String(llm.mode)} provider=${String(llm.provider)} model=${String(llm.model)}`);

  // 2. Count the company channel before we inject anything.
  const initial = await json('/communications?limit=200');
  const initialTypes = initial.map((event) => event.type);
  log(`[2/6] event log seeded: ${String(initialTypes.length)} communication event(s) ${JSON.stringify(initialTypes)}`);

  // 3. Hand the CTO a standalone task that cannot be finished without a colleague's answer.
  const injected = await json('/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      command(
        'Organization.InjectTask',
        { title: MANDATE_TITLE, goal: MANDATE_GOAL, positionId: 'cto', requiredSkills: ['technical_design'] },
        'audit: prove a real two-agent collaboration',
      ),
    ),
  });
  log(`[3/6] task injected: status=${String(injected.status)} taskId=${String(injected.taskId ?? injected.result?.taskId ?? '?')}`);

  // 4. Watch the real exchange until both directions landed (or the clock runs out).
  const deadline = Date.now() + TIMEOUT_MS;
  let messages = [];
  let tasks = [];
  let rounds = 0;
  for (;;) {
    rounds += 1;
    const events = await json('/communications?limit=200');
    messages = events.filter((event) => event.type === 'Communication.MessageSent');
    tasks = await json('/tasks');
    const senders = new Set(messages.map((event) => event.payload?.senderId));
    if (messages.length >= 2 && senders.size >= 2) break;
    if (Date.now() > deadline) break;
    await sleep(1000);
  }
  log(`[4/6] observed ${String(messages.length)} message(s) after ${String(rounds)} poll round(s)`);

  // 5. Give the CTO a bounded window to finish the task once the answer is in.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    tasks = await json('/tasks');
    if (tasks.every((task) => ['completed', 'rejected', 'cancelled'].includes(task.status))) break;
    await sleep(1000);
  }

  // 6. Collect the evidence from the API (what the console polls) and from the run's own log.
  const communications = await json('/communications?limit=200');
  const events = await json('/events?limit=200&includeDeleted=1');
  const taskList = await json('/tasks');
  const injectedTask = taskList.find((task) => task.title === MANDATE_TITLE) ?? taskList[0] ?? null;
  const record = injectedTask === null ? null : await json(`/tasks/${encodeURIComponent(injectedTask.taskId)}`);
  const runtime = await json('/runtime');
  const logLines = existsSync(eventLogPath) ? readFileSync(eventLogPath, 'utf8').trim().split('\n') : [];
  const logEvents = logLines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);

  // `/api/communications` answers newest-first (it is the console's activity feed). The chain check
  // below is about cause and effect, so it needs log order.
  const messageViews = communications
    .filter((event) => event.type === 'Communication.MessageSent')
    .sort((left, right) => Number(left.seq) - Number(right.seq))
    .map((event) => ({
      seq: event.seq,
      eventId: event.eventId,
      atSim: event.occurredAtSim,
      senderId: event.payload?.senderId,
      recipientIds: event.payload?.recipientIds,
      messageType: event.payload?.messageType,
      subject: event.payload?.subject,
      body: event.payload?.body,
      correlationId: event.correlationId,
      causationId: event.causationId,
    }));

  const cycles = logEvents
    .filter((event) => event.type === 'Runtime.CycleStarted' || event.type === 'Runtime.CycleFinished')
    .filter((event) => ['cto-john', 'engineer-mike'].includes(String(event.subjectId)))
    .map((event) => ({
      eventId: event.eventId,
      type: event.type,
      agent: event.subjectId,
      atSim: event.occurredAtSim,
      causationId: event.causationId,
      correlationId: event.correlationId,
      reason: event.payload?.reason ?? event.payload?.outcome ?? null,
      failureCode: event.payload?.failureCode ?? null,
    }));

  const channels = communications.filter((event) => event.type === 'Communication.ChannelOpened');
  const taskLifecycle = logEvents
    .filter((event) => event.type.startsWith('Task.'))
    .map((event) => ({ type: event.type, atSim: event.occurredAtSim, taskId: event.payload?.taskId }));

  // "A asked B, B answered A, and the answer names the request as its cause" — the causal link the
  // brief asks for, checked against the events rather than inferred from ordering.
  const request = messageViews.find((message) => message.messageType === 'request');
  const answer = request === undefined
    ? undefined
    : messageViews.find(
        (message) =>
          message.messageType === 'response'
          && message.causationId === request.eventId
          && message.senderId !== request.senderId,
      );

  const report = {
    runAt: new Date().toISOString(),
    isolation: { eventLogPath, ownership: 'memory', port: PORT },
    llm: { mode: llm.mode, provider: llm.provider, model: llm.model, callCount: llm.callCount },
    mandate: { title: MANDATE_TITLE, goal: MANDATE_GOAL },
    injected,
    channels,
    messages: messageViews,
    task: record,
    taskLifecycle,
    cycles,
    runtime: { tick: runtime.tick, simulationPaused: runtime.simulationPaused },
    totalEventsInLog: logEvents.length,
    recentEvents: events.slice(0, 30).map((event) => ({ seq: event.seq, type: event.type, actorId: event.actorId })),
    verdict: {
      twoAgentsExchanged: messageViews.length >= 2 && new Set(messageViews.map((message) => message.senderId)).size >= 2,
      requestThenAnswer:
        request !== undefined
        && answer !== undefined
        && request.recipientIds.includes(answer.senderId)
        && answer.recipientIds.includes(request.senderId),
      answerCausedByRequest: answer !== undefined,
      taskStarted: taskLifecycle.some((event) => event.type === 'Task.Started'),
      taskClosed: record?.status === 'completed',
      eventsPersisted: logEvents.length > 0,
    },
  };
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  const summary = [
    '# Real collaboration verification',
    '',
    `- run: ${stamp}`,
    `- event log: ${eventLogPath}`,
    `- provider: ${String(llm.provider)} / ${String(llm.model)} (${String(llm.mode)})`,
    `- channels opened: ${String(channels.length)}`,
    `- messages: ${String(messageViews.length)}`,
    ...messageViews.map(
      (message) =>
        `  - t${String(message.atSim)} ${String(message.senderId)} -> ${String(message.recipientIds?.join(', '))} [${String(
          message.messageType,
        )}] ${String(message.subject)}`,
    ),
    `- task: ${String(record?.taskId)} ${String(record?.status)}`,
    `- verdict: ${JSON.stringify(report.verdict)}`,
  ].join('\n');
  writeFileSync(join(runDir, 'summary.md'), summary, 'utf8');

  log(`[5/6] evidence written: ${join(runDir, 'report.json')}`);
  log(summary);
  log(`[6/6] verdict: ${JSON.stringify(report.verdict)}`);
  exitCode = report.verdict.requestThenAnswer && report.verdict.answerCausedByRequest && report.verdict.taskClosed ? 0 : 2;
} catch (error) {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  writeFileSync(join(runDir, 'error.txt'), String(error?.stack ?? error), 'utf8');
  exitCode = 1;
} finally {
  child.kill();
  closeSync(serverLogFd);
  await sleep(500);
  process.exit(exitCode);
}
