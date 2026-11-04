import type { ZodError } from 'zod';
import type { CommunicationIssue } from '../communication-errors.js';

export function zodIssues(error: ZodError): readonly CommunicationIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(root)',
    reason: issue.message,
  }));
}
