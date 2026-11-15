import { useState } from 'react';
import { messageOf } from '../api';
import { useJson } from '../hooks';
import { useI18n, type MessageKey } from '../i18n';
import { LanguageSwitch } from '../i18n/LanguageSwitch';
import { Field, Submit } from '../components';
import {
  createCompany,
  parseOwnership,
  sessionFrom,
  signIn,
  signInOffered,
  type CompanySession,
  type OwnedOrganization,
} from '../ownership';

/**
 * M1.5 · the gate in front of the console: "Create Your AI Company".
 *
 * Not a login page. A founder arrives, names themselves and their company, and the platform
 * stands the organization up — CEO agent included — then drops them straight into the console
 * that now says *their* company's name. `Sign in` is the returning-founder path to a company
 * that already exists; there is no password field anywhere in this file, by design.
 */
type View = 'hero' | 'founder' | 'company' | 'signin';

const ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  founder_name_required: 'foundry.errorFounderName',
  founder_name_too_long: 'foundry.errorTooLong',
  company_name_required: 'foundry.errorCompanyName',
  company_name_too_long: 'foundry.errorTooLong',
  unknown_organization: 'foundry.errorUnknownCompany',
};

/** The API answers with a machine-readable code; the founder reads a sentence, not a code. */
function localizedError(cause: unknown, t: (key: MessageKey) => string): string {
  const message = messageOf(cause);
  const match = Object.keys(ERROR_KEYS).find((code) => message.includes(code));
  return match === undefined ? message : t(ERROR_KEYS[match] as MessageKey);
}

export function Foundry({ onEntered, initialView = 'hero' }: { onEntered: (session: CompanySession) => void; initialView?: View }) {
  const { t } = useI18n();
  const ownership = useJson('/api/ownership', parseOwnership, 0);
  const [view, setView] = useState<View>(initialView);
  const [founderName, setFounderName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const organizations = ownership.data?.organizations ?? [];
  /**
   * Whether the returning-founder entry is offered. `signInOffered` keeps it while the read is
   * pending or failed: hiding it then left a founder with no way to reach the panel that shows
   * why the company list is unavailable, or to retry it.
   */
  const offersSignIn = signInOffered(ownership);

  const startCreate = (): void => {
    setError(null);
    setView('founder');
  };

  const finishCreate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const membership = await createCompany(founderName, companyName);
      onEntered(sessionFrom(membership));
    } catch (cause) {
      setError(localizedError(cause, t));
    } finally {
      setBusy(false);
    }
  };

  const openCompany = async (organization: OwnedOrganization): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const membership = await signIn(organization.id);
      onEntered(sessionFrom(membership));
    } catch (cause) {
      setError(localizedError(cause, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="foundry" data-testid="foundry">
      <section className="foundry-hero">
        <div className="foundry-hero-top">
          <div className="foundry-brand">
            {t('app.brand')} <span>{t('app.brandSuffix')}</span>
          </div>
          <LanguageSwitch />
        </div>
        <div className="foundry-hero-copy">
          <p className="foundry-kicker">{t('foundry.eyebrow')}</p>
          <h1>{t('foundry.title')}</h1>
          <p className="foundry-lede">{t('foundry.subtitle')}</p>
          <div className="foundry-cta">
            <button className="primary" type="button" data-testid="foundry-create" onClick={startCreate}>
              {t('foundry.createCta')}
            </button>
            {offersSignIn && (
              <button className="foundry-secondary" type="button" data-testid="foundry-signin" onClick={() => { setError(null); setView('signin'); }}>
                {t('foundry.signIn')}
              </button>
            )}
          </div>
          <p className="foundry-note">{t('foundry.noPassword')}</p>
        </div>
        <ul className="foundry-points">
          <li>{t('foundry.point1')}</li>
          <li>{t('foundry.point2')}</li>
          <li>{t('foundry.point3')}</li>
        </ul>
      </section>

      <section className="foundry-panel">
        <div className="foundry-panel-inner">
          {view === 'hero' && (
            <div className="foundry-steps">
              <h2>{t('foundry.howTitle')}</h2>
              <ol>
                <li>
                  <b>{t('foundry.step1')}</b>
                  <span>{t('foundry.step1Detail')}</span>
                </li>
                <li>
                  <b>{t('foundry.step2')}</b>
                  <span>{t('foundry.step2Detail')}</span>
                </li>
                <li>
                  <b>{t('foundry.step3')}</b>
                  <span>{t('foundry.step3Detail')}</span>
                </li>
              </ol>
              {ownership.status === 'failed' && (
                <p className="foundry-error">
                  {t('foundry.unavailable')} {ownership.error ?? ''}{' '}
                  <button type="button" onClick={ownership.reload}>{t('common.retry')}</button>
                </p>
              )}
            </div>
          )}

          {view === 'founder' && (
            <form className="foundry-form" onSubmit={(event) => { event.preventDefault(); if (founderName.trim() !== '') setView('company'); }}>
              <p className="foundry-stepline">
                {t('foundry.stepOf', { step: '1', total: '2' })} · {t('foundry.step1')}
              </p>
              <h2>{t('foundry.founderTitle')}</h2>
              <Field label={t('foundry.founderLabel')} hint={t('foundry.founderHint')}>
                <input
                  autoFocus
                  data-testid="foundry-founder"
                  value={founderName}
                  onChange={(event) => setFounderName(event.target.value)}
                  placeholder={t('foundry.founderPlaceholder')}
                />
              </Field>
              <div className="button-row">
                <Submit busy={false} disabled={founderName.trim() === ''} onClick={() => setView('company')} dataTestId="foundry-continue">
                  {t('foundry.continue')}
                </Submit>
                <button type="button" onClick={() => setView('hero')}>
                  {t('foundry.back')}
                </button>
              </div>
            </form>
          )}

          {view === 'company' && (
            <form
              className="foundry-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (companyName.trim() !== '' && !busy) void finishCreate();
              }}
            >
              <p className="foundry-stepline">
                {t('foundry.stepOf', { step: '2', total: '2' })} · {t('foundry.step2')}
              </p>
              <h2>{t('foundry.companyTitle')}</h2>
              <p className="foundry-founder-chip">
                {t('foundry.ownedBy', { name: founderName.trim() })}
              </p>
              <Field label={t('foundry.companyLabel')} hint={t('foundry.companyHint')}>
                <input
                  autoFocus
                  data-testid="foundry-company-name"
                  value={companyName}
                  onChange={(event) => setCompanyName(event.target.value)}
                  placeholder={t('foundry.companyPlaceholder')}
                />
              </Field>
              <p className="foundry-ceo">{t('foundry.ceoNote')}</p>
              {error !== null && <p className="foundry-error" role="alert">{error}</p>}
              <div className="button-row">
                <Submit busy={busy} disabled={companyName.trim() === ''} onClick={() => void finishCreate()} dataTestId="foundry-submit">
                  {t('foundry.createSubmit')}
                </Submit>
                <button type="button" disabled={busy} onClick={() => setView('founder')}>
                  {t('foundry.back')}
                </button>
              </div>
            </form>
          )}

          {view === 'signin' && (
            <div className="foundry-form">
              <p className="foundry-stepline">{t('foundry.signIn')}</p>
              <h2>{t('foundry.signInTitle')}</h2>
              {ownership.status === 'loading' && <p className="foundry-muted">{t('foundry.loading')}</p>}
              {ownership.status === 'failed' && (
                <p className="foundry-error">
                  {t('foundry.unavailable')} {ownership.error ?? ''}
                  <button type="button" onClick={ownership.reload}>{t('common.retry')}</button>
                </p>
              )}
              {organizations.length === 0 && ownership.status === 'ready' && (
                <p className="foundry-muted">{t('foundry.signInEmpty')}</p>
              )}
              <ul className="foundry-companies">
                {organizations.map((organization) => (
                  <li key={organization.id}>
                      <button type="button" data-testid="foundry-company" disabled={busy} onClick={() => void openCompany(organization)}>
                      <span className="foundry-company-mark">{organization.name.slice(0, 1)}</span>
                      <span className="foundry-company-copy">
                        <b>{organization.name}</b>
                        <small>
                          {t('foundry.ownedBy', {
                            name: ownership.data?.users.find((user) => user.id === organization.ownerId)?.name ?? '—',
                          })}
                        </small>
                      </span>
                      <span className="foundry-company-go" aria-hidden="true">→</span>
                    </button>
                  </li>
                ))}
              </ul>
              {error !== null && <p className="foundry-error" role="alert">{error}</p>}
              <div className="button-row">
                <button type="button" disabled={busy} onClick={() => setView('hero')}>
                  {t('foundry.back')}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
