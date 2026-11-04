import { describe, expect, it } from 'vitest';
import type { ControlCommand } from '@maoeh/organization-control';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M1.4 Deliverables over HTTP: the one-task read the result view renders.
 *
 * The workspace list comes from `GET /api/snapshot`; opening a task issues
 * `GET /api/tasks/:id`, which is the only place the submitted delivery is served. This test
 * walks the real chain — inject the task, let the assigned agent actually submit it, then read
 * the record back — so the console renders a delivery the organization produced, not a mock.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(read: () => Promise<T | null>, label: string, timeoutMs = 30_000): Promise<T> {
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

describe('M1.4 deliverable read over HTTP', () => {
  it('serves the submitted result of one task and reports an unknown task as 404', async () => {
    const server = await startApiServer(0, {
      tick: { activeIntervalMs: 5, idleIntervalMs: 50 },
      eventLogPath: null,
    });
    const base = `http://127.0.0.1:${String(server.port)}/api`;
    const get = async (path: string): Promise<Response> => fetch(`${base}${path}`, { headers: { connection: 'close' } });
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
        target: { targetType: 'simulation', targetId: 'future-ai-lab' },
        reason: 'M1.4 deliverable read verification',
        correlationId: commandId,
        causationId: null,
        createdAtSim: 0,
        ...overrides,
      }) as ControlCommand;
    try {
      // Hold the runtime first, so "the task exists but nobody delivered into it yet" is a
      // stable observation instead of a race against the agent's next tick.
      const held = await post(operatorCommand('cmd-m14-hold', 'Simulation.Pause'));
      expect(String(held['status']), JSON.stringify(held['failure'])).toBe('accepted');

      const accepted = await post(
        operatorCommand('cmd-m14-inject', 'Organization.InjectTask', {
          target: { targetType: 'organization', targetId: 'future-ai-lab' },
          positionId: 'ceo',
          title: 'Quantify Q3 churn',
          goal: 'Publish the churn driver table with sources',
        }),
      );
      expect(String(accepted['status']), JSON.stringify(accepted['failure'])).toBe('accepted');

      // The workspace shows the injected task immediately, before anything is delivered.
      const taskId = await waitFor(async () => {
        const tasks = (await (await get('/tasks')).json()) as readonly Json[];
        const injected = tasks.find((task) => task['title'] === 'Quantify Q3 churn');
        return injected === undefined ? null : String(injected['taskId']);
      }, 'the injected task in GET /api/tasks');

      const undelivered = viewOf(await (await get(`/tasks/${taskId}`)).json());
      expect(undelivered['goal']).toBe('Publish the churn driver table with sources');
      expect(undelivered['result']).toBeNull();

      // Release the runtime: the assigned agent (deterministic cognition) accepts, starts and
      // submits the task, and the record starts carrying a real delivery.
      const resumed = await post(operatorCommand('cmd-m14-resume', 'Simulation.Resume'));
      expect(String(resumed['status']), JSON.stringify(resumed['failure'])).toBe('accepted');

      const delivered = await waitFor(async () => {
        const record = viewOf(await (await get(`/tasks/${taskId}`)).json());
        return record['result'] === null ? null : record;
      }, 'the submitted task result');

      expect(delivered['taskId']).toBe(taskId);
      // The organization may also accept the delivery (review → complete) before this read;
      // either way the record carries the submitted work product.
      expect(['submitted', 'completed']).toContain(delivered['status']);
      const result = viewOf(delivered['result']);
      // The record carries the executor's own work product for *this* task, not one constant
      // shared by every task in the company: the summary, the delivered content and the attached
      // files all name the goal the executor was handed.
      expect(String(result['summary'])).toContain('Publish the churn driver table with sources');
      expect(result['producedBy']).toBe('ceo-alex');
      const data = viewOf(result['data']);
      expect(Object.keys(data).length).toBeGreaterThan(0);
      expect(JSON.stringify(data)).toContain('Publish the churn driver table with sources');
      const artifacts = result['artifacts'] as readonly string[];
      expect(Array.isArray(artifacts)).toBe(true);
      expect(artifacts.length).toBeGreaterThan(0);

      const missing = await get('/tasks/task-unknown');
      expect(missing.status).toBe(404);
      expect(String(viewOf(await missing.json())['error'])).toContain('unknown task');
    } finally {
      await server.close();
    }
  });
});
