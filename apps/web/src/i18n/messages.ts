import enUS from './locales/en-US.json';
import zhCN from './locales/zh-CN.json';

/**
 * Resource layer: the locale catalogue, the typed key space and the lookup itself.
 *
 * Pure by design — no React, no DOM, no storage — so the resources can be validated and the
 * translators exercised outside a browser.
 *
 * Design rules:
 * - `en-US` is the source of truth for the key space (`MessageKey` is derived from it) and is
 *   the default locale: the console ships English-first.
 * - A missing key falls back to English, then to the key itself, so a gap never renders blank.
 * - Resources are plain JSON (`locales/en-US.json`, `locales/zh-CN.json`) so translators never
 *   touch TypeScript, and `assertLocaleParity` guarantees both files carry the same key set.
 * - Nothing here reaches into domain state: the runtime, workflow, event and API contracts are
 *   untouched by translation. Enum values the API returns are mapped for display only.
 */

export const LOCALES = ['en-US', 'zh-CN'] as const;

/** The two locales the console supports: `zh-CN` (中文) and `en-US` (English). */
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en-US';

export type Messages = typeof enUS;

type Paths<T> = T extends object
  ? { [K in keyof T & string]: T[K] extends object ? `${K}.${Paths<T[K]>}` : K }[keyof T & string]
  : never;

type PluralPaths<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends { one: string; other: string }
        ? K
        : T[K] extends object
          ? `${K}.${PluralPaths<T[K]>}`
          : never;
    }[keyof T & string]
  : never;

/** Every translatable key, derived from `en-US.json` — a typo is a compile error. */
export type MessageKey = Paths<Messages>;

/** Keys whose value is a `{ one, other }` pair — the counted phrases `translatePlural` resolves. */
export type PluralKey = PluralPaths<Messages>;

export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * Enum sections whose values the API returns as tokens instead of prose. The token stays the
 * identity of the value — tone, filtering and status logic keep reading the raw payload, and
 * only the rendered label goes through the resource. A token the locale does not declare is
 * shown verbatim: the console never invents a label for data it does not know.
 */
export type TokenSection = 'statusToken' | 'presence';

/** Both resources are typed as `Messages`, so a missing section in either locale fails to compile. */
const RESOURCES: Readonly<Record<Locale, Messages>> = { 'en-US': enUS, 'zh-CN': zhCN };

function lookup(resource: unknown, path: string): string | undefined {
  let node: unknown = resource;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(template: string, params?: MessageParams): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    return value === undefined ? `{${name}}` : String(value);
  });
}

/** Resolve one key in one locale; falls back to English, then to the key itself. */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const template = lookup(RESOURCES[locale], key) ?? lookup(RESOURCES[DEFAULT_LOCALE], key);
  return template === undefined ? key : interpolate(template, params);
}

/** Resolve a `{ one, other }` pair — the two forms the resources declare for a counted phrase. */
export function translatePlural(locale: Locale, key: PluralKey, count: number, params?: MessageParams): string {
  const suffix = count === 1 ? 'one' : 'other';
  const pluralKey = `${key}.${suffix}` as MessageKey;
  const template =
    lookup(RESOURCES[locale], pluralKey) ??
    lookup(RESOURCES[DEFAULT_LOCALE], pluralKey) ??
    lookup(RESOURCES[DEFAULT_LOCALE], `${key}.other` as MessageKey);
  const merged: MessageParams = { ...params, count };
  return template === undefined ? key : interpolate(template, merged);
}

/** Localized label for an enum token the API returned (`completed`, `in_meeting`, …). */
export function translateToken(locale: Locale, section: TokenSection, value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return value;
  return lookup(RESOURCES[locale], `${section}.${normalized}`) ?? value;
}

/** Flattened key list of one resource — used by the parity check and by tests. */
export function messageKeys(resource: Messages): readonly string[] {
  const keys: string[] = [];
  const walk = (node: unknown, prefix: string): void => {
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (typeof value === 'string') keys.push(path);
      else walk(value, path);
    }
  };
  walk(resource, '');
  return keys.sort();
}

/** Throws when the two resources drift apart; called once at module load. */
function assertLocaleParity(): void {
  const reference = messageKeys(RESOURCES[DEFAULT_LOCALE]);
  for (const locale of LOCALES) {
    const keys = messageKeys(RESOURCES[locale]);
    const missing = reference.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !reference.includes(key));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `[i18n] locale "${locale}" is out of sync with "${DEFAULT_LOCALE}" — missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`,
      );
    }
  }
}

assertLocaleParity();
