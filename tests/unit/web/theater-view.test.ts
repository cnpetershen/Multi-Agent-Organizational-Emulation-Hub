import { describe, expect, it } from 'vitest';
import {
  buildFeed,
  countByStage,
  filterByStage,
  groupSessions,
  mergeTheaterEvents,
  parseTheaterEvent,
  parseTheaterHistory,
  recentActors,
  theaterEventVisible,
  type TheaterEvent,
} from '../../../apps/web/src/theater';

/**
 * M3.2 · the theater's client-side read model.
 *
 * The page renders these projections directly, so the tests pin the promises a viewer relies on:
 * a message is one card that gains its handled state, a handoff is one card that ends with its
 * result, a reconnect cannot duplicate a fact, and the "unclassified" bucket exists on purpose.
 */

let seq = 0;

function event(
  type: string,
  payload: Record<string, unknown> = {},
  overrides: Partial<TheaterEvent> = {},
): TheaterEvent {
  seq += 1;
  return {
    seq,
    eventId: `evt-${String(seq)}`,
    type,
    occurredAtSim: seq,
    actorId: 'engineer-mike',
    subjectId: null,
    correlationId: 'session-1',
    causationId: null,
    payload,
    stage: null,
    stageBasis: null,
    ...overrides,
  };
}


describe('M3.2 theater view · parsing and merge', () => {
  it('parses the history envelope and drops malformed events instead of fabricating them', () => {
    const parsed = parseTheaterHistory({
      companyId: 'future-ai-lab',
      latestSeq: 3,
      events: [
        { seq: 1, eventId: 'evt-1', type: 'Task.Assigned', occurredAtSim: 4, payload: {} },
        { seq: 'bad' },
        null,
      ],
    });
    expect(parsed.companyId).toBe('future-ai-lab');
    expect(parsed.latestSeq).toBe(3);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.stage).toBeNull();
    expect(parseTheaterEvent({ seq: 0, eventId: 'x', type: 'Task.Assigned' })).toBeNull();
  });

  it('dedupes by seq when a reconnect re-delivers the boundary event', () => {
    const first = event('Task.Assigned', { taskId: 'task-1' });
    const second = event('Task.Started', { taskId: 'task-1' });
    const merged = mergeTheaterEvents([first], [first, second]);
    expect(merged.map((entry) => entry.seq)).toEqual([first.seq, second.seq]);
    const again = mergeTheaterEvents(merged, [second]);
    expect(again).toHaveLength(2);
  });

  it('orders by seq and caps the window', () => {
    const three = [event('A'), event('B'), event('C')];
    const merged = mergeTheaterEvents([], [three[2] as TheaterEvent, three[0] as TheaterEvent], 2);
    expect(merged.map((entry) => entry.seq)).toEqual([three[0]?.seq, three[2]?.seq]);
  });
});

describe('M3.2 theater view · messages and handoffs', () => {
  it('merges a message and its handled result into one card', () => {
    const sent = event('Communication.MessageSent', {
      messageId: 'msg-1',
      senderId: 'engineer-mike',
      recipientIds: ['qa-peter'],
      subject: 'take the checklist',
      body: 'please take it',
      messageType: 'request',
    });
    const processed = event('Communication.MessageProcessed', {
      messageId: 'msg-1',
      recipientId: 'qa-peter',
      outcome: 'handled',
    });
    const feed = buildFeed([sent, processed]);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      kind: 'message',
      fromId: 'engineer-mike',
      toIds: ['qa-peter'],
      subject: 'take the checklist',
      state: 'processed',
      handled: 1,
    });
  });

  it('merges the whole handoff chain into one card with its result', () => {
    const requested = event('Task.HandoffRequested', {
      handoffId: 'handoff-1',
      taskId: 'task-1',
      fromEmployeeId: 'engineer-mike',
      toEmployeeId: 'qa-peter',
      reason: 'QA owns verification',
      title: 'Release checklist',
    });
    const accepted = event('Task.HandoffAccepted', {
      handoffId: 'handoff-1',
      taskId: 'task-1',
      fromEmployeeId: 'engineer-mike',
      toEmployeeId: 'qa-peter',
    });
    const completed = event('Task.HandoffCompleted', {
      handoffId: 'handoff-1',
      taskId: 'task-1',
      fromEmployeeId: 'engineer-mike',
      toEmployeeId: 'qa-peter',
      outcome: 'completed',
      resultSummary: 'checklist delivered',
    });
    const feed = buildFeed([requested, accepted, completed]);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      kind: 'handoff',
      taskTitle: 'Release checklist',
      status: 'completed',
      outcome: 'completed',
      resultSummary: 'checklist delivered',
      seq: requested.seq,
    });
  });

  it('still shows the settled half of a handoff whose request fell outside the window', () => {
    const completed = event('Task.HandoffCompleted', {
      handoffId: 'handoff-9',
      taskId: 'task-9',
      fromEmployeeId: 'engineer-mike',
      toEmployeeId: 'qa-peter',
      outcome: 'completed',
      resultSummary: 'verified',
    });
    const feed = buildFeed([completed]);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      kind: 'handoff',
      fromId: 'engineer-mike',
      toId: 'qa-peter',
      status: 'completed',
      resultSummary: 'verified',
    });
  });

  it('distinguishes a review report from ordinary progress', () => {
    const reviewed = event('Task.ProgressReported', {
      taskId: 'task-1',
      phase: 'reviewed',
      review: { verdict: 'approved' },
    });
    expect(buildFeed([reviewed])[0]).toMatchObject({ kind: 'task', status: 'reviewed' });
  });

  it('shows a canvas draft instance as a draft, not as started work', () => {
    const draft = event(
      'Workflow.InstanceStarted',
      { instanceId: 'instance-1', title: '草案：周报生成器', context: { draft: true } },
      { stage: 'orchestration', stageBasis: 'event-type' },
    );
    expect(buildFeed([draft])[0]).toMatchObject({
      kind: 'workflow',
      instanceTitle: '草案：周报生成器',
      status: 'draft-created',
    });
  });
});

describe('M3.2 theater view · task facts and unclassified work', () => {
  it('turns each real task fact into a readable event, with its own stage', () => {
    const assigned = event(
      'Task.Assigned',
      { taskId: 'task-9', title: 'Launch plan', assignment: { assigneeEmployeeId: 'marketing-manager-hire' } },
      { stage: 'promotion', stageBasis: 'capability' },
    );
    const started = event('Task.Started', { taskId: 'task-9' }, { stage: 'promotion', stageBasis: 'task' });
    const feed = buildFeed([assigned, started]);
    expect(feed.map((item) => item.kind)).toEqual(['task', 'task']);
    expect(feed[0]).toMatchObject({ status: 'assigned', assigneeId: 'marketing-manager-hire', taskTitle: 'Launch plan' });
    expect(feed[1]).toMatchObject({ status: 'started' });
  });

  it('keeps a message and an operator pause out of the stage buckets', () => {
    const events = [
      event('Communication.MessageSent', { messageId: 'msg-1' }, { stage: null }),
      event('Control.SimulationPaused', {}, { stage: null }),
      event('Task.Assigned', { taskId: 'task-1' }, { stage: 'implementation' }),
    ];
    expect(countByStage(events)).toMatchObject({
      all: 3,
      implementation: 1,
      unclassified: 2,
    });
    expect(filterByStage(events, 'unclassified').map((entry) => entry.type)).toEqual([
      'Communication.MessageSent',
      'Control.SimulationPaused',
    ]);
  });

  it('never renders a runtime or clock event as collaboration', () => {
    const feed = buildFeed([
      event('Runtime.CycleStarted', {}),
      event('System.SimClockTicked', {}),
      event('Task.ProgressReported', { taskId: 'task-1', phase: 'progress' }),
    ]);
    expect(feed).toHaveLength(1);
    expect(feed[0]?.kind).toBe('task');
    // The same predicate the stage counters use: counts equal visible facts.
    expect(theaterEventVisible(event('Runtime.CycleStarted'))).toBe(false);
    expect(theaterEventVisible(event('Control.CommandRejected'))).toBe(false);
    expect(theaterEventVisible(event('Communication.ChannelOpened'))).toBe(false);
    expect(theaterEventVisible(event('Task.Created'))).toBe(false);
    expect(theaterEventVisible(event('Task.Assigned'))).toBe(true);
    expect(theaterEventVisible(event('Communication.MessageSent'))).toBe(true);
  });

  it('marks the actors that acted most recently', () => {
    const events = [
      event('A', {}, { actorId: 'ceo-alex' }),
      event('B', {}, { actorId: 'qa-peter' }),
      event('C', {}, { actorId: null }),
    ];
    expect([...recentActors(events, 2)]).toEqual(['qa-peter']);
  });
});

describe('M3.2 theater view · sessions', () => {
  it('groups by the real correlation id and labels from the session, not the id', () => {
    const brief = event(
      'Control.WorkBriefed',
      { title: 'Launch the product' },
      { correlationId: 'corr-1' },
    );
    const task = event('Task.Assigned', { taskId: 'task-1', title: 'Launch the product' }, { correlationId: 'corr-1' });
    const other = event('Task.Assigned', { taskId: 'task-2', title: 'Something else' }, { correlationId: 'corr-2' });
    const sessions = groupSessions([brief, task, other]);
    expect(sessions).toHaveLength(2);
    const first = sessions.find((session) => session.correlationId === 'corr-1');
    expect(first).toMatchObject({ count: 2, title: 'Launch the product' });
    expect(sessions[0]?.correlationId).toBe('corr-2');
  });
});
