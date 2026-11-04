import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PreviewRuntime, type PreviewRecipe, type PreviewTaskReader } from '../../apps/api/src/preview-runtime';

/**
 * The pid marker on disk, against a real preview process.
 *
 * The unit test pins the *decision* (`markedPid`); this one pins what actually gets written and
 * what the runtime does with it, because the defect was a write, not a rule: `materialize` stamped
 * `process.pid` into every working directory, so the next `PreviewRuntime` — one is built by every
 * company switch — read its own API pid back and killed the API with it. `start()` must therefore
 * leave the *child's* pid behind, and the page it protects must really answer.
 *
 * The static plan gets its own case: the planner promises "a single page under any name", but the
 * generated server resolved `/` to a root `index.html`, so a delivery whose page lives in
 * `client/` (which is where this platform's own deliveries put it) could never become ready.
 */

/** Does this host let `killTree` actually kill? (A confined session denies taskkill.) */
function killPrimitiveWorks(): boolean {
  const sleeper: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const result = spawnSync('taskkill', ['/pid', String(sleeper.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 3_000 });
  let alive = true;
  try {
    process.kill(Number(sleeper.pid), 0);
  } catch {
    alive = false;
  }
  if (alive) {
    try {
      process.kill(Number(sleeper.pid), 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return !alive && result.status === 0;
}

const canKill = process.platform === 'win32' ? killPrimitiveWorks() : true;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function workspace(name: string): { root: string; dispose: () => void } {
  const root = mkdtempSync(join(tmpdir(), `maoeh-pid-marker-${name}-`));
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function readerFor(taskId: string, files: PreviewRecipe['files']): PreviewTaskReader {
  return { getPreviewRecipe: async (id) => (id === taskId ? { files, title: 'probe', taskId, sources: [{ taskId, title: 'probe', files: files.length }], skipped: [] } : null) };
}

const PAGE = '<!doctype html><title>probe</title><h1>served</h1>';

describe('preview pid marker: the marker names the preview, never the API', () => {
  it('leaves the preview child in the marker and kills exactly that process on stop', async () => {
    const space = workspace('child');
    const taskId = 'task-marker';
    const runtime = new PreviewRuntime(readerFor(taskId, [{ path: 'index.html', language: 'html', content: PAGE }]), {
      workspaceRoot: space.root,
      readyTimeoutMs: 20_000,
      reapIntervalMs: 0,
    });
    try {
      const status = await runtime.start(taskId);
      expect(status.state).toBe('running');
      if (status.state !== 'running') throw new Error(`expected a running preview, got ${status.state}: ${String(status.error)}`);

      const markerPath = join(space.root, '.maoeh', 'preview', taskId, 'preview.pid');
      const marked = Number(readFileSync(markerPath, 'utf8').trim());
      // The defect in one line: the API's own pid is what made the orphan reaper terminate it.
      expect(marked).not.toBe(process.pid);
      expect(marked).toBeGreaterThan(0);
      // A marker that names the preview is worth having: the process it names is really running.
      expect(isAlive(marked)).toBe(true);
      const served = await fetch(status.previewUrl);
      expect(served.status).toBe(200);
      expect(await served.text()).toContain('served');

      await runtime.dispose();
      // On POSIX a signalled pid can linger as a zombie until this process reaps it on the
      // event loop; poll instead of asserting one synchronous check, which can observe the
      // zombie as alive on Linux CI.
      const goneDeadline = Date.now() + 5_000;
      while (isAlive(marked) && Date.now() < goneDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (canKill) expect(isAlive(marked)).toBe(false);
    } finally {
      await runtime.dispose();
      space.dispose();
    }
  }, 60_000);

  it('serves a single delivered page that lives in a subdirectory at /', async () => {
    const space = workspace('subdir');
    const taskId = 'task-subdir';
    const runtime = new PreviewRuntime(
      readerFor(taskId, [
        { path: 'client/index.html', language: 'html', content: PAGE },
        { path: 'README.md', language: 'markdown', content: '# probe' },
      ]),
      { workspaceRoot: space.root, readyTimeoutMs: 20_000, reapIntervalMs: 0 },
    );
    try {
      const status = await runtime.start(taskId);
      expect(status.plan).toBe('static');
      if (status.state !== 'running') throw new Error(`expected a running preview, got ${status.state}: ${String(status.error)}`);
      const response = await fetch(status.previewUrl);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('served');
    } finally {
      await runtime.dispose();
      space.dispose();
    }
  }, 60_000);
});
