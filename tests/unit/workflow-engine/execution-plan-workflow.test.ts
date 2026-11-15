import { describe, expect, it } from 'vitest';
import {
  generateExecutionPlanWorkflowDefinition,
  regenerateWorkflowDefinition,
  validateWorkflowDefinition,
  type ExecutionPlanSnapshot,
} from '../../../packages/workflow-engine/src';

/**
 * M3.5 · the confirmed plan is translated, not re-planned.
 *
 * These assertions pin the plan-to-engine mapping: node order, owners, inputs/outputs/acceptance
 * and the approval gate are the plan's, and a restarted process can rebuild the same definition
 * from the instance context.
 */

const PLAN: ExecutionPlanSnapshot = {
  planId: 'plan-1',
  planVersion: 3,
  requirementId: 'req-1',
  requirementVersion: 2,
  title: 'Weekly report generator',
  goal: 'Build a weekly report generator',
  nodes: [
    {
      nodeId: 'node-1',
      kind: 'task',
      title: 'Technical Design',
      goal: 'Design the interfaces',
      capability: 'technical_design',
      employeeId: 'cto-john',
      inputs: ['confirmed requirement v2'],
      outputs: ['technical design'],
      acceptance: ['design names interfaces'],
      dependsOn: [],
    },
    {
      nodeId: 'node-2',
      kind: 'task',
      title: 'Implementation',
      goal: 'Build the deliverable',
      capability: 'implementation',
      employeeId: 'engineer-mike',
      inputs: ['technical design'],
      outputs: ['runnable app'],
      acceptance: ['app runs'],
      dependsOn: ['node-1'],
    },
    {
      nodeId: 'node-approve',
      kind: 'approval',
      title: 'Human approval',
      goal: 'Approve the delivery',
      capability: null,
      employeeId: null,
      inputs: ['runnable app'],
      outputs: ['decision'],
      acceptance: ['human sign-off'],
      dependsOn: ['node-1', 'node-2'],
    },
  ],
  order: ['node-1', 'node-2', 'node-approve'],
};

describe('M3.5 execution-plan workflow', () => {
  it('maps nodes, owners and acceptance to engine steps in plan order', () => {
    const definition = generateExecutionPlanWorkflowDefinition({
      instanceId: 'execution-plan-1-v3',
      title: PLAN.title,
      goal: PLAN.goal,
      plan: PLAN,
      approvalRoles: ['ceo'],
    });
    expect(validateWorkflowDefinition(definition)).toEqual([]);
    expect(definition.stages).toHaveLength(3);
    expect(definition.entryStageId).toBe('stage-plan-1');
    const first = definition.stages[0]?.steps[0];
    expect(first).toMatchObject({
      stepId: 'node-1',
      kind: 'task',
      name: 'Technical Design',
      assignment: { kind: 'employee', employeeId: 'cto-john' },
      capability: 'technical_design',
      requiredArtifacts: ['technical design'],
      acceptanceCriteria: ['design names interfaces'],
    });
    expect(first?.description).toContain('Design the interfaces');
    expect(first?.description).toContain('confirmed requirement v2');
    const approval = definition.stages[2]?.steps[0];
    expect(approval).toMatchObject({ stepId: 'node-approve', kind: 'approval', humanOnly: true });
    expect(definition.terminalStageIds).toEqual(['stage-plan-3']);
  });

  it('rebuilds the same definition from the started event context after a restart', () => {
    const context = {
      executionPlan: PLAN,
    };
    const rebuilt = regenerateWorkflowDefinition(
      {
        instanceId: 'execution-plan-1-v3',
        title: PLAN.title,
        goal: PLAN.goal,
        context,
      },
      ['ceo'],
    );
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.workflowId).toBe(
      generateExecutionPlanWorkflowDefinition({
        instanceId: 'execution-plan-1-v3',
        title: PLAN.title,
        goal: PLAN.goal,
        plan: PLAN,
        approvalRoles: ['ceo'],
      }).workflowId,
    );
    expect(rebuilt?.stages.map((stage) => stage.steps[0]?.stepId)).toEqual([
      'node-1',
      'node-2',
      'node-approve',
    ]);
  });

  it('refuses to materialize a task with no confirmed employee', () => {
    expect(() =>
      generateExecutionPlanWorkflowDefinition({
        instanceId: 'execution-plan-1-v3',
        title: PLAN.title,
        goal: PLAN.goal,
        plan: {
          ...PLAN,
          nodes: PLAN.nodes.map((node) =>
            node.nodeId === 'node-2' ? { ...node, employeeId: null } : node,
          ),
        },
        approvalRoles: ['ceo'],
      }),
    ).toThrow(/no employee/u);
  });
});
