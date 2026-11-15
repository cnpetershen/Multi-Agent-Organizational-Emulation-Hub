import { describe, expect, it } from 'vitest';
import type { EventView } from '@maoeh/organization-control';
import {
  TheaterStageTracker,
  buildTheaterEvents,
  stageOfCapability,
  stageOfEventType,
} from '@maoeh/organization-control';

/**
 * M3.2 · the theater's stage association.
 *
 * The point of this suite is the negative case as much as the positive one: an event that does
 * not prove a stage must stay `null` (a message between colleagues is not "需求沙盘"), while a
 * task that declared `marketing` keeps every later fact in 推广 without the event payload having
 * to repeat the capability.
 */

let seq = 0;

function event(
  type: string,
  payload: Readonly<Record<string, unknown>> = {},
  overrides: Partial<EventView> = {},
): EventView {
  seq += 1;
  return {
    seq,
    eventId: `evt-theater-${String(seq)}`,
    type,
    occurredAtSim: seq,
    actorKind: 'employee',
    actorId: 'engineer-mike',
    subjectType: 'task',
    subjectId: typeof payload['taskId'] === 'string' ? (payload['taskId'] as string) : null,
    correlationId: 'session-1',
    causationId: null,
    payload,
    ...overrides,
  };
}

describe('M3.2 theater stages · explicit event boundaries', () => {
  it('maps the events that really are a stage boundary', () => {
    expect(stageOfEventType('Control.WorkBriefed')).toBe('sandbox');
    expect(stageOfEventType('Control.DelegationDecided')).toBe('orchestration');
    expect(stageOfEventType('Workflow.DraftConfirmed')).toBe('canvas');
    expect(stageOfEventType('Workflow.ApprovalRequested')).toBe('approval');
    expect(stageOfEventType('Workflow.ApprovalGranted')).toBe('approval');
    expect(stageOfEventType('Workflow.StepEntered')).toBe('implementation');
    expect(stageOfEventType('Task.Assigned')).toBe('implementation');
  });

  it('leaves an event with no phase unclassified instead of forcing one', () => {
    expect(stageOfEventType('Communication.MessageSent')).toBeNull();
    expect(stageOfEventType('Control.SimulationPaused')).toBeNull();
    expect(stageOfEventType('Runtime.CycleStarted')).toBeNull();
    expect(stageOfEventType('System.SimClockTicked')).toBeNull();
    expect(stageOfEventType('Task.SomeFutureKind')).toBe('implementation');
  });

  it('maps only capabilities whose work defines a phase', () => {
    expect(stageOfCapability('marketing')).toBe('promotion');
    expect(stageOfCapability('Marketing')).toBe('promotion');
    expect(stageOfCapability('go-to-market')).toBe('promotion');
    expect(stageOfCapability('release')).toBe('release');
    expect(stageOfCapability('product_requirement')).toBe('sandbox');
    expect(stageOfCapability('implementation')).toBe('implementation');
    expect(stageOfCapability('unknown_capability')).toBeNull();
    expect(stageOfCapability(null)).toBeNull();
  });
});

describe('M3.2 theater stages · a task carries its stage through its facts', () => {
  it('learns the stage from the capability and keeps later facts in it', () => {
    const tracker = new TheaterStageTracker();
    const assigned = tracker.observe(
      event('Task.Assigned', {
        taskId: 'task-9',
        capability: 'marketing',
        assignment: { assigneeEmployeeId: 'marketing-manager-hire' },
      }),
    );
    expect(assigned).toEqual({ stage: 'promotion', basis: 'capability' });
    expect(tracker.stageOfTask('task-9')).toBe('promotion');

    // No capability on these facts — the task's learned stage is the evidence.
    expect(tracker.observe(event('Task.Started', { taskId: 'task-9' }))).toEqual({
      stage: 'promotion',
      basis: 'task',
    });
    expect(tracker.observe(event('Task.Completed', { taskId: 'task-9' }))).toEqual({
      stage: 'promotion',
      basis: 'task',
    });
    // A gate is still an approval, whatever the task is about.
    expect(tracker.observe(event('Workflow.ApprovalRequested', { taskId: 'task-9' }))).toEqual({
      stage: 'approval',
      basis: 'event-type',
    });
  });

  it('uses the declared stage of a task when the event type alone says "implementation"', () => {
    const tracker = new TheaterStageTracker([
      { taskId: 'task-release', capability: 'release' },
      { taskId: 'task-plain', capability: null },
    ]);
    expect(tracker.stageOfTask('task-release')).toBe('release');
    expect(tracker.observe(event('Workflow.StepCompleted', { taskId: 'task-release' }))).toEqual({
      stage: 'release',
      basis: 'task',
    });
    expect(tracker.observe(event('Task.ProgressReported', { taskId: 'task-plain' }))).toEqual({
      stage: 'implementation',
      basis: 'event-type',
    });
  });

  it('never assigns a stage to a message or an operator control', () => {
    const tracker = new TheaterStageTracker();
    expect(tracker.observe(event('Communication.MessageSent', { senderId: 'a' }))).toEqual({
      stage: null,
      basis: null,
    });
    expect(tracker.observe(event('Control.SimulationPaused', {}))).toEqual({
      stage: null,
      basis: null,
    });
  });

  it('puts an unconfirmed workflow draft in orchestration, and a started one in execution', () => {
    const tracker = new TheaterStageTracker();
    const draft = event(
      'Workflow.InstanceStarted',
      { instanceId: 'instance-1', context: { draft: true } },
      { subjectType: 'workflow', subjectId: 'instance-1' },
    );
    expect(tracker.observe(draft)).toEqual({ stage: 'orchestration', basis: 'event-type' });
    const started = event(
      'Workflow.InstanceStarted',
      { instanceId: 'instance-2', context: {} },
      { subjectType: 'workflow', subjectId: 'instance-2' },
    );
    expect(tracker.observe(started)).toEqual({ stage: 'implementation', basis: 'event-type' });
  });
});

describe('M3.2 theater stages · projection', () => {
  it('builds one chronological projection and carries each stage forward', () => {
    const tracker = new TheaterStageTracker();
    const events = buildTheaterEvents(
      [
        event('Control.WorkBriefed', { briefId: 'brief-1' }),
        event('Task.Assigned', { taskId: 'task-1', capability: 'marketing' }),
        event('Task.Started', { taskId: 'task-1' }),
        event('Communication.MessageSent', { messageId: 'msg-1' }),
      ],
      tracker,
    );
    expect(events.map((entry) => entry.stage)).toEqual([
      'sandbox',
      'promotion',
      'promotion',
      null,
    ]);
    expect(events.map((entry) => entry.seq)).toEqual([...events.map((entry) => entry.seq)].sort((a, b) => a - b));
    expect(events[0]).toMatchObject({ type: 'Control.WorkBriefed', stageBasis: 'event-type' });
  });
});
