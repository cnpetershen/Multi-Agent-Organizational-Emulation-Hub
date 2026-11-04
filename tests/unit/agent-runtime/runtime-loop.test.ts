import { describe, expect, it } from 'vitest';
import type { EmployeeId, EventType, OrgEvent } from '@maoeh/shared-types';
import { parseEventType } from '@maoeh/event-system';
import { createInitialAgentState } from '@maoeh/runtime-state';
import type { RuntimeTurnResult } from '@maoeh/agent-runtime';
import {
  createRuntimeTurnContext,
  decideRuntimeTurn,
  runAgentTurn,
  shouldHandle,
} from '@maoeh/agent-runtime';
import {
  createRuntimeFixture,
  presenceEvent,
  buildEvent,
  sim,
  unregisteredPresenceEvent,
} from '../../helpers/runtime-fixtures';

const fixture = createRuntimeFixture();

function turnInput(event: OrgEvent, state = fixture.alice.state) {
  return {
    agent: fixture.alice,
    state,
    actorContext: fixture.aliceContext,
    event,
    simTime: sim(42),
    registry: fixture.registry,
    turnContext: createRuntimeTurnContext(),
  };
}

function runTurn(event: OrgEvent, state = fixture.alice.state): RuntimeTurnResult {
  const result = runAgentTurn(turnInput(event, state));
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.issues.map((i) => i.field).join(', ')}`);
  }
  return result.value;
}

function ownPresenceEvent(eventId = 'in-1'): OrgEvent {
  return presenceEvent(fixture.registry, fixture.companyId, {
    eventId,
    subjectId: 'alice',
    presence: 'thinking',
    occurredAtSim: 10,
    actorId: 'alice',
    correlationId: 'corr-turn',
  });
}

describe('M0.5 Runtime Loop：runAgentTurn 成功回合', () => {
  it('属于自己的 Runtime.PresenceChanged → completed + 合法事件 + 状态推进', () => {
    const state = fixture.alice.state;
    const event = ownPresenceEvent();
    const result = runAgentTurn(turnInput(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const turn = result.value;

    expect(turn.status).toBe('completed');
    expect(turn.turnId).toBe('turn-1');
    expect(turn.agentId).toBe('agent:agent-alice');
    expect(turn.employeeId).toBe('alice');
    expect(turn.inputEvent).toBe(event);
    expect(turn.stateBefore).toBe(state);

    expect(turn.decision.kind).toBe('process');
    if (turn.decision.kind !== 'process') throw new Error('expected process decision');
    expect(turn.decision.reason).toBe('processed');
    expect(turn.decision.presence).toBe('thinking');
    expect(turn.decision.plan.goal).toBe('adopt presence "thinking"');
    expect(turn.decision.plan.steps).toHaveLength(1);
    expect(turn.decision.plan.steps[0]?.action).toBe('UpdatePresence');
    expect(turn.decision.plan.steps[0]?.args['presence']).toBe('thinking');
    expect(turn.decision.plan.steps[0]?.idempotencyKey).toBe('alice:in-1');

    expect(turn.emittedEvents).toHaveLength(1);
    const emitted = turn.emittedEvents[0];
    if (emitted === undefined) throw new Error('expected emitted event');
    expect(emitted.type).toBe('Runtime.PresenceChanged');
    expect(emitted.eventId).toBe('evt-1');
    expect(emitted.subjectId).toBe('alice');
    expect(emitted.actorId).toBe('alice');
    expect(emitted.causationId).toBe(event.eventId);
    expect(emitted.correlationId).toBe('corr-turn');
    expect(emitted.occurredAtSim).toBe(42);
    expect(emitted.companyId).toBe(fixture.companyId);
    expect(emitted.payload).toEqual({ employeeId: 'alice', presence: 'thinking' });

    expect(turn.stateAfter).not.toBe(state);
    expect(turn.stateAfter.presence).toBe('thinking');
    expect(turn.stateAfter.version).toBe(state.version + 1);
    expect(turn.stateAfter.updatedAtSim).toBe(42);
    expect(turn.stateAfter.employeeId).toBe('alice');
    expect(turn.stateAfter.branchId).toBe('live');
  });

  it('stateBefore 不可变：回合只读取 state，不修改传入对象', () => {
    const state = fixture.alice.state;
    const snapshot = JSON.parse(JSON.stringify(state));
    const result = runAgentTurn(turnInput(ownPresenceEvent('in-immutable')));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(state).toEqual(snapshot);
    expect(state.presence).toBe('idle');
    expect(state.version).toBe(0);
    expect(result.value.stateBefore).toBe(state);
    expect(result.value.stateAfter).not.toBe(result.value.stateBefore);
  });

  it('shouldHandle：自己 / 他人 / 不支持 / 不可运行 四种判定', () => {
    expect(shouldHandle(fixture.alice, ownPresenceEvent('in-a'), fixture.alice.state)).toBe(true);
    expect(shouldHandle(fixture.bob, ownPresenceEvent('in-b'), fixture.bob.state)).toBe(false);
    expect(
      shouldHandle(
        fixture.alice,
        buildEvent(fixture.registry, fixture.companyId, {
          eventId: 'in-c',
          subjectId: 'alice',
          type: 'Task.Completed',
          payload: { taskId: 'task-1' },
        }),
        fixture.alice.state,
      ),
    ).toBe(false);
    expect(
      shouldHandle(
        fixture.alice,
        ownPresenceEvent('in-d'),
        createInitialAgentState('alice' as EmployeeId, { employment: 'offboarded' }),
      ),
    ).toBe(false);
  });
});

describe('M0.5 Runtime Loop：ignore 路径', () => {
  it('其他 Agent 的事件 → ignored / event_for_other_agent，不产生业务事件，状态不变', () => {
    const state = fixture.alice.state;
    const event = presenceEvent(fixture.registry, fixture.companyId, {
      eventId: 'in-other',
      subjectId: 'bob',
      presence: 'blocked',
      actorId: 'bob',
    });
    const turn = runTurn(event, state);
    expect(turn.status).toBe('ignored');
    expect(turn.decision.kind).toBe('ignore');
    expect(turn.decision.reason).toBe('event_for_other_agent');
    expect(turn.decision.plan).toBeNull();
    expect(turn.emittedEvents).toEqual([]);
    expect(turn.stateAfter).toBe(state);
  });

  it('当前 Runtime 不支持的事件类型（已注册）→ ignored / unsupported_event_type', () => {
    const state = fixture.alice.state;
    const event = buildEvent(fixture.registry, fixture.companyId, {
      eventId: 'in-task',
      subjectId: 'alice',
      type: 'Task.Completed',
      payload: { taskId: 'task-1' },
    });
    const turn = runTurn(event, state);
    expect(turn.status).toBe('ignored');
    expect(turn.decision.reason).toBe('unsupported_event_type');
    expect(turn.emittedEvents).toEqual([]);
    expect(turn.stateAfter).toBe(state);
  });

  it('未注册但可解析的 Runtime 类型 → ignored / unsupported_event_type', () => {
    const state = fixture.alice.state;
    expect(parseEventType('Runtime.CycleStarted')).not.toBeNull();
    const turn = runTurn(unregisteredPresenceEvent(fixture.companyId), state);
    expect(turn.status).toBe('ignored');
    expect(turn.decision.reason).toBe('unsupported_event_type');
    expect(turn.emittedEvents).toEqual([]);
  });

  it('subjectId 缺失（unknown 不当作 process）→ ignored / unattributed_event', () => {
    const state = fixture.alice.state;
    const event = presenceEvent(fixture.registry, fixture.companyId, {
      eventId: 'in-no-subject',
      subjectId: null,
      employeeId: 'alice',
      presence: 'thinking',
    });
    const turn = runTurn(event, state);
    expect(turn.status).toBe('ignored');
    expect(turn.decision.reason).toBe('unattributed_event');
    expect(turn.emittedEvents).toEqual([]);
    expect(turn.stateAfter).toBe(state);
  });
});

describe('M0.5 Runtime Loop：reject 路径（业务拒绝，不抛异常）', () => {
  it('Agent 生命周期不允许执行（offboarded）→ rejected / agent_not_runnable', () => {
    const state = createInitialAgentState('alice' as EmployeeId, { employment: 'offboarded' });
    const result = runAgentTurn(turnInput(ownPresenceEvent('in-offboarded'), state));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const turn = result.value;
    expect(turn.status).toBe('rejected');
    expect(turn.decision.kind).toBe('reject');
    expect(turn.decision.reason).toBe('agent_not_runnable');
    expect(turn.decision.plan).toBeNull();
    expect(turn.emittedEvents).toEqual([]);
    expect(turn.stateAfter).toBe(state);
  });

  it('subjectId 与 payload.employeeId 矛盾 → rejected / event_payload_mismatch', () => {
    const state = fixture.alice.state;
    const event = presenceEvent(fixture.registry, fixture.companyId, {
      eventId: 'in-mismatch',
      subjectId: 'alice',
      employeeId: 'bob',
      presence: 'thinking',
    });
    const turn = runTurn(event, state);
    expect(turn.status).toBe('rejected');
    expect(turn.decision.reason).toBe('event_payload_mismatch');
    expect(turn.emittedEvents).toEqual([]);
    expect(turn.stateAfter).toBe(state);
  });

  it('payload presence 非法 → rejected / invalid_event_payload', () => {
    const state = fixture.alice.state;
    const event: OrgEvent = {
      seq: 0,
      eventId: 'in-bad-presence',
      companyId: fixture.companyId,
      type: 'Runtime.PresenceChanged' as EventType,
      version: 1,
      occurredAtSim: sim(10),
      occurredAtWall: '',
      actorKind: 'employee',
      actorId: 'alice',
      subjectType: 'employee',
      subjectId: 'alice',
      payload: { employeeId: 'alice', presence: 'floating' },
      causationId: null,
      correlationId: 'corr-turn',
      traceId: null,
    };
    const turn = runTurn(event, state);
    expect(turn.status).toBe('rejected');
    expect(turn.decision.reason).toBe('invalid_event_payload');
    expect(turn.emittedEvents).toEqual([]);
    expect(turn.stateAfter).toBe(state);
  });
});

describe('M0.5 Runtime Loop：输入不变量 → Result 错误（非 status）', () => {
  it('state 属于其他员工 → INVALID_STATE', () => {
    const result = runAgentTurn(
      turnInput(ownPresenceEvent('in-state'), createInitialAgentState('bob' as EmployeeId)),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_STATE');
    expect(result.error.issues.map((issue) => issue.field)).toEqual(['state.employeeId']);
  });

  it('actorContext 与 agent 不一致 → INVALID_TURN_INPUT', () => {
    const result = runAgentTurn({
      ...turnInput(ownPresenceEvent('in-actor')),
      actorContext: fixture.bobContext,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_TURN_INPUT');
    expect(result.error.issues.map((issue) => issue.field)).toEqual([
      'actorContext.employeeId',
    ]);
  });

  it('AgentInstance id 为空 → INVALID_AGENT_INSTANCE', () => {
    const result = runAgentTurn({
      ...turnInput(ownPresenceEvent('in-agent')),
      agent: { ...fixture.alice, id: '' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_AGENT_INSTANCE');
    expect(result.error.issues.map((issue) => issue.field)).toEqual(['agent.id']);
  });

  it('eventId 为空 → INVALID_TURN_INPUT', () => {
    const event = presenceEvent(fixture.registry, fixture.companyId, {
      eventId: 'placeholder',
      subjectId: 'alice',
      presence: 'thinking',
    });
    const result = runAgentTurn({
      ...turnInput(event),
      event: { ...event, eventId: '' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_TURN_INPUT');
    expect(result.error.issues.map((issue) => issue.field)).toEqual(['event.eventId']);
  });
});

describe('M0.5 Runtime Loop：decideRuntimeTurn 纯决策', () => {
  it('process 决策携带 Plan，ignore / reject 决策 plan 为 null', () => {
    const processDecision = decideRuntimeTurn({
      agent: fixture.alice,
      state: fixture.alice.state,
      event: ownPresenceEvent('in-decide'),
      alreadyProcessed: false,
    });
    expect(processDecision.kind).toBe('process');
    expect(processDecision.plan).not.toBeNull();

    const duplicate = decideRuntimeTurn({
      agent: fixture.alice,
      state: fixture.alice.state,
      event: ownPresenceEvent('in-decide'),
      alreadyProcessed: true,
    });
    expect(duplicate).toEqual({ kind: 'ignore', reason: 'duplicate', plan: null });
  });

  it('重复已处理事件的判定与 runAgentTurn 一致（reason duplicate）', () => {
    const event = ownPresenceEvent('in-decide-2');
    const decision = decideRuntimeTurn({
      agent: fixture.alice,
      state: fixture.alice.state,
      event,
      alreadyProcessed: true,
    });
    expect(decision.reason).toBe('duplicate');
    expect(shouldHandle(fixture.alice, event, fixture.alice.state)).toBe(true);
  });
});
