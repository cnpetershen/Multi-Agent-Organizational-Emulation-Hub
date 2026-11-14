import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CorrelationId, EmployeeId, SimTime } from '@maoeh/shared-types';
import type { LlmGateway } from '@maoeh/llm-gateway';
import { createCallBudget } from '@maoeh/llm-gateway';
import type { Simulation } from '@maoeh/kernel';
import type { ControlQuery } from '@maoeh/organization-control';

/**
 * 赛博沙盘 · a real multi-role adversarial session.
 *
 * The page that shipped before this service was a manual shell: a human typed every line, clicked
 * "next role", and a client-side function scored message counts and keywords. It looked like a
 * debate and was not one. This service replaces that with the thing the brief asked for:
 *
 * - **Real agents.** The four roles are employees of a real organization, carrying their real
 *   definition (identity, responsibilities, capabilities) and their real actor context.
 * - **Real communication.** Every line is sent through the existing `CommunicationService`:
 *   membership and authorization are enforced by the service, the message is a real
 *   `Communication.MessageSent` fact in the event log, and it is really delivered.
 * - **Real transcript.** The transcript returned to the page is the list of those events —
 *   not a parallel array built for display. A reload reads the same events back.
 * - **Grounded scoring.** The evaluator is a real agent producing a JSON verdict with dimensions,
 *   evidence and the message id each score rests on. Scores that cite nothing are marked as such.
 *
 * What it deliberately does **not** do: it does not run the kernel's tick loop. Turn-taking is
 * driven by the session moderator, because a debate has an order that a free-running scheduler
 * does not provide. That is why sessions run on their own composed runtime with their own event
 * log: injecting messages into the live company would wake its agents and start a second,
 * unscripted conversation on top of this one.
 */

export const SANDBOX_ROLES = ['proposer', 'challenger', 'defender', 'evaluator'] as const;
export type SandboxRole = (typeof SANDBOX_ROLES)[number];

export interface SandboxTurn {
  readonly seq: number;
  readonly messageId: string;
  readonly eventId: string;
  readonly channelId: string;
  readonly atSim: number;
  readonly role: SandboxRole;
  readonly employeeId: EmployeeId;
  readonly name: string;
  readonly title: string;
  readonly body: string;
}

export interface SandboxDimension {
  readonly name: string;
  readonly score: number;
  readonly evidence: string;
  /** The message the score rests on, when the evaluator cited one that exists in this session. */
  readonly citedMessageId: string | null;
}

export interface SandboxScores {
  readonly dimensions: readonly SandboxDimension[];
  readonly total: number;
  readonly verdict: string;
  readonly rationale: string;
}

export interface SandboxSession {
  readonly sessionId: string;
  readonly channelId: string;
  readonly topic: string;
  readonly rounds: number;
  readonly roles: readonly { readonly role: SandboxRole; readonly employeeId: EmployeeId; readonly name: string; readonly title: string }[];
  readonly turns: readonly SandboxTurn[];
  readonly scores: SandboxScores | null;
  readonly scoringRaw: string | null;
  readonly provenance: 'live' | 'mock';
  readonly provider: string | null;
  readonly model: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

export interface SandboxSessionInput {
  readonly topic: string;
  readonly rounds?: number;
}

export class SandboxError extends Error {
  constructor(
    readonly code: 'invalid' | 'no_roles' | 'provider' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

/** The parts of a composed runtime this service needs. Structural, so no composition import cycles. */
export interface SandboxRuntime {
  readonly simulation: Simulation;
  readonly api: { readonly query: ControlQuery };
}

export interface SandboxDeps {
  /** Lazily created runtime whose event log belongs to the sandbox, not to the demo company. */
  readonly runtime: () => Promise<SandboxRuntime>;
  /** Borrowed from the serving runtime so `/api/llm` counts these calls. */
  readonly gateway: () => LlmGateway;
  readonly provenance: () => 'live' | 'mock';
  readonly provider: () => string | null;
  readonly model: () => string | null;
  /** Where the small session index is written. The transcript itself is always the event log. */
  readonly sessionsDir: string;
}

export interface SandboxService {
  start(input: SandboxSessionInput): Promise<SandboxSession>;
  list(limit?: number): Promise<readonly SandboxSession[]>;
  get(sessionId: string): Promise<SandboxSession | null>;
}

const MAX_TOPIC_CHARS = 500;
const MAX_ROUNDS = 3;
const MIN_ROUNDS = 1;

const ROLE_GUIDE: Readonly<Record<Exclude<SandboxRole, 'evaluator'>, string>> = Object.freeze({
  proposer:
    'State the proposal in concrete terms: what it is, who it is for, the mechanism that makes it work, and the one assumption you are least sure about. Invite challenge.',
  challenger:
    'Challenge the proposal: name the weakest assumption, the failure mode you consider most likely, and the evidence that would change your mind. Be specific and fair; no straw men.',
  defender:
    'Answer the challenge directly. Concede what is genuinely weak, then explain what the proposal already handles or how it would be changed. Do not repeat the original pitch.',
});

const ROLE_TITLE: Readonly<Record<SandboxRole, string>> = Object.freeze({
  proposer: '提案方',
  challenger: '质询方',
  defender: '答辩方',
  evaluator: '评审',
});

const SCORE_SCHEMA = z.object({
  dimensions: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        score: z.number().min(1).max(10),
        evidence: z.string().min(1).max(600),
        messageId: z.string().max(80).optional(),
      }),
    )
    .min(2)
    .max(6),
  total: z.number().min(0).max(100),
  verdict: z.string().min(1).max(120),
  rationale: z.string().min(1).max(1200),
});

function clampRounds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 2;
  return Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, Math.floor(value)));
}

function channelIdFor(now: Date): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `sandbox-${stamp}-${String(Math.floor(Math.random() * 4096)).padStart(4, '0')}`;
}

interface Candidate {
  readonly employeeId: EmployeeId;
  readonly name: string;
  readonly title: string;
  readonly capabilities: readonly string[];
  readonly responsibilities: readonly string[];
  readonly root: boolean;
}

/** The employees this session may cast, with the facts a prompt needs to keep them in character. */
function candidatesOf(simulation: Simulation): readonly Candidate[] {
  const organization = simulation.organization;
  return organization.employees.flatMap((employee) => {
    const bundle = simulation.agents.get(employee.id);
    if (bundle === undefined) return [];
    const position = organization.positions.find((entry) => entry.id === employee.positionId);
    return [
      {
        employeeId: employee.id,
        name: bundle.definition.identity.name,
        title: position?.title ?? String(employee.positionId),
        capabilities: position?.capabilities ?? [],
        responsibilities: bundle.definition.responsibilities,
        root: position === undefined || position.reportsToPositionId === null,
      },
    ];
  });
}

function takeUnique(
  pool: readonly Candidate[],
  used: Set<EmployeeId>,
  predicate: (candidate: Candidate) => boolean,
): Candidate | null {
  const found = pool.find((candidate) => !used.has(candidate.employeeId) && predicate(candidate));
  if (found === undefined) return null;
  used.add(found.employeeId);
  return found;
}

/**
 * Cast the four seats from the live chart: a technical voice proposes, quality challenges, an
 * implementer answers, and the root seat evaluates. Falls back to "any four distinct employees"
 * rather than failing a company whose chart is organised differently.
 */
export function castSession(simulation: Simulation): readonly { role: SandboxRole; candidate: Candidate }[] {
  const pool = candidatesOf(simulation);
  if (pool.length < 2) throw new SandboxError('no_roles', 'the runtime has fewer than two employees');
  const used = new Set<EmployeeId>();
  const picks: { role: SandboxRole; candidate: Candidate | null }[] = [
    {
      role: 'proposer',
      candidate:
        takeUnique(pool, used, (c) => c.capabilities.includes('technical_design'))
        ?? takeUnique(pool, used, (c) => c.capabilities.includes('product_requirement'))
        ?? takeUnique(pool, used, () => true),
    },
    {
      role: 'challenger',
      candidate:
        takeUnique(pool, used, (c) => c.capabilities.includes('testing'))
        ?? takeUnique(pool, used, () => true),
    },
    {
      role: 'defender',
      candidate:
        takeUnique(pool, used, (c) => c.capabilities.includes('implementation'))
        ?? takeUnique(pool, used, () => true),
    },
    {
      role: 'evaluator',
      candidate: takeUnique(pool, used, (c) => c.root) ?? takeUnique(pool, used, () => true),
    },
  ];
  // A seat may be missing on a tiny chart; reuse an already-cast employee rather than invent one.
  const fallback = pool[0];
  const resolved = picks.map((pick) => ({
    role: pick.role,
    candidate: pick.candidate ?? fallback ?? pool[0]!,
  }));
  return resolved.map((entry) => ({ role: entry.role, candidate: entry.candidate }));
}

function transcriptFor(turns: readonly SandboxTurn[]): string {
  if (turns.length === 0) return '(the session has not started)';
  return turns
    .map(
      (turn, index) =>
        `[#${String(index + 1)} ${turn.messageId}] ${turn.role} · ${turn.name}: ${turn.body}`,
    )
    .join('\n');
}

function systemPromptFor(candidate: Candidate, companyName: string): string {
  return [
    `You are ${candidate.name}, ${candidate.title} at ${companyName}.`,
    candidate.responsibilities.length === 0
      ? ''
      : `Your responsibilities: ${candidate.responsibilities.join(', ')}.`,
    'You are taking part in a structured adversarial review (赛博沙盘) with your colleagues.',
    'Stay in character, be concrete, and never invent numbers, sources or facts.',
    'Output only what you say in the session — no headings, no role label, no commentary.',
  ]
    .filter((line) => line !== '')
    .join(' ');
}

function speechPrompt(topic: string, role: Exclude<SandboxRole, 'evaluator'>, turns: readonly SandboxTurn[]): string {
  return [
    `Session topic: ${topic}`,
    `Your role this round: ${role} (${ROLE_TITLE[role]}).`,
    ROLE_GUIDE[role],
    '',
    'Transcript so far:',
    transcriptFor(turns),
    '',
    'Write your next contribution: 2-5 sentences, in the language of the topic.',
  ].join('\n');
}

function evaluationPrompt(topic: string, turns: readonly SandboxTurn[]): string {
  return [
    `Session topic: ${topic}`,
    'You are the evaluator of this adversarial review. Score the session, not the people.',
    '',
    'Transcript:',
    transcriptFor(turns),
    '',
    'Return ONLY a JSON object with this exact shape:',
    '{"dimensions":[{"name":"<=80 chars>","score":1-10,"evidence":"<=600 chars","messageId":"<the msg-… id you cite>"}],',
    ' "total":0-100,"verdict":"<=120 chars","rationale":"<=1200 chars"}',
    'Rules: 2-6 dimensions; every score must cite the messageId it rests on;',
    'evidence must quote or paraphrase that message specifically; do not reward length or tone.',
  ].join('\n');
}

/**
 * The read-model shape this service rebuilds from: `EventView` (which the query returns) and
 * `OrgEvent` (which the runtime emits) both satisfy it, so the same transcript builder serves a
 * live session and a replay after restart.
 */
export interface SandboxEventLike {
  readonly seq: number;
  readonly eventId: string;
  readonly type: string;
  readonly occurredAtSim: number;
  readonly actorId: string | null;
  readonly subjectId: string | null;
  readonly payload: unknown;
}

interface SessionIndexEntry {
  readonly sessionId: string;
  readonly channelId: string;
  readonly topic: string;
  readonly rounds: number;
  readonly startedAt: string;
  readonly roles: readonly { readonly employeeId: string; readonly role: SandboxRole; readonly name: string; readonly title: string }[];
}

export function createSandboxService(deps: SandboxDeps): SandboxService {
  let runtimePromise: Promise<SandboxRuntime> | null = null;
  const runtime = (): Promise<SandboxRuntime> => {
    if (runtimePromise === null) runtimePromise = deps.runtime();
    return runtimePromise;
  };

  const indexFile = (): string => join(deps.sessionsDir, 'sessions.json');

  const readIndex = (): readonly SessionIndexEntry[] => {
    try {
      const raw = readFileSync(indexFile(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as readonly SessionIndexEntry[]) : [];
    } catch {
      return [];
    }
  };

  const writeIndex = (entry: SessionIndexEntry): void => {
    try {
      mkdirSync(deps.sessionsDir, { recursive: true });
      const entries = readIndex().filter((existing) => existing.sessionId !== entry.sessionId);
      writeFileSync(indexFile(), JSON.stringify([entry, ...entries].slice(0, 100), null, 2), 'utf8');
    } catch {
      // The index is a convenience: the transcript is the event log and is never lost with it.
    }
  };

  const turnsOf = (events: readonly SandboxEventLike[], channelId: string, roles: Map<string, { role: SandboxRole; name: string; title: string }>): readonly SandboxTurn[] =>
    events
      .filter((event) => event.type === 'Communication.MessageSent')
      .filter((event) => {
        const payload = event.payload as Record<string, unknown>;
        return payload['channelId'] === channelId;
      })
      .sort((left, right) => Number(left.seq) - Number(right.seq))
      .map((event, index) => {
        const payload = event.payload as Record<string, unknown>;
        const messageId = String(payload['messageId'] ?? event.subjectId ?? '');
        const senderId = String(payload['senderId'] ?? event.actorId ?? '');
        const known = roles.get(senderId);
        return {
          seq: index + 1,
          messageId,
          eventId: event.eventId,
          channelId,
          atSim: Number(event.occurredAtSim),
          role: known?.role ?? 'proposer',
          employeeId: senderId as EmployeeId,
          name: known?.name ?? senderId,
          title: known?.title ?? '',
          body: String(payload['body'] ?? ''),
        };
      });

  const parseScores = (raw: string | null, turns: readonly SandboxTurn[]): SandboxScores | null => {
    if (raw === null) return null;
    const text = raw.trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
    const checked = SCORE_SCHEMA.safeParse(parsed);
    if (!checked.success) return null;
    const ids = new Set(turns.map((turn) => turn.messageId));
    return {
      dimensions: checked.data.dimensions.map((dimension) => ({
        name: dimension.name,
        score: dimension.score,
        evidence: dimension.evidence,
        citedMessageId:
          dimension.messageId !== undefined && ids.has(dimension.messageId) ? dimension.messageId : null,
      })),
      total: checked.data.total,
      verdict: checked.data.verdict,
      rationale: checked.data.rationale,
    };
  };

  const start = async (input: SandboxSessionInput): Promise<SandboxSession> => {
    const topic = input.topic.trim();
    if (topic === '') throw new SandboxError('invalid', 'topic must not be empty');
    if (topic.length > MAX_TOPIC_CHARS) {
      throw new SandboxError('invalid', `topic must be at most ${String(MAX_TOPIC_CHARS)} characters`);
    }
    const rounds = clampRounds(input.rounds);
    const startedAt = new Date();
    const sessionId = `sandbox-session-${startedAt.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${String(Math.floor(Math.random() * 4096)).padStart(4, '0')}`;
    const channelId = channelIdFor(startedAt);

    const composed = await runtime();
    const { simulation } = composed;
    const companyName = simulation.organization.company.name;
    const cast = castSession(simulation);
    const roleByEmployee = new Map<string, { role: SandboxRole; name: string; title: string }>(
      cast.map((entry) => [
        String(entry.candidate.employeeId),
        { role: entry.role, name: entry.candidate.name, title: entry.candidate.title },
      ]),
    );
    const members = [...new Set(cast.map((entry) => entry.candidate.employeeId))];
    if (members.length < 2) throw new SandboxError('no_roles', 'the session needs at least two distinct employees');

    // The channel is a real fact: opened by the proposer, through the service, recorded in the log.
    const opened = simulation.communication.createChannel({
      channelId,
      channelType: 'group',
      memberIds: members,
      actor: simulation.identity.actorContext(members[0]!, `corr-${sessionId}` as CorrelationId),
      simTime: simulation.scheduler.clock.simTime,
    });
    if (!opened.ok) {
      throw new SandboxError('unavailable', `the session channel could not be opened: ${opened.error.code}`);
    }
    await simulation.inject([opened.value.event]);

    const turns: SandboxTurn[] = [];
    const gateway = deps.gateway();
    const baseSim = Number(simulation.scheduler.clock.simTime);
    let elapsed = 0;

    /** The next speaker on the channel, never the sender (the service refuses self-addressing). */
    const recipientFor = (speaker: EmployeeId, preferred: EmployeeId): EmployeeId => {
      if (preferred !== speaker) return preferred;
      const alternative = members.find((member) => member !== speaker);
      if (alternative === undefined) {
        throw new SandboxError('no_roles', 'the session needs at least two distinct employees');
      }
      return alternative;
    };

    const speak = async (entry: { role: SandboxRole; candidate: Candidate }): Promise<void> => {
      const role = entry.role === 'evaluator' ? 'evaluator' : entry.role;
      if (role === 'evaluator') return;
      const budget = createCallBudget(1);
      const prompt = speechPrompt(topic, role, turns);
      const response = await gateway.generate({
        actorContext: simulation.identity.actorContext(entry.candidate.employeeId, `corr-${sessionId}` as CorrelationId),
        request: {
          requestId: `${sessionId}-${String(elapsed)}-${role}`,
          system: systemPromptFor(entry.candidate, companyName),
          prompt,
          responseFormat: 'text',
          temperature: 0.8,
        },
        budget,
      });
      elapsed += 1;
      if (!response.ok) {
        throw new SandboxError('provider', `${role} generation failed: ${response.error.code}`);
      }
      const body = response.value.text.trim();
      if (body === '') throw new SandboxError('provider', `${role} returned no text`);
      const preferred = role === 'defender'
        ? cast.find((candidate) => candidate.role === 'evaluator')!.candidate.employeeId
        : cast[(cast.findIndex((candidate) => candidate.role === role) + 1) % cast.length]!.candidate.employeeId;
      const sent = simulation.communication.sendMessage({
        actor: simulation.identity.actorContext(entry.candidate.employeeId, `corr-${sessionId}` as CorrelationId),
        senderEmployeeId: entry.candidate.employeeId,
        channelId,
        recipientIds: [recipientFor(entry.candidate.employeeId, preferred)],
        subject: `[${ROLE_TITLE[role]}] ${topic.slice(0, 40)}`,
        body,
        messageType: 'response',
        simTime: (baseSim + elapsed) as SimTime,
      });
      if (!sent.ok) {
        throw new SandboxError('unavailable', `the ${role} message was refused: ${sent.error.code}`);
      }
      await simulation.inject([sent.value.event]);
      simulation.communication.deliverFromEvent(sent.value.event);
      const known = roleByEmployee.get(String(entry.candidate.employeeId));
      turns.push({
        seq: turns.length + 1,
        messageId: sent.value.message.messageId,
        eventId: sent.value.event.eventId,
        channelId,
        atSim: Number(sent.value.message.createdAtSim),
        role,
        employeeId: entry.candidate.employeeId,
        name: known?.name ?? entry.candidate.name,
        title: known?.title ?? entry.candidate.title,
        body,
      });
    };

    const proposer = cast.find((entry) => entry.role === 'proposer')!;
    const challenger = cast.find((entry) => entry.role === 'challenger')!;
    const defender = cast.find((entry) => entry.role === 'defender')!;
    const evaluator = cast.find((entry) => entry.role === 'evaluator')!;

    await speak(proposer);
    for (let round = 0; round < rounds; round += 1) {
      await speak(challenger);
      await speak(defender);
      if (round + 1 < rounds) await speak(proposer);
    }

    // The verdict is a real message on the channel: the page can read the score, and so can the log.
    const verdictBudget = createCallBudget(1);
    const verdict = await gateway.generate({
      actorContext: simulation.identity.actorContext(evaluator.candidate.employeeId, `corr-${sessionId}` as CorrelationId),
      request: {
        requestId: `${sessionId}-verdict`,
        system: systemPromptFor(evaluator.candidate, companyName),
        prompt: evaluationPrompt(topic, turns),
        responseFormat: 'json',
        temperature: 0.2,
      },
      budget: verdictBudget,
    });
    elapsed += 1;
    if (!verdict.ok) {
      throw new SandboxError('provider', `evaluator generation failed: ${verdict.error.code}`);
    }
    const rawVerdict = verdict.value.text.trim();
    const scores = parseScores(rawVerdict, turns);
    const sentVerdict = simulation.communication.sendMessage({
      actor: simulation.identity.actorContext(evaluator.candidate.employeeId, `corr-${sessionId}` as CorrelationId),
      senderEmployeeId: evaluator.candidate.employeeId,
      channelId,
      recipientIds: [recipientFor(evaluator.candidate.employeeId, proposer.candidate.employeeId)],
      subject: `[评审] ${topic.slice(0, 40)}`,
      body: rawVerdict,
      messageType: 'response',
      simTime: (baseSim + elapsed) as SimTime,
    });
    if (!sentVerdict.ok) {
      throw new SandboxError('unavailable', `the verdict was refused: ${sentVerdict.error.code}`);
    }
    await simulation.inject([sentVerdict.value.event]);
    simulation.communication.deliverFromEvent(sentVerdict.value.event);
    turns.push({
      seq: turns.length + 1,
      messageId: sentVerdict.value.message.messageId,
      eventId: sentVerdict.value.event.eventId,
      channelId,
      atSim: Number(sentVerdict.value.message.createdAtSim),
      role: 'evaluator',
      employeeId: evaluator.candidate.employeeId,
      name: evaluator.candidate.name,
      title: evaluator.candidate.title,
      body: rawVerdict,
    });

    const finishedAt = new Date();
    const session: SandboxSession = {
      sessionId,
      channelId,
      topic,
      rounds,
      roles: cast.map((entry) => ({
        role: entry.role,
        employeeId: entry.candidate.employeeId,
        name: entry.candidate.name,
        title: entry.candidate.title,
      })),
      turns,
      scores,
      scoringRaw: scores === null ? rawVerdict : null,
      provenance: deps.provenance(),
      provider: deps.provider(),
      model: deps.model(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    };
    const roles = cast.map((entry) => ({
      role: entry.role,
      employeeId: entry.candidate.employeeId,
      name: entry.candidate.name,
      title: entry.candidate.title,
    }));
    writeIndex({
      sessionId,
      channelId,
      topic,
      rounds,
      startedAt: session.startedAt,
      roles: roles.map((role) => ({ ...role, employeeId: String(role.employeeId) })),
    });
    return session;
  };

  const rebuild = (entry: SessionIndexEntry, events: readonly SandboxEventLike[]): SandboxSession => {
    const roleMap = new Map<string, { role: SandboxRole; name: string; title: string }>(
      entry.roles.map((role) => [role.employeeId, { role: role.role, name: role.name, title: role.title }]),
    );
    const turns = turnsOf(events, entry.channelId, roleMap);
    const verdictTurn = [...turns].reverse().find((turn) => turn.role === 'evaluator');
    return {
      sessionId: entry.sessionId,
      channelId: entry.channelId,
      topic: entry.topic,
      rounds: entry.rounds,
      roles: entry.roles.map((role) => ({
        role: role.role,
        employeeId: role.employeeId as EmployeeId,
        name: role.name,
        title: role.title,
      })),
      turns,
      scores: verdictTurn === undefined ? null : parseScores(verdictTurn.body, turns),
      scoringRaw: verdictTurn === undefined ? null : verdictTurn.body,
      provenance: deps.provenance(),
      provider: deps.provider(),
      model: deps.model(),
      startedAt: entry.startedAt,
      finishedAt: entry.startedAt,
      durationMs: 0,
    };
  };

  const list = async (limit = 10): Promise<readonly SandboxSession[]> => {
    const composed = await runtime().catch(() => null);
    if (composed === null) return [];
    const events = await composed.api.query.getRecentEvents({ eventTypePrefix: 'Communication.', limit: 500 });
    return readIndex()
      .slice(0, Math.max(1, Math.min(50, limit)))
      .map((entry) => rebuild(entry, events));
  };

  const get = async (sessionId: string): Promise<SandboxSession | null> => {
    const entry = readIndex().find((candidate) => candidate.sessionId === sessionId);
    if (entry === undefined) return null;
    const composed = await runtime().catch(() => null);
    if (composed === null) return null;
    const events = await composed.api.query.getRecentEvents({ eventTypePrefix: 'Communication.', limit: 500 });
    return rebuild(entry, events);
  };

  return { start, list, get };
}
