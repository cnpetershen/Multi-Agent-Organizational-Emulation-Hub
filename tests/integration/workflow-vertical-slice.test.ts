import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CorrelationId, EmployeeId, OrgEvent, SimTime } from '@maoeh/shared-types';
import { ACTIONS } from '@maoeh/shared-types';
import type { AgentDefinition, AgentDefinitionSourceReader } from '@maoeh/agent-definition';
import { loadAgentDefinitions } from '@maoeh/agent-definition';
import type { CognitionProfile, CognitionSourceReader } from '@maoeh/agent-cognition';
import { createCognitionExecutor, loadCognitionProfiles } from '@maoeh/agent-cognition';
import type { AgentInstance } from '@maoeh/agent-runtime';
import { instantiateAgent, runAgentCognition } from '@maoeh/agent-runtime';
import { createLlmGateway, createMockLlmProvider } from '@maoeh/llm-gateway';
import type { Seq } from '@maoeh/event-store';
import { createInMemoryEventStore } from '@maoeh/event-store';
import type { Task } from '@maoeh/task-system';
import { applyTaskEvent } from '@maoeh/task-system';
import { replayWorkflowInstance, withoutBookkeeping } from '@maoeh/workflow-engine';
import type { WorkflowOperation } from '@maoeh/workflow-engine';
import { seedRoot } from '../helpers/communication-fixtures';
import { validOutput } from '../helpers/cognition-fixtures';
import { snapshotView } from '../helpers/organization-view';
import type { WorkflowFixture } from '../helpers/workflow-fixtures';
import { createWorkflowFixture, must, sim } from '../helpers/workflow-fixtures';

interface PlanStepSpec {
  readonly action: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly reasonRef?: number;
}

interface SliceResult {
  readonly fx: WorkflowFixture;
  readonly instanceId: string;
  readonly collected: readonly OrgEvent[];
  readonly finalOutcome: string;
  readonly providerCallCount: number;
}

function createAgentSourceReader(): AgentDefinitionSourceReader & CognitionSourceReader {
  return {
    async list(relativeDirectory) {
      const directory = join(seedRoot, relativeDirectory);
      if (!existsSync(directory)) return [];
      return readdirSync(directory)
        .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
        .map((entry) => `${relativeDirectory}/${entry}`)
        .sort();
    },
    async read(relativePath) {
      const filePath = join(seedRoot, relativePath);
      if (!existsSync(filePath)) return null;
      return readFileSync(filePath, 'utf8');
    },
  };
}

let cachedSlice: Promise<SliceResult> | undefined;

function findEvent(events: readonly OrgEvent[], type: string): OrgEvent {
  const found = events.find((event) => event.type === type);
  if (found === undefined) throw new Error(`event ${type} not found`);
  return found;
}

async function runSlice(): Promise<SliceResult> {
  const fx = createWorkflowFixture();
  const reader = createAgentSourceReader();

  const profilesResult = await loadCognitionProfiles({ reader });
  if (!profilesResult.ok) throw new Error('cognition profiles failed to load');
  const profiles: readonly CognitionProfile[] = profilesResult.value;

  const definitionsResult = await loadAgentDefinitions({
    reader,
    organization: fx.organization,
    cognitionProfileIds: profiles.map((profile) => profile.id),
  });
  if (!definitionsResult.ok) throw new Error('agent definitions failed to load');
  const definitions: readonly AgentDefinition[] = definitionsResult.value;

  const instances: AgentInstance[] = [];
  for (const definition of definitions) {
    const context = fx.identity.actorContext(
      definition.employeeId,
      `corr-m08-${definition.employeeId}` as CorrelationId,
    );
    const instantiated = instantiateAgent(definition, context, sim(0));
    if (!instantiated.ok) throw new Error(`instantiate failed for ${definition.id}`);
    instances.push(instantiated.value);
  }

  let nextPlanSteps: readonly PlanStepSpec[] = [];
  const provider = createMockLlmProvider({
    text: () => validOutput({ steps: nextPlanSteps }),
  });
  const executor = createCognitionExecutor({
    gateway: createLlmGateway({ providers: [provider], defaultProvider: 'mock', now: () => 1 }),
  });

  let clock = 0;
  const tick = (): SimTime => sim((clock += 1));
  const collected: OrgEvent[] = [];

  const cognize = async (
    phase: string,
    employeeId: EmployeeId,
    inputEvent: OrgEvent,
  ): Promise<readonly PlanStepSpec[]> => {
    const definition = definitions.find((entry) => entry.employeeId === employeeId);
    const instance = instances.find((entry) => entry.employeeId === employeeId);
    const profile =
      definition === undefined
        ? undefined
        : profiles.find((entry) => entry.id === definition.cognitionProfileId);
    if (definition === undefined || instance === undefined || profile === undefined) {
      throw new Error(`bootstrap incomplete for ${employeeId}`);
    }
    const outcome = await runAgentCognition({
      executor,
      requestId: `req-m08-${phase}`,
      instance,
      definition,
      actorContext: fx.identity.actorContext(employeeId, `corr-m08-${phase}` as CorrelationId),
      profile,
      organization: snapshotView(fx.organization, employeeId),
      inputEvent,
      simTime: tick(),
      maxLlmCalls: 1,
    });
    if (!outcome.ok) {
      throw new Error(
        `cognition failed for ${phase} [${outcome.error.code}]: ${outcome.error.issues
          .map((issue) => issue.field)
          .join(', ')}`,
      );
    }
    expect(outcome.value.cognition.llmMetadata.callCount).toBe(1);
    for (const step of outcome.value.cognition.plan.steps) {
      expect(ACTIONS).toContain(step.action);
    }
    return outcome.value.cognition.plan.steps as readonly PlanStepSpec[];
  };

  const executePlan = (
    steps: readonly PlanStepSpec[],
    employeeId: EmployeeId,
    instanceId: string,
  ): readonly OrgEvent[] => {
    const actor = fx.actor(employeeId);
    const before = collected.length;
    for (const step of steps) {
      const args = step.args ?? {};
      const taskId = String(args['taskId'] ?? '');
      switch (step.action) {
        case 'AcceptTask':
          collected.push(...must(fx.tasks.accept({ taskId, actor, simTime: tick() }), 'accept').events);
          break;
        case 'StartTask':
          collected.push(...must(fx.tasks.start({ taskId, actor, simTime: tick() }), 'start').events);
          break;
        case 'ProgressReport':
          collected.push(
            ...must(
              fx.tasks.submit({
                taskId,
                actor,
                simTime: tick(),
                submission: {
                  summary: String(args['summary'] ?? 'done'),
                  data: (args['data'] ?? {}) as Record<string, unknown>,
                },
              }),
              'submit',
            ).events,
          );
          break;
        case 'CastVote':
          collected.push(
            ...must(
              fx.engine.approve({
                instanceId,
                actor,
                decision: args['decision'] === 'denied' ? 'denied' : 'granted',
                simTime: tick(),
              }),
              'approve',
            ).events,
          );
          break;
        default:
          throw new Error(`unexpected planned action ${step.action}`);
      }
    }
    return collected.slice(before);
  };

  const advance = (
    instanceId: string,
    employeeId: EmployeeId,
    event: OrgEvent,
  ): WorkflowOperation => {
    const operation = must(
      fx.engine.advance({ instanceId, actor: fx.actor(employeeId), event, simTime: tick() }),
      'engine.advance',
    );
    collected.push(...operation.events);
    return operation;
  };

  const startOperation = must(
    fx.engine.start({
      workflowId: 'product-analysis',
      actor: fx.ceoActor,
      simTime: tick(),
      title: 'Analyze the market',
      goal: 'Explain the competitive landscape',
    }),
    'engine.start',
  );
  collected.push(...startOperation.events);
  const instanceId = startOperation.instance.instanceId;
  const intakeTaskId = startOperation.instance.stepStates['intake-brief']?.taskId ?? '';

  const runTaskPhase = async (
    phase: string,
    employeeId: EmployeeId,
    taskId: string,
    inputEvent: OrgEvent,
    data: Record<string, unknown>,
  ): Promise<readonly OrgEvent[]> => {
    nextPlanSteps = [
      { action: 'AcceptTask', args: { taskId }, reasonRef: 0 },
      { action: 'StartTask', args: { taskId }, reasonRef: 0 },
      {
        action: 'ProgressReport',
        args: { taskId, summary: `${phase} complete`, data },
        reasonRef: 1,
      },
    ];
    const plan = await cognize(phase, employeeId, inputEvent);
    expect(plan.map((step) => step.action)).toEqual(['AcceptTask', 'StartTask', 'ProgressReport']);
    return executePlan(plan, employeeId, instanceId);
  };

  // intake 步声明 product_requirement 能力，由产品座席 pm-bona 承担（而非 CEO）。
  const intakeEvents = await runTaskPhase(
    'intake',
    'pm-bona' as EmployeeId,
    intakeTaskId,
    findEvent(startOperation.events, 'Task.Assigned'),
    { problem: 'churn is rising', success_criteria: 'root causes identified' },
  );
  const afterIntake = advance(
    instanceId,
    'pm-bona' as EmployeeId,
    findEvent(intakeEvents, 'Task.ProgressReported'),
  );

  const designTaskId = afterIntake.instance.stepStates['design-approach']?.taskId ?? '';
  const designEvents = await runTaskPhase(
    'design',
    'cto-john' as EmployeeId,
    designTaskId,
    findEvent(afterIntake.events, 'Task.Assigned'),
    { approach: 'phased rollout', risks: ['capacity'] },
  );
  const afterDesign = advance(
    instanceId,
    'cto-john' as EmployeeId,
    findEvent(designEvents, 'Task.ProgressReported'),
  );
  expect(afterDesign.instance.status).toBe('blocked');

  nextPlanSteps = [{ action: 'CastVote', args: { decision: 'granted' }, reasonRef: 0 }];
  const approvalPlan = await cognize(
    'approval',
    'ceo-alex' as EmployeeId,
    findEvent(afterDesign.events, 'Workflow.ApprovalRequested'),
  );
  expect(approvalPlan.map((step) => step.action)).toEqual(['CastVote']);
  const approvalEvents = executePlan(approvalPlan, 'ceo-alex' as EmployeeId, instanceId);
  expect(fx.instance(instanceId)?.status).toBe('running');

  // delivery-synthesize 同样声明 product_requirement 能力，回到产品座席 pm-bona。
  const deliveryTaskId =
    fx.instance(instanceId)?.stepStates['delivery-synthesize']?.taskId ?? '';
  const deliveryEvents = await runTaskPhase(
    'delivery',
    'pm-bona' as EmployeeId,
    deliveryTaskId,
    findEvent(approvalEvents, 'Task.Assigned'),
    { recommendation: 'ship the analysis' },
  );
  const finalAdvance = advance(
    instanceId,
    'pm-bona' as EmployeeId,
    findEvent(deliveryEvents, 'Task.ProgressReported'),
  );

  return {
    fx,
    instanceId,
    collected,
    finalOutcome: finalAdvance.outcome,
    providerCallCount: provider.callCount,
  };
}

function slice(): Promise<SliceResult> {
  cachedSlice ??= runSlice();
  return cachedSlice;
}

describe('M0.8 集成：认知驱动的 CEO→CTO 竖切', () => {
  let result: SliceResult;

  beforeAll(async () => {
    result = await slice();
  });

  it('全流程到 InstanceCompleted：计划驱动 accept/start/submit/approve', () => {
    const { fx, instanceId, collected, finalOutcome, providerCallCount } = result;

    expect(finalOutcome).toBe('completed');
    expect(providerCallCount).toBe(4);

    const instance = fx.instance(instanceId);
    expect(instance).not.toBeNull();
    expect(instance?.status).toBe('completed');
    expect(instance?.currentStageId).toBe('delivery');
    expect(instance?.activeStepIds).toEqual([]);
    expect(instance?.stepStates['intake-brief']?.status).toBe('done');
    expect(instance?.stepStates['design-approach']?.status).toBe('done');
    expect(instance?.stepStates['design-gate']?.status).toBe('done');
    expect(instance?.stepStates['delivery-synthesize']?.status).toBe('done');

    const taskIds = [
      instance?.stepStates['intake-brief']?.taskId,
      instance?.stepStates['design-approach']?.taskId,
      instance?.stepStates['delivery-synthesize']?.taskId,
    ];
    for (const taskId of taskIds) {
      const task = fx.tasks.get(taskId ?? '');
      expect(task).not.toBeNull();
      expect(task?.status).toBe('completed');
      expect(task?.result).not.toBeNull();
      expect(task?.assignment.assigneeEmployeeId).not.toBeNull();
    }

    expect(collected.length).toBeGreaterThan(20);
    for (const event of collected) {
      expect(event.type).toMatch(/^(Task|Workflow)\./);
    }
    expect(
      collected.filter((event) => event.type === 'Workflow.InstanceCompleted'),
    ).toHaveLength(1);

    const finalSubmit = findEvent(
      collected.filter((event) => event.type === 'Task.ProgressReported').slice(-1),
      'Task.ProgressReported',
    );
    const duplicate = fx.engine.advance({
      instanceId,
      actor: fx.actor('pm-bona' as EmployeeId),
      event: finalSubmit,
      simTime: sim(999),
    });
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) return;
    expect(duplicate.value.outcome).toBe('duplicate');
    expect(duplicate.value.events).toEqual([]);
    expect(fx.instance(instanceId)?.status).toBe('completed');
  });

  it('event-store 追加后重放：实例与任务状态可完整重建', async () => {
    const { fx, instanceId, collected } = result;

    const eventStore = createInMemoryEventStore();
    await eventStore.append(collected);

    const replayed: OrgEvent[] = [];
    for await (const event of eventStore.replay(1 as Seq)) {
      replayed.push(event);
    }
    expect(replayed).toHaveLength(collected.length);

    const stored = fx.instance(instanceId);
    const replayedInstance = replayWorkflowInstance(replayed);
    if (stored === null || replayedInstance === null) {
      throw new Error('instance missing for replay comparison');
    }
    expect(withoutBookkeeping(replayedInstance)).toEqual(withoutBookkeeping(stored));

    const taskGroups = new Map<string, OrgEvent[]>();
    for (const event of replayed) {
      if (!event.type.startsWith('Task.')) continue;
      const payload = event.payload as { readonly taskId?: string };
      const taskId = payload.taskId;
      if (taskId === undefined) continue;
      taskGroups.set(taskId, [...(taskGroups.get(taskId) ?? []), event]);
    }
    expect(taskGroups.size).toBe(3);

    for (const [taskId, events] of taskGroups) {
      let replayedTask: Task | null = null;
      for (const event of events) {
        replayedTask = applyTaskEvent(replayedTask, event);
      }
      expect(replayedTask).not.toBeNull();
      expect(replayedTask).toEqual(fx.tasks.get(taskId));
    }
  });
});
