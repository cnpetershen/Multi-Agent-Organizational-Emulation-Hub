import type { Action, Plan, Result, Step } from '@maoeh/shared-types';
import { ACTIONS } from '@maoeh/shared-types';
import type { CognitionError } from '../cognition-errors.js';
import { cognitionError, cognitionIssue } from '../cognition-errors.js';
import type { CognitionPlanDraft } from '../schemas/cognition-output.js';

const ACTION_SPACE: ReadonlySet<string> = new Set<string>(ACTIONS);

export interface BuildPlanInput {
  readonly draft: CognitionPlanDraft;
  readonly considerationsCount: number;
  readonly idempotencySeed: string;
}

export function buildPlan(input: BuildPlanInput): Result<Plan, CognitionError> {
  const { draft, considerationsCount, idempotencySeed } = input;
  const issues: { field: string; reason: string }[] = [];

  if (draft.steps.length === 0) {
    return {
      ok: false,
      error: cognitionIssue('invalid_plan', 'plan.steps', 'a plan must contain at least one step'),
    };
  }

  const steps: Step[] = [];
  draft.steps.forEach((step, index) => {
    const field = `plan.steps[${index}]`;
    if (!ACTION_SPACE.has(step.action)) {
      issues.push({
        field: `${field}.action`,
        reason: `"${step.action}" is not part of the closed Action Space`,
      });
      return;
    }
    if (step.reasonRef >= considerationsCount) {
      issues.push({
        field: `${field}.reasonRef`,
        reason: `reasonRef ${step.reasonRef} does not reference an existing consideration`,
      });
      return;
    }
    steps.push({
      index,
      action: step.action as Action,
      args: Object.freeze({ ...step.args }),
      reasonRef: step.reasonRef,
      idempotencyKey: `${idempotencySeed}:${index}`,
    });
  });

  if (issues.length > 0) return { ok: false, error: cognitionError('invalid_plan', issues) };

  const goal = draft.goal.trim();
  const doneWhen = draft.doneWhen.trim();
  if (goal === '' || doneWhen === '') {
    return {
      ok: false,
      error: cognitionError('invalid_plan', [
        { field: 'plan.goal', reason: 'goal and doneWhen must not be empty' },
      ]),
    };
  }

  return {
    ok: true,
    value: Object.freeze({
      goal,
      steps: Object.freeze(steps),
      doneWhen,
    }),
  };
}
