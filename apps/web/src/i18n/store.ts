import {
  DEFAULT_LOCALE,
  LOCALES,
  translate,
  type Locale,
  type MessageKey,
  type MessageParams,
} from './messages';

/**
 * Locale store: the operator's choice, where it is persisted, and the `<html lang>` mirror.
 *
 * Kept outside React so non-component callers (the API contract layer, the error boundary) can
 * translate too, while components subscribe through `useI18n`. The choice survives a refresh via
 * `localStorage`; a stored value that is not a supported locale is ignored, so the console always
 * starts in `en-US` unless the operator explicitly picked 中文.
 */

/** `localStorage` key holding the operator's explicit choice. */
export const LOCALE_STORAGE_KEY = 'maoeh.locale';

type Listener = () => void;

const listeners = new Set<Listener>();

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

function readStoredLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    // Storage can be unavailable (private mode / blocked cookies): fall back to the default.
    return DEFAULT_LOCALE;
  }
}

function applyLocale(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
}

let currentLocale: Locale = readStoredLocale();
applyLocale(currentLocale);

export function getLocale(): Locale {
  return currentLocale;
}

/** Switch locale: persist the choice, mirror it on `<html lang>`, notify every subscriber. */
export function setLocale(next: Locale): void {
  if (next === currentLocale) return;
  currentLocale = next;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    // Persistence is best-effort; the in-memory locale still switches.
  }
  applyLocale(next);
  for (const listener of listeners) listener();
}

/** Subscribe to locale changes — the contract `useSyncExternalStore` needs. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Module-level translate bound to the current locale, for non-React callers. */
export function t(key: MessageKey, params?: MessageParams): string {
  return translate(currentLocale, key, params);
}
