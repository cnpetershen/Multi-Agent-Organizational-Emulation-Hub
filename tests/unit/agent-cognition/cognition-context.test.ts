import { describe, expect, it } from 'vitest';
import type { AgentDefinition } from '@maoeh/agent-definition';
import type { CognitionProfile, CognitionStateView, OrganizationSnapshotView } from '@maoeh/agent-cognition';
import { buildCognitionContext } from '@maoeh/agent-cognition';
import {
  TEST_PROFILE,
  testActorContext,
  testContext,
  testDefinition,
  testEvent,
  testOrganizationView,
  testStateView,
} from '../../helpers/cognition-fixtures';

function build(
  overrides: {
    readonly definition?: AgentDefinition;
    readonly actorContext?: ReturnType<typeof testActorContext> | undefined;
    readonly state?: CognitionStateView | undefined;
    readonly inputEvent?: ReturnType<typeof testEvent> | undefined;
    readonly organization?: OrganizationSnapshotView | undefined;
    readonly profile?: CognitionProfile | undefined;
  } = {},
) {
  const definition = overrides.definition ?? testDefinition();
  return buildCognitionContext({
    agent: {
      id: 'agent:agent-alice',
      definitionId: definition.id,
      employeeId: definition.employeeId,
    },
    definition,
    actorContext: 'actorContext' in overrides ? overrides.actorContext : testActorContext(),
    state: 'state' in overrides ? overrides.state : testStateView(),
    inputEvent: 'inputEvent' in overrides ? overrides.inputEvent : testEvent(),
    organization: 'organization' in overrides ? overrides.organization : testOrganizationView(),
    simTime: testContext().simTime,
    profile: 'profile' in overrides ? overrides.profile : TEST_PROFILE,
  });
}

describe('agent-cognition: buildCognitionContext 边界校验', () => {
  it('完整输入 → ok，并冻结上下文', () => {
    const result = build();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(result.value.agent.id).toBe('agent:agent-alice');
    expect(result.value.definition.cognitionProfileId).toBe(TEST_PROFILE.id);
    expect('memoryContext' in result.value).toBe(false);
    expect('knowledgeContext' in result.value).toBe(false);
  });

  it('可选的记忆/知识上下文被显式带上', () => {
    const result = buildCognitionContext({
      agent: {
        id: 'agent:agent-alice',
        definitionId: 'agent-alice',
        employeeId: testDefinition().employeeId,
      },
      definition: testDefinition(),
      actorContext: testActorContext(),
      state: testStateView(),
      inputEvent: testEvent(),
      organization: testOrganizationView(),
      simTime: testContext().simTime,
      profile: TEST_PROFILE,
      memoryContext: { notes: ['previous decision'] },
      knowledgeContext: { docs: ['runbook'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.memoryContext).toEqual({ notes: ['previous decision'] });
    expect(result.value.knowledgeContext).toEqual({ docs: ['runbook'] });
  });

  it('缺少 ActorContext → missing_actor_context', () => {
    const result = build({ actorContext: undefined });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('missing_actor_context');
  });

  it('定义与 agent 引用不匹配 → invalid_context', () => {
    const definition = testDefinition();
    const result = buildCognitionContext({
      agent: { id: 'agent:agent-bob', definitionId: 'agent-bob', employeeId: 'bob' as never },
      definition,
      actorContext: { ...testActorContext(), employeeId: 'bob' as never },
      state: testStateView({ employeeId: 'bob' as never }),
      inputEvent: testEvent(),
      organization: testOrganizationView(),
      simTime: testContext().simTime,
      profile: TEST_PROFILE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_context');
    expect(result.error.issues[0]?.field).toBe('definition.employeeId');
  });

  it('ActorContext 与 agent 不匹配 → invalid_context', () => {
    const result = build({ actorContext: testActorContext('bob') });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_context');
    expect(result.error.issues[0]?.field).toBe('actorContext.employeeId');
  });

  it('缺少状态 / 状态错配 → invalid_context', () => {
    const missing = build({ state: undefined });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.issues[0]?.field).toBe('state');

    const mismatched = build({ state: testStateView({ employeeId: 'bob' as never }) });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.error.issues[0]?.field).toBe('state.employeeId');
  });

  it('缺少输入事件 / 组织快照 → invalid_context', () => {
    const noEvent = build({ inputEvent: undefined });
    expect(noEvent.ok).toBe(false);
    if (!noEvent.ok) expect(noEvent.error.issues[0]?.field).toBe('inputEvent');

    const noOrg = build({ organization: undefined });
    expect(noOrg.ok).toBe(false);
    if (!noOrg.ok) expect(noOrg.error.issues[0]?.field).toBe('organization');
  });

  it('缺少认知画像 → invalid_profile', () => {
    const result = build({ profile: undefined });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_profile');
    expect(result.error.issues[0]?.field).toBe('profile.id');
  });
});
