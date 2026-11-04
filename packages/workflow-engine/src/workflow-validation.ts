import type { Result } from '@maoeh/shared-types';
import { workflowIssue } from './workflow-errors.js';
import type { WorkflowIssue } from './workflow-errors.js';
import type {
  TransitionCondition,
  WorkflowDefinition,
  WorkflowStage,
  WorkflowStep,
  WorkflowTransition,
} from './workflow-types.js';
import { allTransitions, findStage, findStep, isApprovalLike } from './workflow-types.js';

function expandStatus(status: 'completed' | 'rejected' | 'failed'): readonly string[] {
  if (status === 'rejected') return ['rejected', 'failed'];
  return [status];
}

export function conditionsOverlap(
  left: TransitionCondition,
  right: TransitionCondition,
): boolean {
  if (left.kind === 'always' || right.kind === 'always') return true;
  if (left.kind === 'task_status' && right.kind === 'task_status') {
    const leftStatuses = expandStatus(left.status);
    const rightStatuses = expandStatus(right.status);
    return leftStatuses.some((status) => rightStatuses.includes(status));
  }
  if (left.kind === 'approval_decision' && right.kind === 'approval_decision') {
    return left.decision === right.decision;
  }
  return false;
}

function conditionLabel(condition: TransitionCondition): string {
  if (condition.kind === 'always') return 'always';
  if (condition.kind === 'task_status') return `task_status=${condition.status}`;
  return `approval_decision=${condition.decision}`;
}

function successorStepIds(
  definition: WorkflowDefinition,
  transition: WorkflowTransition,
): readonly string[] {
  const target = transition.to;
  if (target.kind === 'step') return [target.stepId];
  if (target.kind === 'stage') {
    const targetStage = findStage(definition, target.stageId);
    const first = targetStage?.steps[0];
    return first === undefined ? [] : [first.stepId];
  }
  return [];
}

function detectCycle(definition: WorkflowDefinition): boolean {
  const graph = new Map<string, readonly string[]>();
  for (const stage of definition.stages) {
    for (const step of stage.steps) {
      const successors = stage.transitions
        .filter((transition) => transition.fromStepId === step.stepId)
        .flatMap((transition) => successorStepIds(definition, transition));
      graph.set(step.stepId, successors);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): boolean => {
    if (visiting.has(stepId)) return true;
    if (visited.has(stepId)) return false;
    visiting.add(stepId);
    for (const next of graph.get(stepId) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(stepId);
    visited.add(stepId);
    return false;
  };
  for (const stepId of graph.keys()) {
    if (visit(stepId)) return true;
  }
  return false;
}

function reachableSteps(definition: WorkflowDefinition): ReadonlySet<string> {
  const entryStage = findStage(definition, definition.entryStageId);
  const first = entryStage?.steps[0];
  const reachable = new Set<string>();
  if (first === undefined) return reachable;
  const queue: string[] = [first.stepId];
  while (queue.length > 0) {
    const stepId = queue.shift() as string;
    if (reachable.has(stepId)) continue;
    reachable.add(stepId);
    const located = findStep(definition, stepId);
    if (located === null) continue;
    for (const transition of located.stage.transitions) {
      if (transition.fromStepId !== stepId) continue;
      for (const next of successorStepIds(definition, transition)) {
        if (!reachable.has(next)) queue.push(next);
      }
    }
  }
  return reachable;
}

function validateStep(
  stage: WorkflowStage,
  step: WorkflowStep,
  issues: WorkflowIssue[],
): void {
  const field = `stages.${stage.stageId}.steps.${step.stepId}`;
  if (step.name.trim().length === 0) {
    issues.push(workflowIssue(`${field}.name`, 'step name must not be empty'));
  }
  if (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1) {
    issues.push(workflowIssue(`${field}.maxAttempts`, 'maxAttempts must be >= 1'));
  }
  if (step.kind === 'task') {
    if (step.assignment === null || step.assignment.kind === 'unassigned') {
      issues.push(
        workflowIssue(
          `${field}.assignment`,
          'task steps require an employee or position assignment',
        ),
      );
    }
    if (step.verification !== null && step.verification.requiredOutputKeys.length === 0) {
      issues.push(
        workflowIssue(
          `${field}.verification.requiredOutputKeys`,
          'verification requires at least one output key',
        ),
      );
    }
  }
  if (!isApprovalLike(step.kind) && step.kind !== 'automated') {
    const approvalConditions = stage.transitions.filter(
      (transition) =>
        transition.fromStepId === step.stepId &&
        transition.when.kind === 'approval_decision',
    );
    if (approvalConditions.length > 0) {
      issues.push(
        workflowIssue(
          `${field}.transitions`,
          'task steps cannot branch on approval_decision',
        ),
      );
    }
  }
  if (isApprovalLike(step.kind)) {
    const approvalConditions = stage.transitions.filter(
      (transition) =>
        transition.fromStepId === step.stepId &&
        transition.when.kind === 'approval_decision',
    );
    if (approvalConditions.length === 0) {
      issues.push(
        workflowIssue(
          `${field}.transitions`,
          'approval steps require at least one approval_decision transition',
        ),
      );
    }
    validateApprovalPolicy(step, field, issues);
  }
  if (step.kind === 'automated') {
    const outgoing = stage.transitions.filter(
      (transition) => transition.fromStepId === step.stepId,
    );
    if (outgoing.some((transition) => transition.when.kind !== 'always')) {
      issues.push(
        workflowIssue(
          `${field}.transitions`,
          'automated steps may only branch on always conditions',
        ),
      );
    }
  }
  const outgoing = stage.transitions.filter(
    (transition) => transition.fromStepId === step.stepId,
  );
  if (outgoing.length === 0) {
    issues.push(workflowIssue(`${field}.transitions`, 'every step needs an outgoing transition'));
  }
  for (let i = 0; i < outgoing.length; i += 1) {
    for (let j = i + 1; j < outgoing.length; j += 1) {
      const left = outgoing[i];
      const right = outgoing[j];
      if (left === undefined || right === undefined) continue;
      if (conditionsOverlap(left.when, right.when)) {
        issues.push(
          workflowIssue(
            `${field}.transitions`,
            `ambiguous transitions ${left.transitionId} and ${right.transitionId} overlap on ${conditionLabel(left.when)}`,
          ),
        );
      }
    }
  }
}

function validateApprovalPolicy(step: WorkflowStep, field: string, issues: WorkflowIssue[]): void {
  if (!Number.isInteger(step.requiredCount) || step.requiredCount < 1) {
    issues.push(workflowIssue(`${field}.requiredCount`, 'requiredCount must be >= 1'));
    return;
  }
  if (step.approvalPolicy === 'single' && step.requiredCount !== 1) {
    issues.push(workflowIssue(`${field}.requiredCount`, 'single policy requires requiredCount=1'));
  }
  if (step.approvalPolicy === 'all') {
    if (step.requiredRoles.length === 0) {
      issues.push(
        workflowIssue(`${field}.requiredRoles`, 'all policy requires at least one role'),
      );
    } else if (step.requiredCount !== step.requiredRoles.length) {
      issues.push(
        workflowIssue(
          `${field}.requiredCount`,
          'all policy requires requiredCount to equal requiredRoles length',
        ),
      );
    }
  }
  if (
    step.approvalPolicy === 'quorum' &&
    step.requiredRoles.length > 0 &&
    step.requiredCount > step.requiredRoles.length
  ) {
    issues.push(
      workflowIssue(`${field}.requiredCount`, 'quorum cannot exceed the number of roles'),
    );
  }
}

export function validateWorkflowDefinition(
  definition: WorkflowDefinition,
): readonly WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  if (definition.workflowId.trim().length === 0) {
    issues.push(workflowIssue('workflowId', 'workflowId must not be empty'));
  }
  if (definition.name.trim().length === 0) {
    issues.push(workflowIssue('name', 'workflow name must not be empty'));
  }
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    issues.push(workflowIssue('version', 'version must be >= 1'));
  }
  if (definition.stages.length === 0) {
    issues.push(workflowIssue('stages', 'a workflow needs at least one stage'));
    return issues;
  }
  const stageIds = new Set<string>();
  const stepIds = new Set<string>();
  for (const stage of definition.stages) {
    if (stageIds.has(stage.stageId)) {
      issues.push(workflowIssue(`stages.${stage.stageId}`, 'duplicate stage id'));
    }
    stageIds.add(stage.stageId);
    if (stage.steps.length === 0) {
      issues.push(workflowIssue(`stages.${stage.stageId}.steps`, 'stage has no steps'));
    }
    for (const step of stage.steps) {
      if (stepIds.has(step.stepId)) {
        issues.push(workflowIssue(`steps.${step.stepId}`, 'step ids must be globally unique'));
      }
      stepIds.add(step.stepId);
    }
  }
  if (!stageIds.has(definition.entryStageId)) {
    issues.push(workflowIssue('entryStageId', `unknown stage ${definition.entryStageId}`));
  } else {
    const entry = findStage(definition, definition.entryStageId);
    if (entry !== null && entry.steps.length === 0) {
      issues.push(workflowIssue('entryStageId', 'entry stage has no steps'));
    }
  }
  if (definition.terminalStageIds.length === 0) {
    issues.push(workflowIssue('terminalStageIds', 'at least one terminal stage is required'));
  }
  for (const terminalId of definition.terminalStageIds) {
    if (!stageIds.has(terminalId)) {
      issues.push(workflowIssue('terminalStageIds', `unknown stage ${terminalId}`));
    }
  }

  const transitionIds = new Set<string>();
  for (const stage of definition.stages) {
    for (const step of stage.steps) {
      validateStep(stage, step, issues);
    }
    for (const transition of stage.transitions) {
      const field = `stages.${stage.stageId}.transitions.${transition.transitionId}`;
      if (transitionIds.has(transition.transitionId)) {
        issues.push(workflowIssue(field, 'transition ids must be globally unique'));
      }
      transitionIds.add(transition.transitionId);
      const source = stage.steps.find((step) => step.stepId === transition.fromStepId);
      if (source === undefined) {
        issues.push(
          workflowIssue(`${field}.fromStepId`, `step ${transition.fromStepId} is not in this stage`),
        );
      }
      const target = transition.to;
      if (target.kind === 'step') {
        const located = findStep(definition, target.stepId);
        if (located === null) {
          issues.push(workflowIssue(`${field}.to`, `unknown step ${target.stepId}`));
        } else if (target.stageId !== null && target.stageId !== located.stage.stageId) {
          issues.push(
            workflowIssue(
              `${field}.to`,
              `declared stage ${target.stageId} does not own step ${target.stepId}`,
            ),
          );
        }
      } else if (target.kind === 'stage') {
        const targetStage = findStage(definition, target.stageId);
        if (targetStage === null) {
          issues.push(workflowIssue(`${field}.to`, `unknown stage ${target.stageId}`));
        } else if (targetStage.steps.length === 0) {
          issues.push(workflowIssue(`${field}.to`, `stage ${target.stageId} has no steps`));
        }
      }
    }
  }

  const hasComplete = allTransitions(definition).some(
    (transition) => transition.to.kind === 'complete',
  );
  if (!hasComplete) {
    issues.push(workflowIssue('transitions', 'at least one transition must target complete'));
  }

  const reachable = reachableSteps(definition);
  for (const stage of definition.stages) {
    for (const step of stage.steps) {
      if (!reachable.has(step.stepId)) {
        issues.push(
          workflowIssue(
            `steps.${step.stepId}`,
            'step is unreachable from the entry stage',
          ),
        );
      }
    }
  }

  if (definition.cyclePolicy === 'forbid' && detectCycle(definition)) {
    issues.push(
      workflowIssue('cyclePolicy', 'workflow graph contains a cycle but cyclePolicy is forbid'),
    );
  }

  return issues;
}

export function assertValidWorkflowDefinition(
  definition: WorkflowDefinition,
): Result<WorkflowDefinition, { readonly issues: readonly WorkflowIssue[] }> {
  const issues = validateWorkflowDefinition(definition);
  if (issues.length > 0) return { ok: false, error: { issues } };
  return { ok: true, value: definition };
}
