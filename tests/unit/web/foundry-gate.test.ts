import { describe, expect, it } from 'vitest';
import type { LoadState } from '../../../apps/web/src/hooks';
import { signInOffered, type OwnedOrganization, type OwnershipState } from '../../../apps/web/src/ownership';

/**
 * The gate in front of the console must not remove the returning-founder entry because a read
 * failed.
 *
 * The report this pins: "sign in is not shown, the company list is unavailable". The rule was
 * `organizations.length > 0`, and a failed `GET /api/ownership` leaves `data === null`, so the
 * list was empty, so the button vanished — together with the only route to the panel that carries
 * the Retry. The founder was left with a screen that said the list was unavailable and no way to
 * ask again, which is exactly the state a stopped API produces.
 */

const COMPANY: OwnedOrganization = { id: 'future-ai-lab', name: 'Future AI Lab', ownerId: 'user-guest-founder', seed: 'lab' };

function ownership(organizations: readonly OwnedOrganization[]): OwnershipState {
  return { users: [{ id: 'user-guest-founder', name: 'Guest Founder' }], organizations, activeOrganizationId: 'future-ai-lab' };
}

/** One read of `/api/ownership`, in the three states `useJson` can report. */
function load(status: 'loading' | 'ready' | 'failed', organizations: readonly OwnedOrganization[] = []): LoadState<OwnershipState> {
  return {
    status,
    data: status === 'ready' ? ownership(organizations) : null,
    error: status === 'failed' ? 'GET /api/ownership failed with HTTP 500: empty body' : null,
    reload: () => undefined,
  };
}

describe('the company gate offers Sign in unless it knows there is nothing to sign in to', () => {
  it('offers it when companies came back', () => {
    expect(signInOffered(load('ready', [COMPANY]))).toBe(true);
  });

  it('hides it only when a successful read really reports no company', () => {
    expect(signInOffered(load('ready', []))).toBe(false);
  });

  it('keeps it while the read is still in flight', () => {
    expect(signInOffered(load('loading'))).toBe(true);
  });

  it('keeps it — and the Retry behind it — when the read failed', () => {
    expect(signInOffered(load('failed'))).toBe(true);
  });

  it('keeps it when a refresh failed after a good payload, so the last list stays reachable', () => {
    const refreshed: LoadState<OwnershipState> = { status: 'ready', data: ownership([COMPANY]), error: 'GET /api/ownership failed with HTTP 500: empty body', reload: () => undefined };
    expect(signInOffered(refreshed)).toBe(true);
  });
});
