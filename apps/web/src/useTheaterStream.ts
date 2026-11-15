import { useEffect, useRef, useState } from 'react';
import { requestJson } from './api';
import {
  mergeTheaterEvents,
  parseTheaterEvent,
  parseTheaterHistory,
  type TheaterEvent,
} from './theater';

/**
 * M3.2 · the live theater feed.
 *
 * The hook is a cursor, not a chat client: it seeds from `/api/theater/history`, then opens an
 * `EventSource` at that `latestSeq`. Every delivered event advances the cursor; a dropped
 * connection reopens **from the cursor**, so a reconnect neither loses a fact nor shows one
 * twice (the merge also dedupes by seq, which covers the boundary event).
 *
 * `status` distinguishes the four things an operator needs to know: connecting, live,
 * reconnecting, offline. It is never inferred from animation — it follows the transport.
 */

export type TheaterStreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface TheaterStream {
  readonly events: readonly TheaterEvent[];
  readonly status: TheaterStreamStatus;
  readonly latestSeq: number;
}

interface TheaterStreamOptions {
  readonly companyId: string;
  readonly enabled?: boolean;
  readonly limit?: number;
}

export function useTheaterStream(options: TheaterStreamOptions): TheaterStream {
  const { companyId, enabled = true, limit = 400 } = options;
  const [events, setEvents] = useState<readonly TheaterEvent[]>([]);
  const [status, setStatus] = useState<TheaterStreamStatus>('connecting');
  const [latestSeq, setLatestSeq] = useState(0);
  const cursorRef = useRef(0);
  const sourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef<number | null>(null);
  const attemptRef = useRef(0);

  useEffect(() => {
    if (!enabled || companyId === '') return;
    let cancelled = false;

    setStatus('connecting');
    setEvents([]);
    cursorRef.current = 0;

    const scheduleReconnect = (): void => {
      if (cancelled) return;
      attemptRef.current = Math.min(attemptRef.current + 1, 5);
      const delay = Math.min(1000 * 2 ** (attemptRef.current - 1), 10000);
      retryRef.current = window.setTimeout(() => connect(), delay);
    };

    const connect = (): void => {
      if (cancelled) return;
      sourceRef.current?.close();
      const cursor = cursorRef.current;
      const query =
        cursor > 0
          ? `?cursor=${encodeURIComponent(String(cursor))}&company=${encodeURIComponent(companyId)}`
          : `?company=${encodeURIComponent(companyId)}`;
      const source = new EventSource(`/api/theater/stream${query}`);
      sourceRef.current = source;

      source.addEventListener('hello', (message: MessageEvent<string>) => {
        if (cancelled) return;
        attemptRef.current = 0;
        setStatus('live');
        try {
          const data = JSON.parse(message.data) as {
            cursor?: unknown;
            resync?: unknown;
          };
          if (data.resync === true) {
            // The log moved backwards (a restart): start clean at the server's head.
            setEvents([]);
            cursorRef.current = 0;
          }
          const serverCursor = typeof data.cursor === 'number' ? data.cursor : 0;
          cursorRef.current = Math.max(cursorRef.current, serverCursor);
          setLatestSeq((current) => Math.max(current, serverCursor));
        } catch {
          // A malformed hello does not poison the stream; the next event still works.
        }
      });

      source.addEventListener('theater', (message: MessageEvent<string>) => {
        if (cancelled) return;
        let event: TheaterEvent | null = null;
        try {
          event = parseTheaterEvent(JSON.parse(message.data) as unknown);
        } catch {
          event = null;
        }
        if (event === null) return;
        cursorRef.current = Math.max(cursorRef.current, event.seq);
        setLatestSeq((current) => Math.max(current, event.seq));
        setEvents((current) => mergeTheaterEvents(current, [event], limit));
      });

      source.addEventListener('reset', () => {
        if (cancelled) return;
        source.close();
        cursorRef.current = 0;
        setEvents([]);
        setStatus('reconnecting');
        connect();
      });

      source.onopen = () => {
        if (!cancelled) setStatus('live');
      };
      source.onerror = () => {
        if (cancelled) return;
        source.close();
        setStatus('reconnecting');
        scheduleReconnect();
      };
    };

    void (async () => {
      try {
        const raw = await requestJson('/api/theater/history?limit=200');
        if (cancelled) return;
        const history = parseTheaterHistory(raw);
        cursorRef.current = history.latestSeq;
        setLatestSeq(history.latestSeq);
        setEvents(mergeTheaterEvents([], history.events, limit));
        connect();
      } catch {
        // The live tail can still work without the seed; connecting with no cursor starts at the
        // server's newest event, so the operator sees new collaboration immediately.
        if (!cancelled) {
          setStatus('reconnecting');
          connect();
        }
      }
    })();

    return () => {
      cancelled = true;
      sourceRef.current?.close();
      sourceRef.current = null;
      if (retryRef.current !== null) window.clearTimeout(retryRef.current);
      retryRef.current = null;
    };
  }, [companyId, enabled, limit]);

  return { events, status, latestSeq };
}
