import type { Task, TaskVerification } from '@maoeh/task-system';

export type VerificationVerdict =
  | { readonly kind: 'pass' }
  | { readonly kind: 'fail'; readonly reason: string }
  | { readonly kind: 'pending' };

export function evaluateVerification(
  task: Task,
  rule: TaskVerification | null,
): VerificationVerdict {
  if (rule === null) {
    return task.result === null
      ? { kind: 'pending' }
      : { kind: 'pass' };
  }
  if (rule.kind === 'deterministic') {
    const result = task.result;
    if (result === null) return { kind: 'pending' };
    const missing = rule.requiredOutputKeys.filter((key) => !(key in result.data));
    if (missing.length > 0) {
      return { kind: 'fail', reason: `missing output keys: ${missing.join(', ')}` };
    }
    return { kind: 'pass' };
  }
  const approved = task.reviews.some((review) => review.verdict === 'approved');
  if (approved) return { kind: 'pass' };
  const rejectedReview = [...task.reviews]
    .reverse()
    .find((review) => review.verdict === 'rejected');
  if (rejectedReview !== undefined) {
    return { kind: 'fail', reason: rejectedReview.reason ?? 'review rejected' };
  }
  return { kind: 'pending' };
}
