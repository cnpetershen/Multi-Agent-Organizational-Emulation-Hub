import { describe, expect, it } from 'vitest';
import type { ControlCommand } from '@maoeh/organization-control';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M1.4 Â§5.7 / Â§5.10 acceptance 3 over the real HTTP surface the console talks to:
 *
 *   POST /api/command Work.SubmitBrief â†?`GET /api/work-briefs` carries the brief (empty
 *   decomposition while the runtime is held), `GET /api/work-briefs/:briefId` serves the same
 *   record, an unknown id answers the 404 shape the console already parses â€?and once the
 *   simulation resumes, the composed cognition turns the brief into a capability-routed
 *   workflow whose work items the brief panel groups under the same brief (Â§5.4).
 *
 * The decomposition is **capability routing**, not a fixed pair of seats: the brief's goal text
 * is analysed into the kinds of work it needs and the kernel resolves each one to a staffed
 * seat. "Ship the login feature this sprint" carries no build/design/test cue in any language,
 * so it falls back to the core delivery chain â€?requirements â†?design â†?implementation â†? * testing â€?and this company (the `lab` seed) staffs one seat per link of that chain.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  read: () => Promise<T | null>,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

type Json = Readonly<Record<string, unknown>>;

function viewOf(value: unknown): Json {
  return (typeof value === 'object' && value !== null ? value : {}) as Json;
}

function rowsOf(value: unknown): readonly Json[] {
  return Array.isArray(value)
    ? value.map((entry) => viewOf(entry))
    : [];
}

interface BriefRow {
  readonly briefId: string;
  readonly title: string;
  readonly goal: string;
  readonly verificationKeys: readonly string[];
  readonly counts: Readonly<Record<string, number>>;
  readonly items: readonly Json[];
}

function briefOf(value: unknown): BriefRow {
  const row = viewOf(value);
  const counts = viewOf(row['counts']);
  return {
    briefId: String(row['briefId'] ?? ''),
    title: String(row['title'] ?? ''),
    goal: String(row['goal'] ?? ''),
    verificationKeys: Array.isArray(row['verificationKeys'])
      ? row['verificationKeys'].map((entry) => String(entry))
      : [],
    counts: {
      total: Number(counts['total'] ?? -1),
      assigned: Number(counts['assigned'] ?? -1),
    },
    items: rowsOf(row['items']),
  };
}

describe('M1.4 work briefs over HTTP', () => {
  it('serves a submitted brief as list and record, then shows its decomposition', async () => {
    const server = await startApiServer(0, { requirePlanConfirmation: false, 
      eventLogPath: null,
      tick: { activeIntervalMs: 5, idleIntervalMs: 50 },
    });
    const base = `http://127.0.0.1:${String(server.port)}/api`;
    const get = async (path: string): Promise<Response> =>
      fetch(`${base}${path}`, { headers: { connection: 'close' } });
    const post = async (command: ControlCommand): Promise<Json> =>
      viewOf(
        await (
          await fetch(`${base}/command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', connection: 'close' },
            body: JSON.stringify(command),
          })
        ).json(),
      );
    const operatorCommand = (
      commandId: string,
      commandType: ControlCommand['commandType'],
      overrides: Readonly<Record<string, unknown>> = {},
    ): ControlCommand =>
      ({
        commandId,
        commandType,
        actor: { operatorId: 'ceo-alex', displayName: 'Alex', positionId: 'ceo', kind: 'human' },
        target: commandType.startsWith('Simulation.')
          ? { targetType: 'simulation', targetId: 'future-ai-lab' }
          : { targetType: 'agent', targetId: 'ceo-alex' },
        reason: 'M1.4 work brief over HTTP',
        correlationId: commandId,
        causationId: null,
        createdAtSim: 0,
        ...overrides,
      }) as ControlCommand;
    try {
      // Hold the runtime first: "the brief exists but nothing has been dispatched into it yet"
      // must be a stable observation, not a race against the next tick.
      const held = await post(operatorCommand('cmd-m14-brief-hold', 'Simulation.Pause'));
      expect(String(held['status']), JSON.stringify(held['failure'])).toBe('accepted');

      const submitted = await post(
        operatorCommand('cmd-m14-brief-1', 'Work.SubmitBrief', {
          workBrief: {
            title: 'Login feature',
            goal: 'Ship the login feature this sprint',
            context: 'Handed over by the board.',
            verificationKeys: ['endpoint', 'test-report'],
            priority: 2,
            dueAtSim: 600,
          },
        }),
      );
      expect(String(submitted['status']), JSON.stringify(submitted['failure'])).toBe('accepted');

      // 1. The list route answers with the brief envelope the console panel reads.
      const list = viewOf(await (await get('/work-briefs')).json());
      const briefs = rowsOf(list['briefs']);
      expect(briefs, 'GET /api/work-briefs must list the submitted brief').toHaveLength(1);
      const submittedBrief = briefOf(briefs[0]);
      expect(submittedBrief.briefId).toMatch(/^brief-\d+$/);
      expect(submittedBrief.title).toBe('Login feature');
      expect(submittedBrief.goal).toBe('Ship the login feature this sprint');
      expect(submittedBrief.verificationKeys).toEqual(['endpoint', 'test-report']);
      // Nothing has ticked yet, so the decomposition is honestly empty.
      expect(submittedBrief.counts.total).toBe(0);
      expect(submittedBrief.items).toEqual([]);

      // 2. The by-id record is the same brief the list carries.
      const detail = await get(`/work-briefs/${submittedBrief.briefId}`);
      expect(detail.status).toBe(200);
      expect(briefOf(await detail.json())).toEqual(submittedBrief);

      // 3. An unknown id is a 404 in the shape the console already renders.
      const missing = await get('/work-briefs/brief-unknown');
      expect(missing.status).toBe(404);
      expect(String(viewOf(await missing.json())['error'])).toContain('unknown work brief');

      // 4. Release the runtime: the briefed CEO turns the brief into capability-routed work,
      //    and the read model groups those work items under the same brief (Â§5.4).
      const resumed = await post(operatorCommand('cmd-m14-brief-resume', 'Simulation.Resume'));
      expect(String(resumed['status']), JSON.stringify(resumed['failure'])).toBe('accepted');

      const decomposed = await waitFor(async () => {
        const record = briefOf(await (await get(`/work-briefs/${submittedBrief.briefId}`)).json());
        // The vague goal resolves to the four-link core delivery chain, and every link is
        // staffed in this company, so four work items is the complete decomposition.
        return record.counts.total === 4 ? record : null;
      }, 'the brief to be decomposed into its capability work items');

      expect(decomposed.items).toHaveLength(4);
      // One item per capability, each on a *different* staffed seat: the CEO composes this plan
      // and is not one of its assignees, and no item lands on an empty seat.
      const seats = decomposed.items.map((item) => String(item['positionId'] ?? ''));
      expect(new Set(seats).size, 'one brief, one distinct seat per capability').toBe(4);
      expect(seats).not.toContain('ceo');
      for (const item of decomposed.items) {
        // Every dispatched item must have an owner who can execute it â€?a seat nobody holds is
        // work that would sit `assigned` forever (see `starter-company-brief.test.ts`).
        expect(String(item['assigneeEmployeeId'] ?? '')).not.toBe('');
      }

      const listAfter = briefOf(
        rowsOf(viewOf(await (await get('/work-briefs')).json())['briefs'])[0],
      );
      expect(listAfter.counts.total).toBe(4);
      expect(listAfter.items.map((item) => String(item['positionId'] ?? ''))).toEqual(seats);
    } finally {
      await server.close();
    }
  });
});

