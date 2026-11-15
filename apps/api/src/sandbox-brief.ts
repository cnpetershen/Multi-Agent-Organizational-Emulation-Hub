import type { WorkSubmitBriefCommand } from '@maoeh/organization-control';
import {
  CORE_CAPABILITIES,
  analyzeCapabilities,
  capabilityLabel,
} from '@maoeh/organization-model';
import type { SandboxRole, SandboxSession, SandboxTurn } from './sandbox-session.js';

/**
 * M2: a 赛博沙盘 session → a structured work brief, without inventing a second task system.
 *
 * The sandbox already produces four real messages and a grounded score; this module only turns
 * those facts into the fields the existing `Work.SubmitBrief` command accepts (title, goal,
 * context, verification keys). Nothing here starts a workflow or writes an event: the operator
 * previews and edits the draft, and only an explicit confirm submits the command.
 *
 * The draft is deliberately deterministic. A second model call would make "what the brief says"
 * depend on a provider round-trip instead of on the session the operator watched; the session's
 * own proposal, challenge and verdict are the source material, and every derived field is
 * traceable to one of them.
 */

export interface SandboxBriefSource {
  readonly sessionId: string;
  readonly topic: string;
  readonly rounds: number;
  readonly turns: number;
  readonly total: number | null;
  readonly verdict: string | null;
}

export interface SandboxBriefDraft {
  readonly sessionId: string;
  readonly source: SandboxBriefSource;
  readonly title: string;
  /** The human-facing objective; the final brief appends the required capabilities for routing. */
  readonly goal: string;
  readonly requirements: readonly string[];
  readonly capabilities: readonly string[];
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly verificationKeys: readonly string[];
  readonly notes: string;
  /** A preview of the context the brief will carry; the server recomposes it from the fields. */
  readonly context: string;
  readonly warnings: readonly string[];
}

export interface SandboxBriefInput {
  readonly title: string;
  readonly goal: string;
  readonly requirements: readonly string[];
  readonly capabilities: readonly string[];
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly verificationKeys: readonly string[];
  readonly notes: string;
}

export class SandboxBriefError extends Error {
  constructor(
    readonly code:
      | 'invalid'
      | 'unknown_session'
      | 'session_not_ready'
      | 'session_other_company'
      | 'session_legacy'
      | 'already_converted'
      | 'no_target'
      | 'command_refused',
    message: string,
  ) {
    super(message);
    this.name = 'SandboxBriefError';
  }
}

const MAX_TITLE = 200;
const MAX_GOAL = 8000;
const MAX_CONTEXT = 8000;
const MAX_LIST = 12;
const MAX_LIST_ITEM = 500;
const MAX_NOTES = 4000;
const MAX_TURNS_IN_CONTEXT = 4;

const REQUIREMENT_BY_CAPABILITY: Readonly<Record<string, string>> = Object.freeze({
  product_requirement: '澄清用户、范围与可测试的验收标准，产出需求说明。',
  technical_design: '给出架构、数据与接口设计，足以让实现席位直接开工。',
  implementation: '实现可运行的交付物（代码 / 页面 / 服务），不是一份实现报告。',
  testing: '对真实交付物执行验收检查，报告通过/失败与证据。',
  marketing: '给出定位、受众、渠道与发布计划。',
  frontend: '交付可用的前端页面与交互。',
  backend: '交付可用的后端服务与接口。',
});

const ROLE_LABEL: Readonly<Record<SandboxRole, string>> = Object.freeze({
  proposer: '提案方',
  challenger: '质询方',
  defender: '答辩方',
  evaluator: '评审',
});

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clip(value: string, max: number): string {
  const text = compact(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Length cap that preserves newlines — structured context must not be flattened into one line. */
function limitText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function turnsOf(session: SandboxSession, role: SandboxRole): readonly SandboxTurn[] {
  return session.turns.filter((turn) => turn.role === role);
}

function textOf(session: SandboxSession, role: SandboxRole, max = 600): string {
  return clip(turnsOf(session, role).map((turn) => turn.body).join(' '), max);
}

function requirementOf(capability: string): string {
  return REQUIREMENT_BY_CAPABILITY[capability] ?? `完成 ${capabilityLabel(capability)} 阶段的工作。`;
}

function capabilitiesOf(session: SandboxSession, proposal: string): readonly string[] {
  const analyzed = analyzeCapabilities(`${session.topic} ${proposal}`);
  return analyzed.length > 0 ? analyzed : CORE_CAPABILITIES;
}

function acceptanceOf(session: SandboxSession): { readonly criteria: readonly string[]; readonly warnings: readonly string[] } {
  const criteria: string[] = [];
  const warnings: string[] = [];
  const scores = session.scores;
  if (scores === null) {
    warnings.push('本次会话没有可解析的评审评分，验收标准需由人工补全。');
    criteria.push('会话未产生可解析评分；确认前必须补全可检查的验收标准。');
  } else {
    criteria.push(`本次评审总分 ${String(scores.total)}/100（结论：${scores.verdict}）。`);
    for (const dimension of scores.dimensions.slice(0, 6)) {
      criteria.push(
        `评审维度「${clip(dimension.name, 80)}」达到 ${String(dimension.score)}/10：${clip(dimension.evidence, 240)}`,
      );
    }
    criteria.push('交付物需覆盖质询方指出的主要风险，并由人工在 Results 验收。');
  }
  return { criteria, warnings };
}

function composeContext(input: {
  readonly draft: SandboxBriefDraft;
  readonly turns: readonly SandboxTurn[];
  readonly requirements: readonly string[];
  readonly capabilities: readonly string[];
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly notes: string;
}): string {
  const { draft } = input;
  const lines: string[] = [];
  lines.push(
    `【来源】赛博沙盘会话 ${draft.sessionId} · 议题：${clip(draft.source.topic, 120)} · 回合：${String(draft.source.rounds)}`,
  );
  if (draft.source.total !== null) {
    lines.push(`【评审】总分 ${String(draft.source.total)}/100${draft.source.verdict === null ? '' : ` · ${draft.source.verdict}`}`);
  }
  lines.push('', '【任务拆分】');
  if (input.requirements.length === 0) lines.push('- 按能力阶段推进（见下方「所需能力」）。');
  else input.requirements.forEach((entry, index) => lines.push(`${String(index + 1)}. ${entry}`));
  lines.push('', '【所需能力】');
  lines.push(
    input.capabilities.length === 0
      ? '- 由组织在编排时解析。'
      : input.capabilities.map((capability) => `${capabilityLabel(capability)} (${capability})`).join('、'),
  );
  lines.push('', '【约束】');
  if (input.constraints.length === 0) lines.push('- 以本次沙盘纪要作为范围基线。');
  else input.constraints.forEach((entry) => lines.push(`- ${entry}`));
  lines.push('', '【验收标准】');
  input.acceptanceCriteria.forEach((entry) => lines.push(`- ${entry}`));
  lines.push('', '【讨论纪要】');
  const turns = input.turns.slice(0, MAX_TURNS_IN_CONTEXT);
  if (turns.length === 0) lines.push('- （会话没有可引用的发言）');
  else {
    for (const turn of turns) {
      lines.push(`${ROLE_LABEL[turn.role]} · ${turn.name}：${clip(turn.body, 400)}（${turn.messageId}）`);
    }
  }
  if (input.notes.trim() !== '') {
    lines.push('', '【补充说明】', input.notes.trim());
  }
  return limitText(lines.join('\n'), MAX_CONTEXT);
}

/** The pure draft builder: session facts in, editable fields out. */
export function buildSandboxBriefDraft(session: SandboxSession): SandboxBriefDraft {
  if (session.turns.length < 2) {
    throw new SandboxBriefError(
      'session_not_ready',
      `沙盘会话 ${session.sessionId} 只有 ${String(session.turns.length)} 条发言，不足以生成任务书`,
    );
  }
  const proposal = textOf(session, 'proposer', 700);
  const challenge = textOf(session, 'challenger', 600);
  const verdict = session.scores;
  const capabilities = capabilitiesOf(session, proposal);
  const acceptance = acceptanceOf(session);
  const topic = clip(session.topic, MAX_TITLE);
  const goal = clip(
    `依据赛博沙盘会话「${session.topic}」的方案推进落地：${proposal === '' ? session.topic : proposal}`,
    MAX_GOAL,
  );
  const requirements = capabilities.map((capability) => requirementOf(capability));
  const constraints = [
    `方案基线：本次沙盘会话「${clip(session.topic, 80)}」的提案、质询与答辩纪要。`,
    ...(challenge === '' ? [] : [`质询方提出的主要风险：${challenge}`]),
    '执行前必须由人工确认任务书与画布上的执行计划；未确认不得执行。',
    '范围变更需回到任务书重新确认。',
  ];
  const draft: SandboxBriefDraft = {
    sessionId: session.sessionId,
    source: {
      sessionId: session.sessionId,
      topic: session.topic,
      rounds: session.rounds,
      turns: session.turns.length,
      total: verdict === null ? null : verdict.total,
      verdict: verdict === null ? null : verdict.verdict,
    },
    title: topic,
    goal,
    requirements,
    capabilities,
    constraints,
    acceptanceCriteria: acceptance.criteria,
    verificationKeys: ['acceptance-criteria', 'delivery-evidence'],
    notes: '',
    context: '',
    warnings: acceptance.warnings,
  };
  const context = composeContext({
    draft,
    turns: session.turns,
    requirements,
    capabilities,
    constraints,
    acceptanceCriteria: acceptance.criteria,
    notes: draft.notes,
  });
  return Object.freeze({
    ...draft,
    requirements: Object.freeze([...requirements]),
    capabilities: Object.freeze([...capabilities]),
    constraints: Object.freeze([...constraints]),
    acceptanceCriteria: Object.freeze([...acceptance.criteria]),
    verificationKeys: Object.freeze([...draft.verificationKeys]),
    warnings: Object.freeze([...acceptance.warnings]),
    context,
  });
}

function stringList(value: unknown, max: number, maxItem: number): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const list: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const text = compact(entry).slice(0, maxItem);
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    list.push(text);
    if (list.length >= max) break;
  }
  return Object.freeze(list);
}

/**
 * Validate what the operator edited in the preview. The fields are bounded here (before the
 * command reaches the event schema), and empty structured fields fall back to the draft so a
 * confirm can never submit a brief with no acceptance criteria.
 */
export function normalizeSandboxBriefInput(
  value: unknown,
  draft: SandboxBriefDraft,
): SandboxBriefInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SandboxBriefError('invalid', 'body must be an object');
  }
  const record = value as Readonly<Record<string, unknown>>;
  const title = typeof record['title'] === 'string' ? compact(record['title']) : draft.title;
  const goal = typeof record['goal'] === 'string' ? compact(record['goal']) : draft.goal;
  const notes = typeof record['notes'] === 'string' ? record['notes'].trim() : '';
  if (title === '') throw new SandboxBriefError('invalid', 'title must not be empty');
  if (title.length > MAX_TITLE) throw new SandboxBriefError('invalid', `title must be at most ${String(MAX_TITLE)} characters`);
  if (goal === '') throw new SandboxBriefError('invalid', 'goal must not be empty');
  if (goal.length > MAX_GOAL) throw new SandboxBriefError('invalid', `goal must be at most ${String(MAX_GOAL)} characters`);
  if (notes.length > MAX_NOTES) throw new SandboxBriefError('invalid', `notes must be at most ${String(MAX_NOTES)} characters`);

  const requirements = stringList(record['requirements'], MAX_LIST, MAX_LIST_ITEM);
  const capabilities = stringList(record['capabilities'], MAX_LIST, 64);
  const constraints = stringList(record['constraints'], MAX_LIST, MAX_LIST_ITEM);
  const acceptance = stringList(record['acceptanceCriteria'], MAX_LIST, MAX_LIST_ITEM);
  const keys = stringList(record['verificationKeys'], MAX_LIST, 64);

  const finalCapabilities = capabilities.length === 0 ? draft.capabilities : capabilities;
  const finalAcceptance = acceptance.length === 0 ? draft.acceptanceCriteria : acceptance;
  if (finalAcceptance.length === 0) {
    throw new SandboxBriefError('invalid', 'acceptanceCriteria must not be empty');
  }
  return Object.freeze({
    title,
    goal,
    requirements: requirements.length === 0 ? draft.requirements : requirements,
    capabilities: finalCapabilities,
    constraints: constraints.length === 0 ? draft.constraints : constraints,
    acceptanceCriteria: finalAcceptance,
    verificationKeys: keys.length === 0 ? draft.verificationKeys : keys,
    notes,
  });
}

/** The final goal the brief carries: the human objective plus the capability route. */
export function goalWithCapabilities(goal: string, capabilities: readonly string[]): string {
  if (capabilities.length === 0) return goal;
  return limitText(
    `${goal}\n所需能力：${capabilities.map((capability) => `${capabilityLabel(capability)} (${capability})`).join('、')}`,
    MAX_GOAL,
  );
}

/** The context the brief records: structured fields + the session's own discussion. */
export function briefContextOf(
  draft: SandboxBriefDraft,
  input: SandboxBriefInput,
  turns: readonly SandboxTurn[],
): string {
  return composeContext({
    draft,
    turns,
    requirements: input.requirements,
    capabilities: input.capabilities,
    constraints: input.constraints,
    acceptanceCriteria: input.acceptanceCriteria,
    notes: input.notes,
  });
}

export interface BuildSandboxBriefCommandInput {
  readonly commandId: string;
  readonly actor: WorkSubmitBriefCommand['actor'];
  readonly targetAgentId: string;
  readonly simTime: number;
  readonly draft: SandboxBriefDraft;
  readonly input: SandboxBriefInput;
  /** The session's own transcript, so the context keeps the discussion it came from. */
  readonly turns: readonly SandboxTurn[];
  readonly reason: string;
}

export function buildSandboxBriefCommand(
  command: BuildSandboxBriefCommandInput,
): WorkSubmitBriefCommand {
  return {
    commandId: command.commandId,
    commandType: 'Work.SubmitBrief',
    actor: command.actor,
    target: { targetType: 'agent', targetId: command.targetAgentId },
    reason: command.reason,
    correlationId: command.commandId,
    causationId: null,
    createdAtSim: command.simTime as WorkSubmitBriefCommand['createdAtSim'],
    workBrief: {
      title: command.input.title,
      goal: goalWithCapabilities(command.input.goal, command.input.capabilities),
      context: briefContextOf(command.draft, command.input, command.turns),
      verificationKeys: [...command.input.verificationKeys],
      sourceSessionId: command.draft.sessionId,
    },
  };
}
