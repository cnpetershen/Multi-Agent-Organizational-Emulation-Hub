import { describe, expect, it } from 'vitest';
import type { EmployeeId, OrgEvent } from '@maoeh/shared-types';
import { createInitialAgentState } from '@maoeh/runtime-state';
import type { RuntimeTurnContext } from '@maoeh/agent-runtime';
import { createRuntimeTurnContext, runAgentTurn } from '@maoeh/agent-runtime';
import { createRuntimeFixture, presenceEvent, sim } from '../../helpers/runtime-fixtures';

const fixture = createRuntimeFixture();

function runWith(
  turnContext: RuntimeTurnContext,
  event: OrgEvent,
  agent = fixture.alice,
  state = fixture.alice.state,
  actorContext = fixture.aliceContext,
) {
  return runAgentTurn({
    agent,
    state,
    actorContext,
    event,
    simTime: sim(30),
    registry: fixture.registry,
    turnContext,
  });
}

describe('M0.5 幂等：同一回合上下文内的重复事件', () => {
  it('相同 agent + 相同 eventId 第二次 → ignored / duplicate，不重复发事件、不重复改状态', () => {
    const turnContext = createRuntimeTurnContext();
    const event = presenceEvent(fixture.registry, fixture.companyId, {
      eventId: 'in-idem',
      subjectId: 'alice',
      presence: 'planning',
      actorId: 'alice',
    });

    const first = runWith(turnContext, event);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.status).toBe('completed');
    expect(first.value.turnId).toBe('turn-1');
    expect(first.value.emittedEvents.map((emitted) => emitted.eventId)).toEqual(['evt-1']);
    expect(first.value.stateAfter.presence).toBe('planning');
    expect(first.value.stateAfter.version).toBe(1);

    const second = runWith(turnContext, event, fixture.alice, first.value.stateAfter);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.status).toBe('ignored');
    expect(second.value.turnId).toBe('turn-2');
    expect(second.value.decision.kind).toBe('ignore');
    expect(second.value.decision.reason).toBe('duplicate');
    expect(second.value.emittedEvents).toEqual([]);
    expect(second.value.stateAfter).toBe(second.value.stateBefore);
    expect(second.value.stateAfter.presence).toBe('planning');
    expect(second.value.stateAfter.version).toBe(1);
  });

  it('已处理记录按 agent 隔离：另一个 Agent 用相同 eventId 仍然执行', () => {
    const turnContext = createRuntimeTurnContext();
    const aliceEvent = presenceEvent(fixture.registry, fixture.companyId, {
      eventId: 'shared-id',
      subjectId: 'alice',
      presence: 'thinking',
      actorId: 'alice',
    });
    const bobEvent = presenceEvent(fixture.registry, fixture.companyId, {
      eventId: 'shared-id',
      subjectId: 'bob',
      presence: 'blocked',
      actorId: 'bob',
    });

    const aliceTurn = runWith(turnContext, aliceEvent);
    expect(aliceTurn.ok).toBe(true);
    if (!aliceTurn.ok) return;
    expect(aliceTurn.value.status).toBe('completed');
    expect(aliceTurn.value.emittedEvents[0]?.eventId).toBe('evt-1');

    const bobTurn = runWith(
      turnContext,
      bobEvent,
      fixture.bob,
      fixture.bob.state,
      fixture.bobContext,
    );
    expect(bobTurn.ok).toBe(true);
    if (!bobTurn.ok) return;
    expect(bobTurn.value.status).toBe('completed');
    expect(bobTurn.value.decision.reason).toBe('processed');
    expect(bobTurn.value.emittedEvents[0]?.eventId).toBe('evt-2');
    expect(bobTurn.value.stateAfter.presence).toBe('blocked');
    expect(bobTurn.value.stateAfter.version).toBe(1);
  });

  it('新的回合上下文不继承已处理记录 → 重新执行', () => {
    const event = presenceEvent(fixture.registry, fixture.companyId, {
      eventId: 'in-fresh',
      subjectId: 'alice',
      presence: 'planning',
      actorId: 'alice',
    });
    const first = runWith(createRuntimeTurnContext(), event);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.status).toBe('completed');

    const fresh = runWith(createRuntimeTurnContext(), event);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.status).toBe('completed');
    expect(fresh.value.decision.reason).toBe('processed');
    expect(fresh.value.emittedEvents).toHaveLength(1);
  });

  it('重复判定优先于生命周期：offboarded 状态下重复事件仍返回 duplicate', () => {
    const turnContext = createRuntimeTurnContext();
    const event = presenceEvent(fixture.registry, fixture.companyId, {
      eventId: 'in-offboarded-dup',
      subjectId: 'alice',
      presence: 'thinking',
      actorId: 'alice',
    });
    const first = runWith(turnContext, event);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.status).toBe('completed');

    const offboarded = createInitialAgentState('alice' as EmployeeId, {
      employment: 'offboarded',
    });
    const second = runWith(turnContext, event, fixture.alice, offboarded);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.status).toBe('ignored');
    expect(second.value.decision.reason).toBe('duplicate');
    expect(second.value.stateAfter).toBe(offboarded);
  });
});
