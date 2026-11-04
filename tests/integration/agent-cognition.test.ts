import { beforeEach, describe, expect, it } from 'vitest';
import type { EmployeeId } from '@maoeh/shared-types';
import { ACTIONS } from '@maoeh/shared-types';
import type { CognitionStateView, OrganizationSnapshotView } from '@maoeh/agent-cognition';
import type { AgentInstance } from '@maoeh/agent-runtime';
import { runAgentCognition, toCognitionStateView } from '@maoeh/agent-runtime';
import { createCognitionExecutor } from '@maoeh/agent-cognition';
import { createLlmGateway, createMockLlmProvider } from '@maoeh/llm-gateway';
import { getLlmCalls, resetLlmCalls } from '@maoeh/observability';
import type { Organization } from '@maoeh/organization-model';
import { createRuntimeFixture, presenceEvent } from '../helpers/runtime-fixtures';
import { TEST_PROFILE, sim, testActorContext, testDefinition, validOutput } from '../helpers/cognition-fixtures';

function named(id: string, name: string): { readonly id: EmployeeId; readonly name: string } {
  return { id: id as EmployeeId, name };
}

function snapshotView(organization: Organization, employeeId: EmployeeId): OrganizationSnapshotView {
  const employee = organization.employees.find((candidate) => candidate.id === employeeId);
  if (employee === undefined) throw new Error(`employee ${employeeId} not found`);
  const position = organization.positions.find((candidate) => candidate.id === employee.positionId);
  if (position === undefined) throw new Error(`position for ${employeeId} not found`);

  const managerPositionId = position.reportsToPositionId;
  const managerEmployee =
    managerPositionId === null
      ? undefined
      : organization.employees.find((candidate) => candidate.positionId === managerPositionId);

  const reports = organization.employees.filter((candidate) => {
    const candidatePosition = organization.positions.find(
      (entry) => entry.id === candidate.positionId,
    );
    return candidatePosition !== undefined && candidatePosition.reportsToPositionId === position.id;
  });

  const peers = organization.employees.filter(
    (candidate) => candidate.positionId === position.id && candidate.id !== employee.id,
  );

  const department =
    position.departmentId === null
      ? null
      : (organization.departments.find((entry) => entry.id === position.departmentId) ?? null);

  const colleagues =
    department === null
      ? []
      : organization.employees
          .filter((candidate) => {
            const candidatePosition = organization.positions.find(
              (entry) => entry.id === candidate.positionId,
            );
            return (
              candidate.id !== employee.id &&
              candidatePosition !== undefined &&
              candidatePosition.departmentId === department.id
            );
          })
          .map((candidate) => named(candidate.id, candidate.name));

  return {
    company: { id: organization.company.id, name: organization.company.name },
    department: department === null ? null : { id: department.id, name: department.name },
    position: { id: position.id, title: position.title },
    employee: named(employee.id, employee.name),
    manager:
      managerEmployee === undefined ? null : named(managerEmployee.id, managerEmployee.name),
    reports: reports.map((candidate) => named(candidate.id, candidate.name)),
    peers: peers.map((candidate) => named(candidate.id, candidate.name)),
    colleagues,
  };
}

describe('M0.6 集成：AgentInstance → runAgentCognition → CognitionExecutor → LlmGateway', () => {
  beforeEach(() => {
    resetLlmCalls();
  });

  it('认知执行成功：产生计划、不改运行时状态、写入 llm_calls 观测记录', async () => {
    const fixture = createRuntimeFixture();
    const provider = createMockLlmProvider({ text: validOutput(), inputTokens: 15, outputTokens: 30 });
    const gateway = createLlmGateway({ providers: [provider], defaultProvider: 'mock', now: () => 5000 });
    const executor = createCognitionExecutor({ gateway });
    const instance: AgentInstance = fixture.alice;
    const event = presenceEvent(fixture.registry, fixture.companyId, {
      eventId: 'evt-m06-1',
      subjectId: 'alice',
      employeeId: 'alice',
      presence: 'thinking',
      occurredAtSim: 15,
    });

    const outcome = await runAgentCognition({
      executor,
      requestId: 'req-m06-1',
      instance,
      definition: testDefinition(),
      actorContext: fixture.aliceContext,
      profile: TEST_PROFILE,
      organization: snapshotView(fixture.organization, 'alice' as EmployeeId),
      inputEvent: event,
      simTime: sim(60),
      maxLlmCalls: 3,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { cognition, stateVersionBefore } = outcome.value;

    expect(stateVersionBefore).toBe(0);
    expect(cognition.plan.steps.length).toBeGreaterThan(0);
    for (const step of cognition.plan.steps) {
      expect(ACTIONS).toContain(step.action);
    }
    expect(cognition.llmMetadata.callCount).toBe(1);
    expect(cognition.llmMetadata.latencyMs).toBe(0);

    expect(instance.state.version).toBe(0);
    expect(instance.state.presence).toBe('idle');

    const records = getLlmCalls();
    expect(records).toHaveLength(1);
    expect(records[0]?.agentId).toBe('alice');
    expect(records[0]?.success).toBe(true);
    expect(provider.callCount).toBe(1);
  });

  it('相同输入重复执行 → 认知结果确定且状态不被污染', async () => {
    const fixture = createRuntimeFixture();
    const executor = createCognitionExecutor({
      gateway: createLlmGateway({
        providers: [createMockLlmProvider({ text: validOutput() })],
        defaultProvider: 'mock',
        now: () => 42,
      }),
    });
    const event = presenceEvent(fixture.registry, fixture.companyId, {
      eventId: 'evt-m06-2',
      subjectId: 'alice',
      employeeId: 'alice',
      presence: 'thinking',
      occurredAtSim: 16,
    });
    const input = {
      executor,
      instance: fixture.alice,
      definition: testDefinition(),
      actorContext: fixture.aliceContext,
      profile: TEST_PROFILE,
      organization: snapshotView(fixture.organization, 'alice' as EmployeeId),
      inputEvent: event,
      simTime: sim(60),
      maxLlmCalls: 3,
    };

    const first = await runAgentCognition({ ...input, requestId: 'req-m06-2' });
    const second = await runAgentCognition({ ...input, requestId: 'req-m06-2' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.cognition).toEqual(second.value.cognition);
    expect(fixture.alice.state.version).toBe(0);
  });

  it('ActorContext 与 agent 错配 → invalid_context，且 provider 不被调用', async () => {
    const fixture = createRuntimeFixture();
    const provider = createMockLlmProvider({ text: validOutput() });
    const executor = createCognitionExecutor({
      gateway: createLlmGateway({ providers: [provider], defaultProvider: 'mock' }),
    });
    const event = presenceEvent(fixture.registry, fixture.companyId, {
      eventId: 'evt-m06-3',
      subjectId: 'bob',
      employeeId: 'bob',
      presence: 'planning',
      occurredAtSim: 17,
    });

    const outcome = await runAgentCognition({
      executor,
      requestId: 'req-m06-3',
      instance: fixture.alice,
      definition: testDefinition(),
      actorContext: testActorContext('bob'),
      profile: TEST_PROFILE,
      organization: snapshotView(fixture.organization, 'alice' as EmployeeId),
      inputEvent: event,
      simTime: sim(60),
      maxLlmCalls: 3,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('invalid_context');
    expect(outcome.error.issues[0]?.field).toBe('actorContext.employeeId');
    expect(provider.callCount).toBe(0);
  });

  it('toCognitionStateView 只暴露认知所需的运行时状态切片', () => {
    const fixture = createRuntimeFixture();
    const view: CognitionStateView = toCognitionStateView(fixture.alice.state);
    expect(view).toEqual({
      employeeId: 'alice',
      version: 0,
      employment: 'defined',
      presence: 'idle',
      currentCycleId: null,
      agenda: [],
      updatedAtSim: 0,
    });
    expect('budget' in view).toBe(false);
    expect('health' in view).toBe(false);
    expect(Object.hasOwn(fixture.alice.state, 'budget')).toBe(true);
  });

  it('companyId 使用组织快照来源，不从认知结果推断', async () => {
    const fixture = createRuntimeFixture();
    const view = snapshotView(fixture.organization, 'alice' as EmployeeId);
    expect(view.company.id).toBe(fixture.companyId);
    expect(view.company.id).toBe('acme');
    expect(view.department).toBeNull();
    expect(view.employee).toEqual({ id: 'alice', name: 'Alice' });
  });
});
