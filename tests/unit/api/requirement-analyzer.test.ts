import { describe, expect, it } from 'vitest';
import type { ActorContext } from '@maoeh/shared-types';
import type { LlmGateway } from '@maoeh/llm-gateway';
import type { SandboxSession } from '../../../apps/api/src/sandbox-session';
import {
  RequirementAnalysisError,
  analysisFromSandbox,
  analyzeRequirementGoal,
  deterministicAnalysis,
} from '../../../apps/api/src/requirement-analyzer';

/**
 * M3.3 · 需求分析器。
 *
 * The deterministic path is the honesty baseline: only the user's goal is stated, everything else
 * is a question. The live path is one real model call with a strict shape; a bad response fails
 * instead of becoming a plan.
 */

const ACTOR = {
  employeeId: 'ceo-alex',
  positionId: 'ceo',
  departmentId: null,
  authorityByDomain: {},
} as unknown as ActorContext;

function gatewayReturning(text: string): LlmGateway {
  return {
    async generate() {
      return {
        ok: true as const,
        value: {
          text,
          provider: 'test',
          model: 'test-model',
          latencyMs: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      };
    },
  } as unknown as LlmGateway;
}

function analyzerDeps(gateway: LlmGateway, mode: 'live' | 'mock' = 'live') {
  return {
    gateway,
    provenance: () => mode,
    provider: () => 'test',
    model: () => 'test-model',
    actorContext: () => ACTOR,
  };
}

function sessionWith(turns: number): SandboxSession {
  const roles = ['proposer', 'challenger', 'defender', 'evaluator'] as const;
  return {
    sessionId: 'session-1',
    companyId: 'future-ai-lab',
    channelId: 'channel-1',
    topic: '为设计咨询公司做周报生成器',
    rounds: 2,
    roles: roles.slice(0, 3).map((role, index) => ({
      role,
      employeeId: `employee-${String(index)}` as never,
      name: `Employee ${String(index)}`,
      title: role,
    })),
    turns: Array.from({ length: turns }, (_, index) => ({
      seq: index + 1,
      messageId: `msg-${String(index + 1)}`,
      eventId: `evt-${String(index + 1)}`,
      channelId: 'channel-1',
      atSim: index,
      role: roles[index % 3] as (typeof roles)[number],
      employeeId: `employee-${String(index)}` as never,
      name: `Employee ${String(index)}`,
      title: 'role',
      body:
        index === 0
          ? '做一个可运行的周报生成器，包含前端页面、后端接口和测试。'
          : '需要保留历史记录，并给出可检查的验收标准。',
    })),
    scores: {
      dimensions: [
        { name: '可执行性', score: 8, evidence: '有明确的前后端与测试', citedMessageId: 'msg-1' },
        { name: '风险', score: 6, evidence: '历史数据保留需要设计', citedMessageId: 'msg-2' },
      ],
      total: 74,
      verdict: '可以推进',
      rationale: '交付物明确',
    },
    scoringRaw: null,
    provenance: 'live',
    provider: 'deepseek',
    model: 'deepseek-flash',
    startedAt: '2026-11-15T00:00:00.000Z',
    finishedAt: '2026-11-15T00:01:00.000Z',
    durationMs: 60_000,
  };
}

describe('M3.3 requirement analyzer · deterministic fallback', () => {
  it('keeps the goal verbatim and asks rather than inventing business facts', () => {
    const goal = '为一家设计咨询公司做周报生成器';
    const analysis = deterministicAnalysis(goal);
    expect(analysis.title).toBe(goal);
    expect(analysis.background).toBeNull();
    expect(analysis.audience).toEqual([]);
    expect(analysis.deliverables).toEqual([]);
    expect(analysis.acceptanceCriteria).toEqual([]);
    expect(analysis.clarifications.some((question) => question.blocking)).toBe(true);
    // Capabilities are derived from the user's own words by the existing vocabulary.
    expect(analysis.requiredCapabilities.length).toBeGreaterThan(0);
  });

  it('uses the deterministic path in mock mode without calling the model', async () => {
    let calls = 0;
    const gateway = {
      async generate() {
        calls += 1;
        throw new Error('should not be called');
      },
    } as unknown as LlmGateway;
    const result = await analyzeRequirementGoal(analyzerDeps(gateway, 'mock'), '做一个官网');
    expect(result.mode).toBe('deterministic');
    expect(calls).toBe(0);
  });
});

describe('M3.3 requirement analyzer · sandbox source', () => {
  it('reuses the sandbox session brief instead of starting a second analysis', () => {
    const analysis = analysisFromSandbox(sessionWith(3));
    expect(analysis.title).toContain('周报生成器');
    expect(analysis.constraints.length).toBeGreaterThan(0);
    expect(analysis.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(analysis.requiredCapabilities.length).toBeGreaterThan(0);
    expect(analysis.deliverables.length).toBeGreaterThan(0);
  });

  it('refuses a session with too few turns', () => {
    expect(() => analysisFromSandbox(sessionWith(1))).toThrow(RequirementAnalysisError);
  });
});

describe('M3.3 requirement analyzer · live model', () => {
  it('parses a strict JSON analysis', async () => {
    const payload = {
      title: 'Design-consultancy weekly report',
      background: '20-person consultancy',
      audience: ['management'],
      constraints: ['keep history'],
      inScope: ['submit', 'summarise'],
      outOfScope: ['payroll'],
      deliverables: ['runnable app'],
      acceptanceCriteria: ['employees can submit'],
      risks: [{ risk: 'adoption', mitigation: null, severity: 'medium' }],
      requiredCapabilities: ['technical_design', 'implementation', 'testing'],
      clarifications: [],
      gaps: [],
    };
    const result = await analyzeRequirementGoal(
      analyzerDeps(gatewayReturning(JSON.stringify(payload))),
      'a weekly report app',
    );
    expect(result.mode).toBe('live');
    expect(result.analysis.deliverables).toEqual(['runnable app']);
    expect(result.analysis.requiredCapabilities).toEqual([
      'technical_design',
      'implementation',
      'testing',
    ]);
  });

  it('fails loudly on non-JSON or out-of-shape output', async () => {
    await expect(
      analyzeRequirementGoal(analyzerDeps(gatewayReturning('here is a nice plan')), 'a goal'),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(
      analyzeRequirementGoal(
        analyzerDeps(gatewayReturning(JSON.stringify({ title: 'only a title' }))),
        'a goal',
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('surfaces a provider failure instead of fabricating a plan', async () => {
    const gateway = {
      async generate() {
        return { ok: false as const, error: { code: 'provider_unavailable', issues: [] } };
      },
    } as unknown as LlmGateway;
    await expect(
      analyzeRequirementGoal(analyzerDeps(gateway), 'a goal'),
    ).rejects.toMatchObject({ code: 'provider_failed' });
  });
});
