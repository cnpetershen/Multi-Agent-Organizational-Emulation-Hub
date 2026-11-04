import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import type { PermissionPolicy } from '@maoeh/permission-system';
import {
  approvalGateOpen,
  collectEvents,
  createControlHarness,
  humanDecidableWorkflowDefinitions,
} from '../helpers/control-fixtures';
import { loadSeedWorkflows } from '../helpers/simulation-fixtures';

/**
 * M1.0 §26 — the full vertical slice:
 *
 * Human Operator -> Control Command -> Permission -> Authority -> CEO
 *   -> Existing Simulation -> CEO Cognition -> CTO -> Workflow -> Task
 *   -> Agent Result -> CEO -> EventStore -> Audit -> Observation
 *
 * The gate step `design-gate` declares `required_roles: [ceo]`. `AuthzService.can()`
 * enforces that list against the actor's *position*, so a human operator can only decide the
 * gate if they actually hold the gate's role. Two policies are used below: one where the
 * operator does hold it (so the human approval drives the workflow), and one where the AI CEO
 * holds it (so the human attempt is refused by permission — never by a bypass).
 */
function operatorDecidesApprovals(): PermissionPolicy {
  return {
    grants: [
      { subject: { kind: 'any' }, action: 'ControlSimulation', resource: '*' },
      { subject: { kind: 'any' }, action: 'ControlAgent', resource: '*' },
      { subject: { kind: 'any' }, action: 'ControlWorkflow', resource: '*' },
      { subject: { kind: 'any' }, action: 'ControlTask', resource: '*' },
      { subject: { kind: 'any' }, action: 'InjectOrganizationInput', resource: '*' },
      { subject: { kind: 'any' }, action: 'CreateProposal', resource: 'workflow:*' },
      { subject: { kind: 'any' }, action: 'ApproveStep', resource: 'workflow:*' },
      { subject: { kind: 'any' }, action: 'RejectStep', resource: 'workflow:*' },
      { subject: { kind: 'any' }, action: 'CastVote', resource: 'workflow:*' },
      { subject: { kind: 'any' }, action: 'FinalizeDecision', resource: 'workflow:*' },
      { subject: { kind: 'any' }, action: 'RequestDeviation', resource: 'workflow:*' },
      { subject: { kind: 'any' }, action: 'AcceptTask', resource: 'task:*' },
      { subject: { kind: 'any' }, action: 'StartTask', resource: 'task:*' },
      { subject: { kind: 'any' }, action: 'ProgressReport', resource: 'task:*' },
      { subject: { kind: 'any' }, action: 'SubmitReport', resource: 'task:*' },
      { subject: { kind: 'any' }, action: 'CompleteTask', resource: 'task:*' },
      { subject: { kind: 'any' }, action: 'RejectTask', resource: 'task:*' },
      { subject: { kind: 'any' }, action: 'BlockTask', resource: 'task:*' },
      { subject: { kind: 'any' }, action: 'ReviewProposal', resource: 'task:*' },
      { subject: { kind: 'any' }, action: 'UpdatePresence', resource: 'runtime:*' },
    ],
    denies: [
      // The human operator is the gate decider; the AI CEO loses that authority.
      { subject: { kind: 'position', positionId: 'ceo' }, action: 'ApproveStep', resource: 'workflow:*' },
      { subject: { kind: 'position', positionId: 'ceo' }, action: 'CastVote', resource: 'workflow:*' },
      { subject: { kind: 'position', positionId: 'ceo' }, action: 'RejectStep', resource: 'workflow:*' },
    ],
  };
}

/**
 * Tenant workflow definitions for the human-approval scenario: the gate accepts the
 * `board-operator` role as well as `ceo`. The repository seed under `workflows/` is NOT
 * modified — M0.9 tests still assert the original `required_roles: [ceo]`.
 */
const HUMAN_DECIDABLE_WORKFLOWS = humanDecidableWorkflowDefinitions(loadSeedWorkflows());

describe('M1.0 end-to-end: human operator drives the autonomous company', () => {
  it('walks the complete Human -> Command -> Permission -> CEO -> CTO -> Workflow -> Task -> EventStore -> Audit -> Observation chain', async () => {
    const h = await createControlHarness({
      policy: operatorDecidesApprovals(),
      workflowDefinitions: HUMAN_DECIDABLE_WORKFLOWS,
    });

    // 1. Human starts the simulation.
    const start = await h.plane.control.execute(
      h.command('Simulation.Start', { reason: 'open the trading day' }),
    );
    expect(start.status, JSON.stringify(start.failure)).toBe('accepted');
    expect(h.simulation.scheduler.clock.currentTick).toBe(1);

    // 2. The simulation runs autonomously for a second tick.
    await h.simulation.tick();
    expect(h.simulation.scheduler.clock.currentTick).toBe(2);

    // 3. Human observes the agents.
    const agents = h.plane.control.query.getAgents();
    expect(agents.map((agent) => agent.employeeId)).toEqual([
      'ceo-alex',
      'cto-john',
      'engineer-mike',
      'marketing-jack',
      'operator-dana',
      'operator-erin',
      'pm-bona',
      'qa-peter',
    ]);
    const before = h.plane.control.query.getSimulationState();
    expect(before.status).toBe('running');
    expect(before.tick).toBe(2);

    // 4. Human injects a brand new task into the organization.
    const inject = await h.plane.control.execute(
      h.command('Organization.InjectTask', {
        targetType: 'organization',
        targetId: 'future-ai-lab',
        positionId: 'ceo',
        title: 'Research an adjacent market',
        goal: 'Decide whether to enter the adjacent market',
        reason: 'board requested a new analysis',
      } as never),
    );
    expect(inject.status, JSON.stringify(inject.failure)).toBe('accepted');
    expect(inject.events.some((eventId) => eventId.startsWith('evt-'))).toBe(true);

    // 5-7. CEO receives the injected task, decomposes it, and drives it through the
    //      existing workflow/task machinery (reused, not reimplemented).
    const instanceId = await h.harness.startProductAnalysis();
    const instanceAfterStart = h.plane.control.query.getWorkflow(instanceId);
    expect(instanceAfterStart, 'workflow instance must be observable').not.toBeNull();

    // 8. Run the workflow up to the human approval gate.
    let gateReached = false;
    for (let attempt = 0; attempt < 8 && !gateReached; attempt += 1) {
      await h.simulation.tick();
      gateReached = approvalGateOpen(h.simulation, instanceId);
    }
    expect(gateReached, 'the workflow must reach the approval gate').toBe(true);

    const atGate = h.plane.control.query.getWorkflow(instanceId);
    expect(atGate?.status).toBe('blocked');
    expect(atGate?.blockedReason?.kind).toBe('approval');
    expect(atGate?.approval?.status).toBe('open');

    // 9. Human approves the gate from the Control Plane.
    const approve = await h.plane.control.execute(
      h.command('Workflow.Approve', {
        targetType: 'workflow',
        targetId: instanceId,
        reason: 'board approves the technical approach',
      }),
    );
    expect(approve.status, JSON.stringify(approve.failure)).toBe('accepted');
    expect(approve.events.length).toBeGreaterThan(0);

    // 10-11. The workflow continues and the agents finish.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await h.simulation.tick();
      if (h.simulation.instanceStore.get(instanceId)?.status === 'completed') break;
    }
    const completed = h.plane.control.query.getWorkflow(instanceId);
    expect(completed?.status).toBe('completed');
    expect(completed?.activeStepIds).toEqual([]);

    const instance = h.simulation.instanceStore.get(instanceId);
    for (const stepId of [
      'intake-brief',
      'design-approach',
      'design-gate',
      'delivery-synthesize',
    ]) {
      expect(instance?.stepStates[stepId]?.status, stepId).toBe('done');
    }

    // 12. Human can query the final state from the Control Plane.
    const snapshot = await h.plane.control.query.getOrganizationSnapshot();
    expect(snapshot.company.id).toBe('future-ai-lab');
    expect(snapshot.simulation.tick).toBe(h.simulation.scheduler.clock.currentTick);
    expect(snapshot.tasks.length).toBeGreaterThan(0);
    expect(snapshot.workflows.some((entry) => entry.instanceId === instanceId)).toBe(true);
    expect(snapshot.recentEvents.length).toBeGreaterThan(0);

    // 13. Every human operation is audited.
    for (const commandId of ['cmd-1', 'cmd-2', 'cmd-3']) {
      const record = h.audit.find(commandId);
      expect(record, commandId).not.toBeNull();
      expect(record?.verdict, commandId).toBe('accepted');
    }
    const audits = h.plane.control.query.getRecentAudits(50);
    expect(audits.length).toBe(3);
    expect(audits.map((entry) => entry.actionType).sort()).toEqual([
      'Organization.InjectTask',
      'Simulation.Start',
      'Workflow.Approve',
    ]);
    expect(audits.every((entry) => entry.actorId === 'operator-dana')).toBe(true);

    // Command -> Event -> State correlation.
    const events = await collectEvents(h.simulation.eventStore);
    const approvalEvents = events.filter(
      (event: OrgEvent) => event.type === 'Control.WorkflowApprovalDecided',
    );
    expect(approvalEvents).toHaveLength(1);
    expect((approvalEvents[0]?.payload as { readonly commandId?: string }).commandId).toBe('cmd-3');
    expect(
      (approvalEvents[0]?.payload as { readonly decision?: string }).decision,
    ).toBe('granted');

    // 14. Recovery leaves the state correct.
    const report = await h.simulation.recover();
    expect(report.workflowInstanceCount).toBeGreaterThanOrEqual(1);
    const afterRecovery = h.plane.control.query.getWorkflow(instanceId);
    expect(afterRecovery?.status).toBe('completed');
    expect(h.plane.control.query.getSimulationState().tick).toBe(report.tickNumber);
  });

  it('rejects the approval when the operator cannot decide the gate', async () => {
    // A policy where the operator has control grants but the AI CEO owns approval:
    // the human approval command must still go through permission/authority, not a bypass.
    const h = await createControlHarness();
    const instanceId = await h.harness.startProductAnalysis();
    let gateReached = false;
    for (let attempt = 0; attempt < 8 && !gateReached; attempt += 1) {
      await h.simulation.tick();
      gateReached = approvalGateOpen(h.simulation, instanceId);
    }
    // The AI CEO auto-approves here, so the workflow completes without the human.
    const final = h.plane.control.query.getWorkflow(instanceId);
    expect(['completed', 'blocked']).toContain(final?.status);

    const approve = await h.plane.control.execute(
      h.command('Workflow.Approve', {
        targetType: 'workflow',
        targetId: instanceId,
        reason: 'late human approval attempt',
      }),
    );
    // The operator holds `ControlWorkflow` but not the gate's `ceo` role, so the attempt is
    // refused by the existing permission/authority path — never by a silent state write.
    expect(approve.status).toBe('rejected');
    expect(approve.failure?.code).toBe('UNAUTHORIZED');
    // The refusal itself is recorded on the event log (as `Control.CommandRejected`), but no
    // domain change happened: the workflow is untouched.
    expect(approve.events).toHaveLength(1);
    expect(h.plane.control.query.getWorkflow(instanceId)?.status).toBe(final?.status);
  });
});
