import { useCallback, useEffect, useState } from 'react';

/**
 * Console routing.
 *
 * The console is a single-page app with exactly one deep-linkable destination: a delivered
 * result (`/results/:taskId`). Everything else is the shell's own state, so there is no router
 * dependency here — one History API read, one listener, one push helper.
 *
 * Two rules keep it honest:
 * - `parseRoute` is pure and touches no browser global, so the path contract is unit-tested in
 *   a node environment instead of through a render.
 * - Pushing a path that is already current does not grow the history stack: navigating to the
 *   page you are on is a no-op, not a second back-button stop.
 */

export type Route =
  | { readonly kind: 'console' }
  | { readonly kind: 'results'; readonly taskId: string };

/** The one deep link the console owns: a delivered result. */
export const RESULTS_ROUTE = '/results';

/** The path of one task's delivery page — the id is encoded, never pasted in raw. */
export function resultsPath(taskId: string): string {
  return `${RESULTS_ROUTE}/${encodeURIComponent(taskId)}`;
}

/**
 * Resolve a pathname to the route it addresses. Anything that is not a well-formed
 * `/results/:taskId` — including `/results/` with nothing after it — is the console, so a
 * mistyped link lands on a working shell instead of an error page.
 */
export function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '');
  if (!path.startsWith(`${RESULTS_ROUTE}/`)) return { kind: 'console' };
  let taskId: string;
  try {
    taskId = decodeURIComponent(path.slice(RESULTS_ROUTE.length + 1)).trim();
  } catch {
    return { kind: 'console' };
  }
  return taskId === '' ? { kind: 'console' } : { kind: 'results', taskId };
}

export interface Router {
  readonly route: Route;
  /** Move to a path, keeping the history stack honest about what actually changed. */
  readonly push: (path: string) => void;
}

/** Subscribe the shell to the URL: the initial path, then every back/forward navigation. */
export function useRoute(): Router {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPopState = (): void => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const push = useCallback((path: string): void => {
    const next = parseRoute(path);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    setRoute(next);
  }, []);

  return { route, push };
}
