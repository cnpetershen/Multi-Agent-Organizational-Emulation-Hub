import { describe, expect, it } from 'vitest';
import type { ControlCommand } from '@maoeh/organization-control';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M1.6 over the real HTTP surface the console talks to:
 *
 *   POST /api/command Agent.Create + newPosition  →  the typed seat enters the roster with its
 *   capability tags (the API edge passes the command through untouched), then an instruction to
 *   the CEO is analysed into capabilities and finishes as a generated workflow.
 *
 * Both failure shapes ride the same route, so the console's error rendering is exercised too.
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
function command(
  commandType: ControlCommand['commandType'],
  target: { readonly targetType: string; readonly targetId: string },
  overrides: Readonly<Record<string, unknown>> = {},
): ControlCommand {
  commandSeq += 1;
  const commandId = `cmd-m16-${String(commandSeq)}`;
  return {
    commandId,
    commandType,
    actor: { operatorId: 'ceo-alex', displayName: 'Alex', positionId: 'ceo', kind: 'human' },
    target,
    reason: 'M1.6 position authoring over HTTP',
    correlationId: commandId,
    causationId: null,
    createdAtSim: 0,
    ...overrides,
  } as ControlCommand;
}

interface PositionRow {
  readonly positionId: string;
  readonly departmentId: string | null;
  readonly title: string;
  readonly capabilities?: readonly string[];
  readonly employeeIds: readonly string[];
}

interface WorkflowRow {
  readonly workflowId: string;
  readonly status: string;
  readonly title: string;
}

describe('M1.6：打字新建岗位与生成式工作流走 HTTP 全链路', () => {
  it('Agent.Create+newPosition 落花名册；CEO 指示按能力生成工作流并跑完', async () => {
    const server = await startApiServer(0, {
      eventLogPath: null,
      tick: { activeIntervalMs: 5, idleIntervalMs: 50 },
      // This suite verifies newPosition authoring, not the draft-confirm flow (its own tests do).
      requirePlanConfirmation: false,
    });
    const base = `http://127.0.0.1:${String(server.port)}/api`;
    try {
      const post = async (path: string, body: unknown): Promise<Response> =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', connection: 'close' },
          body: JSON.stringify(body),
        });
      const get = async <T>(path: string): Promise<T> =>
        (await (await fetch(`${base}${path}`, { headers: { connection: 'close' } })).json()) as T;

      const createSeat = (employeeId: string, positionId: string, departmentId: string) =>
        command(
          'Agent.Create',
          { targetType: 'organization', targetId: 'future-ai-lab' },
          {
            employeeId,
            name: employeeId,
            positionId,
            responsibilities: ['gameplay'],
            newPosition: {
              departmentId,
              title: 'Game Developer',
              capabilities: ['implementation', 'testing'],
            },
          },
        );

      // 1. The edge neither strips nor reshapes the command: a refusal names the offending field.
      const badDepartment = await post('/command', createSeat('ghost-1', 'ghost-1', 'no-such-dept'));
      expect(badDepartment.status).toBe(200);
      const badOutcome = (await badDepartment.json()) as {
        status: string;
        failure?: { code: string; issues?: readonly { field?: string }[] };
      };
      expect(badOutcome.status).toBe('rejected');
      expect(badOutcome.failure?.code).toBe('INVALID_TARGET');
      expect(badOutcome.failure?.issues?.[0]?.field).toBe('departmentId');

      // 2. The typed seat is real: department + title + capability tags, agent hired into it.
      const created = await post('/command', createSeat('game-dev-dora', 'game-developer', 'engineering'));
      expect(created.status).toBe(200);
      const createdOutcome = (await created.json()) as { status: string; failure?: unknown };
      expect(createdOutcome.status, JSON.stringify(createdOutcome.failure)).toBe('accepted');

      const snapshot = await get<{ positions: PositionRow[]; agents: readonly Record<string, string>[] }>(
        '/snapshot',
      );
      const seat = snapshot.positions.find((row) => row.positionId === 'game-developer');
      expect(seat, 'the typed-in seat must appear in the organization snapshot').toBeDefined();
      expect(seat?.title).toBe('Game Developer');
      expect(seat?.departmentId).toBe('engineering');
      expect(seat?.capabilities).toEqual(['implementation', 'testing']);
      expect(seat?.employeeIds).toEqual(['game-dev-dora']);
      const agent = snapshot.agents.find((row) => row['employeeId'] === 'game-dev-dora');
      expect(agent?.['positionId']).toBe('game-developer');
      expect(agent?.['managerEmployeeId']).toBe('cto-john');

      // 3. The same positionId again is a conflict, over HTTP too.
      const duplicate = await post('/command', createSeat('game-dev-dora-2', 'game-developer', 'engineering'));
      const duplicateOutcome = (await duplicate.json()) as {
        status: string;
        failure?: { code: string; issues?: readonly { field?: string }[] };
      };
      expect(duplicateOutcome.status).toBe('rejected');
      expect(duplicateOutcome.failure?.code).toBe('CONFLICT');
      expect(duplicateOutcome.failure?.issues?.[0]?.field).toBe('positionId');

      // 4. An instruction to the CEO: analysis narrows to what the text asks for
      //    (requirements + testing), and the generated workflow drives itself to completion.
      commandSeq += 1;
      const instructed = await post(
        '/command',
        command(
          'Agent.Instruct',
          { targetType: 'agent', targetId: 'ceo-alex' },
          { instruction: 'Write the requirements and run the tests for the onboarding flow.' },
        ),
      );
      const instructOutcome = (await instructed.json()) as { status: string; failure?: unknown };
      expect(instructOutcome.status, JSON.stringify(instructOutcome.failure)).toBe('accepted');

      await waitFor(async () => {
        const workflows = await get<readonly WorkflowRow[]>('/workflows');
        return workflows.some(
          (workflow) => workflow.workflowId.startsWith('generated-')
            && (workflow.status === 'blocked' || workflow.status === 'completed'),
        );
      }, 'the capability-generated workflow to reach its gate over HTTP');
      const gatedWorkflows = await get<readonly WorkflowRow[]>('/workflows');
      for (const gated of gatedWorkflows.filter(
        (workflow) => workflow.workflowId.startsWith('generated-') && workflow.status === 'blocked',
      )) {
        const approved = await post(
          '/command',
          command(
            'Workflow.Approve',
            { targetType: 'workflow', targetId: String(gated.instanceId) },
            { reason: 'human acceptance of the generated delivery' },
          ),
        );
        expect(approved.status).toBe(200);
      }
      await waitFor(async () => {
        const workflows = await get<readonly WorkflowRow[]>('/workflows');
        return workflows.some(
          (workflow) => workflow.workflowId.startsWith('generated-') && workflow.status === 'completed',
        );
      }, 'the human-accepted workflow to complete over HTTP');

      const workflows = await get<readonly WorkflowRow[]>('/workflows');
      const generated = workflows.filter((workflow) => workflow.workflowId.startsWith('generated-'));
      expect(generated.length).toBeGreaterThan(0);
      const tasks = await get<readonly { status: string }[]>('/tasks');
      expect(tasks.filter((task) => task.status === 'completed').length).toBeGreaterThanOrEqual(2);
    } finally {
      await server.close();
    }
  });
});
