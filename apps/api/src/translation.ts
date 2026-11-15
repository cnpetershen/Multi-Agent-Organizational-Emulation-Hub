/**
 * Document translation for the delivery page.
 *
 * A delivered document is often written in the language its author reasoned in. The console
 * already offers a Chinese/English shell, so the document itself should be readable in both
 * without the operator copying it into another tool. This is deliberately a small, separate
 * service instead of a new LLM cognition path: it translates bytes the organization already
 * produced, has no actor/budget semantics, and never mutates the event log.
 *
 * The provider is the same OpenAI-compatible endpoint the organization uses. The API key stays
 * server-side; the browser only sees the translated text. If no provider is configured the
 * endpoint answers a typed `unavailable` failure and the document keeps its original language.
 */

export type TranslationTarget = 'en' | 'zh';

export interface TranslationInput {
  readonly text: string;
  readonly target: TranslationTarget;
}

export class TranslationError extends Error {
  constructor(
    readonly code: 'unavailable' | 'invalid' | 'provider',
    message: string,
  ) {
    super(message);
    this.name = 'TranslationError';
  }
}

const MAX_TRANSLATION_CHARS = 60_000;

const TARGET_NAMES: Readonly<Record<TranslationTarget, string>> = Object.freeze({
  en: 'English',
  zh: 'Simplified Chinese',
});

interface ProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

function providerConfig(env: NodeJS.ProcessEnv): ProviderConfig | null {
  const baseUrl = env['MAOEH_LLM_BASE_URL']?.trim().replace(/\/+$/, '');
  const apiKey = env['MAOEH_LLM_API_KEY']?.trim();
  const model = env['MAOEH_LLM_MODEL']?.trim() || 'deepseek-chat';
  if (baseUrl === undefined || baseUrl === '' || apiKey === undefined || apiKey === '') return null;
  return { baseUrl, apiKey, model };
}

/**
 * Translate a Markdown/text document, preserving its structure.
 *
 * The prompt explicitly forbids commentary because the result is rendered as the document body,
 * not as a chat answer. A provider failure becomes `TranslationError('provider')`; the route
 * turns that into a readable 502 instead of a half-translated page.
 */
export async function translateDocument(
  input: TranslationInput,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const text = input.text.trim();
  if (text === '') throw new TranslationError('invalid', 'text must be non-empty');
  if (text.length > MAX_TRANSLATION_CHARS) {
    throw new TranslationError('invalid', `text must be at most ${String(MAX_TRANSLATION_CHARS)} characters`);
  }
  if (input.target !== 'en' && input.target !== 'zh') {
    throw new TranslationError('invalid', 'target must be en or zh');
  }
  const config = providerConfig(env);
  if (config === null) {
    throw new TranslationError('unavailable', 'No translation provider is configured');
  }

  const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.1,
      max_tokens: 8192,
      messages: [
        {
          role: 'system',
          content:
            `You are a faithful technical translator. Translate the user's Markdown document into ${TARGET_NAMES[input.target]}. `
            + 'Preserve headings, lists, tables, code fences, links, numbers and identifiers exactly. '
            + 'Output only the translated document, with no preface, commentary or surrounding code fence.',
        },
        { role: 'user', content: text },
      ],
    }),
  });

  if (!response.ok) {
    throw new TranslationError('provider', `Translation provider answered ${String(response.status)}`);
  }
  const payload: unknown = await response.json();
  const content = readContent(payload);
  if (content === '') throw new TranslationError('provider', 'Translation provider returned an empty document');
  return content;
}

function readContent(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const choices = (payload as Record<string, unknown>)['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return '';
  const message = (first as Record<string, unknown>)['message'];
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as Record<string, unknown>)['content'];
  return typeof content === 'string' ? content.trim() : '';
}
