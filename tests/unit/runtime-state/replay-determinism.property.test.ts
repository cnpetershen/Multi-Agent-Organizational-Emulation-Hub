import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CompanyId, EmployeeId, OrgEvent, PresenceState, SimTime } from '@maoeh/shared-types';
import { PRESENCE_STATES } from '@maoeh/shared-types';
import { createEventRegistry, createOrgEvent } from '@maoeh/event-system';
import { createInitialAgentState, replayAgentState } from '@maoeh/runtime-state';

const registry = (() => {
  const created = createEventRegistry();
  const result = created.register(
    'Runtime.PresenceChanged',
    z.object({ employeeId: z.string().min(1), presence: z.enum(PRESENCE_STATES) }),
  );
  if (!result.ok) throw new Error('registry setup failed');
  return created;
})();

const subjectArb = fc.constantFrom('engineer-mike', 'cto-john');
const presenceArb = fc.constantFrom<PresenceState>(...PRESENCE_STATES);
const stepArb = fc.tuple(subjectArb, presenceArb, fc.integer({ min: 0, max: 10_000 }));

function buildEvents(
  steps: readonly (readonly [string, PresenceState, number])[],
): OrgEvent[] {
  const events: OrgEvent[] = [];
  steps.forEach(([subjectId, presence, at], index) => {
    const result = createOrgEvent(
      registry,
      {
        companyId: 'future-ai-lab' as CompanyId,
        type: 'Runtime.PresenceChanged',
        occurredAtSim: at as SimTime,
        actorKind: 'employee',
        correlationId: `corr-prop-${index % 3}`,
        subjectType: 'employee',
        subjectId,
        payload: { employeeId: subjectId, presence },
      },
      { eventIdGenerator: () => `prop-${index}` },
    );
    if (!result.ok) throw new Error(result.error.issues.map((issue) => issue.reason).join('\n'));
    events.push(result.value);
  });
  return events;
}

const mike = 'engineer-mike' as EmployeeId;
const initial = createInitialAgentState(mike);

describe('Runtime State：回放确定性（fast-check 属性）', () => {
  it('同一事件序列任意次回放，结果结构化等价', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 30 }), (steps) => {
        const events = buildEvents(steps);
        const first = replayAgentState(initial, events);
        const second = replayAgentState(initial, events);
        expect(second).toEqual(first);
        expect(first.version).toBeLessThanOrEqual(events.length);
        expect(first.branchId).toBe('live');
      }),
      { numRuns: 60 },
    );
  });

  it('混入其他员工事件不影响目标员工的回放结果（subject 过滤等价）', () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 30 }), (steps) => {
        const events = buildEvents(steps);
        const mine = events.filter((event) => event.subjectId === mike);
        expect(replayAgentState(initial, mine)).toEqual(replayAgentState(initial, events));
      }),
      { numRuns: 60 },
    );
  });

  it('分段回放与一次性回放等价（任意切分可结合）', () => {
    fc.assert(
      fc.property(
        fc.array(stepArb, { maxLength: 30 }),
        fc.nat({ max: 30 }),
        (steps, cutRaw) => {
          const events = buildEvents(steps);
          const cut = Math.min(cutRaw, events.length);
          const head = events.slice(0, cut);
          const tail = events.slice(cut);
          const whole = replayAgentState(initial, events);
          const folded = replayAgentState(replayAgentState(initial, head), tail);
          expect(folded).toEqual(whole);
        },
      ),
      { numRuns: 60 },
    );
  });
});
