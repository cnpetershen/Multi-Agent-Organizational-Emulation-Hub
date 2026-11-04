import { describe, expect, it } from 'vitest';
import type { EmployeeId, OrgEvent } from '@maoeh/shared-types';
import { createInMemoryEventStore } from '@maoeh/event-store';
import { ARCHIVED_EMPLOYMENT_STATUS } from '@maoeh/organization-control';
import {
  collectEvents,
  createControlHarness,
  type ControlHarness,
} from '../helpers/control-fixtures';
import { createSimulationHarness } from '../helpers/simulation-fixtures';

/**
 * M1.3 · Agent Lifecycle Management, at the Runtime.
 *
 * These tests exercise what "create" and "archive" mean for a running organization:
 * a created agent is instantiated and can really do work, an archived agent keeps every record
 * but stops being schedulable, and both facts survive a replay of the event log.
 */

const HIRE_AGENT = 'backend-priya';

const NEW_AGENT = {
  employeeId: HIRE_AGENT,
  name: 'Priya',
  positionId: 'backend-engineer',
  employeeNo: 'FAL-004',
  responsibilities: ['test_strategy', 'release_verification'],
  traits: ['methodical'],
  templateEmployeeId: 'engineer-mike',
} as const;

function payloadOf(event: OrgEvent | undefined): Readonly<Record<string, unknown>> {
  const payload = event?.payload;
  return typeof payload === 'object' && payload !== null
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

async function createAgent(h: ControlHarness): Promise<void> {
  const outcome = await h.plane.control.execute(
    h.command('Agent.Create', { extra: { ...NEW_AGENT } } as never),
  );
  expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
}

async function archiveAgent(h: ControlHarness): Promise<string> {
  const outcome = await h.plane.control.execute(h.command('Agent.Archive', { targetId: HIRE_AGENT }));
  return outcome.status;
}

async function injectTask(h: ControlHarness, positionId: string, title: string): Promise<string> {
  const outcome = await h.plane.control.execute(
    h.command('Organization.InjectTask', {
      extra: { title, goal: `goal for ${title}`, positionId },
    } as never),
  );
  expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');
  const task = h.plane.control.query.getTasks().find((summary) => summary.title === title);
  if (task === undefined) throw new Error(`injected task "${title}" is not visible`);
  return task.taskId;
}

describe('M1.3 runtime: a created agent is a real, working agent', () => {
  it('takes the task assigned to its position and submits the work', async () => {
    const h = await createControlHarness();
    await createAgent(h);
    const taskId = await injectTask(h, 'backend-engineer', 'verify the release candidate');
    expect(h.plane.control.query.getTask(taskId)?.assigneeEmployeeId).toBe(HIRE_AGENT);

    const [result] = await h.harness.run(1);
    expect(result?.turns.map((turn) => turn.employeeId)).toEqual([HIRE_AGENT]);
    // `acted` is the runtime's own outcome for "a plan produced effects" (cycle.ts).
    expect(result?.turns[0]?.status).toBe('acted');
    expect(result?.turns[0]?.emittedEventCount).toBeGreaterThan(0);

    // The work is real: the task went through accept → start → submit using the agent's own
    // ActorContext and the permissions of the `qa` position it was placed in, and the kernel's
    // reactor settled the standalone task.
    expect(h.plane.control.query.getTask(taskId)?.status).toBe('completed');
    const events = await collectEvents(h.simulation.eventStore);
    expect(
      events
        .filter((event) => event.type.startsWith('Runtime.'))
        .map((event) => String(event.subjectId)),
    ).toContain(HIRE_AGENT);
  });

  it('keeps the agent definition the operator asked for', async () => {
    const h = await createControlHarness();
    await createAgent(h);
    const bundle = h.simulation.agents.get(HIRE_AGENT as EmployeeId);
    expect(bundle?.definition.employeeId).toBe(HIRE_AGENT);
    expect(bundle?.definition.positionId).toBe('backend-engineer');
    expect(bundle?.definition.responsibilities).toEqual([
      'test_strategy',
      'release_verification',
    ]);
    expect(bundle?.definition.capabilities).toEqual(
      h.simulation.agents.get('engineer-mike' as EmployeeId)?.definition.capabilities,
    );
  });
});

describe('M1.3 runtime: an archived agent stops being schedulable, keeps everything else', () => {
  it('cancels the wakeups already queued for the agent', async () => {
    const h = await createControlHarness();
    await createAgent(h);

    const instructed = await h.plane.control.execute(
      h.command('Agent.Instruct', {
        targetId: HIRE_AGENT,
        extra: { instruction: 'draft the test plan' },
      } as never),
    );
    expect(instructed.status, JSON.stringify(instructed.failure)).toBe('accepted');
    expect(
      h.simulation.scheduler.pending().filter((wakeup) => String(wakeup.agentId) === HIRE_AGENT),
    ).toHaveLength(1);

    expect(await archiveAgent(h)).toBe('accepted');
    expect(
      h.simulation.scheduler.pending().filter((wakeup) => String(wakeup.agentId) === HIRE_AGENT),
    ).toHaveLength(0);

    const [result] = await h.harness.run(1);
    expect(result?.turns.map((turn) => turn.employeeId)).not.toContain(HIRE_AGENT);
  });

  it('leaves a position effectively open instead of feeding work to a retired agent', async () => {
    const h = await createControlHarness();
    await createAgent(h);
    expect(await archiveAgent(h)).toBe('accepted');

    // Assigning to the vacated position still works — it simply waits for somebody who can
    // actually do the work instead of handing it to the archived agent.
    const taskId = await injectTask(h, 'backend-engineer', 'work for a retired agent');
    expect(h.plane.control.query.getTask(taskId)?.assigneeEmployeeId).toBeNull();
    expect(h.plane.control.query.getTask(taskId)?.status).toBe('assigned');

    const [result] = await h.harness.run(1);
    expect(result?.turns.map((turn) => turn.employeeId)).not.toContain(HIRE_AGENT);
  });

  it('revokes the archive decision through the domain, not by deleting records', async () => {
    const h = await createControlHarness();
    await createAgent(h);
    expect(await archiveAgent(h)).toBe('accepted');

    const employee = h.simulation.organization.employees.find(
      (entry) => String(entry.id) === HIRE_AGENT,
    );
    expect(employee?.status).toBe(ARCHIVED_EMPLOYMENT_STATUS);
    // The identity is still resolvable (history, audit and memory stay addressable).
    expect(h.simulation.identity.resolve(HIRE_AGENT as EmployeeId).name).toBe('Priya');
  });
});

describe('M1.3 runtime: the roster is rebuilt from the event log', () => {
  it('re-places a created agent on recovery and archives it again from the log', async () => {
    const store = createInMemoryEventStore();
    const first = await createControlHarness({ eventStore: store });
    await createAgent(first);

    const replayed = await createSimulationHarness({ eventStore: store });
    const placed = replayed.simulation.organization.employees.find(
      (entry) => String(entry.id) === HIRE_AGENT,
    );
    expect(placed?.status).toBe('active');
    expect(replayed.simulation.agents.has(HIRE_AGENT as EmployeeId)).toBe(true);
    // The same 8-layer structure is rebuilt, including the template's cognition profile.
    expect(replayed.simulation.agents.get(HIRE_AGENT as EmployeeId)?.definition.cognitionProfileId).toBe('tech-task');
    // The creation fact on the log is complete enough to place the agent again.
    const created = (await collectEvents(store)).find(
      (event) => event.type === 'Control.AgentCreated',
    );
    expect(payloadOf(created)).toMatchObject({
      agentId: HIRE_AGENT,
      name: 'Priya',
      positionId: 'backend-engineer',
      employeeNo: 'FAL-004',
      templateEmployeeId: 'engineer-mike',
      status: 'active',
    });

    const archived = await createControlHarness({ eventStore: store });
    const archiveOutcome = await archived.plane.control.execute(
      archived.command('Agent.Archive', { targetId: HIRE_AGENT }),
    );
    expect(archiveOutcome.status, JSON.stringify(archiveOutcome.failure)).toBe('accepted');

    const afterArchive = await createSimulationHarness({ eventStore: store });
    const retired = afterArchive.simulation.organization.employees.find(
      (entry) => String(entry.id) === HIRE_AGENT,
    );
    expect(retired?.status).toBe(ARCHIVED_EMPLOYMENT_STATUS);
    // Not deleted, and the event that closed it is still on the log.
    const events = await collectEvents(store);
    expect(events.map((event) => event.type)).toContain('Control.AgentArchived');
  });

  it('keeps the roster at one employee when the same log is replayed twice', async () => {
    const store = createInMemoryEventStore();
    const h = await createControlHarness({ eventStore: store });
    await createAgent(h);

    // A second simulation over the same log (a restart) must not add the agent twice.
    await createSimulationHarness({ eventStore: store });
    const third = await createSimulationHarness({ eventStore: store });
    expect(
      third.simulation.organization.employees.filter(
        (entry) => String(entry.id) === HIRE_AGENT,
      ),
    ).toHaveLength(1);
  });
});
