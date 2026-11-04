import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import { createInMemoryEventStore } from '@maoeh/event-store';
import { capabilityLabel, requiredCapabilitiesFor } from '@maoeh/organization-model';
import type { ControlHarness } from '../helpers/control-fixtures';
import { collectEvents, createControlHarness } from '../helpers/control-fixtures';

/**
 * M1.6 half-two acceptance · "开发一个官网" (build a marketing website).
 *
 * This is the end-to-end sentence from the milestone brief, with the pieces keeping their
 * real jobs — no step is stubbed:
 *
 *   user goal text → `requiredCapabilitiesFor` (deterministic, no LLM)
 *                  → `Organization.InjectTask { requiredSkills }`
 *                  → capability matching over the live organization
 *                  → `Task.Assigned` + `Control.DelegationDecided`
 *                  → the engineer is woken with the work.
 *
 * The claim under test is not "somebody got the task": it is that the *engineer* did, and that
 * the log says why in capabilities a reader recognizes (frontend / implementation).
 */

const WEBSITE_GOAL = '开发一个官网';

async function inject(h: ControlHarness, extra: Readonly<Record<string, unknown>>) {
  return h.plane.control.execute(
    h.command('Organization.InjectTask', {
      targetType: 'organization',
      targetId: 'future-ai-lab',
      extra,
    } as never),
  );
}

function payloadOf(event: OrgEvent | undefined): Readonly<Record<string, unknown>> {
  const payload = event?.payload;
  return typeof payload === 'object' && payload !== null
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

describe('M1.6 acceptance · a website task finds the engineer by capability', () => {
  it('analyses the goal, matches the engineer and records why — as events', async () => {
    const h = await createControlHarness();

    // 1. Requirement analysis: "开发一个官网" is implementation work that is frontend-specific.
    const required = requiredCapabilitiesFor(WEBSITE_GOAL);
    expect(required).toEqual(['implementation', 'frontend']);

    // 2. Route by capability, not by naming a seat.
    const outcome = await inject(h, {
      title: WEBSITE_GOAL,
      goal: WEBSITE_GOAL,
      requiredSkills: required,
    });
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    // 3. The engineer got it, covering both required capabilities.
    const task = h.plane.control.query.getTasks()[0];
    expect(task?.assigneeEmployeeId).toBe('engineer-mike');
    expect(task?.positionId).toBe('engineer');
    expect(task?.requiredSkills).toEqual(required);
    expect(task?.matchedCapabilities).toEqual(required);

    // 4. And the console can explain it in words a human reads, not ids.
    expect(task?.assignmentReason).toContain('Mike');
    expect(task?.assignmentReason).toContain(capabilityLabel('implementation'));
    expect(task?.assignmentReason).toContain(capabilityLabel('frontend'));

    // 5. The decision is a fact on the log, ordered after the assignment it explains.
    const events = await collectEvents(h.simulation.eventStore);
    const types = events.map((event) => event.type);
    expect(types.indexOf('Task.Created')).toBeLessThan(types.indexOf('Task.Assigned'));
    expect(types.indexOf('Task.Assigned')).toBeLessThan(
      types.indexOf('Control.DelegationDecided'),
    );
    const decided = events.find((event) => event.type === 'Control.DelegationDecided');
    expect(payloadOf(decided)).toMatchObject({
      taskId: task?.taskId,
      requiredCapabilities: required,
      assigneeEmployeeId: 'engineer-mike',
      assigneePositionId: 'engineer',
      rationale: task?.assignmentReason,
    });

    // 6. The scheduler really wakes the matched employee with this work.
    const results = await h.harness.run(1);
    expect(results[0]?.turns.map((turn) => turn.employeeId)).toEqual(['engineer-mike']);
  });

  it('restores the assignment and its reason from the event log alone', async () => {
    const store = createInMemoryEventStore();
    const first = await createControlHarness({ eventStore: store });
    const required = requiredCapabilitiesFor(WEBSITE_GOAL);
    const outcome = await inject(first, {
      title: WEBSITE_GOAL,
      goal: WEBSITE_GOAL,
      requiredSkills: required,
    });
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    const taskId = first.plane.control.query.getTasks()[0]?.taskId ?? '';
    const before = first.plane.control.query.getTask(taskId);

    const restarted = await createControlHarness({ eventStore: store });
    const after = restarted.plane.control.query.getTask(taskId);
    expect(after?.assigneeEmployeeId).toBe('engineer-mike');
    expect(after?.matchedCapabilities).toEqual(required);
    expect(after?.assignmentReason).toBe(before?.assignmentReason);

    // The folded task record carries the same explanation.
    const folded = restarted.simulation.tasks.get(taskId);
    expect(folded?.matchedCapabilities).toEqual(required);
    expect(folded?.assignment.assigneeEmployeeId).toBe('engineer-mike');
  });

  it('keeps the frontend/backend vocabulary usable as an explicit requirement', async () => {
    const h = await createControlHarness();
    // A backend-only task must route to the engineer as well (the seat declares `backend`).
    const outcome = await inject(h, {
      title: '搭建后端服务',
      goal: '搭建后端服务',
      requiredSkills: ['backend'],
    });
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    const task = h.plane.control.query.getTasks()[0];
    expect(task?.assigneeEmployeeId).toBe('engineer-mike');
    expect(task?.matchedCapabilities).toEqual(['backend']);
    expect(task?.assignmentReason).toContain(capabilityLabel('backend'));
  });
});
