import { describe, expect, it } from 'vitest';
import type { OrgEvent, PresenceState } from '@maoeh/shared-types';
import { replayAgentState } from '@maoeh/runtime-state';
import type { RuntimeTurnResult } from '@maoeh/agent-runtime';
import { createRuntimeTurnContext, runAgentTurn } from '@maoeh/agent-runtime';
import { createRuntimeFixture, presenceEvent, sim } from '../../helpers/runtime-fixtures';

const fixture = createRuntimeFixture();

function runOnce(event: OrgEvent): RuntimeTurnResult {
  const result = runAgentTurn({
    agent: fixture.alice,
    state: fixture.alice.state,
    actorContext: fixture.aliceContext,
    event,
    simTime: sim(77),
    registry: fixture.registry,
    turnContext: createRuntimeTurnContext(),
  });
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.issues.map((issue) => issue.field).join(', ')}`);
  }
  return result.value;
}

function snapshot(turn: RuntimeTurnResult): unknown {
  return {
    turnId: turn.turnId,
    agentId: turn.agentId,
    employeeId: turn.employeeId,
    status: turn.status,
    decision: turn.decision,
    emittedEvents: turn.emittedEvents,
    stateBefore: turn.stateBefore,
    stateAfter: turn.stateAfter,
  };
}

describe('M0.5 确定性：相同输入产生相同输出', () => {
  it('两个全新回合上下文对同一事件 → 决策 / turnId / 事件 / 状态完全一致', () => {
    const first = runOnce(
      presenceEvent(fixture.registry, fixture.companyId, {
        eventId: 'in-det',
        subjectId: 'alice',
        presence: 'planning',
        actorId: 'alice',
        correlationId: 'corr-det',
        occurredAtSim: 15,
      }),
    );
    const second = runOnce(
      presenceEvent(fixture.registry, fixture.companyId, {
        eventId: 'in-det',
        subjectId: 'alice',
        presence: 'planning',
        actorId: 'alice',
        correlationId: 'corr-det',
        occurredAtSim: 15,
      }),
    );
    expect(first.turnId).toBe(second.turnId);
    expect(first.emittedEvents).toEqual(second.emittedEvents);
    expect(snapshot(first)).toEqual(snapshot(second));
  });

  it('发事件与改状态等价：用 emittedEvents 回放得到与 stateAfter 相同的状态', () => {
    const turn = runOnce(
      presenceEvent(fixture.registry, fixture.companyId, {
        eventId: 'in-replay',
        subjectId: 'alice',
        presence: 'acting',
        actorId: 'alice',
      }),
    );
    expect(turn.emittedEvents).toHaveLength(1);
    const replayed = replayAgentState(turn.stateBefore, turn.emittedEvents);
    expect(replayed).toEqual(turn.stateAfter);
  });

  it('stateBefore 与输入状态恒等引用，stateAfter 恒为新对象', () => {
    const state = fixture.alice.state;
    const turn = runOnce(
      presenceEvent(fixture.registry, fixture.companyId, {
        eventId: 'in-ref',
        subjectId: 'alice',
        presence: 'thinking',
        actorId: 'alice',
      }),
    );
    expect(turn.stateBefore).toBe(state);
    expect(turn.stateAfter).not.toBe(state);
    expect(state.presence).toBe('idle');
    expect(state.version).toBe(0);
  });

  it('同一上下文连续回合：turnId / eventId 单调递增且互不干扰', () => {
    const turnContext = createRuntimeTurnContext();
    const run = (eventId: string, presence: PresenceState) =>
      runAgentTurn({
        agent: fixture.alice,
        state: fixture.alice.state,
        actorContext: fixture.aliceContext,
        event: presenceEvent(fixture.registry, fixture.companyId, {
          eventId,
          subjectId: 'alice',
          presence,
          actorId: 'alice',
        }),
        simTime: sim(5),
        registry: fixture.registry,
        turnContext,
      });

    const one = run('in-seq-1', 'thinking');
    const two = run('in-seq-2', 'planning');
    const ignored = run('in-seq-1', 'planning');

    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
    expect(ignored.ok).toBe(true);
    if (!one.ok || !two.ok || !ignored.ok) return;
    expect(one.value.turnId).toBe('turn-1');
    expect(two.value.turnId).toBe('turn-2');
    expect(ignored.value.turnId).toBe('turn-3');
    expect(one.value.emittedEvents[0]?.eventId).toBe('evt-1');
    expect(two.value.emittedEvents[0]?.eventId).toBe('evt-2');
    expect(ignored.value.emittedEvents).toEqual([]);
    expect(ignored.value.decision.reason).toBe('duplicate');
  });

  it('忽略与拒绝回合不消耗 eventId 计数器', () => {
    const turnContext = createRuntimeTurnContext();
    const ignored = runAgentTurn({
      agent: fixture.bob,
      state: fixture.bob.state,
      actorContext: fixture.bobContext,
      event: presenceEvent(fixture.registry, fixture.companyId, {
        eventId: 'in-ignore',
        subjectId: 'alice',
        presence: 'thinking',
        actorId: 'alice',
      }),
      simTime: sim(5),
      registry: fixture.registry,
      turnContext,
    });
    expect(ignored.ok).toBe(true);
    if (!ignored.ok) return;
    expect(ignored.value.status).toBe('ignored');

    const completed = runAgentTurn({
      agent: fixture.alice,
      state: fixture.alice.state,
      actorContext: fixture.aliceContext,
      event: presenceEvent(fixture.registry, fixture.companyId, {
        eventId: 'in-complete',
        subjectId: 'alice',
        presence: 'thinking',
        actorId: 'alice',
      }),
      simTime: sim(5),
      registry: fixture.registry,
      turnContext,
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.emittedEvents[0]?.eventId).toBe('evt-1');
  });
});
