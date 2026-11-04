import { describe, expect, it } from 'vitest';
import type { EmployeeId, OrgEvent } from '@maoeh/shared-types';
import {
  AGENT_ARCHIVED,
  AGENT_CREATED,
  ARCHIVED_EMPLOYMENT_STATUS,
  CONTROL_AGENT_ARCHIVED,
  CONTROL_AGENT_CREATED,
} from '@maoeh/organization-control';
import type { ControlHarness } from '../../helpers/control-fixtures';
import {
  NO_CONTROL_POLICY,
  collectEvents,
  createControlHarness,
} from '../../helpers/control-fixtures';

/**
 * M1.3 · Agent Lifecycle Management, at the Control Plane.
 *
 * The chain under test is the milestone's acceptance chain, minus the HTTP edge (covered by
 * `tests/integration/agent-lifecycle-http.test.ts`):
 *
 *   ControlCommand → validate → authorize → Runtime (ControlSimulationPort) → Organization
 *                  → EventStore.append → Audit.record
 */

const CEO = 'ceo-alex';
const HIRE_AGENT = 'backend-priya';

interface CreateOverrides {
  readonly employeeId?: string;
  readonly name?: string;
  readonly positionId?: string;
  readonly employeeNo?: string;
  readonly responsibilities?: readonly string[];
  readonly traits?: readonly string[];
  readonly templateEmployeeId?: string;
}

function createPayload(overrides: CreateOverrides = {}): Readonly<Record<string, unknown>> {
  return {
    employeeId: HIRE_AGENT,
    name: 'Priya',
    positionId: 'backend-engineer',
    employeeNo: 'FAL-004',
    responsibilities: ['test_strategy', 'release_verification'],
    traits: ['methodical'],
    ...overrides,
  };
}

function payloadOf(event: OrgEvent | undefined): Readonly<Record<string, unknown>> {
  const payload = event?.payload;
  return typeof payload === 'object' && payload !== null
    ? (payload as Readonly<Record<string, unknown>>)
    : {};
}

function eventsOfType(events: readonly OrgEvent[], type: string): readonly OrgEvent[] {
  return events.filter((event) => event.type === type);
}

async function storedEvents(h: ControlHarness): Promise<readonly OrgEvent[]> {
  return collectEvents(h.simulation.eventStore);
}

async function createAgent(
  h: ControlHarness,
  overrides: CreateOverrides = {},
): Promise<{ readonly status: string; readonly code: string | null }> {
  const outcome = await h.plane.control.execute(
    h.command('Agent.Create', { extra: { ...createPayload(overrides) } } as never),
  );
  return { status: outcome.status, code: outcome.failure?.code ?? null };
}

async function archiveAgent(
  h: ControlHarness,
  agentId: string,
): Promise<{ readonly status: string; readonly code: string | null; readonly reason: string }> {
  const outcome = await h.plane.control.execute(h.command('Agent.Archive', { targetId: agentId }));
  return {
    status: outcome.status,
    code: outcome.failure?.code ?? null,
    reason: outcome.failure?.issues.map((issue) => issue.reason).join(' ') ?? '',
  };
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

describe('M1.3 Agent CRUD: Create Agent', () => {
  it('places a real agent: roster, runtime, event store and audit all agree', async () => {
    const h = await createControlHarness();

    const outcome = await h.plane.control.execute(
      h.command('Agent.Create', { extra: { ...createPayload() } } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    // Read model: the new employee is part of the organization the console reads.
    const agent = h.plane.control.query.getAgent(HIRE_AGENT as EmployeeId);
    expect(agent).not.toBeNull();
    expect(agent).toMatchObject({
      employeeId: HIRE_AGENT,
      name: 'Priya',
      positionId: 'backend-engineer',
      status: 'active',
      lifecycle: 'active',
      kind: 'agent',
    });
    const snapshot = await h.plane.control.query.getOrganizationSnapshot();
    expect(snapshot.agents.map((row) => row.employeeId)).toContain(HIRE_AGENT);
    const position = snapshot.positions.find((row) => row.positionId === 'backend-engineer');
    expect(position?.employeeIds).toContain(HIRE_AGENT);

    // Runtime: the agent is instantiated, so the scheduler can hand it a turn.
    expect(h.simulation.agents.has(HIRE_AGENT as EmployeeId)).toBe(true);

    // EventStore: `AGENT_CREATED` is the fact, named after the new employee.
    const created = eventsOfType(await storedEvents(h), CONTROL_AGENT_CREATED);
    expect(created).toHaveLength(1);
    expect(created[0]?.subjectType).toBe('employee');
    expect(created[0]?.subjectId).toBe(HIRE_AGENT);
    expect(payloadOf(created[0])).toMatchObject({
      commandId: outcome.commandId,
      operatorId: 'operator-dana',
      agentId: HIRE_AGENT,
      name: 'Priya',
      positionId: 'backend-engineer',
      employeeNo: 'FAL-004',
      responsibilities: ['test_strategy', 'release_verification'],
      traits: ['methodical'],
      templateEmployeeId: null,
      status: 'active',
    });
    // The 8-layer structure comes from a real definition, never from the prompt.
    expect(typeof payloadOf(created[0])['cognitionProfileId']).toBe('string');
    expect(String(payloadOf(created[0])['cognitionProfileId'])).not.toBe('');

    // Audit: the operator, the reason and the verdict are recorded against the command.
    const audit = h.audit.find(outcome.commandId);
    expect(audit?.verdict).toBe('accepted');
    expect(audit?.action.type).toBe('Agent.Create');
    expect(audit?.action.reason).toBe('operator action under test');
    expect(audit?.actorId).toBe('operator-dana');
    expect(audit?.action.resource).toBe('organization:future-ai-lab');
    expect(audit?.target).toEqual({
      targetType: 'organization',
      targetId: 'future-ai-lab',
    });
    expect(audit?.eventIds).toEqual([created[0]?.eventId]);
  });

  it('gives the new agent the permissions of its position, immediately', async () => {
    const h = await createControlHarness();
    expect((await createAgent(h)).status).toBe('accepted');

    // Task assignment resolves the position to its holder through the live organization graph.
    const taskId = await injectTask(h, 'backend-engineer', 'verify the release');
    expect(h.plane.control.query.getTask(taskId)?.assigneeEmployeeId).toBe(HIRE_AGENT);

    // A created agent acts with its own ActorContext (identity registration is part of placement).
    const context = h.simulation.identity.actorContext(
      HIRE_AGENT as EmployeeId,
      'corr-m1.3-authz' as never,
    );
    expect(context.positionId).toBe('backend-engineer');
    expect(context.departmentId).toBe('engineering');
  });

  it('honours an explicit template and the operator mandate', async () => {
    const h = await createControlHarness();
    const outcome = await h.plane.control.execute(
      h.command('Agent.Create', {
        extra: {
          ...createPayload({ templateEmployeeId: 'engineer-mike' }),
        },
      } as never),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const created = eventsOfType(await storedEvents(h), CONTROL_AGENT_CREATED)[0];
    expect(payloadOf(created)).toMatchObject({
      templateEmployeeId: 'engineer-mike',
      definitionSource: 'engineer-mike',
      cognitionProfileId: 'tech-task',
    });
    const definition = h.simulation.agents.get(HIRE_AGENT as EmployeeId)?.definition;
    expect(definition?.responsibilities).toEqual(['test_strategy', 'release_verification']);
    expect(definition?.identity.traits).toEqual(['methodical']);
  });

  it('is idempotent per commandId and never creates the agent twice', async () => {
    const h = await createControlHarness();
    const command = h.command('Agent.Create', { extra: { ...createPayload() } } as never);
    const first = await h.plane.control.execute(command);
    const second = await h.plane.control.execute(command);

    expect(first.status).toBe('accepted');
    expect(second.replayed).toBe(true);
    expect(second.status).toBe('accepted');
    expect(eventsOfType(await storedEvents(h), CONTROL_AGENT_CREATED)).toHaveLength(1);
    expect(
      h.simulation.organization.employees.filter((employee) => employee.id === HIRE_AGENT),
    ).toHaveLength(1);
  });

  it('fails closed: duplicate id, unknown position and an empty mandate are refused', async () => {
    const h = await createControlHarness();

    const duplicateName = await createAgent(h, { employeeId: CEO });
    expect(duplicateName).toEqual({ status: 'rejected', code: 'CONFLICT' });

    const unknownPosition = await createAgent(h, { positionId: 'ghost-position' });
    expect(unknownPosition).toEqual({ status: 'rejected', code: 'INVALID_TARGET' });

    const noMandate = await createAgent(h, { responsibilities: [] });
    expect(noMandate).toEqual({ status: 'rejected', code: 'INVALID_COMMAND' });

    const takenEmployeeNo = await createAgent(h, { employeeNo: 'OP-001' });
    expect(takenEmployeeNo).toEqual({ status: 'rejected', code: 'CONFLICT' });

    // Nothing was half-created: no event, no employee, no agent.
    expect(eventsOfType(await storedEvents(h), CONTROL_AGENT_CREATED)).toHaveLength(0);
    expect(h.simulation.agents.has(HIRE_AGENT as EmployeeId)).toBe(false);
    expect(
      h.simulation.organization.employees.some((employee) => employee.id === HIRE_AGENT),
    ).toBe(false);
  });

  it('validates the payload before the roster changes: template and length are refused first', async () => {
    const h = await createControlHarness();

    const unknownTemplate = await h.plane.control.execute(
      h.command('Agent.Create', {
        extra: { ...createPayload({ templateEmployeeId: 'ghost-agent' }) },
      } as never),
    );
    expect(unknownTemplate.status).toBe('rejected');
    expect(unknownTemplate.failure?.code).toBe('INVALID_COMMAND');
    expect(unknownTemplate.failure?.issues[0]?.field).toBe('templateEmployeeId');

    // A payload the event schema would reject is refused *before* the Runtime places anybody,
    // so a rejected command can never leave an employee without its `Agent.Created` fact.
    const overLong = await h.plane.control.execute(
      h.command('Agent.Create', { extra: { ...createPayload({ name: 'P'.repeat(300) }) } } as never),
    );
    expect(overLong.status).toBe('rejected');
    expect(overLong.failure?.code).toBe('INVALID_COMMAND');
    expect(overLong.failure?.issues[0]?.field).toBe('name');

    expect(eventsOfType(await storedEvents(h), CONTROL_AGENT_CREATED)).toHaveLength(0);
    expect(
      h.simulation.organization.employees.some((employee) => employee.id === HIRE_AGENT),
    ).toBe(false);
  });

  it('requires the ControlAgent grant: a policy without it refuses the command', async () => {
    const h = await createControlHarness({ policy: NO_CONTROL_POLICY });
    const outcome = await createAgent(h);
    expect(outcome).toEqual({ status: 'rejected', code: 'UNAUTHORIZED' });
    expect(eventsOfType(await storedEvents(h), CONTROL_AGENT_CREATED)).toHaveLength(0);
  });
});

describe('M1.3 Agent CRUD: Archive Agent', () => {
  it('archives instead of deleting: status flips, every record survives', async () => {
    const h = await createControlHarness();
    expect((await createAgent(h)).status).toBe('accepted');
    const taskHistory = await storedEvents(h);

    const outcome = await h.plane.control.execute(
      h.command('Agent.Archive', { targetId: HIRE_AGENT }),
    );
    expect(outcome.status, JSON.stringify(outcome.failure)).toBe('accepted');

    const agent = h.plane.control.query.getAgent(HIRE_AGENT as EmployeeId);
    expect(agent?.lifecycle).toBe('archived');
    expect(agent?.status).toBe(ARCHIVED_EMPLOYMENT_STATUS);

    // Not a physical delete: the employee record, the definition and the history are all there.
    const employee = h.simulation.organization.employees.find(
      (entry) => String(entry.id) === HIRE_AGENT,
    );
    expect(employee?.status).toBe(ARCHIVED_EMPLOYMENT_STATUS);
    expect(h.simulation.agents.has(HIRE_AGENT as EmployeeId)).toBe(true);
    expect((await storedEvents(h)).length).toBeGreaterThan(taskHistory.length);

    const archived = eventsOfType(await storedEvents(h), CONTROL_AGENT_ARCHIVED);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.subjectId).toBe(HIRE_AGENT);
    expect(payloadOf(archived[0])).toMatchObject({
      commandId: outcome.commandId,
      agentId: HIRE_AGENT,
      status: 'archived',
      employmentStatus: ARCHIVED_EMPLOYMENT_STATUS,
    });
    expect(h.audit.find(outcome.commandId)?.verdict).toBe('accepted');
  });

  it('refuses to archive an agent that still owns a running task, and says which one', async () => {
    const h = await createControlHarness();
    expect((await createAgent(h)).status).toBe('accepted');
    const taskId = await injectTask(h, 'backend-engineer', 'running work');
    expect(h.plane.control.query.getTask(taskId)?.assigneeEmployeeId).toBe(HIRE_AGENT);

    const refused = await archiveAgent(h, HIRE_AGENT);
    expect(refused.status).toBe('rejected');
    expect(refused.code).toBe('CONFLICT');
    expect(refused.reason).toContain(taskId);
    expect(refused.reason).toContain('archive is refused');

    // The refusal left the agent on the roster with no archive event.
    expect(h.plane.control.query.getAgent(HIRE_AGENT as EmployeeId)?.lifecycle).toBe('active');
    expect(eventsOfType(await storedEvents(h), CONTROL_AGENT_ARCHIVED)).toHaveLength(0);

    // Once the work is gone, the same archive is accepted.
    const cancel = await h.plane.control.execute(
      h.command('Task.Cancel', { targetId: taskId }),
    );
    expect(cancel.status, JSON.stringify(cancel.failure)).toBe('accepted');
    expect((await archiveAgent(h, HIRE_AGENT)).status).toBe('accepted');
  });

  it('is a one-way transition: the second archive and every later command are refused', async () => {
    const h = await createControlHarness();
    await createAgent(h);
    expect((await archiveAgent(h, HIRE_AGENT)).status).toBe('accepted');

    const again = await archiveAgent(h, HIRE_AGENT);
    expect(again.status).toBe('rejected');
    expect(again.code).toBe('CONFLICT');
    expect(again.reason).toContain('already archived');

    const instruct = await h.plane.control.execute(
      h.command('Agent.Instruct', {
        targetId: HIRE_AGENT,
        extra: { instruction: 'one more thing' },
      } as never),
    );
    expect(instruct.status).toBe('rejected');
    expect(instruct.failure?.code).toBe('INVALID_STATE');
    expect(eventsOfType(await storedEvents(h), CONTROL_AGENT_ARCHIVED)).toHaveLength(1);
  });

  it('refuses to archive the identity the operator is acting as', async () => {
    const h = await createControlHarness();
    const outcome = await h.plane.control.execute(
      h.command('Agent.Archive', { targetId: 'operator-dana' }),
    );
    expect(outcome.status).toBe('rejected');
    expect(outcome.failure?.code).toBe('FORBIDDEN');
    expect(outcome.failure?.issues[0]?.reason).toContain('cannot archive the agent it is acting as');
  });

  it('refuses an unknown agent and an operator without the grant', async () => {
    const h = await createControlHarness();
    expect((await archiveAgent(h, 'ghost-agent')).code).toBe('NOT_FOUND');

    const unauthorised = await createControlHarness({ policy: NO_CONTROL_POLICY });
    expect((await archiveAgent(unauthorised, CEO)).code).toBe('UNAUTHORIZED');
    expect(eventsOfType(await storedEvents(unauthorised), CONTROL_AGENT_ARCHIVED)).toHaveLength(0);
  });
});

describe('M1.3 Agent CRUD: the archive event is the domain vocabulary', () => {
  it('names its constants AGENT_CREATED / AGENT_ARCHIVED and registers them', () => {
    expect(AGENT_CREATED).toBe('Control.AgentCreated');
    expect(AGENT_ARCHIVED).toBe('Control.AgentArchived');
    expect(AGENT_CREATED).toBe(CONTROL_AGENT_CREATED);
    expect(AGENT_ARCHIVED).toBe(CONTROL_AGENT_ARCHIVED);
  });
});
