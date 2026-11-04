import { describe, expect, it } from 'vitest';
import type { EmployeeId, PositionId } from '@maoeh/shared-types';
import {
  CAPABILITY_PLAN_CONTEXT_KEY,
} from '@maoeh/workflow-engine';
import {
  createWorkflowFixture,
  loadSeedOrganization,
  must,
  sim,
} from '../../helpers/workflow-fixtures';

/**
 * The engine's capability path: `start({ capabilities })` resolves the plan against the live
 * organization, saves a freshly generated definition and records the plan on the instance —
 * while the template path (`start({ workflowId })`) keeps its old behaviour exactly.
 */

describe('workflow engine: capability-driven start', () => {
  it('generates and stores the definition, with the plan carried on the instance', () => {
    const f = createWorkflowFixture();
    const operation = must(
      f.engine.start({
        capabilities: ['implementation', 'testing'],
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Board directive',
        goal: 'Own the churn problem.',
      }),
      'capability start',
    );
    expect(operation.outcome).toBe('transitioned');

    const instance = f.instance('instance-1');
    expect(instance).not.toBeNull();
    expect(instance?.workflowId).toBe('generated-instance-1');

    const definition = f.definitionStore.get('generated-instance-1');
    expect(definition).not.toBeNull();
    expect(definition?.stages.map((stage) => stage.stageId)).toEqual([
      'stage-1',
      'stage-2',
      'stage-approve',
    ]);
    expect(definition?.stages[0]?.steps[0]?.assignment).toEqual({
      kind: 'position',
      positionId: 'engineer',
    });

    expect(instance?.context[CAPABILITY_PLAN_CONTEXT_KEY]).toMatchObject({
      capabilities: ['implementation', 'testing'],
    });

    // The instance entered its first step: a real task for the resolving seat.
    const task = f.currentTask('instance-1');
    expect(task).not.toBeNull();
    expect(task?.title).toContain('Implementation');
  });

  it('enters a stage whose seat also carries a retired holder (M1.3 re-hire)', () => {
    // `Agent.Archive` is a status change, not a deletion, so re-hiring into a seat leaves the
    // previous holder's record pointing at it — and that record can be listed first. Resolving
    // the seat by "first match" handed back the retired employee, the step preflight refused it
    // (`employee "…" has employment status "offboarded"`) and the engine would not even start the
    // workflow, while the live holder sat right there in the same seat.
    const organization = loadSeedOrganization();
    organization.employees.unshift({
      id: 'qa-former' as EmployeeId,
      companyId: organization.company.id,
      positionId: 'qa' as PositionId,
      name: 'former-qa',
      status: 'offboarded',
    });
    const f = createWorkflowFixture({ organization });

    const operation = must(
      f.engine.start({
        capabilities: ['testing'],
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Board directive',
        goal: 'Verify the release.',
      }),
      'capability start with a retired seat holder',
    );
    expect(operation.outcome).toBe('transitioned');

    const task = f.currentTask('instance-1');
    expect(task?.assignment.positionId).toBe('qa');
    expect(task?.assignment.assigneeEmployeeId).toBe('qa-peter');
  });

  it('refuses capabilities no seat declares and starts nothing', () => {
    const f = createWorkflowFixture();
    const result = f.engine.start({
      capabilities: ['teleportation'],
      actor: f.ceoActor,
      simTime: sim(1),
      title: 'Impossible mandate',
      goal: 'Beam it up.',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error.code).toBe('invalid_input');
    expect(f.instanceStore.all()).toHaveLength(0);
    expect(f.definitionStore.all().some((definition) => definition.workflowId.startsWith('generated-'))).toBe(false);
  });

  it('requires a workflowId when starting without capabilities', () => {
    const f = createWorkflowFixture();
    const result = f.engine.start({
      actor: f.ceoActor,
      simTime: sim(1),
      title: 'Vague',
      goal: 'No id and no capabilities.',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error.code).toBe('invalid_input');
  });

  it('keeps the composing seat out of its own plan', () => {
    // The CEO both composes this plan and declares `product_requirement`. With the product seat
    // empty, the only staffed seat left for that capability is the CEO's own — and the work must
    // not come back to the seat that just dispatched it, so the plan simply omits it.
    const organization = loadSeedOrganization();
    organization.employees = organization.employees.filter(
      (employee) => String(employee.id) !== 'pm-bona',
    );
    const f = createWorkflowFixture({ organization });

    const result = f.engine.start({
      capabilities: ['product_requirement'],
      actor: f.ceoActor,
      simTime: sim(1),
      title: 'Own the roadmap',
      goal: 'Write the roadmap.',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error.code).toBe('invalid_input');
    expect(f.instanceStore.all()).toHaveLength(0);
  });

  it('a template declares the work, not the seat: the entry step lands on the product seat', () => {
    // `product-analysis` used to pin its intake and delivery steps to `position_id: ceo`, so the
    // CEO executed work in every instance of it. The step now declares `product_requirement` and
    // the live chart answers — the same routing a generated workflow uses.
    const f = createWorkflowFixture();
    const operation = must(
      f.engine.start({
        workflowId: 'product-analysis',
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Template run',
        goal: 'From disk.',
      }),
      'template start',
    );
    expect(operation.outcome).toBe('transitioned');
    const task = f.currentTask('instance-1');
    expect(task?.assignment.positionId).toBe('product-manager');
    expect(task?.assignment.assigneeEmployeeId).toBe('pm-bona');
  });

  it('keeps the template path unchanged', () => {
    const f = createWorkflowFixture();
    const operation = must(
      f.engine.start({
        workflowId: 'product-analysis',
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Template run',
        goal: 'From disk.',
      }),
      'template start',
    );
    expect(operation.outcome).toBe('transitioned');
    const instance = f.instance('instance-1');
    expect(instance?.workflowId).toBe('product-analysis');
    expect(instance?.context[CAPABILITY_PLAN_CONTEXT_KEY]).toBeUndefined();
    expect(f.currentTask('instance-1')).not.toBeNull();
  });

  it('every template starts, and its entry task is not handed back to the dispatching CEO', () => {
    // 模板路径在进入任务步时逐步 preflight：能力解析不了，模板根本开不起来——这是上面
    // 「声明的每个能力都有席位承接」那条定义层契约的运行时版本。
    // 另一半是路由方向：CEO 是派活的人，也是 `product_requirement` 的声明者之一，四个模板
    // 的入口任务一个都不该回到他手上（审批门才是他的位置）。
    for (const workflowId of ['product-analysis', 'product-development', 'hiring', 'decision-making']) {
      const f = createWorkflowFixture();
      const operation = must(
        f.engine.start({
          workflowId,
          actor: f.ceoActor,
          simTime: sim(1),
          title: 'Template run',
          goal: 'From disk.',
        }),
        `start ${workflowId}`,
      );
      expect(operation.outcome, workflowId).toBe('transitioned');
      const task = f.currentTask('instance-1');
      expect(task, workflowId).not.toBeNull();
      expect(task?.assignment.positionId, workflowId).not.toBe('ceo');
      expect(task?.assignment.assigneeEmployeeId, workflowId).not.toBe('ceo-alex');
    }
  });

  it('a template still starts when only the dispatching seat can carry the work', () => {
    // 两条路径的刻意差别：生成计划排除派活的席位（不执行自己的派工），模板不排——
    // 模板声明的是工作本身，派活的人只是启动它。把派活的席位排掉，只有一个员工的公司
    // 会连模板都开不起来，那既不是诚实，也不是「老板兜底空坑」的既有规则。
    const organization = loadSeedOrganization();
    organization.employees = organization.employees.filter(
      (employee) => String(employee.id) === 'ceo-alex',
    );
    const f = createWorkflowFixture({ organization });

    const operation = must(
      f.engine.start({
        workflowId: 'product-analysis',
        actor: f.ceoActor,
        simTime: sim(1),
        title: 'Template run',
        goal: 'From disk.',
      }),
      'template start with the CEO as the only holder',
    );
    expect(operation.outcome).toBe('transitioned');
    const task = f.currentTask('instance-1');
    expect(task?.assignment.positionId).toBe('ceo');
    expect(task?.assignment.assigneeEmployeeId).toBe('ceo-alex');
  });
});
