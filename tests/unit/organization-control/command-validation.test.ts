import { describe, expect, it } from 'vitest';
import type { EmployeeId, OrgEvent } from '@maoeh/shared-types';
import type { ControlCommand, ControlCommandType } from '@maoeh/organization-control';
import {
  CONTROL_COMMAND_REJECTED,
  CONTROL_COMMAND_TYPES,
  fingerprintOf,
  validateCommand,
} from '@maoeh/organization-control';
import type { ControlHarness } from '../../helpers/control-fixtures';
import {
  NO_CONTROL_POLICY,
  collectEvents,
  createControlHarness,
} from '../../helpers/control-fixtures';

/**
 * Structurally valid payloads, one per command type that carries extra fields.
 * These exist so a test can prove "this command failed for the reason under test"
 * instead of accidentally failing structural validation on a missing field.
 */
const VALID_PAYLOAD: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  'Simulation.Seek': Object.freeze({ tickNumber: 1 }),
  // M1.3: creating an agent needs identity, placement and a mandate before authorization runs.
  'Agent.Create': Object.freeze({
    employeeId: 'qa-priya',
    name: 'Priya',
    positionId: 'qa',
    responsibilities: Object.freeze(['test_strategy']),
  }),
  'Agent.Instruct': Object.freeze({ instruction: 'review the brief' }),
  'Agent.CancelTask': Object.freeze({ taskId: 'task-unknown' }),
  'Agent.RequestReview': Object.freeze({ taskId: 'task-unknown' }),
  'Task.Reassign': Object.freeze({ positionId: 'engineer' }),
  'Organization.InjectTask': Object.freeze({
    title: 'injected title',
    goal: 'injected goal',
    positionId: 'ceo',
  }),
  'Organization.InjectEvent': Object.freeze({
    eventType: 'Operation.Note',
    subjectId: 'future-ai-lab',
    payload: Object.freeze({}),
  }),
  // M1.4: the work brief's verification is mandatory (Q3), so a valid payload carries it.
  'Work.SubmitBrief': Object.freeze({
    workBrief: Object.freeze({
      title: 'Ship the login feature',
      goal: 'Deliver a minimal login endpoint',
      context: 'operator-supplied context',
      verificationKeys: Object.freeze(['endpoint']),
      priority: 3,
      dueAtSim: null,
    }),
  }),
});

/** A valid command of `commandType`, with `payload` merged over the valid defaults. */
function commandWith(
  h: ControlHarness,
  commandType: ControlCommandType,
  payload: Readonly<Record<string, unknown>> = {},
): ControlCommand {
  return h.command(commandType, {
    extra: { ...(VALID_PAYLOAD[commandType] ?? {}), ...payload },
  } as never);
}

function payloadOf(event: OrgEvent | undefined): Readonly<Record<string, unknown>> {
  const payload = event?.payload;
  return typeof payload === 'object' && payload !== null
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

/**
 * Events appended to the log since `before`.
 *
 * A refusal is recorded as exactly one `Control.CommandRejected` marker when its envelope can
 * still be formed (the event registry is the authority on that); it must never forge a fact
 * event of its own command family, and when it cannot be expressed at all the audit row is the
 * only trace.
 */
async function appendedSince(
  h: ControlHarness,
  before: readonly OrgEvent[],
): Promise<readonly OrgEvent[]> {
  const after = await collectEvents(h.simulation.eventStore);
  return after.slice(before.length);
}

/** Splits a refusal's appended events into markers and (illegal) fact events. */
function rejectionMarkers(appended: readonly OrgEvent[], resultCode: string): readonly OrgEvent[] {
  const markers = appended.filter((event) => event.type === CONTROL_COMMAND_REJECTED);
  // Anything that is not a rejection marker would be a fact event forged by a refusal.
  expect(appended).toHaveLength(markers.length);
  for (const marker of markers) {
    expect(payloadOf(marker)['resultCode']).toBe(resultCode);
  }
  return markers;
}

describe('M1.0 control plane: command validation', () => {
  it('accepts every control command type once its payload is structurally valid', async () => {
    const h = await createControlHarness();
    for (const commandType of CONTROL_COMMAND_TYPES) {
      const failure = validateCommand(commandWith(h, commandType));
      expect(failure, `${commandType}: ${JSON.stringify(failure)}`).toBeNull();
    }
  });

  it('rejects a broken command envelope as INVALID_COMMAND, naming the offending field', async () => {
    const h = await createControlHarness();
    const cases: readonly {
      readonly overrides: Readonly<Record<string, unknown>>;
      readonly field: string;
    }[] = [
      { overrides: { commandId: '' }, field: 'commandId' },
      { overrides: { reason: '   ' }, field: 'reason' },
      { overrides: { correlationId: '' }, field: 'correlationId' },
      { overrides: { expectedVersion: -1 }, field: 'expectedVersion' },
      { overrides: { expectedVersion: 1.5 }, field: 'expectedVersion' },
      { overrides: { commandType: 'Simulation.Teleport' }, field: 'commandType' },
    ];

    for (const testCase of cases) {
      const outcome = await h.plane.control.execute(
        h.command('Simulation.Pause', testCase.overrides as never),
      );
      const label = `${testCase.field}=${String(testCase.overrides[testCase.field])}`;
      expect(outcome.status, `${label}: ${JSON.stringify(outcome.failure)}`).toBe('rejected');
      expect(outcome.failure?.code, label).toBe('INVALID_COMMAND');
      expect(outcome.failure?.issues[0]?.field, label).toBe(testCase.field);
    }
  });

  it('requires an operator identity (UNAUTHENTICATED) and a position (INVALID_COMMAND)', async () => {
    const h = await createControlHarness();

    const anonymous = await h.plane.control.execute(
      h.command('Simulation.Pause', { actor: {} } as never),
    );
    expect(anonymous.status, JSON.stringify(anonymous.failure)).toBe('rejected');
    expect(anonymous.failure?.code).toBe('UNAUTHENTICATED');
    expect(anonymous.failure?.issues[0]?.field).toBe('actor.operatorId');

    const emptyId = await h.plane.control.execute(
      h.command('Simulation.Pause', {
        actor: {
          operatorId: '' as EmployeeId,
          displayName: 'nobody',
          positionId: 'board-operator',
          kind: 'human',
        },
      } as never),
    );
    expect(emptyId.status, JSON.stringify(emptyId.failure)).toBe('rejected');
    expect(emptyId.failure?.code).toBe('UNAUTHENTICATED');

    const homeless = await h.plane.control.execute(
      h.command('Simulation.Pause', {
        actor: {
          operatorId: 'operator-dana' as EmployeeId,
          displayName: 'Dana',
          positionId: '',
          kind: 'human',
        },
      } as never),
    );
    expect(homeless.status, JSON.stringify(homeless.failure)).toBe('rejected');
    expect(homeless.failure?.code).toBe('INVALID_COMMAND');
    expect(homeless.failure?.issues[0]?.field).toBe('actor.positionId');
  });

  it('rejects an empty or mismatched target as INVALID_TARGET', async () => {
    const h = await createControlHarness();

    const emptyTarget = await h.plane.control.execute(
      h.command('Agent.Pause', { targetId: '' }),
    );
    expect(emptyTarget.status, JSON.stringify(emptyTarget.failure)).toBe('rejected');
    expect(emptyTarget.failure?.code).toBe('INVALID_TARGET');
    expect(emptyTarget.failure?.issues[0]?.field).toBe('target.targetId');

    const wrongKind = await h.plane.control.execute(
      h.command('Simulation.Pause', { targetType: 'task' }),
    );
    expect(wrongKind.status, JSON.stringify(wrongKind.failure)).toBe('rejected');
    expect(wrongKind.failure?.code).toBe('INVALID_TARGET');
    expect(wrongKind.failure?.issues[0]?.field).toBe('target.targetType');
  });

  it('validates each command payload and names the offending field', async () => {
    const h = await createControlHarness();
    const cases: readonly {
      readonly commandType: ControlCommandType;
      readonly payload: Readonly<Record<string, unknown>>;
      readonly field: string;
    }[] = [
      { commandType: 'Simulation.Seek', payload: { tickNumber: -1 }, field: 'tickNumber' },
      { commandType: 'Simulation.Seek', payload: { tickNumber: 2.5 }, field: 'tickNumber' },
      { commandType: 'Agent.Instruct', payload: { instruction: '' }, field: 'instruction' },
      { commandType: 'Agent.CancelTask', payload: { taskId: '' }, field: 'taskId' },
      {
        commandType: 'Agent.RequestReview',
        payload: { taskId: '   ' },
        field: 'taskId',
      },
      { commandType: 'Task.Reassign', payload: { positionId: '' }, field: 'positionId' },
      {
        commandType: 'Organization.InjectTask',
        payload: { title: '' },
        field: 'title',
      },
      {
        commandType: 'Organization.InjectTask',
        payload: { goal: '' },
        field: 'goal',
      },
      {
        commandType: 'Organization.InjectTask',
        payload: { positionId: '' },
        field: 'positionId',
      },
      {
        commandType: 'Organization.InjectEvent',
        payload: { eventType: '' },
        field: 'eventType',
      },
      {
        commandType: 'Organization.InjectEvent',
        payload: { subjectId: '' },
        field: 'subjectId',
      },
      // A typed-in seat ("Engineering" + "Game Developer") is validated before anything happens:
      // the seat's event is only written after the Runtime has acted.
      {
        commandType: 'Agent.Create',
        payload: { newPosition: { departmentId: '', title: 'Game Developer' } },
        field: 'newPosition.departmentId',
      },
      {
        commandType: 'Agent.Create',
        payload: { newPosition: { departmentId: 'engineering', title: '   ' } },
        field: 'newPosition.title',
      },
      {
        commandType: 'Agent.Create',
        payload: { newPosition: { departmentId: 'engineering', title: 'x'.repeat(121) } },
        field: 'newPosition.title',
      },
      {
        commandType: 'Agent.Create',
        payload: {
          newPosition: {
            departmentId: 'engineering',
            title: 'Game Developer',
            capabilities: ['implementation', '   '],
          },
        },
        field: 'newPosition.capabilities',
      },
      {
        commandType: 'Agent.Create',
        payload: {
          newPosition: {
            departmentId: 'engineering',
            title: 'Game Developer',
            capabilities: ['x'.repeat(65)],
          },
        },
        field: 'newPosition.capabilities',
      },
      {
        commandType: 'Agent.Create',
        payload: {
          newPosition: { departmentId: 'engineering', title: 'Game Developer', reportsToPositionId: '' },
        },
        field: 'newPosition.reportsToPositionId',
      },
    ];

    for (const testCase of cases) {
      const command = commandWith(h, testCase.commandType, testCase.payload);
      const failure = validateCommand(command);
      const label = `${testCase.commandType} ${testCase.field}=${String(
        testCase.payload[testCase.field],
      )}`;
      expect(failure, label).not.toBeNull();
      expect(failure?.code, label).toBe('INVALID_COMMAND');
      expect(failure?.issues[0]?.field, label).toBe(testCase.field);

      const outcome = await h.plane.control.execute(command);
      expect(outcome.status, `${label}: ${JSON.stringify(outcome.failure)}`).toBe('rejected');
      expect(outcome.failure?.code, label).toBe('INVALID_COMMAND');
    }
  });

  it('accepts a structurally sound typed-in seat alongside the agent', async () => {
    const h = await createControlHarness();
    const command = commandWith(h, 'Agent.Create', {
      positionId: 'game-developer',
      newPosition: {
        departmentId: 'engineering',
        title: 'Game Developer',
        capabilities: ['implementation', 'testing'],
      },
    });
    expect(validateCommand(command)).toBeNull();
  });

  it('validates structure before authorization', async () => {
    const denied = await createControlHarness({ policy: NO_CONTROL_POLICY });

    const invalidFirst = await denied.plane.control.execute(
      denied.command('Simulation.Pause', { reason: '' } as never),
    );
    expect(invalidFirst.status, JSON.stringify(invalidFirst.failure)).toBe('rejected');
    expect(invalidFirst.failure?.code).toBe('INVALID_COMMAND');

    const unauthorizedSecond = await denied.plane.control.execute(
      denied.command('Simulation.Pause'),
    );
    expect(unauthorizedSecond.status, JSON.stringify(unauthorizedSecond.failure)).toBe('rejected');
    expect(unauthorizedSecond.failure?.code).toBe('UNAUTHORIZED');
  });

  it('records an expressible structural refusal as exactly one Control.CommandRejected', async () => {
    const h = await createControlHarness();
    const before = await collectEvents(h.simulation.eventStore);
    // `expectedVersion: -1` is structurally invalid but the refusal envelope can still be
    // formed, so the frozen contract keeps it on the log as a first-class fact.
    const command = h.command('Simulation.Pause', { expectedVersion: -1 } as never);

    const outcome = await h.plane.control.execute(command);
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('rejected');
    expect(outcome.failure?.code).toBe('INVALID_COMMAND');

    const markers = rejectionMarkers(await appendedSince(h, before), 'INVALID_COMMAND');
    expect(markers).toHaveLength(1);
    expect(outcome.events).toEqual([markers[0]?.eventId]);
    expect(payloadOf(markers[0])).toMatchObject({
      commandId: command.commandId,
      commandType: 'Simulation.Pause',
      targetId: 'future-ai-lab',
      resultCode: 'INVALID_COMMAND',
      operatorId: 'operator-dana',
    });
    expect(h.simulation.scheduler.paused).toBe(false);
    expect(h.simulation.scheduler.clock.currentTick).toBe(0);
  });

  it('keeps structural refusals out of the fact stream and leaves state untouched', async () => {
    const h = await createControlHarness();
    const eventsBefore = await collectEvents(h.simulation.eventStore);
    const tickBefore = h.simulation.scheduler.clock.currentTick;

    const rejected: readonly {
      readonly command: ControlCommand;
      readonly code: 'INVALID_COMMAND' | 'INVALID_TARGET';
    }[] = [
      { command: h.command('Simulation.Pause', { commandId: '' } as never), code: 'INVALID_COMMAND' },
      { command: h.command('Simulation.Pause', { reason: '' } as never), code: 'INVALID_COMMAND' },
      { command: h.command('Simulation.Start', { targetId: '' }), code: 'INVALID_TARGET' },
      { command: h.command('Simulation.Pause', { targetType: 'task' }), code: 'INVALID_TARGET' },
      { command: h.command('Agent.Pause', { targetId: '' }), code: 'INVALID_TARGET' },
      {
        command: h.command('Agent.Instruct', { extra: { instruction: '' } } as never),
        code: 'INVALID_COMMAND',
      },
      {
        command: h.command('Organization.InjectTask', {
          extra: { title: '', goal: 'goal', positionId: 'ceo' },
        } as never),
        code: 'INVALID_COMMAND',
      },
    ];

    for (const testCase of rejected) {
      const before = await collectEvents(h.simulation.eventStore);
      const outcome = await h.plane.control.execute(testCase.command);
      const label = `${testCase.command.commandType} ${JSON.stringify(testCase.command)}`;
      expect(outcome.status, `${label}: ${JSON.stringify(outcome.failure)}`).toBe('rejected');
      expect(outcome.failure?.code, label).toBe(testCase.code);
      expect(outcome.failure?.issues.length, label).toBeGreaterThan(0);
      // A refusal never forges a fact event. It is logged as at most one rejection marker —
      // a command whose envelope is unusable (empty commandId/reason/correlationId) leaves the
      // audit record as its only trace, because the marker would violate the event contract.
      const markers = rejectionMarkers(await appendedSince(h, before), testCase.code);
      expect(markers.length, label).toBeLessThanOrEqual(1);
    }

    expect(h.simulation.scheduler.clock.currentTick).toBe(tickBefore);
    expect(h.simulation.scheduler.paused).toBe(false);
    expect(h.plane.control.query.getTasks()).toHaveLength(0);
    const appended = await appendedSince(h, eventsBefore);
    expect(appended).toHaveLength(
      appended.filter((event) => event.type === CONTROL_COMMAND_REJECTED).length,
    );
  });

  it('records a post-validation refusal on the log and in the audit trail', async () => {
    const denied = await createControlHarness({ policy: NO_CONTROL_POLICY });
    const unauthorized = denied.command('Simulation.Pause');
    const before = await collectEvents(denied.simulation.eventStore);
    const outcome = await denied.plane.control.execute(unauthorized);
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('rejected');
    expect(outcome.failure?.code).toBe('UNAUTHORIZED');

    const markers = rejectionMarkers(await appendedSince(denied, before), 'UNAUTHORIZED');
    expect(markers).toHaveLength(1);
    expect(outcome.events).toEqual([markers[0]?.eventId]);
    expect(payloadOf(markers[0])).toMatchObject({ commandId: unauthorized.commandId });
    // The audit row is written independently of the log marker.
    const audit = denied.audit.find(unauthorized.commandId);
    expect(audit?.verdict).toBe('rejected');
    expect(audit?.resultCode).toBe('UNAUTHORIZED');
    expect(audit?.action.type).toBe('Simulation.Pause');
    // The refusal has no effect on the running simulation.
    expect(denied.simulation.scheduler.paused).toBe(false);
    expect(denied.simulation.scheduler.clock.currentTick).toBe(0);

    // A dispatch-level refusal (unknown agent) behaves the same way.
    const granted = await createControlHarness();
    const invalidTarget = granted.command('Agent.Pause', { targetId: 'ghost-agent' });
    const beforeTarget = await collectEvents(granted.simulation.eventStore);
    const targetOutcome = await granted.plane.control.execute(invalidTarget);
    expect(targetOutcome.status, JSON.stringify(targetOutcome.failure)).toBe('rejected');
    expect(targetOutcome.failure?.code).toBe('INVALID_TARGET');
    const targetMarkers = rejectionMarkers(
      await appendedSince(granted, beforeTarget),
      'INVALID_TARGET',
    );
    expect(targetMarkers).toHaveLength(1);
    expect(payloadOf(targetMarkers[0])).toMatchObject({
      commandId: invalidTarget.commandId,
      targetId: 'ghost-agent',
    });
    expect(granted.audit.find(invalidTarget.commandId)?.resultCode).toBe('INVALID_TARGET');
  });

  it('fingerprints the same commandId intent stably and detects payload drift', async () => {
    const h = await createControlHarness();
    const instruct = h.command('Agent.Instruct', {
      extra: { instruction: 'alpha' },
    } as never);

    expect(fingerprintOf(instruct)).toBe(fingerprintOf({ ...instruct }));

    const otherPayload = { ...instruct, instruction: 'beta' } as ControlCommand;
    expect(fingerprintOf(otherPayload)).not.toBe(fingerprintOf(instruct));

    const otherTarget = h.command('Agent.Instruct', {
      targetId: 'cto-john',
      extra: { instruction: 'alpha' },
    } as never);
    expect(fingerprintOf(otherTarget)).not.toBe(fingerprintOf(instruct));

    // createdAtSim is deliberately excluded: a replay may arrive later in sim time.
    const later = { ...instruct, createdAtSim: 99 as ControlCommand['createdAtSim'] };
    expect(fingerprintOf(later)).toBe(fingerprintOf(instruct));
  });

  it('routes a structurally valid organization event to the event contract', async () => {
    const h = await createControlHarness();
    const before = await collectEvents(h.simulation.eventStore);
    const outcome = await h.plane.control.execute(
      commandWith(h, 'Organization.InjectEvent', { eventType: 'Operation.Note' }),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('rejected');
    expect(outcome.failure?.code).toBe('INVALID_COMMAND');
    expect(outcome.failure?.issues[0]?.field).toBe('type');

    // The contract violation is refused: the payload event is never appended, and the refusal
    // is recorded as exactly one rejection marker.
    const appended = await appendedSince(h, before);
    expect(appended.map((event) => event.type)).not.toContain('Operation.Note');
    const markers = rejectionMarkers(appended, 'INVALID_COMMAND');
    expect(markers).toHaveLength(1);
    expect(outcome.events).toEqual([markers[0]?.eventId]);
  });
});
