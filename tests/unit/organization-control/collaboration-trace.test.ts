import { describe, expect, it } from 'vitest';
import type { OrgEvent } from '@maoeh/shared-types';
import {
  buildCollaborationTrace,
  buildMessageLifecycles,
  collaborationTraceOfSession,
  collaborationTraceOfTask,
} from '@maoeh/organization-control';

/**
 * M3.1 · collaboration trace and message lifecycle (pure projections).
 *
 * These are the two read models a product surface needs and must be able to trust:
 *   - the trace: who did what, to whom, why (causation), in which session/task;
 *   - the lifecycle: sent → received → processed, per recipient.
 *
 * The fixtures below are hand-built events so every field is explicit; the kernel-level test
 * (`tests/integration/collaboration-handoff-chain.test.ts`) proves the same projections over a
 * real, replayed log.
 */

let seq = 0;

function event(
  type: string,
  payload: Readonly<Record<string, unknown>>,
  overrides: Partial<OrgEvent> = {},
): OrgEvent {
  seq += 1;
  return {
    seq,
    eventId: overrides.eventId ?? `evt-${String(seq)}`,
    companyId: 'future-ai-lab' as never,
    type: type as never,
    version: 1,
    occurredAtSim: overrides.occurredAtSim ?? (seq as never),
    occurredAtWall: '2026-11-15T00:00:00.000Z',
    actorKind: 'employee',
    actorId: 'engineer-mike',
    subjectType: 'task',
    subjectId: 'task-1',
    payload,
    causationId: overrides.causationId ?? null,
    correlationId: 'session-brief-1',
    traceId: null,
  };
}

const requested = event(
  'Task.HandoffRequested',
  {
    handoffId: 'handoff-1',
    taskId: 'task-1',
    fromEmployeeId: 'engineer-mike',
    toEmployeeId: 'qa-peter',
    fromStatus: 'assigned',
    reason: 'QA owns verification',
    note: null,
    title: 'Release checklist',
  },
  { eventId: 'evt-request' },
);
const accepted = event(
  'Task.HandoffAccepted',
  {
    handoffId: 'handoff-1',
    taskId: 'task-1',
    fromEmployeeId: 'engineer-mike',
    toEmployeeId: 'qa-peter',
    previousStatus: 'assigned',
  },
  { eventId: 'evt-accept', causationId: 'evt-request', actorId: 'qa-peter' },
);
const submitted = event(
  'Task.ProgressReported',
  {
    taskId: 'task-1',
    employeeId: 'qa-peter',
    phase: 'submitted',
    summary: null,
    result: { taskId: 'task-1', producedBy: 'qa-peter', summary: 'checklist delivered', data: {}, artifacts: [] },
    review: null,
  },
  { eventId: 'evt-submitted', causationId: 'evt-accept', actorId: 'qa-peter' },
);
const completed = event(
  'Task.Completed',
  {
    taskId: 'task-1',
    employeeId: 'qa-peter',
    verification: null,
    result: { taskId: 'task-1', producedBy: 'qa-peter', summary: 'checklist delivered', data: {}, artifacts: [] },
  },
  { eventId: 'evt-completed', causationId: 'evt-submitted', actorId: 'kernel-reactor', actorKind: 'system' },
);
const settled = event(
  'Task.HandoffCompleted',
  {
    handoffId: 'handoff-1',
    taskId: 'task-1',
    fromEmployeeId: 'engineer-mike',
    toEmployeeId: 'qa-peter',
    outcome: 'completed',
    summary: 'handoff completed: qa-peter delivered the task',
    resultSummary: 'checklist delivered',
    artifactCount: 0,
  },
  { eventId: 'evt-settled', causationId: 'evt-completed', actorId: 'kernel-reactor', actorKind: 'system' },
);
const message = event(
  'Communication.MessageSent',
  {
    messageId: 'msg-1',
    channelId: 'company-future-ai-lab',
    senderId: 'engineer-mike',
    recipientIds: ['qa-peter'],
    subject: 'take over the checklist',
    body: 'please take this',
    messageType: 'request',
  },
  { eventId: 'evt-message', subjectType: 'message', subjectId: 'msg-1' },
);
const approval = event(
  'Workflow.ApprovalRequested',
  {
    instanceId: 'instance-1',
    stepId: 'step-approve',
    approvalKey: 'instance-1:step-approve',
    policy: 'any',
    requiredCount: 1,
    requiredLevel: 2,
    requiredRoles: ['ceo'],
    requestedBy: 'pm-bona',
    requestedAtSim: 10,
  },
  { eventId: 'evt-approval', subjectType: 'workflow', subjectId: 'instance-1', actorId: 'pm-bona' },
);

describe('M3.1 collaboration trace · one chain, fully walkable', () => {
  const trace = buildCollaborationTrace([requested, accepted, submitted, completed, settled, message, approval]);

  it('projects every event to a kind with its identities', () => {
    const kinds = trace.entries.map((entry) => entry.kind);
    expect(kinds).toEqual([
      'TaskHandoff',
      'TaskHandoff',
      'DeliverableSubmitted',
      'TaskHandoff',
      'AgentMessage',
      'ApprovalRequested',
    ]);

    const [request, accept, submit, settlement, msg, gate] = trace.entries;
    expect(request).toMatchObject({
      type: 'Task.HandoffRequested',
      sessionId: 'session-brief-1',
      taskId: 'task-1',
      handoffId: 'handoff-1',
      senderAgentId: 'engineer-mike',
      receiverAgentIds: ['qa-peter'],
      outcome: null,
    });
    expect(accept?.receiverAgentIds).toEqual(['qa-peter']);
    // The transfer event itself is caused by the acceptance: the chain is ordinal, not "same
    // correlation id" only.
    expect(accept?.causationId).toBe('evt-request');
    expect(submit).toMatchObject({ phase: 'submitted', senderAgentId: 'qa-peter', outcome: null });
    expect(submit?.summary).toBe('checklist delivered');
    expect(settlement).toMatchObject({ outcome: 'completed', causationId: 'evt-completed' });
    expect(msg).toMatchObject({
      messageId: 'msg-1',
      senderAgentId: 'engineer-mike',
      receiverAgentIds: ['qa-peter'],
    });
    expect(gate).toMatchObject({ approvalKey: 'instance-1:step-approve', senderAgentId: 'pm-bona' });
  });

  it('keeps Task.Completed out of the collaboration story but keeps the handoff settlement in it', () => {
    // The settlement is the collaboration result; the plain completion is the task's own fact.
    expect(trace.entries.some((entry) => entry.type === 'Task.Completed')).toBe(false);
    const settlement = trace.entries.find((entry) => entry.type === 'Task.HandoffCompleted');
    expect(settlement).toMatchObject({
      kind: 'TaskHandoff',
      outcome: 'completed',
      causationId: 'evt-completed',
    });
  });

  it('groups by session, task and agents', () => {
    expect(trace.sessions).toHaveLength(1);
    const session = collaborationTraceOfSession(trace, 'session-brief-1');
    expect(session).toHaveLength(trace.entries.length);
    expect(trace.sessions[0]?.taskIds).toEqual(['task-1']);
    expect(trace.sessions[0]?.workflowInstanceIds).toEqual(['instance-1']);
    expect(trace.sessions[0]?.agentIds).toEqual(
      expect.arrayContaining(['engineer-mike', 'qa-peter', 'pm-bona']),
    );
    const taskTrace = collaborationTraceOfTask(trace, 'task-1');
    expect(taskTrace.map((entry) => entry.type)).toEqual([
      'Task.HandoffRequested',
      'Task.HandoffAccepted',
      'Task.ProgressReported',
      'Task.HandoffCompleted',
    ]);
  });

  it('reports a causation pointer that is not in the projected window', () => {
    const broken = buildCollaborationTrace([accepted]);
    expect(broken.danglingCausation).toEqual([
      { eventId: 'evt-accept', causationId: 'evt-request', type: 'Task.HandoffAccepted' },
    ]);
    // A deliberately narrow window is not a defect: the caller says so explicitly.
    const narrow = buildCollaborationTrace([accepted], { requireCausationInWindow: false });
    expect(narrow.danglingCausation).toEqual([]);
  });

  it('never invents an entry for a non-collaboration event', () => {
    const clock = event('System.SimClockTicked', { tickNumber: 1 }, { subjectType: 'system' });
    expect(buildCollaborationTrace([clock]).entries).toEqual([]);
  });
});

describe('M3.1 collaboration trace · workflow instance linkage', () => {
  it('resolves a task collaboration event to its workflow instance from Task.Created', () => {
    const created = event(
      'Task.Created',
      {
        taskId: 'task-9',
        title: 'Implementation',
        goal: 'build it',
        workflowInstanceId: 'instance-42',
        workflowStepId: 'step-3',
      },
      { eventId: 'evt-created', subjectId: 'task-9' },
    );
    const assigned = event(
      'Task.Assigned',
      {
        taskId: 'task-9',
        attempt: 1,
        reason: null,
        assignment: {
          kind: 'employee',
          positionId: 'qa',
          targetEmployeeId: 'qa-peter',
          assigneeEmployeeId: 'qa-peter',
          actingEmployeeId: null,
        },
      },
      { eventId: 'evt-assigned', subjectId: 'task-9' },
    );
    const trace = buildCollaborationTrace([created, assigned]);
    // The creation is task mechanics, not collaboration; it is only the lookup source.
    expect(trace.entries.map((entry) => entry.type)).toEqual(['Task.Assigned']);
    expect(trace.entries[0]).toMatchObject({
      kind: 'TaskAssigned',
      taskId: 'task-9',
      workflowInstanceId: 'instance-42',
      receiverAgentIds: ['qa-peter'],
    });
  });

  it('does not guess an instance when the creation fact is outside the projected window', () => {
    const assigned = event(
      'Task.Assigned',
      {
        taskId: 'task-9',
        attempt: 1,
        reason: null,
        assignment: {
          kind: 'employee',
          positionId: 'qa',
          targetEmployeeId: 'qa-peter',
          assigneeEmployeeId: 'qa-peter',
          actingEmployeeId: null,
        },
      },
      { eventId: 'evt-assigned', subjectId: 'task-9' },
    );
    expect(buildCollaborationTrace([assigned]).entries[0]?.workflowInstanceId).toBeNull();
  });
});

describe('M3.1 message lifecycle · sent → delivered → processed', () => {
  const processed = event(
    'Communication.MessageProcessed',
    {
      messageId: 'msg-1',
      channelId: 'company-future-ai-lab',
      recipientId: 'qa-peter',
      outcome: 'handled',
    },
    { eventId: 'evt-processed', subjectType: 'message', subjectId: 'msg-1', actorId: 'qa-peter' },
  );

  it('reports sent-only when neither delivery nor processing was observed', () => {
    const [lifecycle] = buildMessageLifecycles([message]);
    expect(lifecycle).toMatchObject({ messageId: 'msg-1', sentEventId: 'evt-message', sentAtSim: 6 });
    expect(lifecycle?.recipients[0]).toMatchObject({
      recipientId: 'qa-peter',
      state: 'sent',
      deliveredAtSim: null,
      processedAtSim: null,
    });
  });

  it('reports delivered from the runtime ledger without inventing an event id', () => {
    const [lifecycle] = buildMessageLifecycles([message], [
      {
        messageId: 'msg-1',
        recipientId: 'qa-peter',
        channelId: 'company-future-ai-lab',
        deliveredAtSim: 6,
        sourceEventId: 'evt-message',
      },
    ]);
    expect(lifecycle?.recipients[0]).toMatchObject({
      state: 'delivered',
      deliveredAtSim: 6,
      deliveredEventId: 'evt-message',
      processedAtSim: null,
    });
  });

  it('reports processed/failed from the durable event and lets handled upgrade a failure', () => {
    const [lifecycle] = buildMessageLifecycles([message, processed]);
    expect(lifecycle?.recipients[0]).toMatchObject({
      state: 'processed',
      processedEventId: 'evt-processed',
      outcome: 'handled',
    });

    const failed = event(
      'Communication.MessageProcessed',
      {
        messageId: 'msg-1',
        channelId: 'company-future-ai-lab',
        recipientId: 'qa-peter',
        outcome: 'failed',
      },
      { eventId: 'evt-failed', subjectType: 'message', subjectId: 'msg-1' },
    );
    const [afterFailure] = buildMessageLifecycles([message, failed]);
    expect(afterFailure?.recipients[0]).toMatchObject({ state: 'failed', outcome: 'failed' });

    // A later successful handling of the same message is the truth, not the earlier failure.
    const [recovered] = buildMessageLifecycles([message, failed, processed]);
    expect(recovered?.recipients[0]).toMatchObject({ state: 'processed', outcome: 'handled' });
  });
});
