import { describe, expect, it } from 'vitest';
import type { LlmProviderConfig, LlmRequest } from '@maoeh/llm-gateway';
import { createOpenAiCompatibleProvider } from '@maoeh/llm-gateway';

/**
 * The provider is the only place in the repository that talks to a model vendor, so its wire
 * behaviour is pinned here: what it sends, and how every documented failure maps onto the
 * gateway's error vocabulary.
 */

interface CapturedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function jsonResponse(pStatus: number, pBody: unknown): Response {
  return new Response(JSON.stringify(pBody), {
    status: pStatus,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(pStatus: number, pText: string): Response {
  return new Response(pText, { status: pStatus, headers: { 'content-type': 'text/plain' } });
}

function completion(pContent: string): unknown {
  return {
    id: 'chatcmpl-1',
    model: 'deepseek-flash',
    choices: [{ index: 0, message: { role: 'assistant', content: pContent } }],
    usage: { prompt_tokens: 120, completion_tokens: 64 },
  };
}

function harness(pResponder: (pCall: number) => Response | Promise<Response>) {
  const calls: CapturedCall[] = [];
  const impl = (async (pUrl: string, pInit: RequestInit) => {
    calls.push({
      url: pUrl,
      method: String(pInit.method),
      headers: (pInit.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(pInit.body)) as Record<string, unknown>,
    });
    return pResponder(calls.length);
  }) as typeof fetch;
  return { impl, calls };
}

function providerConfig(pOverrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    id: 'deepseek',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKey: 'sk-test-key',
    maxTokens: 8192,
    timeoutMs: 60_000,
    thinking: 'disabled',
    ...pOverrides,
  };
}

function jsonRequest(pOverrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    requestId: 'req-1',
    system: 'Answer with a single JSON object.',
    prompt: 'Plan the work.',
    responseFormat: 'json',
    ...pOverrides,
  };
}

describe('openai-compatible provider: 请求体', () => {
  it('发送 system/user、模型、max_tokens 与 JSON 模式，并带上 Bearer 凭据', async () => {
    const { impl, calls } = harness(() => jsonResponse(200, completion('{"ok":true}')));
    const provider = createOpenAiCompatibleProvider({
      config: providerConfig(),
      fetchImpl: impl,
    });

    await provider.generate(jsonRequest({ temperature: 0.2 }));

    const call = calls[0];
    if (call === undefined) throw new Error('expected one HTTP call');
    expect(call.url).toBe('https://api.deepseek.com/chat/completions');
    expect(call.method).toBe('POST');
    expect(call.headers['authorization']).toBe('Bearer sk-test-key');
    expect(call.body['model']).toBe('deepseek-flash');
    expect(call.body['max_tokens']).toBe(8192);
    expect(call.body['response_format']).toEqual({ type: 'json_object' });
    expect(call.body['messages']).toEqual([
      { role: 'system', content: 'Answer with a single JSON object.' },
      { role: 'user', content: 'Plan the work.' },
    ]);
  });

  it('thinking 关闭时显式下发，让 temperature 真正生效', async () => {
    const { impl, calls } = harness(() => jsonResponse(200, completion('{}')));
    const provider = createOpenAiCompatibleProvider({
      config: providerConfig({ thinking: 'disabled' }),
      fetchImpl: impl,
    });

    await provider.generate(jsonRequest({ temperature: 0.3 }));

    expect(calls[0]?.body['thinking']).toEqual({ type: 'disabled' });
    expect(calls[0]?.body['temperature']).toBe(0.3);
  });

  it('thinking 开启时不发送 temperature——服务端会忽略它，发出去等于假装设置生效', async () => {
    const { impl, calls } = harness(() => jsonResponse(200, completion('{}')));
    const provider = createOpenAiCompatibleProvider({
      config: providerConfig({ thinking: 'enabled' }),
      fetchImpl: impl,
    });

    await provider.generate(jsonRequest({ temperature: 0.3 }));

    expect(calls[0]?.body['temperature']).toBeUndefined();
    expect(calls[0]?.body['thinking']).toBeUndefined();
  });

  it('未要求 JSON 时不发送 response_format，保持通用', async () => {
    const { impl, calls } = harness(() => jsonResponse(200, completion('hello')));
    const provider = createOpenAiCompatibleProvider({
      config: providerConfig(),
      fetchImpl: impl,
    });

    const result = await provider.generate(jsonRequest({ responseFormat: undefined }));

    expect(calls[0]?.body['response_format']).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('baseUrl 末尾斜杠不会拼出双斜杠', async () => {
    const { impl, calls } = harness(() => jsonResponse(200, completion('{}')));
    const provider = createOpenAiCompatibleProvider({
      config: providerConfig({ baseUrl: 'https://api.deepseek.com/' }),
      fetchImpl: impl,
    });

    await provider.generate(jsonRequest());

    expect(calls[0]?.url).toBe('https://api.deepseek.com/chat/completions');
  });

  it('request.model 覆盖配置里的默认模型', async () => {
    const { impl, calls } = harness(() => jsonResponse(200, completion('{}')));
    const provider = createOpenAiCompatibleProvider({
      config: providerConfig(),
      fetchImpl: impl,
    });

    await provider.generate(jsonRequest({ model: 'deepseek-v4-pro' }));

    expect(calls[0]?.body['model']).toBe('deepseek-v4-pro');
  });
});

describe('openai-compatible provider: 成功响应', () => {
  it('返回 content 与 usage token 数，并忽略 reasoning_content', async () => {
    const { impl } = harness(() =>
      jsonResponse(200, {
        model: 'deepseek-flash',
        choices: [
          {
            message: {
              role: 'assistant',
              reasoning_content: 'let me think about this',
              content: '{"plan":"real"}',
            },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 64 },
      }),
    );
    const provider = createOpenAiCompatibleProvider({
      config: providerConfig(),
      fetchImpl: impl,
    });

    const result = await provider.generate(jsonRequest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe('{"plan":"real"}');
    expect(result.value.provider).toBe('deepseek');
    expect(result.value.model).toBe('deepseek-flash');
    expect(result.value.inputTokens).toBe(120);
    expect(result.value.outputTokens).toBe(64);
  });
});

describe('openai-compatible provider: 空 JSON 响应判为失败（DeepSeek 已知行为）', () => {
  it('JSON 模式返回空白 content → provider_error，从而进入网关重试与账本', async () => {
    const { impl } = harness(() => jsonResponse(200, completion('   ')));
    const provider = createOpenAiCompatibleProvider({
      config: providerConfig(),
      fetchImpl: impl,
    });

    const result = await provider.generate(jsonRequest());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('provider_error');
    expect(result.error.issues[0]?.field).toBe('response.text');
  });

  it('未要求 JSON 时空 content 仍然是一次成功调用', async () => {
    const { impl } = harness(() => jsonResponse(200, completion('')));
    const provider = createOpenAiCompatibleProvider({
      config: providerConfig(),
      fetchImpl: impl,
    });

    const result = await provider.generate(jsonRequest({ responseFormat: 'text' }));

    expect(result.ok).toBe(true);
  });
});

describe('openai-compatible provider: HTTP 状态映射', () => {
  const cases: readonly (readonly [number, string])[] = [
    [401, 'auth_failed'],
    [402, 'account_unfunded'],
    [429, 'rate_limited'],
    [400, 'invalid_request'],
    [422, 'invalid_request'],
    [500, 'provider_error'],
    [503, 'provider_error'],
  ];

  for (const [status, expected] of cases) {
    it(`HTTP ${status} → ${expected}`, async () => {
      const { impl } = harness(() =>
        jsonResponse(status, { error: { message: `seeded ${status}` } }),
      );
      const provider = createOpenAiCompatibleProvider({
        config: providerConfig(),
        fetchImpl: impl,
      });

      const result = await provider.generate(jsonRequest());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(expected);
      expect(result.error.issues[0]?.reason).toContain(`HTTP ${status}`);
    });
  }
});

describe('openai-compatible provider: 畸形响应与传输失败', () => {
  it('200 但没有 choices → provider_error，而不是把 undefined 当答案', async () => {
    const { impl } = harness(() => jsonResponse(200, { model: 'deepseek-flash' }));
    const provider = createOpenAiCompatibleProvider({
      config: providerConfig(),
      fetchImpl: impl,
    });

    const result = await provider.generate(jsonRequest());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('provider_error');
  });

  it('200 但响应体不是 JSON → provider_error', async () => {
    const { impl } = harness(() => textResponse(200, '<html>gateway</html>'));
    const provider = createOpenAiCompatibleProvider({
      config: providerConfig(),
      fetchImpl: impl,
    });

    const result = await provider.generate(jsonRequest());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('provider_error');
  });

  it('fetch 抛异常 → provider_error，绝不外泄异常', async () => {
    const impl = (async () => {
      throw new Error('socket hang up');
    }) as typeof fetch;
    const provider = createOpenAiCompatibleProvider({
      config: providerConfig(),
      fetchImpl: impl,
    });

    const result = await provider.generate(jsonRequest());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('provider_error');
    expect(result.error.issues[0]?.reason).toContain('socket hang up');
  });

  it('provider 名称取自配置 id，便于 llm_calls 归属', async () => {
    const { impl } = harness(() => jsonResponse(200, completion('{}')));
    const provider = createOpenAiCompatibleProvider({
      config: providerConfig({ id: 'deepseek-prod' }),
      fetchImpl: impl,
    });

    expect(provider.name).toBe('deepseek-prod');
  });
});
