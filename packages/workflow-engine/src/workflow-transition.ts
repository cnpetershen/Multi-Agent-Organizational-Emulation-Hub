import type { Result } from '@maoeh/shared-types';
import { workflowError } from './workflow-errors.js';
import type { WorkflowFailure } from './workflow-errors.js';
import type { WorkflowDefinition, WorkflowTransition } from './workflow-types.js';
import { findStep } from './workflow-types.js';

export type TransitionInput =
  | { readonly kind: 'task'; readonly status: 'completed' | 'rejected' | 'failed' }
  | { readonly kind: 'approval'; readonly decision: 'granted' | 'denied' }
  | { readonly kind: 'none' };

function matches(transition: WorkflowTransition, input: TransitionInput): boolean {
  const condition = transition.when;
  if (condition.kind === 'always') return true;
  if (input.kind === 'none') return false;
  if (condition.kind === 'task_status') {
    if (input.kind !== 'task') return false;
    if (condition.status === 'rejected') {
      return input.status === 'rejected' || input.status === 'failed';
    }
    return condition.status === input.status;
  }
  if (input.kind !== 'approval') return false;
  return condition.decision === input.decision;
}

export function selectTransitions(
  definition: WorkflowDefinition,
  fromStepId: string,
  input: TransitionInput,
): Result<readonly WorkflowTransition[], WorkflowFailure> {
  const located = findStep(definition, fromStepId);
  if (located === null) {
    return {
      ok: false,
      error: workflowError(
        'invalid_definition',
        'stepId',
        `step "${fromStepId}" does not exist in workflow "${definition.workflowId}"`,
      ),
    };
  }
  const matched = located.stage.transitions.filter(
    (transition) => transition.fromStepId === fromStepId && matches(transition, input),
  );
  if (matched.length === 0) {
    return {
      ok: false,
      error: workflowError(
        'no_matching_transition',
        'transition',
        `no transition from step "${fromStepId}" matches ${input.kind} input`,
      ),
    };
  }
  if (matched.length > 1) {
    return {
      ok: false,
      error: workflowError(
        'ambiguous_transition',
        'transition',
        `${matched.length} transitions from step "${fromStepId}" match ${input.kind} input`,
      ),
    };
  }
  return { ok: true, value: matched };
}
