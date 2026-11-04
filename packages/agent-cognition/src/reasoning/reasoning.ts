import type { Result } from '@maoeh/shared-types';
import type { CognitionError, CognitionIssue } from '../cognition-errors.js';
import { cognitionError } from '../cognition-errors.js';
import type { ReasoningResult } from '../cognition-result.js';

const MAX_TEXT_LENGTH = 4000;

export interface ReasoningDraft {
  readonly interpretation: string;
  readonly considerations: readonly string[];
  readonly conclusion: string;
}

function checkText(value: string, field: string, issues: CognitionIssue[]): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    issues.push({ field, reason: 'must not be empty' });
    return '';
  }
  if (trimmed.length > MAX_TEXT_LENGTH) {
    issues.push({ field, reason: `must be at most ${MAX_TEXT_LENGTH} characters` });
    return '';
  }
  return trimmed;
}

export function buildReasoning(draft: ReasoningDraft): Result<ReasoningResult, CognitionError> {
  const issues: CognitionIssue[] = [];

  const interpretation = checkText(draft.interpretation, 'interpretation', issues);
  const conclusion = checkText(draft.conclusion, 'conclusion', issues);

  const considerations: string[] = [];
  draft.considerations.forEach((consideration, index) => {
    const trimmed = checkText(consideration, `considerations[${index}]`, issues);
    if (trimmed !== '') considerations.push(trimmed);
  });

  if (issues.length > 0) return { ok: false, error: cognitionError('invalid_reasoning', issues) };

  return {
    ok: true,
    value: Object.freeze({
      interpretation,
      considerations: Object.freeze(considerations),
      conclusion,
    }),
  };
}
