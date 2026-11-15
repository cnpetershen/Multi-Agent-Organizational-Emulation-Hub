import { describe, expect, it } from 'vitest';
import { createEventRegistry } from '@maoeh/event-system';
import { registerCommunicationEvents } from '@maoeh/agent-communication';
import { registerTaskEvents } from '@maoeh/task-system';
import { registerWorkflowEvents } from '@maoeh/workflow-engine';
import {
  COLLABORATION_EVENT_KINDS,
  COLLABORATION_EVENT_PROTOCOL,
  collaborationDescriptorOf,
  collaborationKindOf,
  protocolDescriptorOf,
} from '@maoeh/organization-control';
import type { OrgEvent } from '@maoeh/shared-types';

/**
 * M3.1 · the collaboration protocol is a descriptor over the real event registry.
 *
 * The mandate is "reuse semantics before defining new ones", so this test is the guard against
 * both failure modes:
 *
 *   - declaring a kind whose event type does not actually exist (fake coverage), and
 *   - registering a collaboration event nobody can classify (a second, parallel taxonomy).
 *
 * It builds the same registry the kernel builds, then checks both directions.
 */

function kernelRegistry() {
  const registry = createEventRegistry();
  for (const outcome of [
    registerTaskEvents(registry),
    registerWorkflowEvents(registry),
    registerCommunicationEvents(registry),
  ]) {
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  }
  return registry;
}

function eventOf(type: string, payload: Readonly<Record<string, unknown>> = {}): OrgEvent {
  return {
    seq: 1,
    eventId: `evt-${type}`,
    companyId: 'future-ai-lab' as never,
    type: type as never,
    version: 1,
    occurredAtSim: 7 as never,
    occurredAtWall: '2026-11-15T00:00:00.000Z',
    actorKind: 'employee',
    actorId: 'ceo-alex',
    subjectType: 'task',
    subjectId: 'task-1',
    payload,
    causationId: null,
    correlationId: 'session-1',
    traceId: null,
  };
}

describe('M3.1 collaboration protocol · coverage of the mandated kinds', () => {
  it('declares every mandated kind exactly once', () => {
    const kinds = COLLABORATION_EVENT_PROTOCOL.map((descriptor) => descriptor.kind);
    expect(new Set(kinds)).toEqual(new Set(COLLABORATION_EVENT_KINDS));
    expect(kinds).toHaveLength(COLLABORATION_EVENT_KINDS.length);
  });

  it('maps every implemented kind to a registered event type', () => {
    const registry = kernelRegistry();
    for (const descriptor of COLLABORATION_EVENT_PROTOCOL) {
      if (descriptor.status !== 'implemented') continue;
      expect(descriptor.eventTypes.length, `${descriptor.kind} declares no event`).toBeGreaterThan(0);
      for (const type of descriptor.eventTypes) {
        expect(registry.isRegistered(type), `${descriptor.kind} → ${type} is not registered`).toBe(
          true,
        );
      }
    }
  });

  it('keeps reserved kinds unregistered instead of emitting schema-less facts', () => {
    const registry = kernelRegistry();
    const reserved = COLLABORATION_EVENT_PROTOCOL.filter(
      (descriptor) => descriptor.status === 'reserved',
    );
    expect(reserved.map((descriptor) => descriptor.kind)).toEqual([
      'DecisionProposed',
      'DecisionAccepted',
      'ConflictDetected',
      'ConflictResolved',
    ]);
    for (const descriptor of reserved) {
      for (const type of descriptor.eventTypes) {
        expect(registry.isRegistered(type), `reserved ${type} must not be registered yet`).toBe(false);
      }
    }
  });

  it('never claims one event type for two different kinds', () => {
    // `Task.ProgressReported` is the one deliberate exception: it is a progress report in phase
    // `progress` and a deliverable submission in `submitted`/`reviewed`, and the projection
    // disambiguates by payload. Everything else maps 1:1.
    const shared = new Set(['Task.ProgressReported']);
    const seen = new Map<string, string>();
    for (const descriptor of COLLABORATION_EVENT_PROTOCOL) {
      for (const type of descriptor.eventTypes) {
        if (shared.has(type)) continue;
        const previous = seen.get(type);
        expect(previous, `${type} claimed by both ${String(previous)} and ${descriptor.kind}`).toBe(
          undefined,
        );
        seen.set(type, descriptor.kind);
      }
    }
    // The exception is real: both kinds name the type, and the payload decides.
    expect(
      COLLABORATION_EVENT_PROTOCOL.filter((descriptor) =>
        descriptor.eventTypes.includes('Task.ProgressReported'),
      ).map((descriptor) => descriptor.kind),
    ).toEqual(['ProgressReported', 'DeliverableSubmitted']);
  });

  it('does not pretend every task event is a collaboration kind', () => {
    // Creation, start, blocking and terminal facts are task mechanics; a product surface that
    // showed them as "collaboration" would inflate the story. Only the listed kinds qualify.
    for (const type of ['Task.Created', 'Task.Started', 'Task.Blocked', 'Task.Deleted']) {
      expect(collaborationDescriptorOf(type)).toBeNull();
    }
  });

  it('classifies progress and deliverable submissions from the same type by phase', () => {
    expect(collaborationKindOf(eventOf('Task.ProgressReported', { phase: 'progress' }))).toBe(
      'ProgressReported',
    );
    expect(collaborationKindOf(eventOf('Task.ProgressReported', { phase: 'submitted' }))).toBe(
      'DeliverableSubmitted',
    );
    expect(collaborationKindOf(eventOf('Task.ProgressReported', { phase: 'reviewed' }))).toBe(
      'DeliverableSubmitted',
    );
    expect(collaborationKindOf(eventOf('System.SimClockTicked'))).toBeNull();
  });

  it('declares only the trace fields the event actually carries', () => {
    const message = protocolDescriptorOf('AgentMessage');
    expect(message?.trace).toMatchObject({
      sessionId: true,
      senderAgentId: true,
      receiverAgentId: true,
      taskId: false,
      workflowInstanceId: false,
    });
    const accepted = protocolDescriptorOf('TaskAccepted');
    // An acceptance is the executor's own act; inventing a receiver would be fake trace data.
    expect(accepted?.trace.receiverAgentId).toBe(false);
    expect(accepted?.trace.taskId).toBe(true);
    const handoff = protocolDescriptorOf('TaskHandoff');
    expect(handoff?.trace.receiverAgentId).toBe(true);
    expect(handoff?.trace.correlationKeys).toContain('handoffId');
  });
});
