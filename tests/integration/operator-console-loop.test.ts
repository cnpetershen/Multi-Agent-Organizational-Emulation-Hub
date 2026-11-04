import { describe, expect, it } from 'vitest';
import type { ControlCommand } from '@maoeh/organization-control';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M1.2-C: the operator loop, over the same HTTP surface the console uses.
 *
 *   Hold the runtime -> brief the CEO -> the company plans -> the approval gate stops for
 *   the human -> the human decides -> the runtime continues -> the work completes.
 *
 * Nothing here is simulated in the test: every step is a real `POST /api/command` against
 * the composed runtime, and every observation is a real `GET` the console renders.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

let commandSeq = 0;
function operatorCommand(
  commandType: ControlCommand['commandType'],
  overrides: Readonly<Record<string, unknown>> = {},
): ControlCommand {
  commandSeq += 1;
  const commandId = `cmd-m12c-${String(commandSeq)}`;
  return {
    commandId,
    commandType,
    actor: { operatorId: 'ceo-alex', displayName: 'Alex', positionId: 'ceo', kind: 'human' },
    target: { targetType: 'simulation', targetId: 'future-ai-lab' },
    reason: 'M1.2-C operator loop verification',
    correlationId: commandId,
    causationId: null,
    createdAtSim: 0,
    ...overrides,
  } as ControlCommand;
}

type Json = Readonly<Record<string, unknown>>;

function viewOf(value: unknown): Json {
  return (typeof value === 'object' && value !== null ? value : {}) as Json;
}

describe('M1.2-C: an operator can run the company through the console API', () => {
  it('holds the runtime, surfaces the approval gate, decides it and reaches completion', async () => {
    const server = await startApiServer(0, { tick: { activeIntervalMs: 5, idleIntervalMs: 50 }, eventLogPath: null });
    const base = `http://127.0.0.1:${String(server.port)}/api`;
    const get = async <T>(path: string): Promise<T> =>
      (await (await fetch(`${base}${path}`, { headers: { connection: 'close' } })).json()) as T;
    const post = async (command: ControlCommand): Promise<Json> => {
      const response = await fetch(`${base}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify(command),
      });
      expect(response.status).toBe(200);
      return viewOf(await response.json());
    };
    const expectAccepted = async (command: ControlCommand): Promise<void> => {
      const outcome = await post(command);
      expect(String(outcome['status']), JSON.stringify(outcome['failure'])).toBe('accepted');
      expect(String(outcome['commandType'])).toBe(command.commandType);
    };

    try {
      // The console builds its organization chart and task form from the snapshot, so the
      // positions (including the ones nobody staffs) have to be part of that payload.
      const snapshot = viewOf(await get<unknown>('/snapshot'));
      const positions = (snapshot['positions'] as readonly Json[] | undefined) ?? [];
      expect(positions.length).toBeGreaterThan(0);
      const qa = positions.find((position) => position['positionId'] === 'backend-engineer');
      expect(qa, 'the unstaffed backend-engineer position must be visible to the console').toBeDefined();
      expect((qa?.['employeeIds'] as readonly unknown[] | undefined) ?? []).toEqual([]);

      // 1. Hold the runtime — the console's "let me decide approval gates" checkbox.
      await expectAccepted(operatorCommand('Simulation.Pause'));
      expect((await get<Json>('/simulation'))['paused']).toBe(true);

      // 2. Start Work: the human briefs the CEO; the CEO decides how to break it down.
      await expectAccepted(
        operatorCommand('Agent.Instruct', {
          target: { targetType: 'agent', targetId: 'ceo-alex' },
          instruction: 'Own the churn problem and drive it to a decision.',
        }),
      );

      // 3. Walk the company forward until the CEO's own intake task is done.
      const workflows = async (): Promise<readonly Json[]> => get<readonly Json[]>('/workflows');
      const detail = async (): Promise<Json | undefined> =>
        (await workflows()).find((workflow) => workflow['status'] !== 'completed');
      const gateOf = (workflow: Json | undefined): Json | null => {
        const approval = workflow?.['approval'];
        return typeof approval === 'object' && approval !== null && approval['status'] === 'open'
          ? viewOf(approval)
          : null;
      };
      const stepUntil = async (label: string, reached: (workflow: Json | undefined) => boolean): Promise<void> => {
        const deadline = Date.now() + 30_000;
        for (;;) {
          const current = await detail();
          if (reached(current)) return;
          if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${label}; workflows=${JSON.stringify(await workflows())}`);
          }
          await expectAccepted(operatorCommand('Simulation.Step'));
        }
      };

      await stepUntil('the intake stage to finish while the runtime is held', (workflow) => {
        if (workflow === undefined) return false;
        return workflow['stageId'] === 'design' || gateOf(workflow) !== null;
      });

      // 4. Hold the approver so the gate waits for the human instead of auto-resolving.
      await expectAccepted(
        operatorCommand('Agent.Pause', {
          target: { targetType: 'agent', targetId: 'ceo-alex' },
        }),
      );

      // 5. Step until the engine opens the approval gate.
      let gate: Json | undefined;
      await stepUntil('the approval gate to open', (workflow) => {
        if (workflow === undefined || gateOf(workflow) === null) return false;
        gate = workflow;
        return true;
      });
      expect(gate, 'a gate must be waiting for the operator').toBeDefined();
      // The detail view the console renders: objective, step progress, gate state.
      expect(String(gate?.['goal'])).toContain('churn');
      expect(Array.isArray(gate?.['stepStates'])).toBe(true);
      expect((gate?.['stepStates'] as readonly Json[]).length).toBeGreaterThan(0);
      // The audit-derived pending list stays empty: gates are read from workflow state.
      expect((await get<Json>('/approvals'))['pending']).toEqual([]);

      // 6. The human decides — the runtime is still held, so nothing outraces the click.
      const instanceId = String(gate?.['instanceId']);
      await expectAccepted(
        operatorCommand('Workflow.Approve', {
          target: { targetType: 'workflow', targetId: instanceId },
          reason: 'approved by the operator from the console',
        }),
      );

      const events = await get<readonly Json[]>('/events?limit=200');
      const granted = events.find((event) => event['type'] === 'Workflow.ApprovalGranted');
      expect(granted, 'the human decision must be recorded in the event log').toBeDefined();
      expect(String(viewOf(granted?.['payload'])['decidedBy'])).toBe('ceo-alex');

      // 7. Release the hold: the company continues and finishes the work.
      await expectAccepted(
        operatorCommand('Agent.Resume', {
          target: { targetType: 'agent', targetId: 'ceo-alex' },
        }),
      );
      await expectAccepted(operatorCommand('Simulation.Resume'));
      expect((await get<Json>('/simulation'))['paused']).toBe(false);

      await waitFor(
        async () => (await workflows()).some((workflow) => workflow['status'] === 'completed'),
        'the workflow to complete after the human decision',
      );

      const tasks = await get<readonly Json[]>('/tasks');
      expect(tasks.filter((task) => task['status'] === 'completed').length).toBeGreaterThanOrEqual(3);

      // Nothing was lost by pausing: every agent cycle that ran, ran without failing.
      const cycles = events
        .filter((event) => event['type'] === 'Runtime.CycleFinished')
        .map((event) => viewOf(event['payload']));
      expect(
        cycles.filter((cycle) => cycle['failureCode'] !== null && cycle['failureCode'] !== undefined),
        'no cycle may fail during the operator loop',
      ).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('injects a task to an unstaffed position and reports it as waiting for assignment', async () => {
    const server = await startApiServer(0, { tick: { activeIntervalMs: 5, idleIntervalMs: 50 }, eventLogPath: null });
    const base = `http://127.0.0.1:${String(server.port)}/api`;
    try {
      const outcome = viewOf(
        await (
          await fetch(`${base}/command`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', connection: 'close' },
            body: JSON.stringify(
              operatorCommand('Organization.InjectTask', {
                target: { targetType: 'organization', targetId: 'future-ai-lab' },
                title: 'Regression smoke suite',
                goal: 'Publish the passing suite for the release',
                positionId: 'backend-engineer',
              }),
            ),
          })
        ).json(),
      );
      expect(String(outcome['status']), JSON.stringify(outcome['failure'])).toBe('accepted');

      const tasks = (await (await fetch(`${base}/tasks`)).json()) as readonly Json[];
      const injected = tasks.find((task) => task['title'] === 'Regression smoke suite');
      expect(injected, 'the injected task must show up in the queue the console renders').toBeDefined();
      expect(injected?.['positionId']).toBe('backend-engineer');
      expect(injected?.['assigneeEmployeeId'] ?? null).toBeNull();
    } finally {
      await server.close();
    }
  });
});
