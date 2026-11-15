import { describe, expect, it } from 'vitest';
import type { SimTime } from '@maoeh/shared-types';
import type { Task } from '@maoeh/task-system';
import {
  tasksAwaitingContinuation,
  noteTaskActivity,
  noteTaskHeartbeat,
  stalledTasks,
  STALL_THRESHOLD_TICKS,
  type TaskHeartbeat,
} from '../../../apps/kernel/src/simulation/stall';

const task = (
  taskId: string,
  status: Task['status'],
  companyId: string,
  createdAtSim: number,
): Task =>
  ({
    taskId,
    organizationId: companyId,
    companyId,
    title: taskId,
    goal: taskId,
    detail: null,
    workflowInstanceId: 'instance-x',
    workflowStepId: 'step-x',
    assignment: {
      kind: 'position',
      positionId: 'engineer',
      targetEmployeeId: null,
      assigneeEmployeeId: 'engineer-mike',
      actingEmployeeId: null,
    },
    assigneeEmployeeId: 'engineer-mike',
    positionId: 'engineer',
    status,
    attempt: 1,
    maxAttempts: 1,
    createdAtSim: Number(createdAtSim) as SimTime,
    completedAtSim: null,
    eventCount: 0,
    requiredSkills: [],
    assignmentReason: null,
    matchedCapabilities: [],
  }) as unknown as Task;

const simTime = (value: number): SimTime => Number(value) as SimTime;

describe('stall watchdog decider', () => {
  it('flags a stale started task for fail and a stale accepted task for reject', () => {
    const tasks: Task[] = [
      task('t-started', 'started', 'co-1', 0),
      task('t-accepted', 'accepted', 'co-1', 0),
      task('t-completed', 'completed', 'co-1', 0),
      task('t-other-co', 'started', 'co-2', 0),
      task('t-fresh', 'started', 'co-1', STALL_THRESHOLD_TICKS - 1),
    ];
    const activity = new Map<string, SimTime>();
    const actions = stalledTasks(tasks, activity, 'co-1', simTime(STALL_THRESHOLD_TICKS + 10));
    expect(actions.map((action) => [action.taskId, action.action])).toEqual([
      ['t-started', 'fail'],
      ['t-accepted', 'reject'],
    ]);
    expect(actions.every((action) => action.reason.includes('watchdog'))).toBe(true);
  });

  it('honors the activity map over the creation time', () => {
    const tasks = [task('t-started', 'started', 'co-1', 0)];
    const tooNew = new Map<string, SimTime>([['t-started', simTime(5)]]);
    const tooOld = new Map<string, SimTime>([['t-started', simTime(0)]]);
    expect(stalledTasks(tasks, tooNew, 'co-1', simTime(30), 30)).toEqual([]);
    expect(stalledTasks(tasks, tooOld, 'co-1', simTime(30), 30)).toHaveLength(1);
  });

  it('keeps a task that was active in a recent event from firing', () => {
    const tasks = [task('t-started', 'started', 'co-1', 100)];
    const activity = new Map<string, SimTime>([['t-started', simTime(120)]]);
    expect(stalledTasks(tasks, activity, 'co-1', simTime(200), 100)).toEqual([]);
  });

  it('noteTaskActivity refreshes every task event and ignores others', () => {
    const activity = new Map<string, TaskHeartbeat>();
    noteTaskActivity(activity, [
      { type: 'Task.Started', subjectType: 'task', subjectId: 't-1', occurredAtSim: simTime(10) },
      { type: 'Task.Completed', subjectType: 'task', subjectId: 't-1', occurredAtSim: simTime(14) },
      { type: 'Workflow.StepEntered', subjectType: 'workflow', subjectId: 'instance-1', occurredAtSim: simTime(15) },
      { type: 'Communication.MessageSent', subjectType: 'channel', subjectId: 'c-1', occurredAtSim: simTime(16) },
    ]);
    expect(activity.get('t-1')).toEqual({ atSim: simTime(14), phase: 'tool' });
    expect(activity.has('instance-1')).toBe(false);
    expect(activity.has('c-1')).toBe(false);
  });

  it('records inference and tool heartbeats as real work, not stale time', () => {
    const heartbeats = new Map<string, TaskHeartbeat>();
    noteTaskHeartbeat(heartbeats, ['t-started'], simTime(100), 'inference');
    const tasks = [task('t-started', 'started', 'co-1', 0)];
    expect(stalledTasks(tasks, heartbeats, 'co-1', simTime(140), 45)).toEqual([]);
    noteTaskHeartbeat(heartbeats, ['t-started'], simTime(141), 'tool');
    expect(stalledTasks(tasks, heartbeats, 'co-1', simTime(180), 45)).toEqual([]);
    expect(heartbeats.get('t-started')).toEqual({ atSim: simTime(141), phase: 'tool' });
  });

  it('excludes tasks whose workflow instance is paused', () => {
    const tasks = [task('t-paused', 'started', 'co-1', 0), task('t-live', 'started', 'co-1', 0)];
    const paused = new Set(['instance-paused']);
    tasks[0] = { ...tasks[0]!, workflowInstanceId: 'instance-paused' } as Task;
    const actions = stalledTasks(tasks, new Map(), 'co-1', simTime(100), 45, {
      pausedWorkflowIds: paused,
    });
    expect(actions.map((action) => action.taskId)).toEqual(['t-live']);
  });

  it('deduplicates a task that appears twice in the read model', () => {
    const duplicated = [task('t-dup', 'started', 'co-1', 0), task('t-dup', 'started', 'co-1', 0)];
    const actions = stalledTasks(duplicated, new Map(), 'co-1', simTime(100), 45);
    expect(actions).toHaveLength(1);
  });

  it('seeding from a recent event protects a task whose createdAt is old (restart recovery)', () => {
    const heartbeats = new Map<string, TaskHeartbeat>();
    noteTaskActivity(heartbeats, [
      { type: 'Task.Started', subjectType: 'task', subjectId: 't-restart', occurredAtSim: simTime(90) },
    ]);
    const tasks = [task('t-restart', 'started', 'co-1', 0)];
    expect(stalledTasks(tasks, heartbeats, 'co-1', simTime(100), 45)).toEqual([]);
  });

  it('lists open tasks that need a continuation, excluding paused instances', () => {
    const accepted = { ...task('t-accepted', 'accepted', 'co-1', 0), workflowInstanceId: 'instance-live' } as Task;
    const started = { ...task('t-started', 'started', 'co-1', 0), workflowInstanceId: 'instance-live' } as Task;
    const paused = { ...task('t-paused', 'accepted', 'co-1', 0), workflowInstanceId: 'instance-paused' } as Task;
    const waiting = tasksAwaitingContinuation(
      [accepted, started, paused],
      'engineer-mike' as never,
      'co-1' as never,
      new Set(['instance-paused']),
    );
    expect(waiting.map((entry) => entry.taskId)).toEqual(['t-accepted', 't-started']);
  });
});
