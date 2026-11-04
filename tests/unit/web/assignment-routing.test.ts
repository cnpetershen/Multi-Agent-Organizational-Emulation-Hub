import { describe, expect, it } from 'vitest';
import { injectTask, taskAssignToAgent, type CommandContext } from '../../../apps/web/src/commands';
import { collaborationRequest, vacantPositions } from '../../../apps/web/src/derive';

/**
 * The console's routing choices are wire decisions, not styling: a seat, a set of capabilities
 * or a named agent each produce a different command envelope, and a command that carries both
 * (or neither) is a contract violation the Control Plane has to refuse. The payload builders
 * and the two read-model lookups they rely on are pinned here so the console can never drift
 * into a mode the backend does not accept.
 */

const ctx: CommandContext = { companyId: 'peter-ai-lab', simTime: 42 };

describe('task injection routing', () => {
  const input = { title: 'Quantify churn', goal: 'Publish the driver table', detail: '' };

  it('carries the seat and nothing about capabilities when the operator picked a position', () => {
    const command = injectTask(ctx, { ...input, positionId: 'engineer' });
    expect(command['commandType']).toBe('Organization.InjectTask');
    expect(command['target']).toEqual({ targetType: 'organization', targetId: 'peter-ai-lab' });
    expect(command['positionId']).toBe('engineer');
    expect(command['requiredSkills']).toBeUndefined();
  });

  it('carries the capabilities and no seat when the operator routed by capability', () => {
    const command = injectTask(ctx, { ...input, requiredSkills: ['testing', 'implementation'] });
    expect(command['positionId']).toBeUndefined();
    expect(command['requiredSkills']).toEqual(['testing', 'implementation']);
  });

  it('never sends both routing modes at once, and never neither', () => {
    const both = injectTask(ctx, { ...input, positionId: 'qa', requiredSkills: ['testing'] });
    expect(both['requiredSkills']).toBeUndefined();
    const neither = injectTask(ctx, input);
    expect(neither['positionId']).toBeUndefined();
    expect(neither['requiredSkills']).toBeUndefined();
  });
});

describe('reassignment to an agent', () => {
  it('names the agent when the operator chose one, targeting the task', () => {
    const command = taskAssignToAgent(ctx, 'task-4', { agentId: 'jack' });
    expect(command['commandType']).toBe('Task.AssignToAgent');
    expect(command['target']).toEqual({ targetType: 'task', targetId: 'task-4' });
    expect(command['agentId']).toBe('jack');
  });

  it('omits agentId for a capability match, because the requirements belong to the task', () => {
    const command = taskAssignToAgent(ctx, 'task-4');
    expect(command['agentId']).toBeUndefined();
    expect(command['reason']).toContain('capability');
  });
});

describe('vacant positions', () => {
  const positions = [
    { positionId: 'ceo', title: 'CEO', employeeIds: ['ceo-alex'], capabilities: ['product_requirement'] },
    { positionId: 'cto', title: 'Chief Technology Officer', employeeIds: ['bona'], capabilities: ['technical_design'] },
    { positionId: 'engineer', title: 'Software Engineer', employeeIds: ['jack', 'ravi'], capabilities: ['implementation'] },
    { positionId: 'qa', title: 'QA Engineer', employeeIds: [], capabilities: ['testing'] },
    { positionId: 'ai-engineer', title: 'AI Engineer', employeeIds: [], capabilities: ['implementation'] },
    { positionId: 'marketing', title: 'Marketing Lead', capabilities: ['marketing'] },
  ];
  const employees = [
    { employeeId: 'ceo-alex', positionId: 'ceo', status: 'defined' },
    { employeeId: 'bona', positionId: 'cto', status: 'offboarded' },
    { employeeId: 'jack', positionId: 'engineer', status: 'offboarded' },
    { employeeId: 'ravi', positionId: 'engineer', status: 'active' },
    { employeeId: 'mack', positionId: 'qa', status: 'active' },
  ];

  it('reports every seat nobody live holds — the chart count, the roster, and a seat with neither', () => {
    expect(vacantPositions(positions, employees).map((row) => row['positionId'])).toEqual([
      'cto',
      'ai-engineer',
      'marketing',
    ]);
  });

  it('keeps a live holder out of the vacancies even when the chart lists no holder', () => {
    const listed = vacantPositions(positions, employees).map((row) => row['positionId']);
    expect(listed).not.toContain('ceo');
    expect(listed).not.toContain('qa');
    expect(listed).not.toContain('engineer');
  });

  it('counts an offboarded employee as gone, not as a holder of the seat', () => {
    const listed = vacantPositions(positions, employees).map((row) => row['positionId']);
    expect(listed).toContain('cto');
    expect(employees.filter((row) => row.status === 'offboarded').map((row) => row.positionId)).toContain('cto');
  });

  it('has nothing to show for a chart without positions', () => {
    expect(vacantPositions([], employees)).toEqual([]);
  });
});

describe('collaboration requests', () => {
  const event = {
    type: 'Communication.CollaborationRequested',
    occurredAtSim: 7,
    payload: {
      collaborationId: 'collab-3',
      fromAgentId: 'bona',
      toAgentId: 'jack',
      taskId: 'task-4',
      purpose: 'review the release checklist',
    },
  };

  it('reads who asked whom, for which task, and why', () => {
    expect(collaborationRequest(event)).toEqual({
      collaborationId: 'collab-3',
      fromAgentId: 'bona',
      toAgentId: 'jack',
      taskId: 'task-4',
      purpose: 'review the release checklist',
    });
  });

  it('is null for any other communication event', () => {
    expect(collaborationRequest({ ...event, type: 'Communication.MessageSent' })).toBeNull();
    expect(collaborationRequest({ type: 'Task.Assigned' })).toBeNull();
  });

  it('is null when the payload does not name both sides', () => {
    expect(collaborationRequest({ ...event, payload: undefined })).toBeNull();
    expect(
      collaborationRequest({ ...event, payload: { fromAgentId: 'bona', taskId: 'task-4' } }),
    ).toBeNull();
  });
});
