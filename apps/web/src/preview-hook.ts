import { useCallback, useEffect, useRef, useState } from 'react';
import { messageOf, requestJson } from './api';
import { parsePreviewStatus, previewPath, type PreviewStatus } from './preview';

/**
 * The one piece of the run-preview feature that *does* something: it talks to the preview
 * runtime and holds the state the panel renders.
 *
 * It is a hook rather than part of the component because the interesting behaviour is a small
 * state machine, and because the component that renders it must keep its own hooks above its
 * early return (see `tests/unit/web/hook-order.test.ts`):
 *
 * - **Read once on mount**, then re-read whenever the console's own refresh tick or task changes.
 * - **Auto-start once per task.** A delivery that *can* run should already be running when the
 *   owner opens the page — that is the whole point of the panel. The `autoStarted` ref makes that
 *   a one-shot per task, so the "stopped → start → starting" cycle can never loop.
 * - **Poll only while booting.** `starting` is the only state the console cannot learn about by
 *   waiting for the next console refresh, so it polls that one state every `PREVIEW_POLL_MS` and
 *   stops the moment the runtime answers `running`, `failed` or `stopped`. The timer is cleared on
 *   unmount and when the task changes.
 * - **停止 is a decision.** Once the operator stops a preview it stays stopped: `stoppedByUser`
 *   outlives every later poll and refresh, and only an explicit 启动/重新运行 clears it.
 *
 * Nothing here fabricates a status: an unreadable preview keeps the last good answer and reports
 * why, and a `404` (the delivery is not runnable, or the runtime does not know it) is the same
 * statement as `available: false` — the page renders no panel.
 */

/** How often a booting preview is re-read. Fast enough to feel live, slow enough to be a read. */
export const PREVIEW_POLL_MS = 700;

export interface PreviewController {
  /** The last status read from the runtime, or `null` while nothing is known about this task. */
  readonly status: PreviewStatus | null;
  /** A start/stop command is in flight — the buttons wait for it. */
  readonly busy: boolean;
  /** Why the preview could not be read or commanded, or `null`. */
  readonly error: string | null;
  readonly start: () => void;
  readonly stop: () => void;
  /** Start again: the runtime stops the old process and brings a fresh one up. */
  readonly rerun: () => void;
  /** Re-read the status now (the retry affordance). */
  readonly reload: () => void;
}

/** `404` is how the API says "no preview for this task"; the API layer keeps the status in prose. */
function isMissingPreview(message: string): boolean {
  return message.includes('HTTP 404');
}

export function usePreview(taskId: string, refreshToken: number): PreviewController {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  // Every request tags itself; only the newest tag may write state, so a slow reply for an older
  // task (or one overtaken by a command) can never land on the current one.
  const ticket = useRef(0);
  const autoStarted = useRef(false);
  const stoppedByUser = useRef(false);

  // A new task starts with a clean slate: the previous task's one-shot flags must not leak.
  useEffect(() => {
    autoStarted.current = false;
    stoppedByUser.current = false;
  }, [taskId]);

  // Unmount invalidates everything still in flight.
  useEffect(() => () => {
    ticket.current += 1;
  }, []);

  const load = useCallback(async (): Promise<void> => {
    ticket.current += 1;
    const mine = ticket.current;
    try {
      const payload = await requestJson(previewPath(taskId));
      if (mine !== ticket.current) return;
      setStatus(parsePreviewStatus(payload, `GET ${previewPath(taskId)}`));
      setError(null);
    } catch (cause) {
      if (mine !== ticket.current) return;
      const message = messageOf(cause);
      if (isMissingPreview(message)) {
        setStatus(null);
        setError(null);
        return;
      }
      // A failed read keeps the last good status on screen and reports why, like `useJson`.
      setError(message);
    }
  }, [taskId]);

  const command = useCallback(
    async (action: 'start' | 'stop'): Promise<void> => {
      const path = `${previewPath(taskId)}/${action}`;
      setBusy(true);
      ticket.current += 1;
      const mine = ticket.current;
      try {
        const payload = await requestJson(path, { method: 'POST' });
        if (mine !== ticket.current) return;
        setStatus(parsePreviewStatus(payload, `POST ${path}`));
        setError(null);
      } catch (cause) {
        if (mine !== ticket.current) return;
        setError(messageOf(cause));
      } finally {
        setBusy(false);
      }
    },
    [taskId],
  );

  useEffect(() => {
    void load();
  }, [load, refreshToken, nonce]);

  // The one automatic start per task. Any later `stopped` answer is read as a decision, not as an
  // instruction to try again — otherwise a project that refuses to boot would restart forever.
  useEffect(() => {
    if (status === null || !status.available || status.state !== 'stopped') return;
    if (autoStarted.current || stoppedByUser.current) return;
    autoStarted.current = true;
    void command('start');
  }, [status, command]);

  const starting = status !== null && status.state === 'starting';
  useEffect(() => {
    if (!starting) return;
    const timer = setInterval(() => {
      void load();
    }, PREVIEW_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [starting, load]);

  const run = useCallback((): void => {
    autoStarted.current = true;
    stoppedByUser.current = false;
    void command('start');
  }, [command]);

  const stop = useCallback((): void => {
    stoppedByUser.current = true;
    void command('stop');
  }, [command]);

  const reload = useCallback((): void => {
    setNonce((value) => value + 1);
  }, []);

  return { status, busy, error, start: run, rerun: run, reload, stop };
}
