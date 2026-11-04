import { useMemo, useSyncExternalStore } from 'react';
import {
  translate,
  translatePlural,
  translateToken,
  type Locale,
  type MessageKey,
  type MessageParams,
  type PluralKey,
} from './messages';
import { getLocale, setLocale, subscribe } from './store';

/**
 * React binding for the console i18n layer.
 *
 * `useI18n` is how a component renders copy: it subscribes to the locale store, so a single
 * `setLocale` re-renders the whole console, and hands back the translators. Nothing else about
 * the app is locale-aware — there is no provider tree and no per-page wiring.
 *
 * The resource catalogue lives in `./messages` and the persisted choice in `./store`; both are
 * plain modules so they can also be used outside React (see `t` there).
 */

export { LOCALES, DEFAULT_LOCALE, messageKeys, translate, translatePlural, translateToken } from './messages';
export type { Locale, MessageKey, MessageParams, Messages, PluralKey, TokenSection } from './messages';
export { LOCALE_STORAGE_KEY, getLocale, setLocale, t } from './store';

export interface I18n {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: (key: MessageKey, params?: MessageParams) => string;
  readonly tp: (key: PluralKey, count: number, params?: MessageParams) => string;
  /** Localized label for a status token the API returned (`completed`, `pending`, …). */
  readonly status: (value: string) => string;
  /** Localized label for an agent presence token (`thinking`, `in_meeting`, …). */
  readonly presence: (value: string) => string;
}

/**
 * Subscribe a component to the locale and hand it the translators. Every component that renders
 * copy calls this, so one `setLocale` re-renders the whole console.
 */
export function useI18n(): I18n {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  return useMemo(
    () => ({
      locale,
      setLocale,
      t: (key: MessageKey, params?: MessageParams) => translate(locale, key, params),
      tp: (key: PluralKey, count: number, params?: MessageParams) => translatePlural(locale, key, count, params),
      status: (value: string) => translateToken(locale, 'statusToken', value),
      presence: (value: string) => translateToken(locale, 'presence', value),
    }),
    [locale],
  );
}
