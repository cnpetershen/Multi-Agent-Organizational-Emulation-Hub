import { describe, expect, it } from 'vitest';
import {
  layoutPlan,
  parsePlan,
  parsePlanList,
  parsePlanRecord,
  planStatusTone,
} from '../../../apps/web/src/plan';

/**
 * M3.4 · plan read model and canvas geometry.
 *
 * Two invariants matter: a missing document field becomes empty/`null` (never invented), and the
 * visual layer positions nodes by dependency depth so dragging cannot silently change execution
 * order.
 */

const PLAN = {
  planId: 'plan-1',
  companyId: 'future-ai-lab',
  version: 2,
  status: 'draft',
  orchestrationId: 'orch-1',
  orchestrationVersion: 1,
  requirementId: 'req-1',
  requirementVersion: 3,
  title: 'Weekly report',
  goal: 'Build a weekly report generator',
  nodes: [
    {
      nodeId: 'node-1',
      kind: 'task',
      title: 'Design',
      goal: 'Design the product',
      capability: 'technical_design',
      employeeId: 'cto-john',
      positionId: 'cto',
      inputs: ['requirement'],
      outputs: ['design doc'],
      acceptance: ['reviewed'],
      dependsOn: [],
    },
    {
      nodeId: 'node-2',
      kind: 'task',
      title: 'Implement',
      goal: 'Build it',
      capability: 'implementation',
      employeeId: 'engineer-mike',
      positionId: 'engineer',
      inputs: ['design doc'],
      outputs: ['app'],
      acceptance: ['runs'],
      dependsOn: ['node-1'],
    },
    {
      nodeId: 'node-approve',
      kind: 'approval',
      title: 'Human approval',
      goal: 'Approve',
      capability: null,
      employeeId: null,
      positionId: null,
      inputs: ['app'],
      outputs: ['decision'],
      acceptance: ['human sign-off'],
      dependsOn: ['node-1', 'node-2'],
    },
  ],
  order: ['node-1', 'node-2', 'node-approve'],
  validation: { ok: true, blockingCount: 0, warningCount: 0, issues: [], cycleNodeIds: [] },
  summary: { nodeCount: 3, taskCount: 2, employeeCount: 2, capabilities: [], deliverables: [] },
  change: null,
  workflowInstanceId: 'instance-1',
  createdAt: 'now',
  updatedAt: 'now',
  confirmedAt: null,
  confirmedBy: null,
  confirmationNote: null,
};

describe('M3.4 plan view', () => {
  it('parses a plan and its version record', () => {
    const plan = parsePlan(PLAN);
    expect(plan.status).toBe('draft');
    expect(plan.nodes).toHaveLength(3);
    expect(plan.nodes[1]?.dependsOn).toEqual(['node-1']);
    expect(plan.summary.taskCount).toBe(2);
    expect(plan.validation.ok).toBe(true);
    expect(plan.workflowInstanceId).toBe('instance-1');

    const record = parsePlanRecord({ planId: 'plan-1', currentVersion: 2, versions: [PLAN] });
    expect(record.versions).toHaveLength(1);
    expect(record.currentVersion).toBe(2);
    const list = parsePlanList({ plans: [{ planId: 'plan-1', title: 'Weekly report', status: 'draft', version: 2, blockingCount: 0 }] });
    expect(list[0]).toMatchObject({ planId: 'plan-1', version: 2 });
  });

  it('lays nodes out by depth and draws dependency edges', () => {
    const layout = layoutPlan(parsePlan(PLAN));
    const first = layout.boxes.get('node-1');
    const second = layout.boxes.get('node-2');
    const approval = layout.boxes.get('node-approve');
    expect(first?.x).toBeLessThan(second?.x ?? 0);
    expect(second?.x).toBeLessThan(approval?.x ?? 0);
    expect(layout.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'node-1', to: 'node-2', cycle: false }),
        expect.objectContaining({ from: 'node-2', to: 'node-approve', cycle: false }),
      ]),
    );
    expect(layout.layers.get('node-approve')).toBe(2);
  });

  it('marks edges in a cycle so the canvas can show the structural problem', () => {
    const cyclic = parsePlan({
      ...PLAN,
      nodes: [
        { ...PLAN.nodes[0], dependsOn: ['node-2'] },
        { ...PLAN.nodes[1], dependsOn: ['node-1'] },
      ],
      validation: {
        ok: false,
        blockingCount: 1,
        warningCount: 0,
        issues: [
          { code: 'dependency_cycle', severity: 'blocking', detail: 'cycle', nodeIds: ['node-1', 'node-2'] },
        ],
        cycleNodeIds: ['node-1', 'node-2'],
      },
    });
    const layout = layoutPlan(cyclic);
    expect(layout.edges.every((edge) => edge.cycle)).toBe(true);
    expect(planStatusTone('confirmed')).toBe('ok');
    expect(planStatusTone('draft')).toBe('warn');
  });
});
