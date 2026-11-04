import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planArtifact, type PlannedFile } from '../../apps/api/src/preview-plan';

/**
 * The preview planner against the **real** delivered artifact.
 *
 * `tests/unit/api/preview-plan.test.ts` pins the planner's rules on fixtures; this file pins the
 * one thing a fixture cannot: that the artifact this feature was built for — the tetris delivery
 * that a real workflow produced and that sits in `deliverables/` — is planned the way the feature
 * claims. It reads the delivered bytes rather than a transcription of them, so if the delivery
 * ever changes shape (a renamed entry point, a service that stops reading `PORT`, a health route
 * that moves) this test says so instead of the preview silently failing at runtime.
 *
 * It deliberately does not start anything: starting is the runtime's job and is verified against a
 * live process elsewhere.
 */

const DELIVERY = join('deliverables', 'ss-tetris');

/** Every delivered file under `directory`, as the planner sees it. */
function readDelivery(directory: string, root = directory): readonly PlannedFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry): PlannedFile[] => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return readDelivery(full, root);
    if (!entry.isFile()) return [];
    // The delivered source files are what a preview runs; a binary the artifact created on a
    // previous play (`data/scores.db`) is not part of the delivery's text.
    const relativePath = relative(root, full).replace(/\\/g, '/');
    if (/\.(db|sqlite|png|jpg|gif|ico|woff2?)$/i.test(relativePath)) return [];
    return [{ path: relativePath, content: readFileSync(full, 'utf8') }];
  });
}

describe('the real delivered tetris artifact', () => {
  it('exists with the six delivered files the delivery page shows', () => {
    const paths = readDelivery(DELIVERY).map((file) => file.path).sort();
    expect(paths).toEqual([
      'README.md',
      'client/README.md',
      'client/index.html',
      'run.py',
      'server/README.md',
      'server/app.py',
    ]);
    // The artifact is the real thing, not an empty scaffold: the SPA and the service have bodies.
    const spa = readDelivery(DELIVERY).find((file) => file.path === 'client/index.html');
    expect(spa?.content).toContain('<canvas id="board"');
    expect(spa?.content).toContain('maoehScore');
    expect(statSync(join(DELIVERY, 'server', 'app.py')).size).toBeGreaterThan(1000);
  });

  it('is planned as the Python service, on an injectable port, with the real health route', () => {
    const analysis = planArtifact(readDelivery(DELIVERY), 'Implementation');
    expect(analysis.reason).toBeNull();
    expect(analysis.plan).toEqual({
      plan: 'python-server',
      // The service is the entry point, not the launcher: `run.py` would start this same service
      // one process deeper and hide the port the preview needs to know about.
      entryPath: 'server/app.py',
      entryCommand: 'server/app.py',
      portMode: 'env',
      fixedPort: null,
      // Readiness is polled on the route the service itself declares, so `running` means the
      // API answers — not merely that something holds the port.
      readinessPath: '/api/health',
      launcherPath: 'run.py',
    });
    // The delivered name comes from the delivery's own README, never from a constant.
    expect(analysis.projectName).toBe('开发一个俄罗斯方块程序');
  });

  it('plans a delivery whose files are all there but in a different order identically', () => {
    const files = readDelivery(DELIVERY);
    expect(planArtifact([...files].reverse(), 'Implementation')).toEqual(planArtifact(files, 'Implementation'));
  });
});
