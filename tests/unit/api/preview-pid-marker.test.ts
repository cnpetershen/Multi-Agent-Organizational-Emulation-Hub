import { describe, expect, it } from 'vitest';
import { markedPid } from '../../../apps/api/src/preview-runtime';

/**
 * The pid marker beside a preview decides what the *next* runtime kills.
 *
 * The bug this pins: the marker was written with `process.pid` — the API server's own pid — so the
 * orphan reaper executed `taskkill /T /F` on the API itself. Signing in to another company builds a
 * new `PreviewRuntime` (`switchCompany` → `createPreviewApi` → constructor → `reapOrphans`), so the
 * founder's own Sign in click took the whole API down whenever a preview directory existed. The
 * console then read an empty-body `500` from its dev proxy and reported "the company list is
 * unavailable" with the Sign in button hidden — the report this fix came from.
 *
 * `markedPid` is the single place that decides, so the decision is pinned here without spawning
 * anything: a marker names a process to kill, this process (which must never be signalled), or
 * nothing usable at all.
 */
describe('preview pid marker: what the orphan reaper may signal', () => {
  it('names the preview process the marker points at', () => {
    expect(markedPid('4321')).toBe(4321);
    expect(markedPid('  4321\n')).toBe(4321);
  });

  it('never signals this process, even when a marker names it', () => {
    expect(markedPid(String(process.pid))).toBe('self');
    expect(markedPid(` ${String(process.pid)} `)).toBe('self');
  });

  it('reports an unusable marker as "nothing to kill" instead of guessing', () => {
    for (const marker of ['', '   ', 'not-a-pid', '0', '-7', '12.5', 'NaN']) {
      expect(markedPid(marker), marker).toBeNull();
    }
  });
});
