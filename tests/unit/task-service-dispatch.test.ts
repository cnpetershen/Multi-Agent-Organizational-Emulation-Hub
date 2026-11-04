import { describe, expect, it } from 'vitest';
import type { EmployeeId, PositionId } from '@maoeh/shared-types';
import type { CommandActor, PermissionPolicy } from '@maoeh/permission-system';
import { positionGrant } from '@maoeh/permission-system';
import type { Organization } from '@maoeh/organization-model';
import type { TaskVerification } from '@maoeh/task-system';
import type { WorkflowFixture } from '../helpers/workflow-fixtures';
import {
  createWorkflowFixture,
  loadSeedOrganization,
  sim,
  workflowTestPolicy,
} from '../helpers/workflow-fixtures';

const pid = (value: string): PositionId => value as PositionId;
const eid = (value: string): EmployeeId => value as EmployeeId;

const VERIFICATION: TaskVerification = { kind: 'deterministic', requiredOutputKeys: ['result'] };

/** Production-shaped policy: DispatchWork for seats with org authority >= 2 (the CEO). */
const dispatchPolicy: PermissionPolicy = {
  grants: [
    ...workflowTestPolicy.grants,
    {
      subject: { kind: 'any' },
      action: 'DispatchWork',
      resource: 'position:*',
      minAuthority: { domain: 'org', level: 2 },
    },
  ],
  denies: [],
};

function dispatchWork(
  fx: WorkflowFixture,
  actor: CommandActor,
  positionId: string,
  title: string,
  verification: TaskVerification | null = VERIFICATION,
) {
  return fx.tasks.dispatch({
    actor,
    simTime: sim(1),
    positionId: pid(positionId),
    title,
    goal: `Goal for ${title}`,
    verification,
  });
}

describe('M1.4 S1 派发（TaskService.dispatch，ADR-014 A1–A6）', () => {
  it('happy path：Task.Created + Task.Assigned，粒度是岗位，归组到任务书', () => {
    const fx = createWorkflowFixture({ policy: dispatchPolicy });
    const actor = fx.ceoActor;

    const result = dispatchWork(fx, actor, 'engineer', 'Design the API');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.events.map((event) => event.type)).toEqual([
      'Task.Created',
      'Task.Assigned',
    ]);
    const task = result.value.task;
    expect(task.status).toBe('assigned');
    expect(task.assignment.positionId).toBe(pid('engineer'));
    expect(task.assignment.assigneeEmployeeId).toBe(eid('engineer-mike'));
    expect(task.verification?.requiredOutputKeys).toEqual(['result']);
    expect(task.assignmentReason).toContain('dispatched by');
    if (actor.kind === 'employee') {
      expect(task.correlationId).toBe(actor.context.correlationId);
    }
  });

  it('A1：org 权限不足的员工被拒（permission_denied），且不产生任何任务', () => {
    const fx = createWorkflowFixture({ policy: dispatchPolicy });
    const actor = fx.engineerActor;

    const result = dispatchWork(fx, actor, 'engineer', 'Work for myself');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('permission_denied');
    expect(fx.tasks.all()).toHaveLength(0);
  });

  it('A2：向汇报子树之外（自己的上级）派发被拒 out_of_scope', () => {
    const policy: PermissionPolicy = {
      grants: [
        ...workflowTestPolicy.grants,
        positionGrant(pid('engineer'), 'DispatchWork', 'position:*'),
      ],
      denies: [],
    };
    const fx = createWorkflowFixture({ policy });
    const actor = fx.engineerActor;

    const result = dispatchWork(fx, actor, 'cto', 'Tell my manager what to do');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('out_of_scope');
    expect(fx.tasks.all()).toHaveLength(0);
  });

  it('A3：向权威高于自己的下属席位派发被拒 insufficient_authority', () => {
    // Org fixture where the engineer seat outranks the CTO in `engineering` — inside the
    // CTO's reporting subtree (so A2 passes) but above the CTO's own level, which A3 forbids.
    const seed = loadSeedOrganization();
    const organization: Organization = {
      ...seed,
      positions: seed.positions.map((position) =>
        position.id === pid('engineer')
          ? { ...position, decisionDomains: { engineering: 5 } }
          : position,
      ),
    };
    const policy: PermissionPolicy = {
      grants: [
        ...workflowTestPolicy.grants,
        positionGrant(pid('cto'), 'DispatchWork', 'position:*'),
      ],
      denies: [],
    };
    const fx = createWorkflowFixture({ organization, policy });
    const actor = fx.ctoActor;

    const result = dispatchWork(fx, actor, 'engineer', 'Work below the line');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('insufficient_authority');
    expect(fx.tasks.all()).toHaveLength(0);
  });

  it('A4：同一任务书第 9 项被拒 dispatch_quota_exceeded，前 8 项成功', () => {
    const fx = createWorkflowFixture({ policy: dispatchPolicy });
    const actor = fx.ceoActor;
    const seats = [
      'engineer',
      'qa',
      'cto',
      'product-manager',
      'marketing-manager',
      'backend-engineer',
      'frontend-engineer',
      'ux-designer',
      'ai-researcher',
    ];

    for (let index = 0; index < 8; index += 1) {
      const result = dispatchWork(fx, actor, seats[index] ?? 'engineer', `item-${index + 1}`);
      expect(result.ok).toBe(true);
    }

    const ninth = dispatchWork(fx, actor, 'engineer', 'item-9');
    expect(ninth.ok).toBe(false);
    if (!ninth.ok) expect(ninth.error.code).toBe('dispatch_quota_exceeded');
    expect(fx.tasks.all()).toHaveLength(8);
  });

  it('A5：没有验收产出的工作项被拒 invalid_input，且不产生 Task.Created', () => {
    const fx = createWorkflowFixture({ policy: dispatchPolicy });
    const actor = fx.ceoActor;

    const missing = fx.tasks.dispatch({
      actor,
      simTime: sim(1),
      positionId: pid('engineer'),
      title: 'Unverifiable work',
      goal: 'No way to judge it',
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('invalid_input');

    const emptyKeys = dispatchWork(fx, actor, 'engineer', 'Empty output keys', {
      kind: 'deterministic',
      requiredOutputKeys: [],
    });
    expect(emptyKeys.ok).toBe(false);
    if (!emptyKeys.ok) expect(emptyKeys.error.code).toBe('invalid_input');

    expect(fx.tasks.all()).toHaveLength(0);
  });

  it('A6：同一任务书内重复派发同岗位同标题是幂等旁路，不产生第二条任务', () => {
    const fx = createWorkflowFixture({ policy: dispatchPolicy });
    const actor = fx.ceoActor;

    const first = dispatchWork(fx, actor, 'engineer', 'Same work');
    expect(first.ok).toBe(true);

    const second = dispatchWork(fx, actor, 'engineer', 'Same work');
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.task.taskId).toBe(first.value.task.taskId);
      expect(second.value.events).toHaveLength(0);
    }
    expect(fx.tasks.all().filter((task) => task.title === 'Same work')).toHaveLength(1);
  });

  it('派给自己是合法的（终裁类工作），仍受同一任务书配额约束', () => {
    const fx = createWorkflowFixture({ policy: dispatchPolicy });
    const actor = fx.ceoActor;

    const result = dispatchWork(fx, actor, 'ceo', 'Final verdict on the launch');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.assignment.positionId).toBe(pid('ceo'));
    expect(result.value.task.assignment.assigneeEmployeeId).toBe(eid('ceo-alex'));
  });
});
