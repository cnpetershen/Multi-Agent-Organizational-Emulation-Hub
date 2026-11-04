/**
 * M1.5: the console sits behind the "Create Your AI Company" gate.
 *
 * Every e2e script loads the console with a fresh browser profile, so it lands on the gate
 * instead of the shell. Entering is two clicks: sign in (the default `Future AI Lab` already
 * exists, so "Sign in" is a real destination) and pick that company. The gate then stores the
 * session in `localStorage`, which is exactly the path a returning founder takes.
 *
 * Shared by the scripts under `tests/e2e`; the vitest config excludes this directory, so it
 * never runs inside `pnpm test`.
 */

/** @param {{ waitFor: (expression: string, label: string) => Promise<void>, evaluate: (expression: string) => Promise<unknown> }} cdp */
export async function enterConsole(cdp) {
  await cdp.waitFor(
    `document.querySelector('[data-testid="foundry-signin"]') !== null`,
    'the Create Your AI Company gate',
  );
  await cdp.evaluate(
    `(() => { const button = document.querySelector('[data-testid="foundry-signin"]'); if (!button) return false; button.click(); return true; })()`,
  );
  await cdp.waitFor(
    `document.querySelector('[data-testid="foundry-company"]') !== null`,
    'the company list',
  );
  await cdp.evaluate(
    `(() => { const button = document.querySelector('[data-testid="foundry-company"]'); if (!button) return false; button.click(); return true; })()`,
  );
}
