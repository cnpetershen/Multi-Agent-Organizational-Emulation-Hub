import { describe, expect, it } from 'vitest';
import { SNAPSHOT_ARRAY_FIELDS, snapshotContractViolation } from '../../apps/api/src/api-adapter';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M1.2-C regression: the snapshot the console parses is the snapshot the API serves.
 *
 * The console reads `positions`, `employees`, `agents`, `tasks`, `workflows`, `recentEvents`
 * and `recentAudits` out of one payload; when any of them is absent the contract check in
 * `apps/web/src/api.ts` throws (`snapshot.positions must be an array, received undefined`)
 * and every one of the eight pages goes down together. This test pins the server side of
 * that contract, so the field list cannot silently shrink again.
 */

function skeleton(): Record<string, unknown> {
  return Object.fromEntries(SNAPSHOT_ARRAY_FIELDS.map((field) => [field, [] as unknown[]]));
}

describe('M1.2-C regression: GET /api/snapshot satisfies the console contract', () => {
  it('serves every declared array field, positions included, over real HTTP', async () => {
    const server = await startApiServer(0, { tick: { activeIntervalMs: 5, idleIntervalMs: 50 }, eventLogPath: null });
    try {
      const response = await fetch(`http://127.0.0.1:${String(server.port)}/api/snapshot`);
      expect(response.status).toBe(200);
      const snapshot = (await response.json()) as Record<string, unknown>;

      expect(snapshotContractViolation(snapshot)).toBeNull();
      for (const field of SNAPSHOT_ARRAY_FIELDS) {
        expect(Array.isArray(snapshot[field]), `snapshot.${field} must be an array`).toBe(true);
      }

      // The field that broke the console is part of the contract itself, so it cannot be
      // dropped from `SNAPSHOT_ARRAY_FIELDS` without this test failing.
      expect(SNAPSHOT_ARRAY_FIELDS).toContain('positions');
      const positions = snapshot['positions'] as readonly Record<string, unknown>[];
      expect(positions.length).toBeGreaterThan(0);
      const unstaffed = positions.find((position) => position['positionId'] === 'backend-engineer');
      expect(unstaffed, 'the unstaffed backend-engineer position must be in the snapshot').toBeDefined();
      expect(unstaffed?.['employeeIds']).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('rejects a snapshot that drops any single array field, naming the path', () => {
    expect(snapshotContractViolation(skeleton())).toBeNull();
    for (const field of SNAPSHOT_ARRAY_FIELDS) {
      const broken = skeleton();
      delete broken[field];
      expect(snapshotContractViolation(broken), `snapshot.${field} must be rejected`).toBe(
        `snapshot.${field} must be an array, received undefined`,
      );
    }
    expect(snapshotContractViolation({ ...skeleton(), positions: undefined })).toBe(
      'snapshot.positions must be an array, received undefined',
    );
    expect(snapshotContractViolation({ ...skeleton(), positions: {} })).toBe(
      'snapshot.positions must be an array, received object',
    );
    expect(snapshotContractViolation([])).toBe('snapshot must be an object');
  });
});
