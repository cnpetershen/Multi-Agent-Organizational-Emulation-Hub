import { describe, expect, it } from 'vitest';
import {
  LLM_DEFAULTS,
  LLM_ENV,
  loadLlmGatewayConfig,
  type LlmGatewayConfig,
} from '@maoeh/llm-gateway';

/**
 * The config loader is the only thing standing between "the operator meant to run a real model"
 * and "the mock quietly answered". These tests therefore pin behaviour, not implementation:
 * what the defaults are, and which mistakes are refused outright.
 */

function load(pEnv: Record<string, string | undefined>) {
  return loadLlmGatewayConfig(pEnv);
}

function configOf(pEnv: Record<string, string | undefined>): LlmGatewayConfig {
  const result = load(pEnv);
  if (!result.ok) {
    throw new Error(`expected a valid config, got ${JSON.stringify(result.error.issues)}`);
  }
  return result.value;
}

function issuesOf(pEnv: Record<string, string | undefined>) {
  const result = load(pEnv);
  if (result.ok) {
    throw new Error('expected an invalid config, got a valid one');
  }
  return result.error.issues;
}

const liveEnv = {
  [LLM_ENV.mode]: 'live',
  [LLM_ENV.apiKey]: 'sk-test-key',
};

describe('llm-gateway config: 默认 mock，接真实模型必须显式开启', () => {
  it('空环境 → mock 模式，这是零行为变更的基线', () => {
    const config = configOf({});

    expect(config.mode).toBe('mock');
    expect(config.defaultProvider).toBe('mock');
    expect(config.providers).toHaveLength(1);

    const provider = config.providers[0];
    if (provider === undefined) throw new Error('expected one provider');
    expect(provider.kind).toBe('mock');
    expect(provider.apiKey).toBeNull();
  });

  it('默认 thinking=disabled，否则 temperature 会被服务端静默忽略', () => {
    expect(LLM_DEFAULTS.thinking).toBe('disabled');
    expect(configOf({}).providers[0]?.thinking).toBe('disabled');
  });

  it('默认 maxAttempts=1，保持既有「一次调用一次预算」语义', () => {
    expect(LLM_DEFAULTS.maxAttempts).toBe(1);
    expect(configOf({}).maxAttempts).toBe(1);
  });

  it('空白字符串等同于未设置，不会被当成一个合法的值', () => {
    const config = configOf({
      [LLM_ENV.mode]: '   ',
      [LLM_ENV.model]: '',
    });

    expect(config.mode).toBe('mock');
    expect(config.providers[0]?.model).toBe('mock-model-1');
  });

  it('CI 环境变量本身不影响 mock 模式', () => {
    expect(configOf({ CI: 'true' }).mode).toBe('mock');
  });
});

describe('llm-gateway config: live 模式的前置条件', () => {
  it('live 但缺 API key → invalid_config，绝不静默降级为 mock', () => {
    const issues = issuesOf({ [LLM_ENV.mode]: 'live' });

    expect(issues.some((issue) => issue.field === LLM_ENV.apiKey)).toBe(true);
  });

  it('live + key → openai-compatible，并带上 DeepSeek 端点与模型', () => {
    const config = configOf(liveEnv);

    expect(config.mode).toBe('live');
    expect(config.defaultProvider).toBe('deepseek');

    const provider = config.providers[0];
    if (provider === undefined) throw new Error('expected one provider');
    expect(provider.kind).toBe('openai-compatible');
    expect(provider.baseUrl).toBe('https://api.deepseek.com');
    expect(provider.model).toBe('deepseek-flash');
    expect(provider.apiKey).toBe('sk-test-key');
  });

  it('live 但 baseUrl 不是 http(s) → 拒绝，而不是留给运行时报错', () => {
    const issues = issuesOf({ ...liveEnv, [LLM_ENV.baseUrl]: 'api.deepseek.com' });

    expect(issues.some((issue) => issue.field === LLM_ENV.baseUrl)).toBe(true);
  });

  it('CI 下 live → 拒绝（CI 必须保持确定性）', () => {
    const issues = issuesOf({ ...liveEnv, CI: 'true' });

    expect(issues.some((issue) => issue.field === LLM_ENV.mode)).toBe(true);
  });

  it('CI 下 live + 显式放行 → 允许', () => {
    const config = configOf({
      ...liveEnv,
      CI: 'true',
      [LLM_ENV.allowLiveInCi]: 'true',
    });

    expect(config.mode).toBe('live');
  });

  it('CI=false / CI=0 不视为 CI', () => {
    expect(configOf({ ...liveEnv, CI: 'false' }).mode).toBe('live');
    expect(configOf({ ...liveEnv, CI: '0' }).mode).toBe('live');
  });

  it('live + 放行标志非法 → 报错而不是猜一个意图', () => {
    const issues = issuesOf({ ...liveEnv, [LLM_ENV.allowLiveInCi]: 'maybe' });

    expect(issues.some((issue) => issue.field === LLM_ENV.allowLiveInCi)).toBe(true);
  });
});

describe('llm-gateway config: 非法输入一次性全部报出', () => {
  it('枚举值非法 → 指出字段与合法取值', () => {
    const issues = issuesOf({ [LLM_ENV.mode]: 'production' });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe(LLM_ENV.mode);
    expect(issues[0]?.reason).toContain('mock | live');
  });

  it('数字字段非法 → 指出字段而不是 NaN 传播到请求里', () => {
    const issues = issuesOf({
      [LLM_ENV.maxTokens]: 'lots',
      [LLM_ENV.timeoutMs]: '-5',
      [LLM_ENV.maxAttempts]: '1.5',
    });

    expect(issues.map((issue) => issue.field).sort()).toEqual(
      [LLM_ENV.maxAttempts, LLM_ENV.maxTokens, LLM_ENV.timeoutMs].sort(),
    );
  });

  it('超出防呆上限 → 拒绝，而不是把明显的手误发到 API', () => {
    expect(
      issuesOf({ [LLM_ENV.maxAttempts]: '99' }).some(
        (issue) => issue.field === LLM_ENV.maxAttempts,
      ),
    ).toBe(true);
    expect(
      issuesOf({ [LLM_ENV.maxTokens]: '99999999' }).some(
        (issue) => issue.field === LLM_ENV.maxTokens,
      ),
    ).toBe(true);
  });

  it('多个问题同时存在时全部返回，操作者一次改完', () => {
    const issues = issuesOf({
      [LLM_ENV.mode]: 'live',
      [LLM_ENV.baseUrl]: 'not-a-url',
      CI: 'true',
    });

    expect(issues.length).toBeGreaterThanOrEqual(3);
  });
});
