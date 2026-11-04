import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import { createInMemoryEventStore } from '@maoeh/event-store';
import type { ControlHarness } from '../helpers/control-fixtures';
import { collectEvents, createControlHarness } from '../helpers/control-fixtures';

/**
 * M1.6 half-two · a person's *expertise* is organization state.
 *
 * `Position.capabilities` says what a seat owns; `Employee.expertise` says what the person is
 * good at. Both are matchable, so both must be recoverable — A3: the only way an organization
 * changes is an event, and a replay must rebuild the same answer. This pins the whole chain:
 *
 *   Agent.Create { expertise } → Runtime materialization → Control.AgentCreated
 *                              → read model (`expertise` on employee + agent)
 *                              → capability matching (a tag no seat declares)
 *                              → restart from the log → identical answer.
 */

const HIRE_AGENT = 'ai-dev-ravi';
const UNIQUE_TAG = 'pytorch';

function expertisePayload(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    employeeId: HIRE_AGENT,
    name: 'Ravi',
    positionId: 'ai-engineer',
    responsibilities: ['own the recommendation model'],
    expertise: ['typescript', UNIQUE_TAG],
    ...overrides,
  };
}

function payloadOf(event: OrgEvent | undefined): Readonly<Record<string, unknown>> {
  const payload = event?.payload;
  return typeof payload === 'object' && payload !== null
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

async function hire(
  h: ControlHarness,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<{ readonly status: string; readonly code: string | null }> {
  const outcome = await h.plane.control.execute(
    h.command('Agent.Create', { extra: expertisePayload(overrides) } as never),
  );
  return { status: outcome.status, code: outcome.failure?.code ?? null };
}

async function injectByCapability(h: ControlHarness, requiredSkills: readonly string[]) {
  return h.plane.control.execute(
    h.command('Organization.InjectTask', {
      targetType: 'organization',
      targetId: 'future-ai-lab',
      extra: { title: 'Train the recommender', goal: 'Ship the recommender', requiredSkills },
    } as never),
  );
}

describe('M1.6 · agent expertise is materialized, readable and matchable', () => {
  it('records the hired expertise on Control.AgentCreated and in the read model', async () => {
    const h = await createControlHarness();
    const created = await hire(h);
    expect(created.status).toBe('accepted');

    const event = (await collectEvents(h.simulation.eventStore)).find(
      (candidate) => candidate.type === 'Control.AgentCreated',
    );
    expect(payloadOf(event)['expertise']).toEqual(['typescript', UNIQUE_TAG]);

    const snapshot = await h.plane.control.query.getOrganizationSnapshot();
    expect(snapshot.employees.find((e) => e.employeeId === HIRE_AGENT)?.expertise).toEqual([
      'typescript',
      UNIQUE_TAG,
    ]);
    expect(snapshot.agents.find((a) => a.employeeId === HIRE_AGENT)?.expertise).toEqual([
      'typescript',
      UNIQUE_TAG,
    ]);
  });

  it('routes work to the person by a tag no seat declares', async () => {
    const h = await createControlHarness();
    expect((await hire(h)).status).toBe('accepted');
    // Sanity: the AI-engineer seat declares `implementation`, not `pytorch`.
    expect(
      h.organization.positions.find((position) => String(position.id) === 'ai-engineer')
        ?.capabilities,
    ).toEqual(['implementation']);

    const outcome = await injectByCapability(h, [UNIQUE_TAG]);
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const task = h.plane.control.query.getTasks()[0];
    expect(task?.assigneeEmployeeId).toBe(HIRE_AGENT);
    expect(task?.matchedCapabilities).toEqual([UNIQUE_TAG]);
    expect(task?.assignmentReason).toContain('Ravi');
  });

  it('rebuilds the expertise and the same routing answer after a restart', async () => {
    const store = createInMemoryEventStore();
    const first = await createControlHarness({ eventStore: store });
    expect((await hire(first)).status).toBe('accepted');
    const injected = await injectByCapability(first, [UNIQUE_TAG]);
    expect(injected.status, JSON.stringify(injected.failure)).toBe('accepted');
    const taskId = first.plane.control.query.getTasks()[0]?.taskId ?? '';

    const restarted = await createControlHarness({ eventStore: store });
    const employee = restarted.organization.employees.find((e) => String(e.id) === HIRE_AGENT);
    expect(employee?.expertise).toEqual(['typescript', UNIQUE_TAG]);
    expect(restarted.plane.control.query.getTask(taskId)?.assigneeEmployeeId).toBe(HIRE_AGENT);

    // Matching still works from the rebuilt roster — no live in-memory index was trusted.
    const again = await injectByCapability(restarted, [UNIQUE_TAG]);
    expect(again.status, JSON.stringify(again.failure)).toBe('accepted');
    const tasks = restarted.plane.control.query.getTasks();
    expect(tasks.at(-1)?.assigneeEmployeeId).toBe(HIRE_AGENT);
  });

  it('refuses an empty expertise tag with a field-level issue', async () => {
    const h = await createControlHarness();
    const outcome = await h.plane.control.execute(
      h.command('Agent.Create', {
        extra: expertisePayload({ expertise: ['   '] }),
      } as never),
    );
    expect(outcome.status).toBe('rejected');
    expect(outcome.failure?.code).toBe('INVALID_COMMAND');
    expect(outcome.failure?.issues[0]?.field).toBe('expertise');
    expect(h.plane.control.query.getAgents().some((a) => a.employeeId === HIRE_AGENT)).toBe(false);
  });

  it('inherits the seat holder expertise when the request states none', async () => {
    const h = await createControlHarness();
    // Hiring into the staffed `engineer` seat inherits Mike's specializations: the template *is* the
    // person who holds the requested seat, so a new engineer can do what the team already does.
    const outcome = await h.plane.control.execute(
      h.command('Agent.Create', {
        extra: {
          employeeId: 'engineer-sam',
          name: 'Sam',
          positionId: 'engineer',
          responsibilities: ['build the website'],
        },
      } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    const sam = h.organization.employees.find(
      (employee) => String(employee.id) === 'engineer-sam',
    );
    const mike = h.organization.employees.find(
      (employee) => String(employee.id) === 'engineer-mike',
    );
    expect(sam?.expertise).toEqual(mike?.expertise);
    expect(sam?.expertise?.length ?? 0).toBeGreaterThan(0);
  });

  it('never inherits expertise from a template that holds a different seat', async () => {
    const h = await createControlHarness();
    // `frontend-engineer` is unstaffed in the seed, so the template is only reachable through the
    // department / first-agent fallback — a *structural* stand-in. Borrowing its memory policy is
    // right; borrowing its person's specializations is not. The console's starter flow (the only
    // employee is the CEO) hit exactly this: every hire came back carrying Alex's strategy skills.
    const outcome = await h.plane.control.execute(
      h.command('Agent.Create', {
        extra: {
          employeeId: 'frontend-nova',
          name: 'Nova',
          positionId: 'frontend-engineer',
          responsibilities: ['build the marketing site'],
        },
      } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
    const nova = h.organization.employees.find(
      (employee) => String(employee.id) === 'frontend-nova',
    );
    expect(nova?.expertise ?? []).toEqual([]);
  });
});

describe('M1.6 · expertise never overrides the organization', () => {
  it('does not invent a candidate for a tag nobody declares', async () => {
    const h = await createControlHarness();
    const outcome = await injectByCapability(h, ['teleportation']);
    expect(outcome.status).toBe('rejected');
    expect(outcome.failure?.code).toBe('INVALID_TARGET');
    expect(h.plane.control.query.getTasks()).toEqual([]);
  });
});
