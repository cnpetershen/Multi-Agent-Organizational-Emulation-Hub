import { describe, expect, it } from 'vitest';
import type { ActorContext } from '@maoeh/shared-types';
import type { LlmGateway, LlmGenerateInput } from '@maoeh/llm-gateway';
import { CONTENT_PLATFORMS, ContentStudioError, PLATFORM_BRIEFS, createContentStudio } from '../../../apps/api/src/content-studio';

/**
 * 一鱼多吃's generator, tested at the seam that matters: the prompt per platform and the
 * provenance attached to the result.
 *
 * The delivered content board used to return four fixed strings from a client-side function. The
 * regression this file prevents is subtle and important: "four cards appeared" must never again be
 * achievable without four model calls, each carrying that platform's own format contract, and the
 * result must say where the copy came from.
 */

const actor: ActorContext = {
  employeeId: 'ceo-alex' as never,
  positionId: 'ceo' as never,
  departmentId: null as never,
  authorityByDomain: {} as never,
  correlationId: 'corr-content-test' as never,
};

interface Captured {
  readonly requestId: string;
  readonly prompt: string;
  readonly system: string;
  readonly actorEmployee: string;
}

function scriptedGateway(captured: Captured[], text: (prompt: string) => string = (prompt) => `copy:${prompt.slice(0, 12)}`): LlmGateway {
  return {
    async generate(input: LlmGenerateInput) {
      captured.push({
        requestId: input.request.requestId,
        prompt: input.request.prompt,
        system: input.request.system,
        actorEmployee: String(input.actorContext?.employeeId),
      });
      return {
        ok: true as const,
        value: { text: text(input.request.prompt), provider: 'scripted', model: 'scripted-model', latencyMs: 1 },
      };
    },
  };
}

function studio(gateway: LlmGateway, provenance: 'live' | 'mock' = 'live') {
  let seq = 0;
  return createContentStudio({
    gateway,
    provenance,
    provider: provenance === 'live' ? 'deepseek' : 'mock',
    model: provenance === 'live' ? 'deepseek-flash' : 'mock-model-1',
    actorContext: actor,
    correlationId: () => `corr-${String((seq += 1))}`,
  });
}

describe('一鱼多吃: real per-platform generation', () => {
  it('makes one model call per platform, in the platform order asked for', async () => {
    const captured: Captured[] = [];
    const result = await studio(scriptedGateway(captured)).generate({
      source: '我们用一个 AI 剪辑工具，把一期播客的剪辑时间从 3 小时降到 10 分钟。',
    });

    expect(captured).toHaveLength(CONTENT_PLATFORMS.length);
    expect(result.assets.map((asset) => asset.platform)).toEqual([...CONTENT_PLATFORMS]);
    expect(result.calls).toBe(4);
    expect(result.provenance).toBe('live');
    expect(result.provider).toBe('deepseek');
    expect(result.model).toBe('deepseek-flash');
    // Every call is attributable and independently identified.
    expect(new Set(captured.map((entry) => entry.requestId)).size).toBe(4);
    expect(captured.every((entry) => entry.actorEmployee === 'ceo-alex')).toBe(true);
  });

  it('gives each platform its own formal brief, so the copies cannot be the same request', async () => {
    const captured: Captured[] = [];
    await studio(scriptedGateway(captured)).generate({ source: 'source material' });

    const prompts = captured.map((entry) => entry.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
    for (const platform of CONTENT_PLATFORMS) {
      const brief = PLATFORM_BRIEFS[platform];
      const prompt = captured.find((entry) => entry.prompt.includes(`Platform: ${brief.name}`))?.prompt ?? '';
      expect(prompt).toContain(brief.guide);
      expect(prompt).toContain('source material');
    }
  });

  it('only returns platforms the caller asked for, and validates unknown ones', async () => {
    const captured: Captured[] = [];
    const result = await studio(scriptedGateway(captured)).generate({
      source: 'source material',
      platforms: ['xiaohongshu', 'wechat'],
    });
    expect(result.assets.map((asset) => asset.platform)).toEqual(['xiaohongshu', 'wechat']);
    expect(captured).toHaveLength(2);

    await expect(
      studio(scriptedGateway([])).generate({ source: 'x', platforms: ['myspace'] }),
    ).rejects.toBeInstanceOf(ContentStudioError);
  });

  it('refuses an empty source instead of generating filler', async () => {
    const captured: Captured[] = [];
    await expect(studio(scriptedGateway(captured)).generate({ source: '   ' })).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(captured).toHaveLength(0);
  });

  it('reports a provider failure as a provider failure, not as content', async () => {
    const gateway: LlmGateway = {
      async generate() {
        return { ok: false as const, error: { code: 'provider_error' as never, issues: [] } };
      },
    };
    await expect(studio(gateway).generate({ source: 'x' })).rejects.toMatchObject({ code: 'provider' });
  });

  it('labels mock output as mock — the provenance is never upgraded', async () => {
    const result = await studio(scriptedGateway([]), 'mock').generate({ source: 'x', platforms: ['douyin'] });
    expect(result.provenance).toBe('mock');
    expect(result.assets[0]?.text).toContain('copy:');
  });
});
