import type { ActorContext } from '@maoeh/shared-types';
import type { LlmGateway } from '@maoeh/llm-gateway';
import { createCallBudget } from '@maoeh/llm-gateway';
import { z } from 'zod';

/**
 * M3.7 · promotion strategy suggestion.
 *
 * The model is allowed to make *suggestions* from approved evidence; it is forbidden to invent
 * user feedback, market numbers, partnerships, campaign results or publication records. Anything
 * it cannot derive must stay empty and be visible as a confirmation gap.
 */

export const PromotionStrategySchema = z.object({
  goal: z.string().max(2000).default(''),
  valueProposition: z.string().max(2000).default(''),
  audience: z.array(z.string().max(500)).max(20).default([]),
  audienceNeeds: z.array(z.string().max(500)).max(20).default([]),
  coreMessages: z.array(z.string().max(500)).max(20).default([]),
  channels: z
    .array(
      z.object({
        name: z.string().max(120).default(''),
        reason: z.string().max(1000).default(''),
        contentType: z.string().max(120).default(''),
      }),
    )
    .max(20)
    .default([]),
  schedule: z.array(z.string().max(500)).max(20).default([]),
  metrics: z.array(z.string().max(500)).max(20).default([]),
  risks: z.array(z.string().max(500)).max(30).default([]),
});

export type PromotionStrategy = z.infer<typeof PromotionStrategySchema>;

export interface PromotionStrategyInput {
  readonly title: string;
  readonly goal: string;
  readonly audience: readonly string[];
  readonly deliverables: readonly string[];
  readonly acceptance: readonly string[];
  readonly artifacts: readonly string[];
  readonly taskSummaries: readonly string[];
}

export type PromotionStrategyMode = 'live' | 'mock';

export interface PromotionStrategyResult {
  readonly strategy: PromotionStrategy;
  readonly mode: PromotionStrategyMode;
  readonly provider: string | null;
  readonly model: string | null;
}

export interface PromotionStrategyDeps {
  readonly gateway: LlmGateway;
  readonly provenance: () => string;
  readonly provider: () => string | null;
  readonly model: () => string | null;
  readonly actorContext: () => ActorContext;
}

export class PromotionStrategyError extends Error {
  constructor(
    readonly code: 'invalid_response' | 'provider_failed',
    message: string,
  ) {
    super(message);
  }
}

function unique(values: readonly string[], max = 20): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const value of values) {
    const text = value.replace(/\s+/g, ' ').trim();
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    list.push(text);
    if (list.length >= max) break;
  }
  return list;
}

/** Deterministic suggestions used when no live model is configured. No market facts are added. */
export function deterministicPromotionStrategy(
  input: PromotionStrategyInput,
): PromotionStrategy {
  const deliverables = unique([...input.deliverables, ...input.artifacts], 12);
  return {
    goal: `让目标受众了解并采用「${input.title}」的已批准成果`,
    valueProposition:
      deliverables.length > 0
        ? `已批准交付：${deliverables.join('、')}`
        : `围绕「${input.title}」整理已批准成果`,
    audience: unique(input.audience),
    audienceNeeds: [],
    coreMessages: unique([input.title, ...deliverables], 8),
    channels: [
      {
        name: '内容工作台图文',
        reason: '现有内容工作台支持图文渠道；适配性需人工确认',
        contentType: '图文',
      },
      {
        name: '短视频',
        reason: '现有内容工作台支持短视频文案；适配性需人工确认',
        contentType: '短视频脚本',
      },
    ],
    schedule: [],
    metrics: ['已确认推广材料数量', '人工确认状态'],
    risks: ['未验证市场数据、用户反馈和推广效果；确认前需人工补充或确认'],
  };
}

const SYSTEM_PROMPT = [
  'You are a marketing strategist inside a software company.',
  'Use ONLY the approved evidence supplied. Do not invent user feedback, market data, partnerships, campaign results or publication records.',
  'If a fact is not present, leave the corresponding field empty; do not fill it with plausible fiction.',
  'Output strict JSON matching the requested shape, with no markdown or commentary.',
].join(' ');

function promptFor(input: PromotionStrategyInput): string {
  return [
    `Approved title: ${input.title}`,
    `Approved goal: ${input.goal}`,
    `Known audience from the requirement: ${input.audience.join(' | ') || '(none stated)'}`,
    `Deliverables: ${input.deliverables.join(' | ') || '(none)'}`,
    `Acceptance criteria: ${input.acceptance.join(' | ') || '(none)'}`,
    `Artifacts: ${input.artifacts.join(' | ') || '(none)'}`,
    `Task submissions: ${input.taskSummaries.join(' | ') || '(none)'}`,
    'Return JSON: {goal, valueProposition, audience[], audienceNeeds[], coreMessages[], channels[{name,reason,contentType}], schedule[], metrics[], risks[]}.',
  ].join('\n');
}

function parseJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new PromotionStrategyError('invalid_response', 'model did not return a JSON object');
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    throw new PromotionStrategyError('invalid_response', 'model JSON could not be parsed');
  }
}

export async function generatePromotionStrategy(
  deps: PromotionStrategyDeps,
  input: PromotionStrategyInput,
): Promise<PromotionStrategyResult> {
  if (deps.provenance() !== 'live') {
    return {
      strategy: deterministicPromotionStrategy(input),
      mode: 'mock',
      provider: deps.provider(),
      model: deps.model(),
    };
  }
  const generated = await deps.gateway.generate({
    actorContext: deps.actorContext(),
    request: {
      requestId: `m3.7-strategy-${Date.now().toString(36)}`,
      system: SYSTEM_PROMPT,
      prompt: promptFor(input),
      responseFormat: 'json',
      temperature: 0.2,
      maxTokens: 4096,
    },
    budget: createCallBudget(1),
  });
  if (!generated.ok) {
    throw new PromotionStrategyError('provider_failed', `promotion model failed: ${generated.error.code}`);
  }
  const parsed = PromotionStrategySchema.safeParse(parseJson(generated.value.text));
  if (!parsed.success) {
    throw new PromotionStrategyError(
      'invalid_response',
      `promotion strategy did not match the contract: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  // A live model sometimes returns a valid envelope with empty suggestions. Fill only the
  // missing fields from the same approved evidence the deterministic path uses; never invent a
  // market fact. The UI labels the result as an AI draft with human edits tracked separately.
  const fallback = deterministicPromotionStrategy(input);
  const candidate = parsed.data;
  const channels = candidate.channels.filter(
    (channel) => channel.name.trim() !== '',
  );
  return {
    strategy: {
      goal: candidate.goal.trim() === '' ? fallback.goal : candidate.goal,
      valueProposition:
        candidate.valueProposition.trim() === ''
          ? fallback.valueProposition
          : candidate.valueProposition,
      audience: candidate.audience.length === 0 ? fallback.audience : candidate.audience,
      audienceNeeds:
        candidate.audienceNeeds.length === 0 ? fallback.audienceNeeds : candidate.audienceNeeds,
      coreMessages:
        candidate.coreMessages.length === 0 ? fallback.coreMessages : candidate.coreMessages,
      channels: channels.length === 0 ? fallback.channels : channels,
      schedule: candidate.schedule.length === 0 ? fallback.schedule : candidate.schedule,
      metrics: candidate.metrics.length === 0 ? fallback.metrics : candidate.metrics,
      risks: candidate.risks.length === 0 ? fallback.risks : candidate.risks,
    },
    mode: 'live',
    provider: deps.provider(),
    model: deps.model(),
  };
}
