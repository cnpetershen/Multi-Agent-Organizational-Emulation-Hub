import { describe, expect, it, vi } from 'vitest';
import { TranslationError, translateDocument } from '../../../apps/api/src/translation';

const env = {
  MAOEH_LLM_BASE_URL: 'https://llm.example/v1',
  MAOEH_LLM_API_KEY: 'test-key',
  MAOEH_LLM_MODEL: 'test-model',
} as NodeJS.ProcessEnv;

describe('translateDocument', () => {
  it('asks the configured provider for a structure-preserving translation', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '# Plan\n\n- English body' } }],
    }), { status: 200 }));
    const translated = await translateDocument(
      { text: '# 计划\n\n- 中文正文', target: 'en' },
      env,
      fetchImpl as unknown as typeof fetch,
    );
    expect(translated).toBe('# Plan\n\n- English body');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://llm.example/v1/chat/completions');
    const body = JSON.parse(String((init as RequestInit).body)) as { messages: readonly { content: string }[] };
    expect(body.messages[0]?.content).toContain('Markdown');
    expect(body.messages[1]?.content).toContain('中文正文');
  });

  it('is unavailable when the environment has no provider', async () => {
    await expect(translateDocument({ text: 'hello', target: 'zh' }, {} as NodeJS.ProcessEnv))
      .rejects.toMatchObject({ code: 'unavailable' });
  });

  it('reports an empty provider document instead of returning an empty page', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(translateDocument(
      { text: 'hello', target: 'zh' },
      env,
      fetchImpl as unknown as typeof fetch,
    )).rejects.toBeInstanceOf(TranslationError);
  });

  it('rejects a target that is neither en nor zh', async () => {
    await expect(translateDocument({ text: 'hello', target: 'fr' as 'en' }, env))
      .rejects.toMatchObject({ code: 'invalid' });
  });
});
