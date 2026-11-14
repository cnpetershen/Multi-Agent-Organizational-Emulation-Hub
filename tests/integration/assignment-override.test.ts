import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import { WORKFLOW_STEP_ASSIGNMENT_OVERRIDDEN } from '@maoeh/workflow-engine';
import { CONTROL_WORKFLOW_INSTANCE_ASSIGNMENT_OVERRIDDEN } from '@maoeh/organization-control';
import { collectEvents, createControlHarness } from '../helpers/control-fixtures';

/**
 * M1.8 · ControlPlane → engine → log → query 链路的纵切。
 *
 * 人类把未激活 task step 改派给指定员工，必须:
 * 1. 经过既有的 ControlWorkflow 鉴权(不是旁路);
 * 2. 落两个聚合的事件: `Control.WorkflowInstanceAssignmentOverridden`(谁/为什么)与
 *    `Workflow.StepAssignmentOverridden`(实例事实);
 * 3. 在读侧 (`/api/workflows/:id` 同形状) 直接投影为 `assignmentOverrides` + steps 上的
 *    `overridden` 标记;
 * 4. 不触碰 definition，也不影响其他实例。
 */
describe('control plane · assignment override (M1.8)', () => {
  it('accepts an override, records both facts on the log and projects them to the read model', async () => {
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();
    const before = await collectEvents(h.simulation.eventStore);

    const outcome = await h.plane.control.execute(
      h.command('Workflow.InstanceAssignmentOverride', {
        targetId: instanceId,
        reason: 'operator moved the design to a senior seat before activation',
        extra: {
          overrides: [{ stepId: 'design-approach', employeeId: 'cto-john' }],
        },
      }),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const after = await collectEvents(h.simulation.eventStore);
    const appended = after.slice(before.length).map((event: OrgEvent) => event.type);
    expect(appended).toContain(WORKFLOW_STEP_ASSIGNMENT_OVERRIDDEN);
    expect(appended).toContain(CONTROL_WORKFLOW_INSTANCE_ASSIGNMENT_OVERRIDDEN);

    const detail = h.plane.control.query.getWorkflow(instanceId);
    expect(detail?.assignmentOverrides).toEqual({ 'design-approach': 'cto-john' });
    const step = detail?.steps?.find((entry) => entry.stepId === 'design-approach');
    expect(step?.assigneeEmployeeId).toBe('cto-john');
    expect(step?.overridden).toBe(true);
    expect(step?.status).toBe('pending');

    // The audit trail records the command as accepted with both facts beside it.
    const audit = h.audit.find(outcome.commandId);
    expect(audit?.verdict).toBe('accepted');

    // Recovery (replay) keeps the override: the projection and the fold agree.
    await h.simulation.recover();
    const replayed = h.plane.control.query.getWorkflow(instanceId);
    expect(replayed?.assignmentOverrides).toEqual({ 'design-approach': 'cto-john' });
  });

  it('rejects a batch when one entry names a not-yet-entered approval step — nothing is written', async () => {
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();
    const before = await collectEvents(h.simulation.eventStore);

    const outcome = await h.plane.control.execute(
      h.command('Workflow.InstanceAssignmentOverride', {
        targetId: instanceId,
        reason: 'operator "fixed" the plan',
        extra: {
          overrides: [
            { stepId: 'design-approach', employeeId: 'cto-john' },
            { stepId: 'design-gate', employeeId: 'cto-john' },
          ],
        },
      }),
    );
    expect(outcome.status).toBe('rejected');
    expect(outcome.failure?.code).toBe('INVALID_COMMAND');

    const after = await collectEvents(h.simulation.eventStore);
    const appended = after.slice(before.length).map((event: OrgEvent) => event.type);
    expect(appended).not.toContain(WORKFLOW_STEP_ASSIGNMENT_OVERRIDDEN);
    expect(appended).not.toContain(CONTROL_WORKFLOW_INSTANCE_ASSIGNMENT_OVERRIDDEN);

    const detail = h.plane.control.query.getWorkflow(instanceId);
    expect(detail?.assignmentOverrides ?? {}).toEqual({});
  });

  it('rejects a stale expectedVersion instead of racing another editor', async () => {
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();

    const outcome = await h.plane.control.execute(
      h.command('Workflow.InstanceAssignmentOverride', {
        targetId: instanceId,
        reason: 'stale editor',
        expectedVersion: 999,
        extra: {
          overrides: [{ stepId: 'design-approach', employeeId: 'cto-john' }],
        },
      }),
    );
    expect(outcome.status).toBe('rejected');
    expect(outcome.failure?.code).toBe('STALE_VERSION');
  });
});
