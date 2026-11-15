import type { ActorContext } from '@maoeh/shared-types';
import { createCallBudget, type LlmGateway } from '@maoeh/llm-gateway';
import {
  CAPABILITY_VOCABULARY,
  analyzeCapabilities,
  capabilityLabel,
} from '@maoeh/organization-model';
import { buildSandboxBriefDraft } from './sandbox-brief.js';
import type { SandboxSession } from './sandbox-session.js';
import {
  RequirementAnalysisSchema,
  type RequirementAnalysis,
} from './planning-types.js';

/**
 * M3.3 · 需求沙盘的分析器。
 *
 * Three sources, each honest about what it is:
 *
 * - **live** — a real model call with a strict JSON contract. The prompt forbids inventing
 *   facts: unknown fields stay empty and become clarification questions.
 * - **sandbox** — the existing 赛博沙盘 session is reused: its real transcript already produced a
 *   structured brief (`buildSandboxBriefDraft`), and this adapter turns that into a requirement
 *   plan. No second model call, no second debate.
 * - **deterministic** — no model available (mock mode / tests). It keeps the user's goal verbatim,
 *   derives only capabilities from the user's own words through the existing vocabulary, and asks
 *   the missing questions. It never fills a business fact.
 *
 * In every mode, only `source.goal` is claimed as user-stated; everything else is marked inferred
 * and has to be confirmed by a human before orchestration.
 */

export type RequirementAnalysisErrorCode =
  | 'provider_failed'
  | 'invalid_response'
  | 'sandbox_not_ready';

export class RequirementAnalysisError extends Error {
  constructor(
    readonly code: RequirementAnalysisErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RequirementAnalysisError';
  }
}

export interface RequirementAnalyzerDeps {
  readonly gateway: LlmGateway;
  readonly provenance: () => 'live' | 'mock';
  readonly provider: () => string | null;
  readonly model: () => string | null;
  readonly actorContext: () => ActorContext;
}

export interface RequirementAnalysisResult {
  readonly analysis: RequirementAnalysis;
  readonly mode: 'live' | 'sandbox' | 'deterministic';
  readonly provider: string | null;
  readonly model: string | null;
}

const MAX_GOAL = 8000;

const SYSTEM_PROMPT = [
  'You are the requirements analyst of an AI company.',
  'Turn the user’s business goal into a structured requirement proposal.',
  'You do NOT execute work and you do NOT schedule agents.',
  '',
  'Hard rules:',
  '1. The user’s goal is the only explicit statement. Never claim the user said anything else.',
  '2. Do not invent audience, constraints, deliverables, acceptance criteria, numbers, deadlines or budgets.',
  '3. If a business-critical field is missing, leave it empty and ask ONE precise clarification question with why it blocks.',
  '4. requiredCapabilities must be ids from the provided capability vocabulary only.',
  '5. Deliverables and acceptance criteria must be concrete and checkable, not "do a good job".',
  '6. Return ONLY a JSON object, no markdown, no prose, matching the requested shape.',
].join('\n');

function capabilityMenu(): string {
  return CAPABILITY_VOCABULARY.map(
    (entry) => `- ${entry.id} (${entry.label})`,
  ).join('\n');
}

function userPrompt(goal: string): string {
  return [
    '## User goal (verbatim)',
    goal,
    '',
    '## Capability vocabulary',
    capabilityMenu(),
    '',
    '## Required JSON shape',
    '{',
    '  "title": "<=200 chars, a working title, not a promise>",',
    '  "background": "<=4000 chars or null when the user gave none>",',
    '  "audience": ["who the outcome is for; empty when unknown"],',
    '  "constraints": ["explicit or organisationally unavoidable constraints; empty when unknown"],',
    '  "inScope": ["what this work includes"],',
    '  "outOfScope": ["what it explicitly excludes"],',
    '  "deliverables": ["concrete artifacts the user will receive"],',
    '  "acceptanceCriteria": ["how a human can verify each deliverable"],',
    '  "risks": [{"risk":"<=500 chars","mitigation":"<=500 chars or null","severity":"low|medium|high"}],',
    '  "requiredCapabilities": ["ids from the vocabulary"],',
    '  "clarifications": [{"question":"<=500 chars","why":"why it blocks the plan","blocking":true|false}],',
    '  "gaps": [{"area":"<=120 chars","detail":"<=500 chars","blocking":true|false}]',
    '}',
    '',
    'If a critical field is unknown, leave it empty and add a clarification instead of guessing.',
  ].join('\n');
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced === null ? trimmed : (fenced[1] ?? '').trim();
}

function parseAnalysis(text: string): RequirementAnalysis {
  let raw: unknown;
  try {
    raw = JSON.parse(stripFence(text));
  } catch {
    throw new RequirementAnalysisError(
      'invalid_response',
      'the requirements model returned non-JSON text',
    );
  }
  const parsed = RequirementAnalysisSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RequirementAnalysisError(
      'invalid_response',
      `the requirements model returned an incomplete shape: ${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/** Deterministic, honest fallback: only the user's own words, plus questions. */
export function deterministicAnalysis(goal: string): RequirementAnalysis {
  const title = goal.replace(/\s+/g, ' ').trim().slice(0, 120) || '未命名需求';
  const capabilities = analyzeCapabilities(goal);
  const clarifications: RequirementAnalysis['clarifications'] = [];
  const ask = (question: string, why: string): void => {
    clarifications.push({ question, why, blocking: true });
  };
  ask('这项工作的目标受众是谁？', '没有受众，交付物的定位与验收标准无法确定。');
  ask('必须遵守哪些约束（时间、预算、技术、合规）？', '约束会改变范围与实现方案，不能由 AI 代替用户决定。');
  ask('最终需要交付哪些具体成果？', '没有交付物就无法拆分任务与验收。');
  ask('怎样才算验收通过？', '没有验收标准，任何结果都无法被判定为完成。');
  if (capabilities.length === 0) {
    ask('这项需求需要哪些能力？', '当前目标没有识别出可编排的能力，需要用户或管理者指定。');
  }
  return {
    title,
    background: null,
    audience: [],
    constraints: [],
    inScope: [],
    outOfScope: [],
    deliverables: [],
    acceptanceCriteria: [],
    risks: [],
    requiredCapabilities: [...capabilities],
    clarifications,
    gaps: [
      {
        area: 'requirements',
        detail: '目标只有原始描述；受众、约束、交付物与验收标准尚未提供。',
        blocking: true,
      },
    ],
  };
}

/** Build the analysis from the existing sandbox session's structured brief. */
export function analysisFromSandbox(session: SandboxSession): RequirementAnalysis {
  let draft: ReturnType<typeof buildSandboxBriefDraft>;
  try {
    draft = buildSandboxBriefDraft(session);
  } catch (error) {
    throw new RequirementAnalysisError(
      'sandbox_not_ready',
      error instanceof Error ? error.message : 'the sandbox session is not ready',
    );
  }
  const clarifications: RequirementAnalysis['clarifications'] = [];
  const deliverables = [...draft.requirements];
  if (deliverables.length === 0) {
    clarifications.push({
      question: '这次沙盘要交付的具体成果是什么？',
      why: '沙盘纪要只有方向，没有可验收的交付物。',
      blocking: true,
    });
  }
  if (draft.acceptanceCriteria.length === 0) {
    clarifications.push({
      question: '这次交付怎样算通过？',
      why: '没有验收标准，无法确认工作完成。',
      blocking: true,
    });
  }
  for (const warning of draft.warnings) {
    clarifications.push({
      question: `沙盘纪要提示：${warning}`,
      why: '该警告会影响交付质量，需要人工确认。',
      blocking: false,
    });
  }
  return {
    title: draft.title,
    background: draft.goal,
    audience: [],
    constraints: [...draft.constraints],
    inScope: [...draft.requirements],
    outOfScope: [],
    deliverables,
    acceptanceCriteria: [...draft.acceptanceCriteria],
    risks: [],
    requiredCapabilities: [...draft.capabilities],
    clarifications,
    gaps: draft.warnings.map((warning) => ({
      area: 'sandbox',
      detail: warning,
      blocking: false,
    })),
  };
}

/**
 * Analyze one business goal. In live mode this is one model call; in mock mode it is the
 * deterministic fallback above. A provider failure is surfaced, never replaced by a made-up plan.
 */
export async function analyzeRequirementGoal(
  deps: RequirementAnalyzerDeps,
  goal: string,
): Promise<RequirementAnalysisResult> {
  const clean = goal.trim();
  if (clean === '') throw new RequirementAnalysisError('invalid_response', 'goal must not be empty');
  if (clean.length > MAX_GOAL) {
    throw new RequirementAnalysisError('invalid_response', 'goal is too long');
  }
  if (deps.provenance() !== 'live') {
    return {
      analysis: deterministicAnalysis(clean),
      mode: 'deterministic',
      provider: deps.provider(),
      model: deps.model(),
    };
  }
  const response = await deps.gateway.generate({
    actorContext: deps.actorContext(),
    request: {
      requestId: `requirement-${String(Date.now())}`,
      system: SYSTEM_PROMPT,
      prompt: userPrompt(clean),
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 4096,
    },
    budget: createCallBudget(1),
  });
  if (!response.ok) {
    throw new RequirementAnalysisError(
      'provider_failed',
      `requirements model failed: ${response.error.code}`,
    );
  }
  return {
    analysis: parseAnalysis(response.value.text),
    mode: 'live',
    provider: response.value.provider,
    model: response.value.model,
  };
}

/** The capability list a plan may use, for validation messages and the UI. */
export function knownCapabilityLabel(capability: string): string {
  return capabilityLabel(capability);
}
