import { describe, expect, it } from 'vitest';
import type { AuthorityLevel, DecisionDomain, OrgEvent, PositionId } from '@maoeh/shared-types';
import type { CommandActor } from '@maoeh/permission-system';
import { systemActor } from '@maoeh/permission-system';
import type { WorkflowDefinition, WorkflowOperation } from '@maoeh/workflow-engine';
import type { WorkflowFixture } from '../helpers/workflow-fixtures';
import { createWorkflowFixture, must, sim } from '../helpers/workflow-fixtures';

interface ApprovalOptions {
  readonly workflowId: string;
  readonly requiredRoles?: readonly string[];
  readonly approvalPolicy?: 'single' | 'quorum' | 'all';
  readonly requiredCount?: number;
  readonly requiredAuthority?: {
    readonly domain: DecisionDomain;
    readonly level: AuthorityLevel;
  } | null;
}

function approvalFlowDefinition(options: ApprovalOptions): WorkflowDefinition {
  return {
    workflowId: options.workflowId,
    version: 1,
    name: 'Approval Flow',
    description: null,
    cyclePolicy: 'forbid',
    entryStageId: 'gate-stage',
    terminalStageIds: ['gate-stage'],
    stages: [
      {
        stageId: 'gate-stage',
        name: 'Gate',
        steps: [
          {
            stepId: 'gate',
            name: 'Approval gate',
            kind: 'approval',
            description: null,
            assignment: null,
            verification: null,
            maxAttempts: 1,
            requiredAuthority: options.requiredAuthority ?? null,
            requiredRoles: options.requiredRoles ?? [],
            approvalPolicy: options.approvalPolicy ?? 'single',
            requiredCount: options.requiredCount ?? 1,
          },
        ],
        transitions: [
          {
            transitionId: 'gate__granted',
            fromStepId: 'gate',
            when: { kind: 'approval_decision', decision: 'granted' },
            to: { kind: 'complete' },
          },
          {
            transitionId: 'gate__denied',
            fromStepId: 'gate',
            when: { kind: 'approval_decision', decision: 'denied' },
            to: { kind: 'fail', reason: 'gate_denied' },
          },
        ],
      },
    ],
  };
}

interface GateFixture {
  readonly fx: WorkflowFixture;
  readonly instanceId: string;
}

function startApprovalFlow(
  fx: WorkflowFixture,
  workflowId: string,
): { readonly instanceId: string } {
  const started = must(
    fx.engine.start({
      workflowId,
      actor: fx.ceoActor,
      simTime: sim(0),
      title: 'Approval run',
      goal: 'Exercise the approval gate',
    }),
    'engine.start',
  );
  return { instanceId: started.instance.instanceId };
}

function startProductAnalysis(fx: WorkflowFixture): WorkflowOperation {
  return must(
    fx.engine.start({
      workflowId: 'product-analysis',
      actor: fx.ceoActor,
      simTime: sim(0),
      title: 'Analyze the market',
      goal: 'Explain the competitive landscape',
    }),
    'engine.start',
  );
}

function settleStep(
  fx: WorkflowFixture,
  instanceId: string,
  taskId: string,
  actor: CommandActor,
  data: Record<string, unknown>,
): ReturnType<WorkflowFixture['engine']['advance']> {
  must(fx.tasks.accept({ taskId, actor, simTime: sim(1) }), 'tasks.accept');
  must(fx.tasks.start({ taskId, actor, simTime: sim(2) }), 'tasks.start');
  const submitted = must(
    fx.tasks.submit({
      taskId,
      actor,
      simTime: sim(3),
      submission: { summary: 'done', data },
    }),
    'tasks.submit',
  );
  return fx.engine.advance({
    instanceId,
    actor,
    event: submitted.events[0] as OrgEvent,
    simTime: sim(4),
  });
}

function driveToDesignGate(fx: WorkflowFixture): GateFixture {
  const start = startProductAnalysis(fx);
  const instanceId = start.instance.instanceId;
  const intakeTaskId = start.instance.stepStates['intake-brief']?.taskId ?? '';

  // The intake step is driven by whoever routing assigned it (the product seat), and the design
  // step by whoever provides `technical_design` — both are routing's answer, not the test's.
  const afterIntake = settleStep(fx, instanceId, intakeTaskId, fx.executorActor(intakeTaskId), {
    problem: 'churn is rising',
    success_criteria: 'root causes identified',
  });
  if (!afterIntake.ok) throw new Error(`intake advance failed [${afterIntake.error.code}]`);

  const designTaskId =
    afterIntake.value.instance.stepStates['design-approach']?.taskId ?? '';
  const afterDesign = settleStep(fx, instanceId, designTaskId, fx.ctoActor, {
    approach: 'phased rollout',
    risks: ['capacity'],
  });
  if (!afterDesign.ok) throw new Error(`design advance failed [${afterDesign.error.code}]`);
  if (afterDesign.value.instance.status !== 'blocked') {
    throw new Error(`expected blocked instance, got ${afterDesign.value.instance.status}`);
  }
  return { fx, instanceId };
}

describe('M0.8 审批决策（workflow-engine approve）', () => {
  it('CEO 批准后推进到 delivery', () => {
    const fx = createWorkflowFixture();
    const { instanceId } = driveToDesignGate(fx);

    const approved = must(
      fx.engine.approve({
        instanceId,
        actor: fx.ceoActor,
        decision: 'granted',
        simTime: sim(5),
        reason: 'looks good',
      }),
      'engine.approve',
    );
    expect(approved.outcome).toBe('transitioned');
    expect(approved.events.map((event) => event.type)).toEqual([
      'Workflow.ApprovalGranted',
      'Workflow.StepCompleted',
      'Task.Created',
      'Task.Assigned',
      'Workflow.StepEntered',
    ]);
    expect(approved.events[0]?.actorId).toBe('ceo-alex');

    const instance = approved.instance;
    expect(instance.status).toBe('running');
    expect(instance.currentStageId).toBe('delivery');
    expect(instance.stepStates['design-gate']?.status).toBe('done');
    expect(instance.stepStates['design-gate']?.outcome).toBe('granted');
    expect(instance.stepStates['delivery-synthesize']?.status).toBe('active');
    expect(instance.approval?.status).toBe('granted');
    expect(instance.approval?.grantedBy).toEqual(['ceo-alex']);
    expect(instance.blockedReason).toBeNull();
  });

  it('无 required_roles 的角色被拒 → permission_denied（OUT_OF_SCOPE）', () => {
    // 只声明角色、不声明等级的门：越权审批必须落在角色检查上（等级检查见下一个用例）。
    const definition = approvalFlowDefinition({ workflowId: 'wf-roles', requiredRoles: ['ceo'] });
    const fx = createWorkflowFixture({ definitions: [definition] });
    const { instanceId } = startApprovalFlow(fx, 'wf-roles');

    const denied = fx.engine.approve({
      instanceId,
      actor: fx.engineerActor,
      decision: 'granted',
      simTime: sim(1),
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe('permission_denied');
    expect(denied.error.issues[0]?.reason).toContain('OUT_OF_SCOPE');
    expect(fx.instance(instanceId)?.status).toBe('blocked');
    expect(fx.instance(instanceId)?.approval?.status).toBe('open');
  });

  it('种子审批门带上等级：product L3 的门拒绝工程师（等级先于角色判定）', () => {
    const fx = createWorkflowFixture();
    const { instanceId } = driveToDesignGate(fx);

    // `product-analysis/design-gate` 现在同时声明 required_roles 与 required_authority：
    // 角色不符的工程师先撞上等级检查，而不是拿到 OUT_OF_SCOPE。
    const refused = fx.engine.approve({
      instanceId,
      actor: fx.engineerActor,
      decision: 'granted',
      simTime: sim(5),
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('authority_insufficient');
    expect(refused.error.issues[0]?.field).toBe('authority');
    expect(fx.instance(instanceId)?.status).toBe('blocked');
    expect(fx.instance(instanceId)?.approval?.status).toBe('open');
  });

  it('quorum 两票：同人重复决策被拒，双人批准后实例完成', () => {
    const definition = approvalFlowDefinition({
      workflowId: 'wf-quorum',
      requiredRoles: ['ceo', 'cto'],
      approvalPolicy: 'quorum',
      requiredCount: 2,
    });
    const fx = createWorkflowFixture({ definitions: [definition] });
    const { instanceId } = startApprovalFlow(fx, 'wf-quorum');

    const first = must(
      fx.engine.approve({ instanceId, actor: fx.ceoActor, decision: 'granted', simTime: sim(1) }),
      'first approve',
    );
    expect(first.outcome).toBe('awaiting_approval');
    expect(first.instance.approval?.grantedBy).toEqual(['ceo-alex']);
    expect(first.instance.status).toBe('blocked');

    const duplicate = fx.engine.approve({
      instanceId,
      actor: fx.ceoActor,
      decision: 'granted',
      simTime: sim(2),
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('approval_already_decided');

    const second = must(
      fx.engine.approve({ instanceId, actor: fx.ctoActor, decision: 'granted', simTime: sim(3) }),
      'second approve',
    );
    expect(second.outcome).toBe('completed');
    expect(second.events.map((event) => event.type)).toEqual([
      'Workflow.ApprovalGranted',
      'Workflow.StepCompleted',
      'Workflow.InstanceCompleted',
    ]);
    expect(second.instance.status).toBe('completed');
    expect(second.instance.approval?.grantedBy).toEqual(['ceo-alex', 'cto-john']);

    const afterTerminal = fx.engine.approve({
      instanceId,
      actor: fx.engineerActor,
      decision: 'granted',
      simTime: sim(4),
    });
    expect(afterTerminal.ok).toBe(false);
    if (!afterTerminal.ok) expect(afterTerminal.error.code).toBe('instance_terminal');
  });

  it('系统裁决被拒；未达审批点 → approval_not_open', () => {
    const fx = createWorkflowFixture();
    const { instanceId } = driveToDesignGate(fx);

    const systemDecision = fx.engine.approve({
      instanceId,
      actor: systemActor('workflow-bot', 'corr-bot'),
      decision: 'granted',
      simTime: sim(5),
    });
    expect(systemDecision.ok).toBe(false);
    if (!systemDecision.ok) expect(systemDecision.error.code).toBe('invalid_actor');

    const start = startProductAnalysis(fx);
    const tooEarly = fx.engine.approve({
      instanceId: start.instance.instanceId,
      actor: fx.ceoActor,
      decision: 'granted',
      simTime: sim(1),
    });
    expect(tooEarly.ok).toBe(false);
    if (!tooEarly.ok) expect(tooEarly.error.code).toBe('approval_not_open');
  });

  it('拒绝批准 → 步 rejected + 实例 aborted，审批记录保留', () => {
    const fx = createWorkflowFixture();
    const { instanceId } = driveToDesignGate(fx);

    const denied = must(
      fx.engine.approve({
        instanceId,
        actor: fx.ceoActor,
        decision: 'denied',
        simTime: sim(5),
        reason: 'insufficient evidence',
      }),
      'engine.approve',
    );
    expect(denied.outcome).toBe('aborted');
    expect(denied.events.map((event) => event.type)).toEqual([
      'Workflow.ApprovalDenied',
      'Workflow.StepRejected',
      'Workflow.InstanceAborted',
    ]);
    expect(denied.instance.status).toBe('aborted');
    expect(denied.instance.stepStates['design-gate']?.status).toBe('rejected');
    expect(denied.instance.stepStates['design-gate']?.outcome).toBe('insufficient evidence');
    expect(denied.instance.approval?.status).toBe('denied');
    expect(denied.instance.approval?.decidedBy).toBe('ceo-alex');
    expect(denied.instance.approval?.reason).toBe('insufficient evidence');
  });

  it('权威不足 → authority_insufficient（先于权限检查）', () => {
    // 角色是满足的（engineer 在 required_roles 里），唯一不满足的是等级：被拒只可能来自权威
    // 检查，因此这条用例同时证明它先于权限检查执行。
    const definition = approvalFlowDefinition({
      workflowId: 'wf-authority',
      requiredRoles: ['engineer'],
      requiredAuthority: { domain: 'org', level: 3 },
    });
    const fx = createWorkflowFixture({ definitions: [definition] });
    const { instanceId } = startApprovalFlow(fx, 'wf-authority');

    const refused = fx.engine.approve({
      instanceId,
      actor: fx.engineerActor,
      decision: 'granted',
      simTime: sim(1),
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe('authority_insufficient');
    expect(refused.error.issues[0]?.field).toBe('authority');
    expect(fx.instance(instanceId)?.status).toBe('blocked');
  });

  it('review 验证：pending 暂缓，评审通过后完成实例', () => {
    const definition: WorkflowDefinition = {
      workflowId: 'wf-review',
      version: 1,
      name: 'Review Flow',
      description: null,
      cyclePolicy: 'forbid',
      entryStageId: 's',
      terminalStageIds: ['s'],
      stages: [
        {
          stageId: 's',
          name: 'S',
          steps: [
            {
              stepId: 'author',
              name: 'Author the plan',
              kind: 'task',
              description: null,
              assignment: { kind: 'position', positionId: 'ceo' as PositionId },
              verification: { kind: 'review', requiredOutputKeys: ['plan'] },
              maxAttempts: 1,
              requiredAuthority: null,
              requiredRoles: [],
              approvalPolicy: 'single',
              requiredCount: 1,
            },
          ],
          transitions: [
            {
              transitionId: 'author__completed',
              fromStepId: 'author',
              when: { kind: 'task_status', status: 'completed' },
              to: { kind: 'complete' },
            },
          ],
        },
      ],
    };
    const fx = createWorkflowFixture({ definitions: [definition] });
    const started = must(
      fx.engine.start({
        workflowId: 'wf-review',
        actor: fx.ceoActor,
        simTime: sim(0),
        title: 'Review run',
        goal: 'Exercise review verification',
      }),
      'engine.start',
    );
    const instanceId = started.instance.instanceId;
    const taskId = started.instance.stepStates['author']?.taskId ?? '';

    must(fx.tasks.accept({ taskId, actor: fx.ceoActor, simTime: sim(1) }), 'accept');
    must(fx.tasks.start({ taskId, actor: fx.ceoActor, simTime: sim(2) }), 'start');
    const submitted = must(
      fx.tasks.submit({
        taskId,
        actor: fx.ceoActor,
        simTime: sim(3),
        submission: { summary: 'plan ready', data: { plan: 'phase one' } },
      }),
      'submit',
    );
    const pending = fx.engine.advance({
      instanceId,
      actor: fx.ceoActor,
      event: submitted.events[0] as OrgEvent,
      simTime: sim(4),
    });
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value.outcome).toBe('verification_pending');
    expect(pending.value.events).toEqual([]);
    expect(pending.value.instance.stepStates['author']?.status).toBe('active');
    expect(fx.tasks.get(taskId)?.status).toBe('submitted');

    const reviewed = must(
      fx.tasks.review({
        taskId,
        actor: fx.ctoActor,
        simTime: sim(5),
        review: { verdict: 'approved', reason: 'sound plan' },
      }),
      'tasks.review',
    );
    const completed = fx.engine.advance({
      instanceId,
      actor: fx.ctoActor,
      event: reviewed.events[0] as OrgEvent,
      simTime: sim(5),
    });
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.outcome).toBe('completed');
    expect(completed.value.events.map((event) => event.type)).toEqual([
      'Task.Completed',
      'Workflow.StepCompleted',
      'Workflow.InstanceCompleted',
    ]);
    expect(completed.value.instance.status).toBe('completed');
    expect(completed.value.instance.stepStates['author']?.outcome).toBe('verified');
    expect(fx.tasks.get(taskId)?.status).toBe('completed');
  });
});
