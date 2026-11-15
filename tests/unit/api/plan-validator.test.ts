import { describe, expect, it } from 'vitest';
import { validatePlan } from '../../../apps/api/src/plan-validator';
import type { PlanNode } from '../../../apps/api/src/planning-types';
import { loadSeedOrganization } from '../../helpers/simulation-fixtures';

/**
 * M3.4 · plan validation is the gate between "editable" and "confirmed".
 *
 * Saving an invalid draft is allowed (a human is mid-edit); confirming it is not. These tests pin
 * each blocking rule and the derived topological order.
 */

const ORGANIZATION = loadSeedOrganization();

function node(overrides: Partial<PlanNode> & Pick<PlanNode, 'nodeId'>): PlanNode {
  return {
    nodeId: overrides.nodeId,
    kind: 'task',
    title: 'Task',
    goal: 'Deliver the task',
    capability: 'implementation',
    employeeId: 'engineer-mike',
    positionId: 'engineer',
    inputs: ['需求 v3'],
    outputs: ['交付物'],
    acceptance: ['可检查的验收标准'],
    dependsOn: [],
    ...overrides,
  };
}

function validNodes(): PlanNode[] {
  return [
    node({
      nodeId: 'node-1',
      title: 'Technical Design',
      capability: 'technical_design',
      employeeId: 'cto-john',
      positionId: 'cto',
      outputs: ['技术设计文档'],
    }),
    node({
      nodeId: 'node-2',
      title: 'Implementation',
      dependsOn: ['node-1'],
      inputs: ['技术设计文档'],
      outputs: ['可运行交付物'],
    }),
    node({
      nodeId: 'node-3',
      title: 'Testing',
      capability: 'testing',
      employeeId: 'qa-peter',
      positionId: 'qa',
      dependsOn: ['node-2'],
      inputs: ['可运行交付物'],
      outputs: ['验收报告与证据'],
    }),
    node({
      nodeId: 'node-approve',
      kind: 'approval',
      title: '人类审批',
      capability: null,
      employeeId: null,
      positionId: null,
      dependsOn: ['node-1', 'node-2', 'node-3'],
      inputs: ['交付物', '验收报告'],
      outputs: ['审批决定'],
      acceptance: ['人类确认后才允许进入任务实施'],
    }),
  ];
}

describe('M3.4 plan validator · structure', () => {
  it('accepts a complete plan and derives the topological order', () => {
    const validation = validatePlan({
      nodes: validNodes(),
      organization: ORGANIZATION,
      workflowInstanceId: 'instance-1',
    });
    expect(validation.ok).toBe(true);
    expect(validation.blockingCount).toBe(0);
    expect(validation.cycleNodeIds).toEqual([]);
  });

  it('blocks a missing acceptance criterion', () => {
    const nodes = validNodes();
    nodes[1] = { ...nodes[1]!, acceptance: [] };
    const validation = validatePlan({
      nodes,
      organization: ORGANIZATION,
      workflowInstanceId: 'instance-1',
    });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'missing_acceptance')).toBe(true);
  });

  it('blocks a missing workflow draft', () => {
    const validation = validatePlan({
      nodes: validNodes(),
      organization: ORGANIZATION,
      workflowInstanceId: null,
    });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'missing_workflow_draft')).toBe(true);
  });
});

describe('M3.4 plan validator · employees', () => {
  it('blocks a real employee who does not cover the capability', () => {
    const nodes = validNodes();
    nodes[0] = { ...nodes[0]!, employeeId: 'qa-peter' };
    const validation = validatePlan({
      nodes,
      organization: ORGANIZATION,
      workflowInstanceId: 'instance-1',
    });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'employee_not_capable')).toBe(true);
    expect(validation.missingCapabilities).toContain('technical_design');
  });

  it('blocks an unassigned task', () => {
    const nodes = validNodes();
    nodes[2] = { ...nodes[2]!, employeeId: null };
    const validation = validatePlan({
      nodes,
      organization: ORGANIZATION,
      workflowInstanceId: 'instance-1',
    });
    expect(validation.ok).toBe(false);
    expect(validation.unassignedNodeIds).toContain('node-3');
  });

  it('warns when one employee owns parallel tasks', () => {
    const nodes = validNodes();
    nodes[1] = { ...nodes[1]!, employeeId: 'engineer-mike' };
    nodes[2] = { ...nodes[2]!, employeeId: 'engineer-mike', dependsOn: [] };
    const validation = validatePlan({
      nodes,
      organization: ORGANIZATION,
      workflowInstanceId: 'instance-1',
    });
    expect(validation.issues.some((issue) => issue.code === 'employee_conflict')).toBe(true);
  });
});

describe('M3.4 plan validator · dependencies', () => {
  it('blocks a cycle and reports the nodes in it', () => {
    const nodes = validNodes();
    nodes[0] = { ...nodes[0]!, dependsOn: ['node-2'] };
    const validation = validatePlan({
      nodes,
      organization: ORGANIZATION,
      workflowInstanceId: 'instance-1',
    });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'dependency_cycle')).toBe(true);
    expect(validation.cycleNodeIds).toContain('node-1');
    expect(validation.cycleNodeIds).toContain('node-2');
  });

  it('blocks an unknown dependency and a self dependency', () => {
    const nodes = validNodes();
    nodes[1] = { ...nodes[1]!, dependsOn: ['missing-node'] };
    nodes[2] = { ...nodes[2]!, dependsOn: ['node-3'] };
    const validation = validatePlan({
      nodes,
      organization: ORGANIZATION,
      workflowInstanceId: 'instance-1',
    });
    expect(validation.ok).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'unknown_dependency')).toBe(true);
    expect(validation.issues.some((issue) => issue.code === 'self_dependency')).toBe(true);
  });
});
