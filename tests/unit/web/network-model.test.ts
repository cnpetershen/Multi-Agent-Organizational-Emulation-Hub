import { describe, expect, it } from 'vitest';
import {
  agentTone,
  buildNetworkModel,
  edgePath,
  nodeById,
  showcaseDeliveries,
  workflowTone,
  NETWORK_HEIGHT,
  NETWORK_WIDTH,
  type NetworkInput,
} from '../../../apps/web/src/network';

/**
 * The Network canvas is a pure projection of the read models, so this suite pins the decisions
 * that make the picture honest: who is drawn, in which order, what is deliberately left out, and
 * which edges are real. No DOM and no timers — a broken layout is a failing assertion, not a
 * screenshot review.
 */

function snapshot(): NetworkInput['snapshot'] {
  return {
    departments: [
      { departmentId: 'engineering', name: 'Engineering' },
      { departmentId: 'research', name: 'Research' },
    ],
    positions: [
      { positionId: 'ceo', title: 'Chief Executive Officer', departmentId: null, employeeIds: ['ada'] },
      { positionId: 'engineer', title: 'Software Engineer', departmentId: 'engineering', employeeIds: ['bea'] },
      { positionId: 'researcher', title: 'AI Researcher', departmentId: 'research', employeeIds: [] },
    ],
    employees: [
      {
        employeeId: 'bea',
        name: 'Bea',
        positionId: 'engineer',
        departmentId: 'engineering',
        managerEmployeeId: 'ada',
        status: 'active',
      },
      {
        employeeId: 'ada',
        name: 'Ada',
        positionId: 'ceo',
        departmentId: null,
        managerEmployeeId: null,
        status: 'defined',
      },
    ],
    agents: [
      { employeeId: 'ada', presence: 'idle', paused: false, currentTaskId: null, currentWorkflowInstanceId: null },
      { employeeId: 'bea', presence: 'acting', paused: false, currentTaskId: 'task-1', currentWorkflowInstanceId: 'wf-1' },
    ],
    tasks: [
      {
        taskId: 'task-1',
        title: 'Ship the game',
        status: 'completed',
        workflowInstanceId: 'wf-1',
        assigneeEmployeeId: 'bea',
        positionId: 'engineer',
        completedAtSim: 10,
      },
      {
        taskId: 'task-2',
        title: 'Standalone tic-tac-toe',
        status: 'completed',
        workflowInstanceId: null,
        assigneeEmployeeId: 'bea',
        positionId: 'engineer',
        completedAtSim: 20,
      },
      {
        taskId: 'task-3',
        title: 'Older delivery',
        status: 'completed',
        workflowInstanceId: 'wf-1',
        assigneeEmployeeId: 'bea',
        positionId: 'engineer',
        completedAtSim: 5,
      },
    ],
  };
}

function workflows(): NetworkInput['workflows'] {
  return [
    {
      instanceId: 'wf-0',
      title: 'Draft plan',
      status: 'running',
      draft: true,
      stageId: 'stage-1',
      goal: 'A draft waiting for the operator',
      startedAtSim: 1,
      steps: [],
      stepStates: [],
      initiatedBy: 'ada',
    },
    {
      instanceId: 'wf-1',
      title: 'Build a game',
      status: 'running',
      draft: false,
      stageId: 'stage-2',
      goal: 'Ship a playable game',
      startedAtSim: 2,
      initiatedBy: 'ada',
      steps: [
        { stepId: 'step-1', assigneeEmployeeId: 'bea', assigneePositionId: 'engineer', taskId: 'task-1', status: 'done' },
      ],
      stepStates: [{ stepId: 'step-1', status: 'done', taskId: 'task-1' }],
    },
    {
      instanceId: 'wf-2',
      title: 'Finished branch',
      status: 'completed',
      draft: false,
      stageId: 'stage-3',
      goal: 'Already delivered',
      startedAtSim: 3,
      completedAtSim: 4,
      initiatedBy: 'bea',
      steps: [],
      stepStates: [],
    },
  ];
}

describe('network model', () => {
  it('places the root seat first and resolves roles and departments', () => {
    const model = buildNetworkModel({ snapshot: snapshot(), workflows: workflows() });
    expect(model.agents.map((agent) => agent.id)).toEqual(['ada', 'bea']);
    expect(model.agents[0]?.departmentId).toBe('');
    expect(model.agents[1]?.departmentName).toBe('Engineering');
    expect(model.agents[1]?.positionTitle).toBe('Software Engineer');
    expect(model.agents[1]?.currentTaskTitle).toBe('Ship the game');
    expect(model.agents[2]).toBeUndefined();
  });

  it('keeps every node inside the fixed canvas', () => {
    const model = buildNetworkModel({ snapshot: snapshot(), workflows: workflows(), showAll: true });
    for (const node of [...model.agents, ...model.workflows, ...model.deliverables]) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(NETWORK_WIDTH);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(NETWORK_HEIGHT);
    }
  });

  it('ranks drafts before running branches and reports what it capped', () => {
    const capped = buildNetworkModel({
      snapshot: snapshot(),
      workflows: workflows(),
      maxWorkflows: 1,
      maxDeliverables: 1,
    });
    expect(capped.workflows.map((workflow) => workflow.id)).toEqual(['wf-0']);
    expect(capped.hiddenWorkflows).toBe(2);
    expect(capped.stats.workflows).toBe(3);
    expect(capped.stats.activeWorkflows).toBe(2);
    expect(capped.stats.gates).toBe(0);
    expect(capped.hiddenDeliverables).toBe(2);

    const all = buildNetworkModel({ snapshot: snapshot(), workflows: workflows(), showAll: true });
    expect(all.workflows.map((workflow) => workflow.id)).toEqual(['wf-0', 'wf-1', 'wf-2']);
    expect(all.hiddenWorkflows).toBe(0);
    expect(all.deliverables).toHaveLength(3);
  });

  it('draws only edges that the read model supports', () => {
    const model = buildNetworkModel({ snapshot: snapshot(), workflows: workflows(), showAll: true });
    const reports = model.edges.filter((edge) => edge.kind === 'reports');
    expect(reports.map((edge) => `${edge.from}->${edge.to}`)).toEqual(['bea->ada']);
    const runs = model.edges.filter((edge) => edge.kind === 'runs');
    // One accountable edge per branch: the initiator, not every seat it touched.
    expect(runs.some((edge) => edge.from === 'wf-1' && edge.to === 'ada')).toBe(true);
    expect(runs.some((edge) => edge.from === 'wf-1' && edge.to === 'bea')).toBe(false);
    const delivers = model.edges.filter((edge) => edge.kind === 'delivers');
    expect(delivers.some((edge) => edge.from === 'wf-1' && edge.to === 'task-1')).toBe(true);
    expect(delivers.some((edge) => edge.from === 'bea' && edge.to === 'task-2')).toBe(true);
  });

  it('is deterministic: the same read models draw the same network', () => {
    const first = buildNetworkModel({ snapshot: snapshot(), workflows: workflows(), showAll: true });
    const second = buildNetworkModel({ snapshot: snapshot(), workflows: workflows(), showAll: true });
    expect(second).toEqual(first);
  });

  it('resolves a selected node and reports a missing one as null', () => {
    const model = buildNetworkModel({ snapshot: snapshot(), workflows: workflows() });
    expect(nodeById(model, 'bea')?.kind).toBe('agent');
    expect(nodeById(model, 'wf-1')?.kind).toBe('workflow');
    expect(nodeById(model, 'task-2')?.kind).toBe('deliverable');
    expect(nodeById(model, 'core')?.kind).toBe('core');
    expect(nodeById(model, 'nobody')).toBeNull();
    expect(nodeById(model, null)).toBeNull();
  });

  it('maps status tokens to fixed tones, never to localized copy', () => {
    expect(workflowTone('completed', false)).toBe('ok');
    expect(workflowTone('running', false)).toBe('info');
    expect(workflowTone('blocked', false)).toBe('bad');
    expect(workflowTone('running', true)).toBe('warn');
    expect(agentTone('idle', false)).toBe('neutral');
    expect(agentTone('acting', false)).toBe('info');
    expect(agentTone('acting', true)).toBe('warn');
    expect(agentTone('blocked', false)).toBe('bad');
  });

  it('makes the delivery theatre represent both games and documents', () => {
    const tasks = [
      { taskId: 't-game-2', title: 'Snake game iteration 2', status: 'completed', completedAtSim: 90 },
      { taskId: 't-game-1', title: 'Snake game', status: 'completed', completedAtSim: 80 },
      { taskId: 't-report', title: 'Product requirement', status: 'completed', completedAtSim: 10 },
      { taskId: 't-doc', title: 'Technical design', status: 'completed', completedAtSim: 5 },
      { taskId: 't-other', title: 'Release notes', status: 'completed', completedAtSim: 1 },
    ];
    const picked = showcaseDeliveries(tasks, 3).map((task) => task['taskId']);
    expect(picked).toContain('t-report');
    expect(picked).toContain('t-game-2');
    expect(picked).toHaveLength(3);
    // Newest first, even after the deliberate game/document picks.
    expect(picked[0]).toBe('t-game-2');
  });

  it('builds a curved path between two points', () => {
    const path = edgePath({ x: 10, y: 20 }, { x: 110, y: 20 }, 0.2);
    expect(path).toMatch(/^M 10 20 Q /);
    expect(path).toMatch(/ 110 20$/);
  });
});
