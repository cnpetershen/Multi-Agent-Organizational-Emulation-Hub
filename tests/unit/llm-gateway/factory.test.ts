import { describe, expect, it } from 'vitest';
import type { LlmGatewayConfig, LlmProviderConfig } from '@maoeh/llm-gateway';
import {
  createLlmGatewayFromConfig,
  createMockLlmProvider,
  loadLlmGatewayConfig,
} from '@maoeh/llm-gateway';
import { testActorContext } from '../../helpers/cognition-fixtures';

/**
 * The factory is where configuration becomes a live gateway, so it is also the last place that can
 * refuse to pretend. Every test here is about *not* silently substituting one provider for another.
 */

function mockProviderConfig(): LlmProviderConfig {
  return {
    id: 'mock',
    kind: 'mock',
    baseUrl: 'mock://in-process',
    model: 'mock-model-1',
    apiKey: null,
    maxTokens: 8192,
    timeoutMs: 60_000,
    thinking: 'disabled',
  };
}

function liveProviderConfig(): LlmProviderConfig {
  return {
    id: 'deepseek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: 'sk-test-key',
    maxTokens: 8192,
    timeoutMs: 60_000,
    thinking: 'disabled',
  };
}

const deps = {
  createMockProvider: (config: LlmProviderConfig) =>
    createMockLlmProvider({ name: config.id, model: config.model, text: '{"ok":true}' }),
};

const request = {
  requestId: 'req-1',
  system: 'You are Alice.',
  prompt: '{"interpretation":"x"}',
};

describe('llm-gateway factory: 从配置装配网关', () => {
  it('mock 配置 → 网关可调用，回答来自注入的 mock', async () => {
    const config: LlmGatewayConfig = {
      mode: 'mock',
      defaultProvider: 'mock',
      providers: [mockProviderConfig()],
      maxAttempts: 1,
    };

    const built = createLlmGatewayFromConfig(config, deps);

    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const result = await built.value.generate({
      actorContext: testActorContext(),
      request,
      budget: { maxLlmCalls: 1, callCount: 0, remaining: 1, consume: () => true },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.provider).toBe('mock');
  });

  it('openai-compatible 配置 → 装配成功，且不在这里发起任何网络请求', () => {
    const config: LlmGatewayConfig = {
      mode: 'live',
      defaultProvider: 'deepseek',
      providers: [liveProviderConfig()],
      maxAttempts: 2,
    };

    const built = createLlmGatewayFromConfig(config, deps);

    expect(built.ok).toBe(true);
  });

  it('defaultProvider 指向不存在的 provider → invalid_config，而不是回退到 mock', () => {
    const config: LlmGatewayConfig = {
      mode: 'mock',
      defaultProvider: 'nobody',
      providers: [mockProviderConfig()],
      maxAttempts: 1,
    };

    const built = createLlmGatewayFromConfig(config, deps);

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.issues.some((issue) => issue.field === 'defaultProvider')).toBe(true);
  });

  it('不认识的 provider kind → invalid_config，不猜测意图', () => {
    const unknown = { ...mockProviderConfig(), kind: 'gpt-from-mars' } as unknown as LlmProviderConfig;
    const config: LlmGatewayConfig = {
      mode: 'live',
      defaultProvider: 'mock',
      providers: [unknown],
      maxAttempts: 1,
    };

    const built = createLlmGatewayFromConfig(config, deps);

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.issues.some((issue) => issue.field === 'providers')).toBe(true);
  });
});

describe('llm-gateway factory: 默认配置端到端仍然是 mock', () => {
  it('空环境 → 解析 → 装配 → 调用成功，且 provider 是 mock', async () => {
    const loaded = loadLlmGatewayConfig({});
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const built = createLlmGatewayFromConfig(loaded.value, deps);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const result = await built.value.generate({
      actorContext: testActorContext(),
      request,
      budget: { maxLlmCalls: 1, callCount: 0, remaining: 1, consume: () => true },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.provider).toBe('mock');
    expect(loaded.value.mode).toBe('mock');
  });
});
