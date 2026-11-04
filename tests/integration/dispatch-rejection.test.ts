import { describe, expect, it } from 'vitest';
import type { PositionId } from '@maoeh/shared-types';
import type { LlmRequest } from '@maoeh/llm-gateway';
import { DEFAULT_AGENT_POLICY } from '@maoeh/kernel';
import type { PermissionPolicy } from '@maoeh/permission-system';
import { positionGrant } from '@maoeh/permission-system';
import { validOutput } from '../helpers/cognition-fixtures';
import { collectEvents, createControlHarness } from '../helpers/control-fixtures';
import { planForPrompt } from '../helpers/simulation-fixtures';

/**
 * M1.4 acceptance 4: upward dispatch is refused and the refusal is auditable.
 *
 * The engineer seat is granted `DispatchWork` on purpose so the attempt sails past the A1
 * authority threshold and is judged by the reporting-subtree gate (A2) — the "engineer hands
 * work to the CTO" case the acceptance table names. The refusal must be visible twice: no
 * task exists, and the cycle's failure record (`Runtime.CycleFinished`, outcome `failed`)
 * sits on the log as the audit row M1.4 §5.8 requires for in-cycle action rejections.
 */
const ENGINEER_MAY_DISPATCH: PermissionPolicy = {
  grants: [
    ...DEFAULT_AGENT_POLICY.grants,
    positionGrant('engineer' as PositionId, 'DispatchWork', 'position:*'),
  ],
  denies: [],
};

const DISPATCH_TO_CTO = validOutput({
  goal: 'the CTO owns the design review',
  doneWhen: 'the review sits assigned on the CTO seat',
  steps: [
    {
      action: 'DispatchWork',
      args: {
        positionId: 'cto',
        title: 'Review login design',
        goal: 'CTO reviews the login design',
        requiredOutputKeys: ['design-review'],
        priority: 3,
      },
      reasonRef: 0,
    },
  ],
});

describe('M1.4 acceptance 4: upward dispatch is refused with an audit record', () => {
  it('rejects an engineer dispatching to the CTO and leaves the cycle failure on the log', async () => {
    const requests: LlmRequest[] = [];
    const h = await createControlHarness({
      agentPolicy: ENGINEER_MAY_DISPATCH,
      llmText(request) {
        requests.push(request);
        return request.system.startsWith('You are Mike')
          ? DISPATCH_TO_CTO
          : planForPrompt(request.prompt);
      },
    });
    await h.plane.control.execute(h.command('Simulation.Start'));

    const instruct = await h.plane.control.execute(
      h.command('Agent.Instruct', {
        targetId: 'engineer-mike',
        reason: 'probe the dispatch scope gate',
        extra: { instruction: 'Dispatch a design review to the CTO.' },
      } as never),
    );
    expect(instruct.status, JSON.stringify(instruct.failure)).toBe('accepted');

    const tick = await h.simulation.tick();
    const refusal = tick.turns.find(
      (turn) =>
        turn.employeeId === 'engineer-mike' &&
        turn.status === 'failed' &&
        turn.failureCode === 'out_of_scope',
    );
    expect(refusal, 'the upward dispatch must fail the cycle with out_of_scope').toBeDefined();

    const events = await collectEvents(h.simulation.eventStore);
    const cycleFinished = events.find(
      (event) =>
        event.type === 'Runtime.CycleFinished' &&
        (event.payload as { readonly employeeId?: string }).employeeId === 'engineer-mike',
    );
    expect(cycleFinished, 'the refused dispatch must leave a cycle failure record').toBeDefined();
    const payload = cycleFinished?.payload as {
      readonly outcome: string;
      readonly failureCode: string | null;
    };
    expect(payload.outcome).toBe('failed');
    expect(payload.failureCode).toBe('out_of_scope');

    // The refusal is not just an error: nothing was created anywhere on the log or in the store.
    expect(events.some((event) => event.type === 'Task.Created')).toBe(false);
    expect(h.simulation.tasks.all()).toHaveLength(0);
  });
});
