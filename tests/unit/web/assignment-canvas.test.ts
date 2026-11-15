import { describe, expect, it } from 'vitest';
import {
  ASSIGNMENT_NODE_CENTER_X,
  ASSIGNMENT_NODE_GAP,
  ASSIGNMENT_NODE_HEIGHT,
  ASSIGNMENT_TOP,
  buildAssignmentGraph,
  edgePath,
  effectiveAssignee,
  groupEmployeesByDepartment,
  groupSeatsByDepartment,
  isAdjustableStep,
  parseAssignmentEmployees,
  parseAssignmentInstance,
  parseAssignmentInstances,
  parseAssignmentSeats,
  stepTone,
  type AssignmentInstance,
  type AssignmentStep,
} from '../../../apps/web/src/assignment-canvas';

/**
 * The studio canvas is a pure projection: order, stage bands, edges and effective assignees are
 * deterministic functions of the instance and the local staging map. These tests pin the parts
 * the drag-and-drop UI depends on, without a DOM.
 */

function step(overrides: Partial<AssignmentStep> = {}): AssignmentStep {
  return {
    stepId: 'step-1',
    stageId: 'stage-1',
    stageName: 'Requirements',
    name: 'Analyze requirements',
    kind: 'task',
    status: 'pending',
    taskId: null,
    assigneeEmployeeId: null,
    assigneePositionId: null,
    capability: 'product_requirement',
    requiredRoles: [],
    requiredAuthority: null,
    overridden: false,
    ...overrides,
  };
}

function instance(steps: readonly AssignmentStep[], draft = true): AssignmentInstance {
  return {
    instanceId: 'instance-1',
    title: 'Launch a game',
    goal: 'Ship it',
    status: draft ? 'draft' : 'running',
    eventCount: 0,
    steps,
    assignmentOverrides: {},
    draft,
  };
}

describe('assignment canvas parsing', () => {
  it('reads one instance and keeps only rows that carry steps', () => {
    const parsed = parseAssignmentInstance({
      instanceId: 'instance-1',
      title: 'Launch a game',
      goal: 'Ship it',
      status: 'running',
      eventCount: 4,
      draft: false,
      assignmentOverrides: { 'step-1': 'bea' },
      steps: [step(), null, { stepId: '' }, step({ stepId: 'step-2', stageId: 'stage-2' })],
    });
    expect(parsed?.steps.map((entry) => entry.stepId)).toEqual(['step-1', 'step-2']);
    expect(parsed?.assignmentOverrides).toEqual({ 'step-1': 'bea' });
    expect(parseAssignmentInstance({ instanceId: 'empty', steps: [] })).toBeNull();
  });

  it('sorts drafts before running work and history', () => {
    const rows = [
      { instanceId: 'history', status: 'completed', draft: false, steps: [step()] },
      { instanceId: 'live', status: 'running', draft: false, steps: [step()] },
      { instanceId: 'draft', status: 'running', draft: true, steps: [step()] },
    ];
    expect(parseAssignmentInstances(rows).map((entry) => entry.instanceId)).toEqual(['draft', 'live', 'history']);
    const richer = parseAssignmentInstances([
      { instanceId: 'small', status: 'completed', draft: false, steps: [step()] },
      { instanceId: 'big', status: 'completed', draft: false, steps: [step(), step({ stepId: 's2' }), step({ stepId: 's3' })] },
    ]);
    expect(richer[0]?.instanceId).toBe('big');
  });

  it('merges position capabilities with personal expertise', () => {
    const employees = parseAssignmentEmployees(
      [
        { employeeId: 'bea', name: 'Bea', positionId: 'engineer', positionTitle: 'Engineer', status: 'active', kind: 'agent', expertise: ['implementation'] },
      ],
      [{ positionId: 'engineer', capabilities: ['implementation', 'frontend'] }],
    );
    expect(employees[0]?.capabilities).toEqual(['implementation', 'frontend']);
  });

  it('reads the approval gate the workflow read model reports', () => {
    const parsed = parseAssignmentInstance({
      instanceId: 'instance-1',
      steps: [step()],
      approval: { stepId: 'ship', status: 'open', requiredCount: 2, grantedBy: ['ceo'] },
    });
    expect(parsed?.approval).toEqual({ stepId: 'ship', status: 'open', requiredCount: 2, grantedBy: ['ceo'] });
    expect(parseAssignmentInstance({ instanceId: 'no-gate', steps: [step()] })?.approval).toBeNull();
    expect(parseAssignmentInstance({ instanceId: 'bad-gate', steps: [step()], approval: [] })?.approval).toBeNull();
  });

  it('resolves the department from the employee, falling back to the seat', () => {
    const [ada, bea] = parseAssignmentEmployees(
      [
        { employeeId: 'ada', name: 'Ada', positionId: 'engineer', status: 'active' },
        { employeeId: 'bea', name: 'Bea', positionId: 'designer', status: 'active' },
      ],
      [
        { positionId: 'engineer', capabilities: ['implementation'], departmentId: 'product' },
        { positionId: 'designer', capabilities: ['design'], departmentId: 'design' },
      ],
      [
        { departmentId: 'product', name: 'Product' },
        { departmentId: 'design', name: 'Design' },
      ],
    );
    expect([ada?.departmentName, bea?.departmentName]).toEqual(['Product', 'Design']);
  });

  it('builds every seat, marks offboarded holders as vacant and groups by department', () => {
    const seats = parseAssignmentSeats(
      [
        { positionId: 'engineer', title: 'Engineer', departmentId: 'product', employeeIds: ['bea', 'gone'], capabilities: ['implementation'] },
        { positionId: 'designer', title: 'Designer', departmentId: 'design', employeeIds: [], capabilities: ['design'] },
      ],
      [
        { employeeId: 'bea', positionId: 'engineer', status: 'active' },
        { employeeId: 'gone', positionId: 'engineer', status: 'offboarded' },
      ],
      [
        { departmentId: 'product', name: 'Product' },
        { departmentId: 'design', name: 'Design' },
      ],
    );
    expect(seats.map((seat) => [seat.positionId, seat.vacant, seat.holderIds])).toEqual([
      ['designer', true, []],
      ['engineer', false, ['bea']],
    ]);
    const groups = groupSeatsByDepartment(seats);
    expect(groups.map((group) => [group.departmentName, group.staffed, group.vacant])).toEqual([
      ['Design', 0, 1],
      ['Product', 1, 0],
    ]);
  });

  it('groups the roster by department, with unnamed departments last', () => {
    const employees = parseAssignmentEmployees(
      [
        { employeeId: 'ada', name: 'Ada', positionId: 'engineer', departmentId: 'product', status: 'active' },
        { employeeId: 'bea', name: 'Bea', positionId: 'designer', status: 'active' },
      ],
      [
        { positionId: 'engineer', capabilities: [] },
        { positionId: 'designer', capabilities: [] },
      ],
      [{ departmentId: 'product', name: 'Product' }],
    );
    expect(groupEmployeesByDepartment(employees).map((group) => group.departmentName)).toEqual(['Product', '']);
  });
});

describe('assignment graph', () => {
  const steps = [
    step({ stepId: 'req', stageId: 'requirements', stageName: 'Requirements', status: 'done' }),
    step({ stepId: 'design', stageId: 'design', stageName: 'Design', status: 'active' }),
    step({ stepId: 'build', stageId: 'implementation', stageName: 'Implementation', assigneeEmployeeId: 'bea' }),
    step({ stepId: 'ship', stageId: 'release', stageName: 'Release', status: 'done', kind: 'approval' }),
  ];

  it('lays steps out top-to-bottom with one edge between neighbours', () => {
    const graph = buildAssignmentGraph(instance(steps));
    expect(graph.nodes.map((node) => node.y)).toEqual([
      ASSIGNMENT_TOP,
      ASSIGNMENT_TOP + (ASSIGNMENT_NODE_HEIGHT + ASSIGNMENT_NODE_GAP),
      ASSIGNMENT_TOP + 2 * (ASSIGNMENT_NODE_HEIGHT + ASSIGNMENT_NODE_GAP),
      ASSIGNMENT_TOP + 3 * (ASSIGNMENT_NODE_HEIGHT + ASSIGNMENT_NODE_GAP),
    ]);
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges[0]?.fromStepId).toBe('req');
    expect(graph.edges[0]?.active).toBe(true);
    expect(graph.height).toBeGreaterThan(500);
  });

  it('groups stage bands with their own progress', () => {
    const graph = buildAssignmentGraph(instance(steps));
    expect(graph.stages.map((stage) => stage.stageId)).toEqual(['requirements', 'design', 'implementation', 'release']);
    expect(graph.stages[0]?.total).toBe(1);
    expect(graph.stages[0]?.done).toBe(1);
  });

  it('only a pending task step is adjustable', () => {
    const graph = buildAssignmentGraph(instance(steps));
    expect(graph.nodes.map((node) => node.adjustable)).toEqual([false, false, true, false]);
    expect(isAdjustableStep(steps[2]!)).toBe(true);
  });

  it('applies staged overrides to the effective assignee without moving the node', () => {
    const graph = buildAssignmentGraph(instance(steps), { staging: { build: 'ada' } });
    const build = graph.nodes.find((node) => node.step.stepId === 'build');
    expect(build?.effectiveEmployeeId).toBe('ada');
    expect(build?.staged).toBe(true);
    expect(build?.y).toBe(ASSIGNMENT_TOP + 2 * (ASSIGNMENT_NODE_HEIGHT + ASSIGNMENT_NODE_GAP));
  });

  it('marks pending nodes in a draft as a warning and resolves the default selection', () => {
    const graph = buildAssignmentGraph(instance(steps));
    expect(graph.nodes[2]?.tone).toBe('warn');
    expect(graph.selectedStepId).toBe('req');
    expect(buildAssignmentGraph(instance(steps), { selectedStepId: 'build' }).selectedStepId).toBe('build');
  });

  it('maps status tokens to fixed tones', () => {
    expect(stepTone('done', false)).toBe('ok');
    expect(stepTone('active', false)).toBe('info');
    expect(stepTone('rejected', false)).toBe('bad');
    expect(stepTone('pending', true)).toBe('warn');
  });

  it('draws real transitions when the read model carries them', () => {
    const transitions = [
      {
        transitionId: 'req->ship',
        fromStepId: 'req',
        when: { kind: 'task_status', status: 'completed' },
        to: { kind: 'step', stepId: 'ship' },
      },
      {
        transitionId: 'ship->design',
        fromStepId: 'ship',
        when: { kind: 'approval_decision', decision: 'denied' },
        to: { kind: 'step', stepId: 'design' },
      },
      {
        transitionId: 'build->implementation',
        fromStepId: 'build',
        when: { kind: 'task_status', status: 'completed' },
        to: { kind: 'stage', stageId: 'release' },
      },
      {
        transitionId: 'build->fail',
        fromStepId: 'build',
        when: { kind: 'task_status', status: 'rejected' },
        to: { kind: 'fail', reason: 'build_failed' },
      },
    ];
    const graph = buildAssignmentGraph({ ...instance(steps), transitions });
    // `req → ship` skips `design`; the old neighbour chain would have drawn req→design.
    expect(graph.edges.map((edge) => edge.id)).toEqual(['req->ship', 'ship->design', 'build->implementation']);
    expect(graph.edges[0]?.condition).toBe('task:completed');
    expect(graph.edges[1]?.condition).toBe('approval:denied');
    // A transition back up the board is a loop, not a forward step.
    expect(graph.edges[1]?.feedback).toBe(true);
    // A stage target resolves to the first node of that stage.
    expect(graph.edges[2]?.toStepId).toBe('ship');
    // `fail` is terminal: no invented node or edge.
    expect(graph.edges.map((edge) => edge.toStepId)).not.toContain('fail');
  });

  it('falls back to the neighbour chain only when no transitions are present', () => {
    const graph = buildAssignmentGraph({ ...instance(steps), transitions: [] });
    expect(graph.edges.map((edge) => edge.id)).toEqual(['req->design', 'design->build', 'build->ship']);
    expect(graph.edges.every((edge) => edge.condition === null)).toBe(true);
  });

  it('parses transitions and the paused flag from the workflow row', () => {
    const parsed = parseAssignmentInstance({
      instanceId: 'instance-1',
      status: 'blocked',
      paused: true,
      steps: [step()],
      transitions: [
        {
          transitionId: 't1',
          fromStepId: 'step-1',
          when: { kind: 'always' },
          to: { kind: 'complete' },
        },
      ],
    });
    expect(parsed?.paused).toBe(true);
    expect(parsed?.transitions).toEqual([
      { transitionId: 't1', fromStepId: 'step-1', when: { kind: 'always' }, to: { kind: 'complete' } },
    ]);
    expect(parseAssignmentInstance({ instanceId: 'x', steps: [step()] })?.transitions).toEqual([]);
  });

  it('produces a curved edge and reads the effective assignee from overrides', () => {
    expect(edgePath(100, 200)).toMatch(new RegExp(`^M ${ASSIGNMENT_NODE_CENTER_X} 100 C `));
    expect(effectiveAssignee(steps[2]!, { build: 'ada' })).toBe('ada');  });
});
