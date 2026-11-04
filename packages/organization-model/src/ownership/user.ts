import type { UserId } from '@maoeh/shared-types';

/**
 * A founder: the human who owns an AI company (M1.5 `User owns Organization`).
 *
 * Identity is a name and an id — deliberately *not* an account. There is no password, no
 * credential and no permission attached to a `User`: ownership answers "whose company is
 * this?", which is a product fact, not an authentication decision (M1.5 scope: no login
 * system, no multi-tenant authorization).
 */
export interface User {
  readonly id: UserId;
  readonly name: string;
}
