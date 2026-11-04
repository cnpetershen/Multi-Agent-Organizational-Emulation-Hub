import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmRequest } from '@maoeh/llm-gateway';
import { createFileEventStore } from '@maoeh/event-store';
import { createAuditService } from '@maoeh/audit-system';
import { createAuthzService } from '@maoeh/permission-system';
import { createKernelControlPlane, recoverControlPlane } from '@maoeh/kernel';
import { validOutput } from '../helpers/cognition-fixtures';
import {
  collectEvents,
  createControlHarness,
  loadSeedOrganizationWithOperators,
  operatorControlPolicy,
} from '../helpers/control-fixtures';
import { createSimulationHarness } from '../helpers/simulation-fixtures';

/**
 * M1.4 §5.10 acceptance 7: a work brief and its decomposition survive a restart, using the
 * file event store as the durability boundary. Nothing about the brief is snapshotted —
 * `Control.WorkBriefed` plus the `Task.*` events sharing its `correlationId` (§5.4) are the
 * whole read model, so a replayed kernel must answer identically.
 */
const DISPATCH_PLAN = validOutput({
  goal: 'the brief is decomposed into assigned work',
  doneWhen: 'two work items sit assigned on two different positions',
  steps: [
    {
      action: 'DispatchWork',
      args: {
        positionId: 'engineer',
        title: 'Build login API',
        goal: 'Deliver a minimal login endpoint',
        detail: 'From the brief: minimal login endpoint with tests.',
        requiredSkills: ['backend'],
        requiredOutputKeys: ['endpoint', 'tests'],
        priority: 3,
      },
      reasonRef: 0,
    },
    {
      action: 'DispatchWork',
      args: {
        positionId: 'qa',
        title: 'Verify login flow',
        goal: 'Cover the login flow with tests',
        requiredOutputKeys: ['test-report'],
        priority: 3,
      },
      reasonRef: 1,
    },
  ],
});

/** `cognitionPlanSchema` requires at least one step, so even idle seats get a valid plan. */
const WAIT_PLAN = validOutput({
  goal: 'await further direction',
  doneWhen: 'presence reflects readiness',
  steps: [{ action: 'UpdatePresence', args: { presence: 'acting' }, reasonRef: 0 }],
});

function scriptedCognition(requests: LlmRequest[]): (request: LlmRequest) => string {
  return (request) => {
    requests.push(request);
    return request.system.startsWith('You are Alex') ? DISPATCH_PLAN : WAIT_PLAN;
  };
}

type FileStore = ReturnType<typeof createFileEventStore>;

async function briefHarness(store: FileStore) {
  return createControlHarness({ eventStore: store, llmText: scriptedCognition([]) });
}

/** The composition root's restart path: replay the log, rebuild audit, rehydrate. */
async function restart(store: FileStore) {
  const organization = loadSeedOrganizationWithOperators();
  const policy = operatorControlPolicy();
  const harness = await createSimulationHarness({
    organization,
    eventStore: store,
    llmText: scriptedCognition([]),
  });
  const audit = createAuditService();
  const plane = createKernelControlPlane({
    simulation: harness.simulation,
    authz: createAuthzService({ organization, policy }),
    registry: harness.simulation.registry,
    eventStore: store,
    auditService: audit,
  });
  await recoverControlPlane(plane.control, plane.audit, store);
  return { harness, plane };
}

describe('M1.4 acceptance 7: a work brief and its decomposition survive a restart', () => {
  it('replays brief and decomposition from the file log so the read model is unchanged', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'maoeh-brief-')), 'events.jsonl');
    const store = createFileEventStore({ path });
    const h = await briefHarness(store);

    const started = await h.plane.control.execute(h.command('Simulation.Start'));
    expect(started.status, JSON.stringify(started.failure)).toBe('accepted');

    const submitted = await h.plane.control.execute(
      h.command('Work.SubmitBrief', {
        targetId: 'ceo-alex',
        reason: 'board wants the login feature this sprint',
        workBrief: {
          title: 'Login feature',
          goal: 'Ship the login feature this sprint',
          context: 'Handed over by the board.',
          verificationKeys: ['endpoint', 'test-report'],
          priority: 2,
          dueAtSim: 600,
        },
      } as never),
    );
    expect(submitted.status, JSON.stringify(submitted.failure)).toBe('accepted');
    const briefEventId = submitted.events[0] ?? '';

    // One cycle: the briefed CEO decomposes the brief into dispatched positions.
    const tick = await h.simulation.tick();
    const ceoTurn = tick.turns.find((turn) => turn.employeeId === 'ceo-alex');
    expect(ceoTurn, 'the briefed CEO must get a turn').toBeDefined();
    expect(ceoTurn?.status).toBe('acted');
    expect(ceoTurn?.sourceEventId).toBe(briefEventId);

    const briefsBefore = await h.plane.control.query.listWorkBriefs();
    expect(briefsBefore).toHaveLength(1);
    const brief = briefsBefore[0];
    expect(brief, 'the brief must be projected').toBeDefined();
    expect(brief?.briefId).toBe('brief-1');
    expect(brief?.commandId).toBe(submitted.commandId);
    expect(brief?.title).toBe('Login feature');
    expect(brief?.goal).toBe('Ship the login feature this sprint');
    expect(brief?.verificationKeys).toEqual(['endpoint', 'test-report']);
    expect(brief?.counts).toEqual({
      total: 2,
      assigned: 2,
      completed: 0,
      blocked: 0,
      rejected: 0,
    });
    expect(brief?.items.map((item) => item.positionId)).toEqual(['engineer', 'qa']);
    expect(brief?.items.map((item) => item.assigneeEmployeeId)).toEqual([
      'engineer-mike',
      'qa-peter',
    ]);
    expect(brief?.items.every((item) => item.status === 'assigned')).toBe(true);
    expect(brief?.items.map((item) => item.verificationKeys)).toEqual([
      ['endpoint', 'tests'],
      ['test-report'],
    ]);

    // §5.4 on the log itself: both dispatched items group under the brief's correlationId.
    const events = await collectEvents(h.simulation.eventStore);
    const assigned = events.filter(
      (event) =>
        event.type === 'Task.Assigned' && event.correlationId === brief?.correlationId,
    );
    expect(assigned).toHaveLength(2);

    // Durability is the log, not a private snapshot file.
    expect(readFileSync(path, 'utf8')).toContain('Control.WorkBriefed');

    // Restart on the same file: replayed brief + replayed tasks → identical read model.
    const restarted = await restart(store);
    const briefsAfter = await restarted.plane.control.query.listWorkBriefs();
    expect(briefsAfter).toEqual(briefsBefore);
    expect(await restarted.plane.control.query.getWorkBrief('brief-1')).toEqual(brief);

    // The `brief-<n>` counter is process-local; recovery reseeds it from the log, so the
    // next submission gets `brief-2` instead of silently reusing `brief-1`.
    const second = await restarted.plane.control.execute(
      h.command('Work.SubmitBrief', {
        targetId: 'ceo-alex',
        reason: 'follow-up from the board',
        workBrief: {
          title: 'Second brief',
          goal: 'Keep shipping',
          verificationKeys: ['deliverable'],
          priority: 3,
        },
      } as never),
    );
    expect(second.status, JSON.stringify(second.failure)).toBe('accepted');
    const all = await restarted.plane.control.query.listWorkBriefs();
    expect(all.map((entry) => entry.briefId)).toEqual(['brief-1', 'brief-2']);
  });
});
