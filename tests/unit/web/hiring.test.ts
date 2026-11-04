import { describe, expect, it } from 'vitest';
import type { Row } from '../../../apps/web/src/api';
import {
  hireSeatId,
  hireSeatTitle,
  hiringByTask,
  hiringRequests,
  hiringStatus,
  isHiringGate,
  membersAtSeat,
} from '../../../apps/web/src/hiring';

/**
 * A5's hiring view is derived, not stored: a request *is* a `hire-gate` workflow instance, and
 * its tasks are the items of the work brief that shares its correlation id. These tests pin the
 * two seams the pages rely on — the three-state mapping (pending / approved / rejected) and the
 * one-card-per-request de-duplication — so the console can never show a second card for the same
 * request, or lose the outcome on a reload.
 */

const gate = (overrides: Row = {}): Row => ({
  workflowId: 'hire-gate',
  instanceId: 'res-1',
  title: 'Hire Software Engineer for engineer',
  goal: 'No staffed seat and no staffed manager can carry implementation: fill seat "engineer" so the workflow proposed next has an executor.',
  correlationId: 'corr-1',
  initiatedBy: 'ceo-alex',
  approval: { status: 'open' },
  status: 'blocked',
  ...overrides,
});

const brief = (overrides: Row = {}): Row => ({
  correlationId: 'corr-1',
  items: [
    { taskId: 'hire-task-brief-1', title: 'Tetris', status: 'blocked' },
    { taskId: 'hire-task-brief-2', title: 'Snake', status: 'blocked' },
  ],
  ...overrides,
});

describe('hiring gate identity', () => {
  it('recognises only the kernel-owned hire gate', () => {
    expect(isHiringGate(gate())).toBe(true);
    expect(isHiringGate({ workflowId: 'generated-res-1' })).toBe(false);
    expect(isHiringGate({})).toBe(false);
  });

  it('maps the gate decision to the three words the operator reads', () => {
    expect(hiringStatus(gate({ approval: { status: 'open' } }))).toBe('pending');
    expect(hiringStatus(gate({ approval: { status: 'granted' } }))).toBe('approved');
    expect(hiringStatus(gate({ approval: { status: 'denied' } }))).toBe('rejected');
    // A decided gate whose approval summary has rolled into the instance status still resolves.
    expect(hiringStatus(gate({ approval: null, status: 'completed' }))).toBe('approved');
    expect(hiringStatus(gate({ approval: null, status: 'aborted' }))).toBe('rejected');
    expect(hiringStatus(gate({ approval: null, status: 'running' }))).toBeNull();
  });

  it('reads the seat from the title, then from the objective sentence', () => {
    expect(hireSeatId(gate())).toBe('engineer');
    expect(hireSeatId(gate({ title: 'Some title' }))).toBe('engineer');
    expect(hireSeatId(gate({ title: 'Some title', goal: 'no seat named here' }))).toBe('');
  });

  it('renders the job title a person reads, not the raw gate title', () => {
    expect(hireSeatTitle(gate(), 'engineer')).toBe('Software Engineer');
  });
});

describe('hiring requests', () => {
  it('ignores every workflow that is not a hiring gate', () => {
    const rows = [gate(), { workflowId: 'generated-res-9', instanceId: 'x', approval: { status: 'open' } }];
    expect(hiringRequests(rows, [brief()])).toHaveLength(1);
  });

  it('links the tasks of the brief that shares the gate correlation id', () => {
    const [request] = hiringRequests([gate()], [brief()]);
    expect(request?.relatedTasks.map((task) => task.taskId)).toEqual([
      'hire-task-brief-1',
      'hire-task-brief-2',
    ]);
  });

  it('renders one request for many linked tasks, de-duplicated by task id', () => {
    const duplicated = brief({
      items: [
        { taskId: 'hire-task-brief-1', title: 'Tetris', status: 'blocked' },
        { taskId: 'hire-task-brief-1', title: 'Tetris', status: 'blocked' },
      ],
    });
    const requests = hiringRequests([gate()], [duplicated]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.relatedTasks.map((task) => task.taskId)).toEqual(['hire-task-brief-1']);
  });

  it('never emits a second card for the same instance and leans pending first', () => {
    const rows = [
      gate({ instanceId: 'res-approved', approval: { status: 'granted' } }),
      gate({ instanceId: 'res-pending', approval: { status: 'open' } }),
      gate({ instanceId: 'res-pending', approval: { status: 'open' } }),
    ];
    const requests = hiringRequests(rows, []);
    expect(requests.map((request) => request.instanceId)).toEqual(['res-pending', 'res-approved']);
  });

  it('has no linked tasks when the brief has not arrived yet', () => {
    const [request] = hiringRequests([gate()], []);
    expect(request?.relatedTasks).toEqual([]);
    expect(request?.requesterId).toBe('ceo-alex');
  });

  it('maps every linked task back to its request', () => {
    const requests = hiringRequests([gate()], [brief()]);
    const byTask = hiringByTask(requests);
    expect(byTask.get('hire-task-brief-1')?.instanceId).toBe('res-1');
    expect(byTask.get('hire-task-brief-2')?.instanceId).toBe('res-1');
    expect(byTask.get('unrelated')).toBeUndefined();
  });

  it('finds the people holding a seat — who joined once a request was approved', () => {
    const agents: readonly Row[] = [
      { employeeId: 'engineer-hire', positionId: 'engineer' },
      { employeeId: 'ceo-alex', positionId: 'ceo' },
    ];
    expect(membersAtSeat(agents, 'engineer').map((row) => row['employeeId'])).toEqual(['engineer-hire']);
    expect(membersAtSeat(agents, '')).toEqual([]);
  });
});
