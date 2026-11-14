/**
 * Which deliveries get the scenario runtime instead of another document sheet.
 *
 * The cyber-sandbox brief asks for a place to run adversarial sessions, not a report about a
 * workflow. The workflow can finish with a written implementation report, but the product page
 * should still offer the environment the report describes. This classifier is deliberately
 * presentation-only and narrow: it recognizes an adversarial sandbox by the delivery's own
 * title/goal, never by a task or company id.
 */

export interface SandboxSubject {
  readonly title: string;
  readonly goal?: string;
}

const SANDBOX_SCENARIO = /(赛博沙盘|沙盘推演|对抗质询|multi-role adversarial|cyber[\s-]*sandbox)/i;

export function isSandboxScenario(...subjects: readonly (SandboxSubject | null | undefined)[]): boolean {
  return subjects.some((subject) =>
    subject !== null
    && subject !== undefined
    && SANDBOX_SCENARIO.test(`${subject.title} ${subject.goal ?? ''}`));
}
