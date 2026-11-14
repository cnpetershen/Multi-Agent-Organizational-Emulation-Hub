import { describe, expect, it } from 'vitest';
import { resultSourceOf } from '../../../apps/web/src/results-source';

/**
 * F3: a task belongs to a sandbox run only when the brief that produced it says so
 * (`sourceSessionId` + the task's correlationId). Titles and goals are prose; they must not
 * decide this.
 */
describe('M2 F3 Results source projection', () => {
  it('uses the structured brief source, not the task text', () => {
    const briefs = [
      {
        briefId: 'brief-7',
        correlationId: 'corr-sandbox',
        sourceSessionId: 'sandbox-session-1',
        title: 'M2 验收',
      },
    ];
    expect(resultSourceOf(briefs, 'corr-sandbox')).toEqual({
      briefId: 'brief-7',
      sessionId: 'sandbox-session-1',
      title: 'M2 验收',
    });
    // A task whose prose mentions 赛博沙盘 but has no structured source is not a sandbox task.
    expect(resultSourceOf(briefs, 'corr-other')).toBeNull();
  });

  it('ignores hand-written briefs and missing correlation ids', () => {
    const briefs = [
      { briefId: 'brief-8', correlationId: 'corr-hand', sourceSessionId: null, title: 'Hand written' },
    ];
    expect(resultSourceOf(briefs, 'corr-hand')).toBeNull();
    expect(resultSourceOf(briefs, null)).toBeNull();
    expect(resultSourceOf([], 'corr-sandbox')).toBeNull();
  });
});
