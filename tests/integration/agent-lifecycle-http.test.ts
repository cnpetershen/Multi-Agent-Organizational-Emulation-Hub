import { describe, expect, it } from 'vitest';
import type { ControlCommand } from '@maoeh/organization-control';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M1.3 · Agent Lifecycle Management, over the real HTTP surface.
 *
 * This is the acceptance chain the milestone asks for, exercised end to end and outside the
 * process that serves it:
 *
 *   console (`POST /api/command`, `GET /api/agents…`)
 *     → HTTP edge (apps/api)
 *       → ControlPlane.execute (validate → authorize)
 *         → Runtime (kernel port → Simulation.createAgent / archiveAgent)
 *           → Organization (the roster really changed)
 *             → EventStore (Control.AgentCreated / Control.AgentArchived appended)
 *               → Audit (who did it, why, and what the system answered)
 *
 * Every observation below is a real `GET` the Agent Management page renders.
 */

type Json = Readonly<Record<string, unknown>>;

const OPERATOR = {
  operatorId: 'ceo-alex',
  displayName: 'Alex',
  positionId: 'ceo',
  kind: 'human',
} as const;

const NEW_AGENT = {
  employeeId: 'backend-priya',
  name: 'Priya',
  positionId: 'backend-engineer',
  employeeNo: 'FAL-004',
  responsibilities: ['test_strategy', 'release_verification'],
  traits: ['methodical'],
  templateEmployeeId: 'engineer-mike',
} as const;

let commandSeq = 0;

function command(
  commandType: ControlCommand['commandType'],
  overrides: Readonly<Record<string, unknown>> = {},
): ControlCommand {
  commandSeq += 1;
  const commandId = `cmd-m13-${String(commandSeq)}`;
  return {
    commandId,
    commandType,
    actor: OPERATOR,
    target: { targetType: 'organization', targetId: 'future-ai-lab' },
    reason: 'M1.3 agent lifecycle verification',
    correlationId: commandId,
    causationId: null,
    createdAtSim: 0,
    ...overrides,
  } as ControlCommand;
}

function viewOf(value: unknown): Json {
  return (typeof value === 'object' && value !== null ? value : {}) as Json;
}

function rowsOf(value: unknown): readonly Json[] {
  return Array.isArray(value) ? (value as readonly Json[]) : [];
}

describe('M1.3: an operator manages the agent roster through the console API', () => {
  it('creates, reads and archives an agent with events and audit on every step', async () => {
    const server = await startApiServer(0, { tick: { activeIntervalMs: 5, idleIntervalMs: 50 }, eventLogPath: null });
    const base = `http://127.0.0.1:${String(server.port)}/api`;
    const get = async (path: string): Promise<{ status: number; body: unknown }> => {
      const response = await fetch(`${base}${path}`, { headers: { connection: 'close' } });
      return { status: response.status, body: (await response.json()) as unknown };
    };
    const post = async (payload: ControlCommand): Promise<Json> => {
      const response = await fetch(`${base}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(200);
      return viewOf(await response.json());
    };
    const expectAccepted = async (payload: ControlCommand): Promise<void> => {
      const outcome = await post(payload);
      expect(String(outcome['status']), JSON.stringify(outcome['failure'])).toBe('accepted');
    };

    try {
      // 0. Hold the runtime: the tick driver runs every few milliseconds, and this scenario is
      // about lifecycle decisions, not about racing the scheduler. Holding is exactly what the
      // console does while an operator inspects the roster.
      await expectAccepted(
        command('Simulation.Pause', {
          target: { targetType: 'simulation', targetId: 'future-ai-lab' },
          reason: 'M1.3: hold the runtime while managing the roster',
        }),
      );

      // 1. Create — the roster is the target, the new agent is the subject of the event.
      const create = command('Agent.Create', { ...NEW_AGENT });
      await expectAccepted(create);

      const list = rowsOf((await get('/agents')).body);
      const created = list.find((row) => row['employeeId'] === NEW_AGENT.employeeId);
      expect(created, 'the new agent is part of GET /api/agents').toBeDefined();
      expect(created?.['lifecycle']).toBe('active');
      expect(created?.['status']).toBe('active');
      expect(created?.['positionId']).toBe('backend-engineer');

      // Read one agent — the by-id counterpart of the roster list.
      const detail = await get(`/agents/${NEW_AGENT.employeeId}`);
      expect(detail.status).toBe(200);
      expect(viewOf(detail.body)).toMatchObject({
        employeeId: NEW_AGENT.employeeId,
        name: 'Priya',
        lifecycle: 'active',
      });
      expect((await get('/agents/ghost-agent')).status).toBe(404);

      // The snapshot the console polls shows the same employee in the organization chart.
      const snapshot = viewOf((await get('/snapshot')).body);
      expect(rowsOf(snapshot['agents']).map((row) => row['employeeId'])).toContain(
        NEW_AGENT.employeeId,
      );
      const qa = rowsOf(snapshot['positions']).find((row) => row['positionId'] === 'backend-engineer');
      expect(qa?.['employeeIds']).toContain(NEW_AGENT.employeeId);

      // 2. Archive is refused while the agent owns running work (requirement: never orphan a task).
      const injected = await post(
        command('Organization.InjectTask', {
          target: { targetType: 'organization', targetId: 'future-ai-lab' },
          title: 'Verify the release candidate',
          goal: 'Publish the verification report',
          positionId: 'backend-engineer',
        }),
      );
      expect(String(injected['status']), JSON.stringify(injected['failure'])).toBe('accepted');
      const task = rowsOf((await get('/tasks')).body).find(
        (row) => row['title'] === 'Verify the release candidate',
      );
      const taskId = String(task?.['taskId']);
      expect(task?.['assigneeEmployeeId']).toBe(NEW_AGENT.employeeId);

      const refused = await post(
        command('Agent.Archive', {
          target: { targetType: 'agent', targetId: NEW_AGENT.employeeId },
        }),
      );
      expect(String(refused['status'])).toBe('rejected');
      expect(String(viewOf(refused['failure'])['code'])).toBe('CONFLICT');
      expect(JSON.stringify(refused['failure'])).toContain(taskId);
      expect(viewOf((await get(`/agents/${NEW_AGENT.employeeId}`)).body)['lifecycle']).toBe(
        'active',
      );

      // 3. With the work cancelled, the archive goes through — as a status, not a deletion.
      const cancel = await post(
        command('Task.Cancel', { target: { targetType: 'task', targetId: taskId } }),
      );
      expect(String(cancel['status']), JSON.stringify(cancel['failure'])).toBe('accepted');

      const archive = command('Agent.Archive', {
        target: { targetType: 'agent', targetId: NEW_AGENT.employeeId },
        reason: 'role retired by the board',
      });
      await expectAccepted(archive);

      const archived = viewOf((await get(`/agents/${NEW_AGENT.employeeId}`)).body);
      expect(archived['lifecycle']).toBe('archived');
      expect(archived['status']).toBe('offboarded');
      // Readable, not gone: the identity stays in the roster read.
      expect(rowsOf((await get('/agents')).body).map((row) => row['employeeId'])).toContain(
        NEW_AGENT.employeeId,
      );
      expect(archived['name']).toBe('Priya');

      // 4. EventStore: both lifecycle facts are on the log, in order.
      const events = rowsOf((await get('/events?limit=200')).body);
      const createdEvent = events.find((event) => event['type'] === 'Control.AgentCreated');
      const archivedEvent = events.find((event) => event['type'] === 'Control.AgentArchived');
      expect(createdEvent, 'Control.AgentCreated is on the event stream').toBeDefined();
      expect(archivedEvent, 'Control.AgentArchived is on the event stream').toBeDefined();
      expect(createdEvent?.['subjectId']).toBe(NEW_AGENT.employeeId);
      expect(archivedEvent?.['subjectId']).toBe(NEW_AGENT.employeeId);
      expect(viewOf(createdEvent?.['payload'])).toMatchObject({
        commandId: create.commandId,
        agentId: NEW_AGENT.employeeId,
        status: 'active',
        definitionSource: 'engineer-mike',
      });
      expect(viewOf(archivedEvent?.['payload'])).toMatchObject({
        commandId: archive.commandId,
        agentId: NEW_AGENT.employeeId,
        status: 'archived',
        employmentStatus: 'offboarded',
      });

      // 5. Audit: every command left one record naming the operator, the reason and the verdict.
      const audits = rowsOf((await get('/audits?limit=200')).body);
      const createAudit = audits.find((row) => row['commandId'] === create.commandId);
      const archiveAudit = audits.find((row) => row['commandId'] === archive.commandId);
      const refusalAudit = audits.find((row) => row['commandId'] === refused['commandId']);
      expect(createAudit, 'the create command is audited').toBeDefined();
      expect(createAudit).toMatchObject({
        actionType: 'Agent.Create',
        verdict: 'accepted',
        actorId: 'ceo-alex',
      });
      expect(createAudit?.['eventIds']).toContain(createdEvent?.['eventId']);
      expect(archiveAudit).toMatchObject({
        actionType: 'Agent.Archive',
        verdict: 'accepted',
        reason: 'role retired by the board',
      });
      expect(refusalAudit).toMatchObject({ actionType: 'Agent.Archive', verdict: 'rejected' });
      expect(refusalAudit?.['resultCode']).toBe('CONFLICT');
    } finally {
      await server.close();
    }
  }, 40_000);
});
