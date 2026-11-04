import { describe, expect, it } from 'vitest';
import type { ControlCommand, ControlTargetType } from '@maoeh/organization-control';
import {
  CONTROL_WORK_BRIEFED,
  controlWorkBriefedPayloadSchema,
} from '@maoeh/organization-control';
import type { ControlHarness } from '../../helpers/control-fixtures';
import {
  NO_CONTROL_POLICY,
  collectEvents,
  createControlHarness,
} from '../../helpers/control-fixtures';
import { validOutput } from '../../helpers/cognition-fixtures';

/**
 * M1.4 §5.7/§5.8 — `Work.SubmitBrief` is the single human entry point for organizational
 * work: the brief becomes a `Control.WorkBriefed` fact and the briefed agent is woken
 * explicitly (the `Agent.Instruct` delivery bridge), because `Control.*` events are
 * deliberately outside the subscription table.
 *
 * The mocked cognition returns a minimal valid plan — `cognitionPlanSchema` requires at
 * least one step — so the tick below asserts delivery, not decision content.
 */
const CEO = 'ceo-alex';

const BRIEF = Object.freeze({
  title: 'Ship the login feature',
  goal: 'Deliver a minimal login endpoint this sprint',
  context: 'Board commitment; no password resets in scope.',
  verificationKeys: Object.freeze(['endpoint', 'test-report']),
  priority: 2,
  dueAtSim: 600,
});

const ACK_PLAN = validOutput({
  goal: 'the brief is acknowledged',
  doneWhen: 'presence reflects the new commitment',
  steps: [{ action: 'UpdatePresence', args: { presence: 'acting' }, reasonRef: 0 }],
});

interface BriefOverrides {
  readonly workBrief?: unknown;
  readonly omitBrief?: boolean;
  readonly targetType?: ControlTargetType;
  readonly targetId?: string;
  readonly reason?: string;
}

function briefCommand(h: ControlHarness, overrides: BriefOverrides = {}): ControlCommand {
  return h.command('Work.SubmitBrief', {
    targetType: overrides.targetType ?? 'agent',
    targetId: overrides.targetId ?? CEO,
    ...(overrides.reason === undefined ? {} : { reason: overrides.reason }),
    ...(overrides.omitBrief === true
      ? {}
      : { workBrief: overrides.workBrief ?? BRIEF }),
  } as never);
}

async function briefEvents(h: ControlHarness): Promise<readonly { readonly type: string }[]> {
  return (await collectEvents(h.simulation.eventStore)).filter(
    (event) => event.type === CONTROL_WORK_BRIEFED,
  );
}

describe('M1.4 control plane: Work.SubmitBrief', () => {
  it('records the brief, wakes the briefed agent and projects it for the console', async () => {
    const h = await createControlHarness({ llmText: () => ACK_PLAN });
    const started = await h.plane.control.execute(h.command('Simulation.Start'));
    expect(started.status, JSON.stringify(started.failure)).toBe('accepted');

    const outcome = await h.plane.control.execute(briefCommand(h));
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    expect(outcome.events).toHaveLength(1);

    // The fact is on the log, verbatim and contract-valid.
    const events = await collectEvents(h.simulation.eventStore);
    const briefEvent = events.find((event) => event.type === CONTROL_WORK_BRIEFED);
    expect(briefEvent, 'the brief must be a fact on the log').toBeDefined();
    expect(briefEvent?.subjectId).toBe(CEO);
    expect(briefEvent?.subjectType).toBe('employee');
    expect(briefEvent?.actorKind).toBe('human');
    expect(briefEvent?.actorId).toBe('operator-dana');
    expect(controlWorkBriefedPayloadSchema.safeParse(briefEvent?.payload).success).toBe(true);
    expect(briefEvent?.payload).toMatchObject({
      commandId: outcome.commandId,
      operatorId: 'operator-dana',
      reason: 'operator action under test',
      agentId: CEO,
      briefId: 'brief-1',
      title: BRIEF.title,
      goal: BRIEF.goal,
      context: BRIEF.context,
      verificationKeys: ['endpoint', 'test-report'],
      priority: 2,
      dueAtSim: 600,
    });
    expect(outcome.events[0]).toBe(briefEvent?.eventId);

    // One audit row per brief: actor / reason / verdict / eventIds (§5.8).
    const audit = h.audit.find(outcome.commandId);
    expect(audit?.verdict).toBe('accepted');
    expect(audit?.action.type).toBe('Work.SubmitBrief');
    expect(audit?.eventIds).toEqual([briefEvent?.eventId]);

    // Delivery: exactly one MANUAL wakeup whose input event is the brief.
    const wakeups = h.simulation.scheduler.queue().filter((entry) => entry.reason === 'MANUAL');
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.agentId).toBe(CEO);
    expect(wakeups[0]?.sourceEventId).toBe(briefEvent?.eventId);
    expect(wakeups[0]?.trigger.kind).toBe('manual');
    expect(wakeups[0]?.trigger.refId).toBe('brief-1');

    // Read model: the brief is visible before any work has been dispatched.
    const briefs = await h.plane.control.query.listWorkBriefs();
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toMatchObject({
      briefId: 'brief-1',
      commandId: outcome.commandId,
      agentId: CEO,
      operatorId: 'operator-dana',
      reason: 'operator action under test',
      correlationId: briefEvent?.correlationId,
      title: BRIEF.title,
      goal: BRIEF.goal,
      context: BRIEF.context,
      verificationKeys: ['endpoint', 'test-report'],
      priority: 2,
      dueAtSim: 600,
      submittedAtSim: Number(briefEvent?.occurredAtSim),
      items: [],
      counts: { total: 0, assigned: 0, completed: 0, blocked: 0, rejected: 0 },
    });
    expect(await h.plane.control.query.getWorkBrief('brief-1')).toEqual(briefs[0]);
    expect(await h.plane.control.query.getWorkBrief('brief-unknown')).toBeNull();

    // The wake produces a cycle caused by the brief event: the causation chain end to end.
    const tick = await h.simulation.tick();
    const turn = tick.turns.find((entry) => entry.employeeId === CEO);
    expect(turn, 'the briefed agent must get a turn').toBeDefined();
    expect(turn?.status).toBe('acted');
    expect(turn?.sourceEventId).toBe(briefEvent?.eventId);
    const after = await collectEvents(h.simulation.eventStore);
    expect(
      after.some(
        (event) =>
          event.type === 'Runtime.CycleStarted' &&
          event.causationId === briefEvent?.eventId,
      ),
      'the cycle must be caused by the brief',
    ).toBe(true);
  });

  it('refuses a structurally broken brief, naming the offending field', async () => {
    const h = await createControlHarness();
    const cases: readonly { readonly brief: unknown; readonly field: string }[] = [
      { brief: { ...BRIEF, title: '' }, field: 'workBrief.title' },
      { brief: { ...BRIEF, title: '   ' }, field: 'workBrief.title' },
      { brief: { ...BRIEF, title: 'x'.repeat(201) }, field: 'workBrief.title' },
      { brief: { ...BRIEF, goal: '' }, field: 'workBrief.goal' },
      { brief: { ...BRIEF, goal: 'x'.repeat(8001) }, field: 'workBrief.goal' },
      { brief: { ...BRIEF, context: 7 }, field: 'workBrief.context' },
      { brief: { ...BRIEF, context: 'x'.repeat(8001) }, field: 'workBrief.context' },
      { brief: { ...BRIEF, verificationKeys: [] }, field: 'workBrief.verificationKeys' },
      { brief: { ...BRIEF, verificationKeys: ['   '] }, field: 'workBrief.verificationKeys' },
      {
        brief: { ...BRIEF, verificationKeys: ['x'.repeat(65)] },
        field: 'workBrief.verificationKeys',
      },
      { brief: { ...BRIEF, priority: 0 }, field: 'workBrief.priority' },
      { brief: { ...BRIEF, priority: 10 }, field: 'workBrief.priority' },
      { brief: { ...BRIEF, priority: 2.5 }, field: 'workBrief.priority' },
      { brief: { ...BRIEF, priority: '3' }, field: 'workBrief.priority' },
      { brief: { ...BRIEF, dueAtSim: -1 }, field: 'workBrief.dueAtSim' },
      { brief: { ...BRIEF, dueAtSim: 1.5 }, field: 'workBrief.dueAtSim' },
    ];

    for (const testCase of cases) {
      const outcome = await h.plane.control.execute(
        briefCommand(h, { workBrief: testCase.brief }),
      );
      const label = `${testCase.field} (${JSON.stringify(testCase.brief).slice(0, 96)})`;
      expect(outcome.status, `${label}: ${JSON.stringify(outcome.failure)}`).toBe('rejected');
      expect(outcome.failure?.code, label).toBe('INVALID_COMMAND');
      expect(outcome.failure?.issues[0]?.field, label).toBe(testCase.field);
    }

    // A missing brief is a broken brief too — and reason stays mandatory for every command.
    const missing = await h.plane.control.execute(briefCommand(h, { omitBrief: true }));
    expect(missing.status, JSON.stringify(missing.failure)).toBe('rejected');
    expect(missing.failure?.code).toBe('INVALID_COMMAND');
    expect(missing.failure?.issues[0]?.field).toBe('workBrief');

    const noReason = await h.plane.control.execute(briefCommand(h, { reason: '   ' }));
    expect(noReason.status, JSON.stringify(noReason.failure)).toBe('rejected');
    expect(noReason.failure?.code).toBe('INVALID_COMMAND');
    expect(noReason.failure?.issues[0]?.field).toBe('reason');

    // A refusal never reaches the log and never wakes anyone.
    expect(await briefEvents(h)).toHaveLength(0);
    expect(h.simulation.scheduler.queue().filter((entry) => entry.reason === 'MANUAL')).toHaveLength(
      0,
    );
  });

  it('addresses only a live roster member: wrong target, unknown and archived agents', async () => {
    const h = await createControlHarness();

    const wrongKind = await h.plane.control.execute(
      briefCommand(h, { targetType: 'organization', targetId: 'future-ai-lab' }),
    );
    expect(wrongKind.status, JSON.stringify(wrongKind.failure)).toBe('rejected');
    expect(wrongKind.failure?.code).toBe('INVALID_TARGET');
    expect(wrongKind.failure?.issues[0]?.field).toBe('target.targetType');

    const unknown = await h.plane.control.execute(briefCommand(h, { targetId: 'ghost-agent' }));
    expect(unknown.status, JSON.stringify(unknown.failure)).toBe('rejected');
    expect(unknown.failure?.code).toBe('INVALID_TARGET');
    expect(unknown.failure?.issues[0]?.field).toBe('target.targetId');

    const archived = await h.plane.control.execute(
      h.command('Agent.Archive', { targetType: 'agent', targetId: 'engineer-mike' }),
    );
    expect(archived.status, JSON.stringify(archived.failure)).toBe('accepted');
    const toArchived = await h.plane.control.execute(
      briefCommand(h, { targetId: 'engineer-mike' }),
    );
    expect(toArchived.status, JSON.stringify(toArchived.failure)).toBe('rejected');
    expect(toArchived.failure?.code).toBe('INVALID_STATE');

    expect(await briefEvents(h)).toHaveLength(0);
    expect(h.simulation.scheduler.queue().filter((entry) => entry.reason === 'MANUAL')).toHaveLength(
      0,
    );
  });

  it('refuses to brief a paused agent (AGENT_PAUSED) and wakes nobody', async () => {
    const h = await createControlHarness();
    const paused = await h.plane.control.execute(
      h.command('Agent.Pause', { targetType: 'agent', targetId: CEO }),
    );
    expect(paused.status, JSON.stringify(paused.failure)).toBe('accepted');

    const outcome = await h.plane.control.execute(briefCommand(h));
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('rejected');
    expect(outcome.failure?.code).toBe('AGENT_PAUSED');
    expect(outcome.failure?.issues[0]?.field).toBe('agentId');

    expect(await briefEvents(h)).toHaveLength(0);
    expect(h.simulation.scheduler.queue().filter((entry) => entry.reason === 'MANUAL')).toHaveLength(
      0,
    );
  });

  it('fails closed: an operator holding no grant cannot submit a brief', async () => {
    const h = await createControlHarness({ policy: NO_CONTROL_POLICY });
    const outcome = await h.plane.control.execute(briefCommand(h));
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('rejected');
    expect(outcome.failure?.code).toBe('UNAUTHORIZED');
    expect(outcome.failure?.issues[0]?.field).toBe('permission');

    expect(await briefEvents(h)).toHaveLength(0);
  });

  it('applies a brief once per commandId and detects payload drift', async () => {
    const h = await createControlHarness();
    const command = briefCommand(h);
    const first = await h.plane.control.execute(command);
    const second = await h.plane.control.execute(command);
    expect(first.status, JSON.stringify(first.failure)).toBe('accepted');
    expect(second.status, JSON.stringify(second.failure)).toBe('accepted');
    expect(second.replayed).toBe(true);
    expect(second.events).toEqual(first.events);

    // The nested brief participates in the idempotency fingerprint: same commandId, other
    // intent is a conflict, not a second brief.
    const drifted = await h.plane.control.execute({
      ...command,
      workBrief: { ...BRIEF, title: 'Ship something else' },
    } as ControlCommand);
    expect(drifted.status, JSON.stringify(drifted.failure)).toBe('rejected');
    expect(drifted.failure?.code).toBe('CONFLICT');

    expect(await briefEvents(h)).toHaveLength(1);
    expect(h.simulation.scheduler.queue().filter((entry) => entry.reason === 'MANUAL')).toHaveLength(
      1,
    );
    const briefs = await h.plane.control.query.listWorkBriefs();
    expect(briefs.map((brief) => brief.briefId)).toEqual(['brief-1']);
  });
});
