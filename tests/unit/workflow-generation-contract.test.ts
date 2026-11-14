import { describe, expect, it } from 'vitest';
import { generateWorkflowDefinition } from '../../packages/workflow-engine/src/workflow-generation';
import { hasRunnableArtifact } from '../../packages/workflow-engine/src/workflow-engine';
import type { Task } from '@maoeh/task-system';

const plan = {
  capabilities: ['implementation'],
  assignments: [{
    capability: 'implementation',
    matchedPositionId: 'engineer',
    positionId: 'engineer',
    escalated: false,
  }],
};

describe('generated workflow step contracts', () => {
  it('names the runnable artifact and acceptance checks for implementation', () => {
    const definition = generateWorkflowDefinition({
      instanceId: 'i-contract',
      title: 'Sandbox',
      goal: 'Build a runnable multi-role sandbox',
      plan,
      approvalRoles: ['ceo'],
    });
    const step = definition.stages[0]?.steps[0];
    expect(step?.capability).toBe('implementation');
    expect(step?.requiredArtifacts).toContain('runnable-code-or-page');
    expect(step?.acceptanceCriteria).toContain('the artifact loads or runs');
    expect(step?.description).toContain('Build the actual deliverable');
  });

  it('rejects a prose-only implementation report as non-runnable', () => {
    const report = { result: { artifacts: [], data: { implementation_report: 'We built it' } } } as unknown as Task;
    const page = { result: { artifacts: [], data: { 'index.html': '<!doctype html><html></html>' } } } as unknown as Task;
    expect(hasRunnableArtifact(report)).toBe(false);
    expect(hasRunnableArtifact(page)).toBe(true);
  });

  it('makes the final generated approval human-only', () => {
    const definition = generateWorkflowDefinition({
      instanceId: 'i-contract',
      title: 'Sandbox',
      goal: 'Build a runnable multi-role sandbox',
      plan,
      approvalRoles: ['ceo'],
    });
    const approval = definition.stages.find((stage) => stage.steps[0]?.kind === 'approval')?.steps[0];
    expect(approval?.humanOnly).toBe(true);
  });
});
