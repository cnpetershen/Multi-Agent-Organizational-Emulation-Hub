import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M2 closed loop, over real HTTP against an isolated runtime.
 *
 * The test drives the chain the product is supposed to have:
 *
 *   赛博沙盘 session → GET/POST brief → CEO decomposition → draft workflow (no execution)
 *   → human confirm → task execution → approval gate → human approve → completed delivery
 *
 * It is deliberately isolated (`eventLogPath` and `sandboxStateDir` in a temp directory) so it
 * never reads or writes the operator's demo company or its sessions.
 */

const OPERATOR = {
  operatorId: 'ceo-alex',
  displayName: 'Alex',
  positionId: 'ceo',
  kind: 'human',
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface WorkflowRow {
  readonly instanceId: string;
  readonly title: string;
  readonly status: string;
  readonly draft?: boolean;
  readonly paused?: boolean;
  readonly activeStepIds?: readonly string[];
  readonly steps?: readonly {
    readonly stepId: string;
    readonly name: string;
    readonly kind: string;
    readonly status: string;
    readonly taskId: string | null;
  }[];
  readonly approval?: { readonly stepId: string; readonly status: string } | null;
  readonly transitions?: readonly unknown[];
}

describe('M2 workflow closed loop over HTTP', () => {
  it(
    'runs sandbox → brief → draft → confirm → execution → approval → delivery',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'maoeh-m2-e2e-'));
      const server = await startApiServer(0, {
        eventLogPath: join(dir, 'events.jsonl'),
        sandboxStateDir: join(dir, 'sandbox'),
        requirePlanConfirmation: true,
        // Effectively disable the autonomous driver so the test owns the clock.
        tick: { activeIntervalMs: 600_000, idleIntervalMs: 600_000 },
      });
      const base = `http://127.0.0.1:${String(server.port)}`;
      let commandSeq = 0;
      const nextCommand = (
        commandType: string,
        targetType: string,
        targetId: string,
        simTime: number,
        actor: Readonly<Record<string, string>> = OPERATOR,
      ): Record<string, unknown> => {
        commandSeq += 1;
        const commandId = `e2e-${String(commandSeq)}`;
        return {
          commandId,
          commandType,
          actor,
          target: { targetType, targetId },
          reason: `M2 e2e ${commandType}`,
          correlationId: commandId,
          causationId: null,
          createdAtSim: simTime,
        };
      };
      const getJson = async (path: string): Promise<unknown> => {
        const response = await fetch(`${base}${path}`);
        expect(response.ok, `${path} → ${String(response.status)}`).toBe(true);
        return await response.json();
      };
      const postJson = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      };
      const workflows = async (): Promise<readonly WorkflowRow[]> =>
        (await getJson('/api/workflows')) as readonly WorkflowRow[];
      const simTime = async (): Promise<number> => {
        const state = (await getJson('/api/simulation')) as { simTime: number };
        return state.simTime;
      };
      const tickOnce = async (): Promise<void> => {
        const response = await fetch(`${base}/api/tick`, { method: 'POST' });
        expect(response.status).toBe(200);
        await sleep(2);
      };
      const waitFor = async <T>(
        label: string,
        read: () => Promise<T | null>,
        maxTicks = 120,
      ): Promise<T> => {
        for (let index = 0; index < maxTicks; index += 1) {
          const value = await read();
          if (value !== null) return value;
          await tickOnce();
        }
        throw new Error(`timed out waiting for ${label}`);
      };

      try {
        const llm = (await getJson('/api/llm')) as { mode?: string };
        expect(llm.mode).toBe('mock');

        // 1) A real sandbox session on the isolated runtime.
        const started = await postJson('/api/sandbox/session', {
          topic: '开发一个面向高校的课程实验平台，需要产品需求、技术设计、实现和测试',
          rounds: 1,
        });
        expect(started.status).toBe(201);
        const session = started.body as {
          sessionId: string;
          companyId?: string;
          turns: readonly unknown[];
        };
        expect(session.turns.length).toBeGreaterThanOrEqual(2);
        expect(session.companyId).toBeDefined();

        // 2) Preview the brief: GET writes nothing.
        const preview = await getJson(`/api/sandbox/sessions/${session.sessionId}/brief`);
        const draft = (preview as { draft: { capabilities: string[]; acceptanceCriteria: string[] } }).draft;
        expect(draft.capabilities).toContain('implementation');
        expect(draft.acceptanceCriteria.length).toBeGreaterThan(0);

        // 3) Confirming submits exactly one Work.SubmitBrief.
        const submitted = await postJson(`/api/sandbox/sessions/${session.sessionId}/brief`, {
          confirm: true,
        });
        expect(submitted.status).toBe(201);
        const briefId = (submitted.body as { submitted: { briefId: string } }).submitted.briefId;
        expect(briefId).toMatch(/^brief-/u);

        const duplicate = await postJson(`/api/sandbox/sessions/${session.sessionId}/brief`, {
          confirm: true,
        });
        expect(duplicate.status).toBe(409);

        // 4) The CEO decomposes the brief into a capability workflow — as a draft only.
        const draftInstance = await waitFor('draft workflow', async () => {
          const list = await workflows();
          return list.find((entry) => entry.draft === true) ?? null;
        });
        expect((draftInstance.activeStepIds ?? []).length).toBe(0);
        expect((draftInstance.steps ?? []).every((step) => step.status === 'pending')).toBe(true);
        expect((draftInstance.transitions ?? []).length).toBeGreaterThan(0);

        // 5) Confirm the plan (the canvas' Workflow.ConfirmStart) and run it.
        const confirmed = await postJson(
          '/api/command',
          nextCommand('Workflow.ConfirmStart', 'workflow', draftInstance.instanceId, await simTime()),
        );
        expect(confirmed.status).toBe(200);
        expect(confirmed.body).toMatchObject({ status: 'accepted' });

        const gate = await waitFor('approval gate', async () => {
          const list = await workflows();
          const entry = list.find((candidate) => candidate.instanceId === draftInstance.instanceId) ?? null;
          return entry !== null && entry.approval?.status === 'open' ? entry : null;
        });
        expect(gate.status).toBe('blocked');
        expect(gate.approval?.status).toBe('open');
        const deliveredTasks = (gate.steps ?? []).filter((step) => step.taskId !== null);
        expect(deliveredTasks.length).toBeGreaterThan(0);

        // Every task behind the gate has a real submitted result.
        for (const step of deliveredTasks) {
          const task = (await getJson(`/api/tasks/${String(step.taskId)}`)) as {
            taskId: string;
            status: string;
            result: { summary: string; artifacts: readonly string[] } | null;
          };
          expect(task.taskId).toBe(step.taskId);
          expect(task.status).toBe('completed');
          expect(task.result).not.toBeNull();
          expect((task.result?.summary ?? '').length).toBeGreaterThan(0);
        }

        // 6) Illegal transitions, duplicate decisions and an outsider must all be refused by the
        //    same kernel the Results panel calls — the UI never owns an approval boolean.
        const wrongResume = await postJson(
          '/api/command',
          nextCommand('Workflow.Resume', 'workflow', draftInstance.instanceId, await simTime()),
        );
        expect(wrongResume.status).toBe(200);
        expect(wrongResume.body).toMatchObject({ status: 'rejected' });
        expect((wrongResume.body as { failure?: { code?: string } }).failure?.code).toBe('INVALID_STATE');

        const outsider = await postJson(
          '/api/command',
          nextCommand('Workflow.Approve', 'workflow', draftInstance.instanceId, await simTime(), {
            operatorId: 'engineer-mike',
            displayName: 'Mike',
            positionId: 'engineer',
            kind: 'employee',
          }),
        );
        expect(outsider.status).toBe(200);
        expect(outsider.body).toMatchObject({ status: 'rejected' });
        expect(
          ['OUT_OF_SCOPE', 'UNAUTHORIZED', 'FORBIDDEN', 'NEEDS_APPROVAL'],
        ).toContain((outsider.body as { failure?: { code?: string } }).failure?.code);

        const stillOpen = (await workflows()).find(
          (candidate) => candidate.instanceId === draftInstance.instanceId,
        );
        expect(stillOpen?.approval?.status).toBe('open');

        // 7) Accept the delivery on the same read model the Results page uses.
        const decided = await postJson(
          '/api/command',
          nextCommand('Workflow.Approve', 'workflow', draftInstance.instanceId, await simTime()),
        );
        expect(decided.status).toBe(200);
        expect(decided.body).toMatchObject({ status: 'accepted' });

        const duplicateDecision = await postJson(
          '/api/command',
          nextCommand('Workflow.Approve', 'workflow', draftInstance.instanceId, await simTime()),
        );
        expect(duplicateDecision.status).toBe(200);
        expect(duplicateDecision.body).toMatchObject({ status: 'rejected' });
        expect((duplicateDecision.body as { failure?: { code?: string } }).failure?.code).toBe(
          'INVALID_STATE',
        );

        const completed = await waitFor('completed workflow', async () => {
          const list = await workflows();
          const entry = list.find((candidate) => candidate.instanceId === draftInstance.instanceId) ?? null;
          return entry !== null && entry.status === 'completed' ? entry : null;
        });
        expect(completed.approval?.status).toBe('granted');
        expect((completed.steps ?? []).every((step) => step.status === 'done')).toBe(true);
        expect(completed.paused).toBe(false);

        // 7) The brief read model links back to the delivered tasks.
        const briefs = (await getJson('/api/work-briefs')) as {
          briefs: readonly {
            briefId: string;
            sourceSessionId: string | null;
            items: readonly { taskId: string; status: string }[];
          }[];
        };
        const linked = briefs.briefs.find((entry) => entry.briefId === briefId);
        expect(linked).toBeDefined();
        expect(linked?.sourceSessionId).toBe(session.sessionId);
        expect((linked?.items ?? []).length).toBeGreaterThan(0);
      } finally {
        await server.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
