import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import { WORKFLOW_DRAFT_CONFIRMED } from '@maoeh/workflow-engine';
import { CONTROL_WORKFLOW_INSTANCE_CONFIRMED } from '@maoeh/organization-control';
import { collectEvents, createControlHarness } from '../helpers/control-fixtures';
import { must, sim } from '../helpers/workflow-fixtures';

/**
 * M1.9 · 草稿 → 二次确认 → 运行的纵切（Canvas 的后端契约）。
 *
 * capability 生成的 workflow 实例以 `draft` 落库、无步骤入场；人类在画布上看过后发
 * `Workflow.ConfirmStart`：内核进入入口阶段，审计落 `Control.WorkflowInstanceConfirmed`，
 * 读侧投影 `draft: false`。任何不是草稿的实例都会被拒绝，零副作用。
 */
describe('control plane · draft confirm (M1.9)', () => {
  it('confirms a capability-generated draft and projects the promotion', async () => {
    const h = await createControlHarness();
    const op = must(
      h.simulation.workflow.start({
        capabilities: ['implementation'],
        actor: h.harness.actor('ceo-alex'),
        simTime: sim(0),
        title: 'Feature draft',
        goal: 'Ship the capability.',
        awaitConfirmation: true,
      }),
      'draft start',
    );
    await h.simulation.inject(op.events);
    const instanceId = op.instance.instanceId;
    const before = await collectEvents(h.simulation.eventStore);

    // The read model shows the draft with nothing entered.
    const parked = h.plane.control.query.getWorkflow(instanceId);
    expect(parked?.draft).toBe(true);
    expect(parked?.stepStates).toEqual([]);

    const outcome = await h.plane.control.execute(
      h.command('Workflow.ConfirmStart', {
        targetId: instanceId,
        reason: 'plan approved on the canvas',
      }),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const after = await collectEvents(h.simulation.eventStore);
    const appended = after.slice(before.length).map((event: OrgEvent) => event.type);
    expect(appended).toContain(WORKFLOW_DRAFT_CONFIRMED);
    expect(appended).toContain(CONTROL_WORKFLOW_INSTANCE_CONFIRMED);

    const detail = h.plane.control.query.getWorkflow(instanceId);
    expect(detail?.draft).toBe(false);
    expect(detail?.stepStates.some((step) => step.status === 'active')).toBe(true);

    const audit = h.audit.find(outcome.commandId);
    expect(audit?.verdict).toBe('accepted');
  });

  it('refuses to confirm a template instance that started immediately — no side effects', async () => {
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();
    const before = await collectEvents(h.simulation.eventStore);

    const outcome = await h.plane.control.execute(
      h.command('Workflow.ConfirmStart', {
        targetId: instanceId,
        reason: 'attempt to re-confirm',
      }),
    );
    expect(outcome.status).toBe('rejected');
    expect(outcome.failure?.code).toBe('INVALID_STATE');

    const after = await collectEvents(h.simulation.eventStore);
    const appended = after.slice(before.length).map((event: OrgEvent) => event.type);
    expect(appended).not.toContain(WORKFLOW_DRAFT_CONFIRMED);
    expect(appended).not.toContain(CONTROL_WORKFLOW_INSTANCE_CONFIRMED);
  });
});
