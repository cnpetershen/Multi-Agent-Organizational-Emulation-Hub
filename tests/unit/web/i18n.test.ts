import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  messageKeys,
  translate,
  translatePlural,
  translateToken,
  type Locale,
  type MessageKey,
  type Messages,
  type PluralKey,
} from '../../../apps/web/src/i18n/messages';
import { LOCALE_STORAGE_KEY } from '../../../apps/web/src/i18n/store';

/**
 * The console's i18n resources are data, so the guard rails have to be tests: a key that only
 * exists in one locale, or a `{placeholder}` that only survives translation in English, is a
 * blank cell in the other language — not a compile error.
 *
 * The React binding is exercised by the render checks in `apps/web`; here we cover the resource
 * layer and the persisted choice, which both run without a DOM.
 */

const resourcePath = (locale: Locale): string =>
  fileURLToPath(new URL(`../../../apps/web/src/i18n/locales/${locale}.json`, import.meta.url));

const resource = (locale: Locale): Messages => JSON.parse(readFileSync(resourcePath(locale), 'utf8')) as Messages;

const en = resource('en-US');
const zh = resource('zh-CN');

function valueAt(source: unknown, path: string): string {
  let node: unknown = source;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) return '';
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'string' ? node : '';
}

function placeholders(template: string): readonly string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

/**
 * Keys that intentionally read the same in both languages: a brand mark, the tick unit, the
 * `#` column header, the language endonyms, and the word "Agent", which Chinese product copy
 * keeps in Latin script. The last four are data-shaped examples rather than copy — a person's
 * name, an employee-number sample, the machine-readable responsibility tokens a user types and
 * the acceptance keys of a brief — so translating them would make the example wrong.
 */
const SAME_IN_BOTH = new Set([
  'app.brand',
  'shell.tick',
  'runtime.tags.tick',
  'runtime.facts.tick',
  'events.seq',
  'language.cn',
  'language.us',
  'common.agentFallback',
  'page.agents.title',
  'overview.stat.agents',
  'runtime.tags.agents',
  'overview.brief.keysPlaceholder',
  'agents.create.namePlaceholder',
  'agents.create.employeeNoPlaceholder',
  'agents.create.responsibilitiesPlaceholder',
]);

describe('i18n resources', () => {
  it('ships the two supported locales with English as the default', () => {
    expect([...LOCALES]).toEqual(['en-US', 'zh-CN']);
    expect(DEFAULT_LOCALE).toBe('en-US');
    expect(LOCALE_STORAGE_KEY).toBe('maoeh.locale');
  });

  it('keeps zh-CN and en-US on an identical key set', () => {
    expect(messageKeys(zh)).toEqual(messageKeys(en));
    expect(messageKeys(en).length).toBeGreaterThan(200);
  });

  it('has no empty translation in either locale', () => {
    for (const locale of LOCALES) {
      const empty = messageKeys(en).filter((key) => valueAt(resource(locale), key).trim() === '');
      expect(empty, `${locale} has empty strings`).toEqual([]);
    }
  });

  it('preserves every {placeholder} across locales', () => {
    for (const key of messageKeys(en)) {
      expect(placeholders(valueAt(zh, key)), `placeholders differ for ${key}`).toEqual(placeholders(valueAt(en, key)));
    }
  });

  it('translates zh-CN copy, leaving only identities and format-only templates in Latin script', () => {
    // A value with no prose of its own (`{status} · {task}`) needs no translation; everything
    // else must be Chinese, or it is a string someone forgot to translate.
    const prose = (template: string): string => template.replace(/\{\w+\}/g, '');
    const untranslated = messageKeys(en).filter((key) => {
      if (SAME_IN_BOTH.has(key)) return false;
      if (!/[A-Za-z]/.test(prose(valueAt(en, key)))) return false;
      return !/[\u4e00-\u9fff]/.test(valueAt(zh, key));
    });
    expect(untranslated).toEqual([]);
  });

  it('translates every key through the resource, not through a fallback', () => {
    for (const key of messageKeys(en)) {
      expect(translate('en-US', key as MessageKey)).toBe(valueAt(en, key));
      expect(translate('zh-CN', key as MessageKey)).toBe(valueAt(zh, key));
    }
  });

  it('resolves counted phrases from the one/other pair', () => {
    const key = 'overview.workInMotion' as PluralKey;
    expect(translatePlural('en-US', key, 1)).toBe('1 workflow in motion');
    expect(translatePlural('en-US', key, 3)).toBe('3 workflows in motion');
    expect(translatePlural('zh-CN', key, 3)).toBe('3 个工作流进行中');
  });

  it('maps API status tokens to a localized label and passes unknown tokens through', () => {
    expect(translateToken('en-US', 'statusToken', 'completed')).toBe('completed');
    expect(translateToken('zh-CN', 'statusToken', 'completed')).toBe('已完成');
    expect(translateToken('zh-CN', 'statusToken', 'aborted')).toBe('已中止');
    expect(translateToken('zh-CN', 'statusToken', 'some_new_state')).toBe('some_new_state');
    expect(translateToken('en-US', 'presence', 'in_meeting')).toBe('in_meeting');
    expect(translateToken('zh-CN', 'presence', 'in_meeting')).toBe('会议中');
  });
});

/**
 * The choice the operator made has to survive a refresh, so it is read from `localStorage` when
 * the store module initialises. These tests stub the two browser globals the store touches and
 * re-import the module, which is exactly what a page load does.
 */
describe('locale store', () => {
  const globals = globalThis as unknown as Record<string, unknown>;

  interface FakeStorage {
    readonly values: Map<string, string>;
    readonly localStorage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };
  }

  function installBrowser(stored?: string, blocked = false): FakeStorage {
    const values = new Map<string, string>();
    if (stored !== undefined) values.set(LOCALE_STORAGE_KEY, stored);
    const localStorage = blocked
      ? {
          getItem: () => {
            throw new Error('storage blocked');
          },
          setItem: () => {
            throw new Error('storage blocked');
          },
        }
      : {
          getItem: (key: string): string | null => values.get(key) ?? null,
          setItem: (key: string, value: string): void => {
            values.set(key, value);
          },
        };
    globals['window'] = { localStorage };
    globals['document'] = { documentElement: { lang: '' } };
    return { values, localStorage };
  }

  const documentLang = (): string => (globals['document'] as { documentElement: { lang: string } }).documentElement.lang;

  const loadStore = async () => {
    vi.resetModules();
    return await import('../../../apps/web/src/i18n/store');
  };

  afterEach(() => {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
  });

  it('starts in en-US and mirrors the locale on <html lang>', async () => {
    installBrowser();
    const store = await loadStore();
    expect(store.getLocale()).toBe('en-US');
    expect(store.t('common.refresh')).toBe('Refresh');
    expect(documentLang()).toBe('en-US');
  });

  it('persists the operator choice and keeps it across a reload', async () => {
    const browser = installBrowser();
    const first = await loadStore();
    first.setLocale('zh-CN');
    expect(browser.values.get(LOCALE_STORAGE_KEY)).toBe('zh-CN');
    expect(documentLang()).toBe('zh-CN');

    const reloaded = await loadStore();
    expect(reloaded.getLocale()).toBe('zh-CN');
    expect(reloaded.t('common.refresh')).toBe('刷新');
    expect(documentLang()).toBe('zh-CN');
  });

  it('ignores a stored value that is not a supported locale', async () => {
    installBrowser('fr-FR');
    const store = await loadStore();
    expect(store.getLocale()).toBe('en-US');
  });

  it('still switches in memory when storage is unavailable', async () => {
    installBrowser(undefined, true);
    const store = await loadStore();
    expect(store.getLocale()).toBe('en-US');
    store.setLocale('zh-CN');
    expect(store.getLocale()).toBe('zh-CN');
    expect(store.t('common.refresh')).toBe('刷新');
  });
});
