import { describe, expect, it } from 'vitest';
import { validOutput } from '../helpers/cognition-fixtures';
import { collectEvents, createControlHarness } from '../helpers/control-fixtures';

/**
 * `Control.*` events are deliberately excluded from wakeup eligibility (they must not drive
 * agent turns by subscription). That makes operator instruction delivery the one control path
 * that needs an explicit bridge into the existing scheduler — this suite pins it end to end.
 *
 * The mocked cognition returns a minimal *valid* plan (`cognitionPlanSchema` requires at least
 * one step). These tests assert the delivery path — wakeup -> turn -> cycle causation — not the
 * content of the agent's decision.
 */
const INSTRUCTION_PLAN = (): string =>
  validOutput({
    goal: 'acknowledge the operator instruction',
    doneWhen: 'presence reflects the instruction',
    steps: [{ action: 'UpdatePresence', args: { presence: 'acting' }, reasonRef: 0 }],
  });

describe('M1.0 intervention: operator instructions reach the agent runtime', () => {
  it('turns an Agent.Instruct command into a MANUAL wakeup whose input event is the instruction', async () => {
    const h = await createControlHarness({ llmText: INSTRUCTION_PLAN });
    await h.plane.control.execute(h.command('Simulation.Start'));

    const instruct = await h.plane.control.execute(
      h.command('Agent.Instruct', {
        targetType: 'agent',
        targetId: 'ceo-alex',
        reason: 'board directive',
        extra: { instruction: 'Re-evaluate the current decision (Control.AgentInstructed)' },
      } as never),
    );
    expect(instruct.status, JSON.stringify(instruct.failure)).toBe('accepted');
    expect(instruct.events).toHaveLength(1);
    const instructionEventId = instruct.events[0] ?? '';

    // The scheduler now holds a MANUAL wakeup sourced from the instruction event.
    const queued = h.simulation.scheduler.queue();
    const wakeup = queued.find((entry) => entry.reason === 'MANUAL');
    expect(wakeup, 'a MANUAL wakeup must be enqueued').toBeDefined();
    expect(wakeup?.agentId).toBe('ceo-alex');
    expect(wakeup?.sourceEventId).toBe(instructionEventId);
    expect(wakeup?.trigger.kind).toBe('manual');

    // The next tick actually runs the agent with the instruction as its input event.
    // (`turn.reason` reports the cycle's terminal outcome; the wakeup reason is asserted on the
    // scheduler entry above, and the causation chain below proves the instruction drove it.)
    const result = await h.simulation.tick();
    const ceoTurn = result.turns.find((turn) => turn.employeeId === 'ceo-alex');
    expect(ceoTurn, 'the instructed agent must get a turn').toBeDefined();
    expect(ceoTurn?.status).toBe('acted');
    expect(ceoTurn?.sourceEventId).toBe(instructionEventId);

    // The runtime recorded a cycle caused by the instruction event.
    const events = await collectEvents(h.simulation.eventStore);
    const cycleStarted = events.find(
      (event) =>
        event.type === 'Runtime.CycleStarted' && event.causationId === instructionEventId,
    );
    expect(cycleStarted, 'the cycle must be caused by the instruction').toBeDefined();
    expect(cycleStarted?.subjectId).toBe('ceo-alex');

    // The instruction itself is on the log, carrying the operator and the reason.
    const instruction = events.find((event) => event.eventId === instructionEventId);
    expect(instruction?.type).toBe('Control.AgentInstructed');
    expect(instruction?.actorKind).toBe('human');
    expect(instruction?.actorId).toBe('operator-dana');
    expect(
      (instruction?.payload as { readonly instruction?: string }).instruction,
    ).toBe('Re-evaluate the current decision (Control.AgentInstructed)');
  });

  it('does not wake a paused agent and reports AGENT_PAUSED', async () => {
    const h = await createControlHarness();
    await h.plane.control.execute(h.command('Simulation.Start'));
    await h.plane.control.execute(
      h.command('Agent.Pause', { targetType: 'agent', targetId: 'ceo-alex' }),
    );

    const instruct = await h.plane.control.execute(
      h.command('Agent.Instruct', {
        targetType: 'agent',
        targetId: 'ceo-alex',
        extra: { instruction: 'should not be delivered' },
      } as never),
    );
    expect(instruct.status).toBe('rejected');
    expect(instruct.failure?.code).toBe('AGENT_PAUSED');
    expect(
      h.simulation.scheduler.queue().some((entry) => entry.reason === 'MANUAL'),
    ).toBe(false);
  });

  it('delivers one wakeup per instruction and stays idempotent per commandId', async () => {
    const h = await createControlHarness({ llmText: INSTRUCTION_PLAN });
    await h.plane.control.execute(h.command('Simulation.Start'));

    const command = h.command('Agent.Instruct', {
      targetType: 'agent',
      targetId: 'cto-john',
      extra: { instruction: 'Review the architecture (Control.AgentInstructed)' },
    } as never);
    const first = await h.plane.control.execute(command);
    const second = await h.plane.control.execute(command);
    expect(first.status, JSON.stringify(first.failure)).toBe('accepted');
    expect(second.replayed).toBe(true);

    const manualWakeups = h.simulation.scheduler
      .queue()
      .filter((entry) => entry.reason === 'MANUAL');
    expect(manualWakeups).toHaveLength(1);

    const result = await h.simulation.tick();
    const ctoTurn = result.turns.find((turn) => turn.employeeId === 'cto-john');
    expect(ctoTurn?.sourceEventId).toBe(first.events[0]);
    expect(ctoTurn?.status).toBe('acted');
  });
});
