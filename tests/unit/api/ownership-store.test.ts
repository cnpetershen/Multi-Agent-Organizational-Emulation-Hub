import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createOwnershipStore,
  DEFAULT_COMPANY_ID,
  DEFAULT_COMPANY_NAME,
  DEFAULT_FOUNDER_NAME,
} from '../../../apps/api/src/ownership-store';

/**
 * M1.5 · `User (Founder) owns Organization (AI company) employs Agents`.
 *
 * The ownership record is the smallest new state in the platform and the easiest to get subtly
 * wrong: it decides who a company belongs to, what its id (and therefore its event-log directory)
 * is, and which company the runtime boots into. These tests pin the contract the API, the console
 * gate and every company switch depend on — including the deliberate *absence* of an account
 * system: no credential, no permission, no merge of two people who happen to share a name.
 */

function store(path: string | null = null) {
  const ownership = createOwnershipStore({ path });
  ownership.ensureDefaults();
  return ownership;
}

describe('M1.5 ownership store: founder owns company', () => {
  it('seeds Guest Founder + Future AI Lab exactly once, and keeps running that company by default', () => {
    const ownership = store();
    ownership.ensureDefaults();
    ownership.ensureDefaults();

    const state = ownership.state();
    expect(state.users).toEqual([{ id: 'user-guest-founder', name: DEFAULT_FOUNDER_NAME }]);
    expect(state.organizations).toEqual([
      {
        id: DEFAULT_COMPANY_ID,
        name: DEFAULT_COMPANY_NAME,
        ownerId: 'user-guest-founder',
        seed: 'lab',
      },
    ]);
    expect(state.activeOrganizationId).toBe(DEFAULT_COMPANY_ID);
  });

  it('founds a company from Founder → Company Name and makes it the active one', () => {
    const ownership = store();
    const created = ownership.createCompany({ founderName: '  Ada Lovelace ', companyName: 'Neural Bakery' });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.user).toEqual({ id: 'user-ada-lovelace', name: 'Ada Lovelace' });
    expect(created.organization).toEqual({
      id: 'neural-bakery',
      name: 'Neural Bakery',
      ownerId: 'user-ada-lovelace',
      seed: 'starter',
    });

    const state = ownership.state();
    expect(state.activeOrganizationId).toBe('neural-bakery');
    // The lab is a destination, not a record that gets overwritten: both companies are listable.
    expect(state.organizations.map((organization) => organization.id)).toEqual([
      DEFAULT_COMPANY_ID,
      'neural-bakery',
    ]);
  });

  it('reuses one founder for the same name and never merges two different people', () => {
    const ownership = store();
    const first = ownership.createCompany({ founderName: 'Ada Lovelace', companyName: 'Difference Engine' });
    const second = ownership.createCompany({ founderName: 'ada lovelace', companyName: 'Analytical Works' });
    const other = ownership.createCompany({ founderName: 'Grace Hopper', companyName: 'Compiler Co' });

    expect(first.ok && second.ok && other.ok).toBe(true);
    if (!first.ok || !second.ok || !other.ok) return;
    expect(second.user.id).toBe(first.user.id);
    expect(second.organization.ownerId).toBe(first.user.id);
    expect(other.user.id).toBe('user-grace-hopper');
    expect(other.organization.ownerId).toBe('user-grace-hopper');
    expect(ownership.state().users.map((user) => user.id)).toEqual([
      'user-guest-founder',
      'user-ada-lovelace',
      'user-grace-hopper',
    ]);
  });

  it('refuses a company it cannot name, changing nothing', () => {
    const ownership = store();
    const before = ownership.state();

    expect(ownership.createCompany({ founderName: '   ', companyName: 'X' })).toMatchObject({
      ok: false,
      code: 'founder_name_required',
    });
    expect(ownership.createCompany({ founderName: 'Ada', companyName: '' })).toMatchObject({
      ok: false,
      code: 'company_name_required',
    });
    expect(
      ownership.createCompany({ founderName: 'A'.repeat(101), companyName: 'X' }),
    ).toMatchObject({ ok: false, code: 'founder_name_too_long' });
    expect(
      ownership.createCompany({ founderName: 'Ada', companyName: 'B'.repeat(121) }),
    ).toMatchObject({ ok: false, code: 'company_name_too_long' });

    expect(ownership.state()).toEqual(before);
  });

  it('gives every company a portable id: slugs, collisions and non-ASCII names', () => {
    const ownership = store();
    const bakery = ownership.createCompany({ founderName: 'Ada', companyName: 'Neural Bakery' });
    const again = ownership.createCompany({ founderName: 'Ada', companyName: 'neural bakery' });
    const chinese = ownership.createCompany({ founderName: '林岚', companyName: '星河实验室' });
    const punctuation = ownership.createCompany({ founderName: 'Ada', companyName: '!!!' });

    expect(bakery.ok && again.ok && chinese.ok && punctuation.ok).toBe(true);
    if (!bakery.ok || !again.ok || !chinese.ok || !punctuation.ok) return;
    expect(bakery.organization.id).toBe('neural-bakery');
    expect(again.organization.id).toBe('neural-bakery-2');
    // A name with no ASCII at all still has to yield a directory name.
    expect(chinese.organization.id).toBe('company');
    expect(punctuation.organization.id).toBe('company-2');
    for (const organization of ownership.state().organizations) {
      expect(organization.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('signs in to an existing company and refuses one that does not exist', () => {
    const ownership = store();
    const created = ownership.createCompany({ founderName: 'Ada', companyName: 'Neural Bakery' });
    if (!created.ok) throw new Error('expected the company to be created');
    expect(ownership.state().activeOrganizationId).toBe('neural-bakery');

    const back = ownership.activate(DEFAULT_COMPANY_ID);
    expect(back.ok).toBe(true);
    expect(ownership.state().activeOrganizationId).toBe(DEFAULT_COMPANY_ID);

    expect(ownership.activate('does-not-exist')).toMatchObject({
      ok: false,
      code: 'unknown_organization',
    });
    expect(ownership.state().activeOrganizationId).toBe(DEFAULT_COMPANY_ID);
  });

  it('round-trips through the ownership file, and a damaged file boots to the defaults', () => {
    const directory = mkdtempSync(join(tmpdir(), 'maoeh-ownership-'));
    const path = join(directory, 'companies.json');

    const first = store(path);
    const created = first.createCompany({ founderName: 'Ada', companyName: 'Neural Bakery' });
    if (!created.ok) throw new Error('expected the company to be created');
    expect(existsSync(path)).toBe(true);

    const reopened = store(path);
    expect(reopened.state().organizations.map((organization) => organization.id)).toEqual([
      DEFAULT_COMPANY_ID,
      'neural-bakery',
    ]);
    expect(reopened.state().activeOrganizationId).toBe('neural-bakery');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1 });

    writeFileSync(path, '{ not json', 'utf8');
    const afterDamage = store(path);
    expect(afterDamage.state().organizations.map((organization) => organization.id)).toEqual([
      DEFAULT_COMPANY_ID,
    ]);
    expect(afterDamage.state().activeOrganizationId).toBe(DEFAULT_COMPANY_ID);
    // The damaged file is replaced, not kept: the next boot reads a valid record again.
    expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow();
  });

  it('stays in memory when no path is given (tests and MAOEH_EVENT_LOG=off runs)', () => {
    const ownership = createOwnershipStore({});
    ownership.ensureDefaults();
    const created = ownership.createCompany({ founderName: 'Ada', companyName: 'Neural Bakery' });
    expect(created.ok).toBe(true);
    expect(ownership.state().activeOrganizationId).toBe('neural-bakery');
    // Nothing was written: a second in-memory store never sees the first one's company.
    const second = createOwnershipStore({});
    second.ensureDefaults();
    expect(second.state().organizations).toHaveLength(1);
  });
});
