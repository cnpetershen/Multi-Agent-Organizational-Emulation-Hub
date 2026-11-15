import { describe, expect, it } from 'vitest';
import { buildOrchestrationDraft } from '../../../apps/api/src/orchestrator';
import { RequirementPlanSchema, type RequirementPlan } from '../../../apps/api/src/planning-types';
import { loadSeedOrganization } from '../../helpers/simulation-fixtures';

/**
 * M3.3 · the orchestrator is deterministic and organisation-grounded.
 *
 * Every assertion below is about a real seat in the seeded organization: if a capability has no
 * seat, the node is unassigned and the draft is blocked; no employee is invented to fill it.
 */

function planWith(overrides: Partial<Record<string, unknown>> = {}): RequirementPlan {
  const now = '2026-11-15T00:00:00.000Z';
  return RequirementPlanSchema.parse({
    requirementId: 'req-1',
    companyId: 'future-ai-lab',
    version: 2,
    status: 'confirmed',
    source: { kind: 'goal', sessionId: null, goal: 'Build a weekly report generator for a design consultancy' },
    title: 'Weekly report generator',
    background: null,
    audience: ['management'],
    constraints: ['keep history'],
    scope: { inScope: ['submit', 'summarise'], outOfScope: ['payroll'] },
    deliverables: ['runnable app', 'test report'],
    acceptanceCriteria: ['employees can submit', 'management report is produced'],
    risks: [],
    requiredCapabilities: ['technical_design', 'implementation', 'testing'],
    clarifications: [],
    gaps: [],
    provenance: {
      mode: 'live',
      provider: 'test',
      model: 'test',
      stated: ['source.goal'],
      inferred: ['title', 'deliverables'],
    },
    createdAt: now,
    updatedAt: now,
    confirmedAt: now,
    confirmedBy: 'ceo-alex',
    ...overrides,
  });
}

function build(requirement: RequirementPlan) {
  return buildOrchestrationDraft({
    orchestrationId: 'orch-1',
    version: 1,
    requirement,
    organization: loadSeedOrganization(),
    now: '2026-11-15T00:00:00.000Z',
  });
}

describe('M3.3 orchestrator · a ready draft from real seats', () => {
  it('produces task nodes with owners, inputs/outputs, acceptance and a human gate', () => {
    const draft = build(planWith());
    expect(draft.status).toBe('ready');
    expect(draft.missingCapabilities).toEqual([]);
    expect(draft.unassignedNodeIds).toEqual([]);
    const tasks = draft.nodes.filter((node) => node.kind === 'task');
    expect(tasks).toHaveLength(3);
    for (const node of tasks) {
      expect(node.employeeId).not.toBeNull();
      expect(node.outputs.length).toBeGreaterThan(0);
      expect(node.acceptance.length).toBeGreaterThan(0);
    }
    expect(tasks.map((node) => node.capability)).toEqual([
      'technical_design',
      'implementation',
      'testing',
    ]);
    // Dependencies follow the delivery arc: design → implementation → testing.
    expect(tasks[0]?.dependsOn).toEqual([]);
    expect(tasks[1]?.dependsOn).toContain(tasks[0]?.nodeId);
    expect(tasks[2]?.dependsOn).toContain(tasks[1]?.nodeId);
    // The approval gate is human-only and waits for every task.
    const approval = draft.nodes.find((node) => node.kind === 'approval');
    expect(approval).toMatchObject({ status: 'human-gate', employeeId: null });
    expect(approval?.dependsOn).toEqual(expect.arrayContaining(tasks.map((node) => node.nodeId)));
    expect(draft.order[draft.order.length - 1]).toBe('node-approve');
    expect(draft.basis.employees.length).toBeGreaterThan(0);
  });
});

describe('M3.3 orchestrator · honest blockers', () => {
  it('reports a capability with no seat and leaves the node unassigned', () => {
    const draft = build(planWith({ requiredCapabilities: ['quantum_chip_design', 'implementation'] }));
    expect(draft.status).toBe('blocked');
    expect(draft.missingCapabilities).toContain('quantum_chip_design');
    expect(draft.unassignedNodeIds.length).toBeGreaterThan(0);
    expect(
      draft.conflicts.some(
        (conflict) => conflict.code === 'missing_capability' && conflict.severity === 'blocking',
      ),
    ).toBe(true);
  });

  it('refuses an unconfirmed requirement', () => {
    const draft = build(planWith({ status: 'needs_clarification' }));
    expect(draft.status).toBe('blocked');
    expect(draft.conflicts.some((conflict) => conflict.severity === 'blocking')).toBe(true);
  });

  it('refuses a requirement without deliverables or acceptance criteria', () => {
    const noDeliverables = build(planWith({ deliverables: [] }));
    expect(noDeliverables.status).toBe('blocked');
    expect(noDeliverables.conflicts.some((conflict) => conflict.code === 'missing_deliverable')).toBe(true);

    const noAcceptance = build(planWith({ acceptanceCriteria: [] }));
    expect(noAcceptance.status).toBe('blocked');
    expect(noAcceptance.conflicts.some((conflict) => conflict.code === 'missing_acceptance')).toBe(true);
  });

  it('refuses a requirement with no capabilities', () => {
    const draft = build(planWith({ requiredCapabilities: [] }));
    expect(draft.status).toBe('blocked');
    expect(draft.conflicts.some((conflict) => conflict.code === 'missing_capability')).toBe(true);
  });
});
