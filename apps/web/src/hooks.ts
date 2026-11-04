import { useEffect, useRef, useState } from 'react';
import { messageOf, requestJson } from './api';

export interface LoadState<T> {
  readonly status: 'loading' | 'ready' | 'failed';
  readonly data: T | null;
  readonly error: string | null;
  readonly reload: () => void;
}

/**
 * Fetch one endpoint and keep the contract check in front of React.
 *
 * `refreshToken` is the console's poll tick: while the runtime advances on its own the
 * page re-reads the same URL instead of inventing a second transport (no WebSocket, no
 * client-side state that could drift from the API). A failed refresh keeps the last good
 * payload on screen and reports why, so a transient error never blanks the console.
 */
export function useJson<T>(
  path: string,
  parse: (payload: unknown, path: string) => T,
  refreshToken: number,
): LoadState<T> {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'failed'; data: T | null; error: string | null }>({
    status: 'loading',
    data: null,
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const parseRef = useRef(parse);
  parseRef.current = parse;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await requestJson(path);
        if (cancelled) return;
        setState({ status: 'ready', data: parseRef.current(payload, path), error: null });
      } catch (cause) {
        if (cancelled) return;
        setState((previous) => ({
          status: previous.data === null ? 'failed' : 'ready',
          data: previous.data,
          error: messageOf(cause),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, refreshToken, nonce]);

  return { ...state, reload: () => setNonce((value) => value + 1) };
}
