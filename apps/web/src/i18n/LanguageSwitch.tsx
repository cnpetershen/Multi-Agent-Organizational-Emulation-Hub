import { Fragment } from 'react';
import { useI18n, type Locale, type MessageKey } from './index';
import './i18n.css';

interface LanguageOption {
  readonly code: string;
  readonly locale: Locale;
  readonly nameKey: MessageKey;
}

/**
 * The topbar language entry — `CN 中文 | US English`.
 *
 * Two flat text targets, no dropdown and no extra chrome: the control stays the weight of a
 * status label so it does not compete with the console's operational data. The selected option
 * is marked with `aria-pressed` (and a green rule under the active label).
 */
const OPTIONS: readonly LanguageOption[] = [
  { code: 'CN', locale: 'zh-CN', nameKey: 'language.cn' },
  { code: 'US', locale: 'en-US', nameKey: 'language.us' },
];

export function LanguageSwitch() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className="lang-switch" role="group" aria-label={t('language.ariaLabel')}>
      {OPTIONS.map((option, index) => (
        <Fragment key={option.locale}>
          {index > 0 && (
            <span className="lang-sep" aria-hidden="true">
              |
            </span>
          )}
          <button
            type="button"
            aria-pressed={locale === option.locale}
            onClick={() => setLocale(option.locale)}
          >
            <span className="lang-code">{option.code}</span>{' '}
            <span className="lang-name">{t(option.nameKey)}</span>
          </button>
        </Fragment>
      ))}
    </div>
  );
}
