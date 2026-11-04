/**
 * M1.5 · the founder side of the product: create a company, sign in to a company.
 *
 * This is deliberately *not* an auth client. There is no credential, no token and no expiry:
 * `CompanySession` is only "which company this browser tab has open", stored so a refresh puts
 * the founder back in their own company instead of on the gate. The server independently
 * decides which company the runtime is running, so a stale session is corrected (or dropped)
 * by the restore call in `App`, never trusted.
 *
 * Contract style matches `api.ts`: every response is checked field by field, and the first
 * violated path throws `ApiError` with the exact path — a broken payload is shown to the
 * founder, never rendered as an empty company list.
 */

import { requestJson, type Row } from './api';
import type { LoadState } from './hooks';

export interface FounderUser {
  readonly id: string;
  readonly name: string;
}

export interface OwnedOrganization {
  readonly id: string;
  readonly name: string;
  readonly ownerId: string;
  readonly seed: string;
}

export interface OwnershipState {
  readonly users: readonly FounderUser[];
  readonly organizations: readonly OwnedOrganization[];
  readonly activeOrganizationId: string;
}

export interface Membership {
  readonly user: FounderUser;
  readonly organization: OwnedOrganization;
}

export interface CompanySession {
  readonly userId: string;
  readonly organizationId: string;
  /** Display name of the founder; refreshed from the API on every restore. */
  readonly founderName: string;
}

export const SESSION_STORAGE_KEY = 'maoeh.session';

function record(value: unknown, where: string): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Row;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where} must be a non-empty string`);
  }
  return value;
}

function rows(value: unknown, where: string): readonly Row[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  return value.map((entry, index) => record(entry, `${where}[${String(index)}]`));
}

function parseUser(value: unknown, where: string): FounderUser {
  const source = record(value, where);
  return { id: text(source['id'], `${where}.id`), name: text(source['name'], `${where}.name`) };
}

function parseOrganization(value: unknown, where: string): OwnedOrganization {
  const source = record(value, where);
  return {
    id: text(source['id'], `${where}.id`),
    name: text(source['name'], `${where}.name`),
    ownerId: text(source['ownerId'], `${where}.ownerId`),
    seed: typeof source['seed'] === 'string' ? source['seed'] : 'starter',
  };
}

/** `GET /api/ownership` — founders, their companies, and the one the runtime runs. */
export function parseOwnership(value: unknown, where = 'GET /api/ownership response'): OwnershipState {
  const source = record(value, where);
  return {
    users: rows(source['users'], `${where}.users`).map((entry, index) => parseUser(entry, `${where}.users[${String(index)}]`)),
    organizations: rows(source['organizations'], `${where}.organizations`).map((entry, index) =>
      parseOrganization(entry, `${where}.organizations[${String(index)}]`),
    ),
    activeOrganizationId: text(source['activeOrganizationId'], `${where}.activeOrganizationId`),
  };
}

/** `POST /api/ownership/companies` and `POST /api/ownership/session` — who you now are, and which company you own. */
export function parseMembership(value: unknown, where: string): Membership {
  const source = record(value, where);
  return {
    user: parseUser(source['user'], `${where}.user`),
    organization: parseOrganization(source['organization'], `${where}.organization`),
  };
}

export async function loadOwnership(): Promise<OwnershipState> {
  return parseOwnership(await requestJson('/api/ownership'));
}

/** `Founder → Company Name → 公司成立`: creates both records and makes the company active. */
export async function createCompany(founderName: string, companyName: string): Promise<Membership> {
  return parseMembership(
    await requestJson('/api/ownership/companies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ founderName, companyName }),
    }),
    'POST /api/ownership/companies response',
  );
}

/** Sign in to an existing company — switches the runtime to it. */
export async function signIn(organizationId: string): Promise<Membership> {
  return parseMembership(
    await requestJson('/api/ownership/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId }),
    }),
    'POST /api/ownership/session response',
  );
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Private-mode and blocked-storage browsers still get a working console: the session is
    // simply remembered for this page load only.
    return null;
  }
}

export function readSession(): CompanySession | null {
  const store = storage();
  if (store === null) return null;
  try {
    const raw = store.getItem(SESSION_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    const source = record(parsed, SESSION_STORAGE_KEY);
    return {
      userId: text(source['userId'], `${SESSION_STORAGE_KEY}.userId`),
      organizationId: text(source['organizationId'], `${SESSION_STORAGE_KEY}.organizationId`),
      founderName: typeof source['founderName'] === 'string' ? source['founderName'] : '',
    };
  } catch {
    clearSession();
    return null;
  }
}

export function writeSession(session: CompanySession): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* storage full or blocked: the session survives this page load only */
  }
}

export function clearSession(): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* nothing to clean up when storage is unavailable */
  }
}

export function sessionFrom(membership: Membership): CompanySession {
  return {
    userId: membership.user.id,
    organizationId: membership.organization.id,
    founderName: membership.user.name,
  };
}

/**
 * Does the gate offer the returning-founder path — the "Sign in" entry?
 *
 * The rule used to be `organizations.length > 0`, which conflates "there is no company" with "the
 * company list could not be read". When `GET /api/ownership` fails (the API is stopped, or is
 * switching companies), `data` stays `null`, so the list is empty, so the button *disappeared* —
 * and with it the only route to the panel that carries the Retry. A failed read is exactly when a
 * returning founder still needs a way in, so only a *successful* read that really reports no
 * company hides the entry; a pending or failed one keeps it and lets the panel report itself.
 */
export function signInOffered(ownership: LoadState<OwnershipState>): boolean {
  if (ownership.status !== 'ready') return true;
  return (ownership.data?.organizations.length ?? 0) > 0;
}
