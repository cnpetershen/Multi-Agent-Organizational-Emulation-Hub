import { describe, expect, it } from 'vitest';
import { ACTIONS } from '@maoeh/shared-types';
import { buildPlan } from '@maoeh/agent-cognition';
import { buildCognitionPrompt } from '../../../packages/agent-cognition/src/prompts/cognition';
import { testContext } from '../../helpers/cognition-fixtures';

/**
 * `RequestCollaboration` was implemented end to end — the plan executor binds it, the
 * collaboration service records `Communication.CollaborationRequested`, the service wakes the
 * target and the console renders the request — and it could never run.
 *
 * The closed Action Space (`ACTIONS`) did not contain it, and `buildPlan` rejects any step outside
 * that set as `invalid_plan`. So a model that guessed the action was stopped one layer above the
 * executor, and a model that read the prompt was never told it existed. The live log's zero
 * `CollaborationRequested` events were not a usage problem; they were the only possible outcome.
 *
 * These assertions pin the fix on both sides: the action space accepts it, and the prompt states
 * its contract (including when a message is the better tool).
 */

describe('collaboration request is part of the closed action space', () => {
  it('is advertised to the planner', () => {
    expect(ACTIONS).toContain('RequestCollaboration');
  });

  it('survives buildPlan instead of being rejected as invalid_plan', () => {
    const plan = buildPlan({
      draft: {
        goal: 'the dependency is on the record',
        doneWhen: 'a collaboration request exists for task-1',
        steps: [
          {
            action: 'RequestCollaboration',
            args: { toAgentId: 'engineer-mike', taskId: 'task-1', purpose: 'session design review' },
            reasonRef: 0,
          },
        ],
      },
      considerationsCount: 1,
      idempotencySeed: 'test-request-collaboration',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.steps[0]?.action).toBe('RequestCollaboration');
    expect(plan.value.steps[0]?.args).toEqual({
      toAgentId: 'engineer-mike',
      taskId: 'task-1',
      purpose: 'session design review',
    });
  });

  it('still rejects an action nobody implements', () => {
    const plan = buildPlan({
      draft: {
        goal: 'x',
        doneWhen: 'y',
        steps: [{ action: 'Teleport', args: {}, reasonRef: 0 }],
      },
      considerationsCount: 1,
      idempotencySeed: 'test-unknown-action',
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe('invalid_plan');
  });

  it('tells the planner the contract and when to prefer a message', () => {
    const prompt = buildCognitionPrompt(
      testContext({
        communication: {
          channels: [{ channelId: 'company-future-ai-lab', channelType: 'group', memberIds: ['ceo-alex', 'cto-john'] }],
          recentMessages: [],
        },
      }),
    );
    expect(prompt).toContain('`RequestCollaboration` records a tracked collaboration request');
    expect(prompt).toContain("the taskId of one of your open tasks");
    expect(prompt).toContain('use `SendMessage` for a quick question');
    // The contract is prose on purpose: a `"taskId": "..."` example here would be matched by the
    // deterministic mock's prompt parser before the real input event, and every task would be
    // accepted against the placeholder instead of its own id.
    expect(prompt.split('## Input event')[0]).not.toMatch(/"taskId"\s*:/);
  });
});
