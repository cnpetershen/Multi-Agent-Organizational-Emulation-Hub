import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_PLAN_CONTEXT_KEY,
  buildCapabilityPlan,
  capabilityPlanContext,
  generateWorkflowDefinition,
  generatedWorkflowId,
  regenerateWorkflowDefinition,
  validateWorkflowDefinition,
} from '@maoeh/workflow-engine';
import type { WorkflowInstance } from '@maoeh/workflow-engine';
import { loadSeedOrganization } from '../../helpers/simulation-fixtures';

/**
 * Generated workflows — the CEO's capability plan becomes a real, valid, replayable graph:
 *
 *   capability stage 1 → … → approval stage → complete (rejected/denied → fail)
 *
 * The definition is derived state: it validates like a YAML template, lives under a
 * deterministic `generated-<instanceId>` id, and can be rebuilt from the capability plan the
 * started-instance event carries — which is what keeps a running instance alive across a
 * restart.
 */

const seed = loadSeedOrganization();

function planFor(capabilities: readonly string[]) {
  const { plan, issues } = buildCapabilityPlan(seed, capabilities);
  expect(issues).toEqual([]);
  if (plan === null) throw new Error('expected a plan');
  return plan;
}

function generatedFor(capabilities: readonly string[], instanceId = 'instance-7') {
  const definition = generateWorkflowDefinition({
    instanceId,
    title: 'Board directive',
    goal: 'Own the churn problem.',
    plan: planFor(capabilities),
    approvalRoles: ['ceo'],
  });
  return definition;
}

describe('capability plan (seed resolution)', () => {
  it('records one assignment per requested capability', () => {
    const plan = planFor(['implementation', 'testing']);
    expect(plan.capabilities).toEqual(['implementation', 'testing']);
    expect(plan.assignments.map((assignment) => assignment.capability)).toEqual([
      'implementation',
      'testing',
    ]);
    for (const assignment of plan.assignments) {
      const seat = seed.positions.find((position) => String(position.id) === assignment.positionId);
      expect(seat?.capabilities ?? []).toContain(assignment.capability);
    }
  });

  it('refuses a request no seat can serve', () => {
    const { plan, issues } = buildCapabilityPlan(seed, ['teleportation']);
    expect(plan).toBeNull();
    expect(issues[0]?.field).toBe('capabilities');
  });

  it('refuses an empty capability list', () => {
    const { plan, issues } = buildCapabilityPlan(seed, ['  ']);
    expect(plan).toBeNull();
    expect(plan === null && issues.length > 0).toBe(true);
  });
});

describe('generated definition', () => {
  it('produces a valid sequential graph with a closing root approval', () => {
    const definition = generatedFor(['implementation', 'testing']);
    expect(validateWorkflowDefinition(definition)).toEqual([]);
    expect(definition.workflowId).toBe('generated-instance-7');
    expect(definition.entryStageId).toBe('stage-1');
    expect(definition.cyclePolicy).toBe('forbid');
    expect(definition.stages.map((stage) => stage.stageId)).toEqual([
      'stage-1',
      'stage-2',
      'stage-approve',
    ]);

    const first = definition.stages[0]?.steps[0];
    expect(first?.kind).toBe('task');
    expect(first?.assignment).toEqual({ kind: 'position', positionId: 'engineer' });
    expect(first?.verification).toBeNull();

    const approval = definition.stages[2]?.steps[0];
    expect(approval?.kind).toBe('approval');
    expect(approval?.requiredRoles).toEqual(['ceo']);
    expect(approval?.approvalPolicy).toBe('single');
    expect(approval?.requiredCount).toBe(1);

    const terminal = definition.stages[2]?.transitions ?? [];
    expect(terminal.map((transition) => transition.to.kind)).toEqual(['complete', 'fail']);
  });

  it('sends every rejected stage to fail instead of looping', () => {
    const definition = generatedFor(['implementation', 'testing']);
    for (const stage of definition.stages.slice(0, 2)) {
      const rejected = stage.transitions.find((transition) =>
        transition.to.kind === 'fail',
      );
      expect(rejected?.when).toEqual({ kind: 'task_status', status: 'rejected' });
    }
    expect(validateWorkflowDefinition(definition)).toEqual([]);
  });

  it('names stages from the capability label, not from a position title', () => {
    const definition = generatedFor(['testing']);
    expect(definition.stages[0]?.name).toBe('Testing');
    const assignment = planFor(['testing']).assignments[0];
    expect(assignment?.positionId).toBe('qa');
    expect(definition.stages[0]?.name).not.toContain('qa');
  });

  it('declares the capability each stage was built for, so the executor learns its kind of work', () => {
    // The stage exists because of one capability; without it on the step, a seat that declares
    // several capabilities cannot tell its steps apart and answers every one the same way.
    const definition = generatedFor(['implementation', 'frontend', 'backend']);
    expect(definition.stages.slice(0, 3).map((stage) => stage.steps[0]?.capability)).toEqual([
      'implementation',
      'frontend',
      'backend',
    ]);
    // The closing approval step declares none: it is a decision, not a kind of production work.
    expect(definition.stages[3]?.steps[0]?.capability).toBeUndefined();
  });

  it('caps the generated workflow id at the event-contract limit', () => {
    expect(generatedWorkflowId('instance-7')).toBe('generated-instance-7');
    const long = 'x'.repeat(120);
    const id = generatedWorkflowId(long);
    expect(id.startsWith('generated-')).toBe(true);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(generatedWorkflowId(long)).toBe(id);
  });
});

describe('replay regeneration', () => {
  it('rebuilds the same definition from the plan the instance carried', () => {
    const plan = planFor(['implementation', 'testing']);
    const definition = generateWorkflowDefinition({
      instanceId: 'instance-9',
      title: 'Restarted mandate',
      goal: 'Ship it.',
      plan,
      approvalRoles: ['ceo'],
    });
    const instance = {
      instanceId: 'instance-9',
      title: 'Restarted mandate',
      goal: 'Ship it.',
      context: capabilityPlanContext(plan),
    } as Pick<WorkflowInstance, 'instanceId' | 'title' | 'goal' | 'context'>;

    const rebuilt = regenerateWorkflowDefinition(instance, ['ceo']);
    expect(rebuilt).toEqual(definition);
    expect(validateWorkflowDefinition(rebuilt ?? definition)).toEqual([]);
    expect(instance.context[CAPABILITY_PLAN_CONTEXT_KEY]).toBeDefined();
  });

  it('returns null for template instances and malformed plans', () => {
    expect(
      regenerateWorkflowDefinition(
        {
          instanceId: 'instance-1',
          title: 'Template run',
          goal: 'From disk.',
          context: { anyKey: 'anyValue' },
        },
        ['ceo'],
      ),
    ).toBeNull();
    expect(
      regenerateWorkflowDefinition(
        {
          instanceId: 'instance-2',
          title: 'Broken plan',
          goal: 'Nope.',
          context: { [CAPABILITY_PLAN_CONTEXT_KEY]: { capabilities: [], assignments: [] } },
        },
        ['ceo'],
      ),
    ).toBeNull();
  });
});
