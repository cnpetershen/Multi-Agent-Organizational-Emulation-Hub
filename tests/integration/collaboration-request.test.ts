import { describe, expect, it } from 'vitest';
import type { ActorContext, CorrelationId, EmployeeId } from '@maoeh/shared-types';
import type {
  CollaborationService,
  CommunicationIdentity,
} from '@maoeh/agent-communication';
import { createCollaborationService, createInMemoryCollaborationStore } from '@maoeh/agent-communication';
import type { EventRegistry } from '@maoeh/event-system';
import { createEventRegistry } from '@maoeh/event-system';
import { createIdentity } from '@maoeh/identity-system';
import { createAuthzService } from '@maoeh/permission-system';
import type { PermissionPolicy } from '@maoeh/permission-system';
import { DEFAULT_AGENT_POLICY } from '@maoeh/kernel';
import { createControlHarness } from '../helpers/control-fixtures';
import {
  defaultCommunicationPolicy,
  eid,
  sim,
} from '../helpers/communication-fixtures';
import { createSimulationHarness, loadSeedOrganization } from '../helpers/simulation-fixtures';

/**
 * Agent collaboration (M1.6): an agent asks a colleague for help on a task, the request is a
 * recorded, authorized fact, and the runtime both wakes the colleague and can rebuild the
 * record from the log after a restart.
 *
 * Pinned properties:
 *   1. a successful request stores a `CollaborationRecord` and produces exactly one
 *      `Communication.CollaborationRequested` event the record is derived from;
 *   2. the request refuses to speak for someone else, to collaborate with oneself, or to
 *      address an employee identity cannot resolve;
 *   3. authorization reuses the existing `SendMessage` on `channel:*` — no new action, no new
 *      policy;
 *   4. the kernel wires the service: the event wakes the requested agent, and recovery
 *      rebuilds both the records and the id sequence.
 */

interface CollaborationFixture {
  readonly service: CollaborationService;
  readonly registry: EventRegistry;
  readonly store: ReturnType<typeof createInMemoryCollaborationStore>;
  readonly ceo: ActorContext;
}

function createCollaborationFixture(
  policy: PermissionPolicy = defaultCommunicationPolicy,
): CollaborationFixture {
  const organization = loadSeedOrganization();
  const identity = createIdentity(organization);
  const registry = createEventRegistry();
  const authz = createAuthzService({ organization, policy });
  const store = createInMemoryCollaborationStore();
  const known = new Set(organization.employees.map((employee) => String(employee.id)));
  const identityPort: CommunicationIdentity = {
    resolve(employeeId) {
      if (!known.has(String(employeeId))) {
        return { ok: false, error: { code: 'unknown_employee', employeeId: String(employeeId) } };
      }
      const resolved = identity.resolve(employeeId);
      return {
        ok: true,
        value: {
          employeeId: resolved.employeeId,
          positionId: resolved.positionId,
          departmentId: resolved.departmentId,
        },
      };
    },
  };
  const service = createCollaborationService({
    authz,
    identity: identityPort,
    registry,
    store,
    companyId: organization.company.id,
  });
  return {
    service,
    registry,
    store,
    ceo: identity.actorContext(eid('ceo-alex'), 'corr-ceo' as CorrelationId),
  };
}

describe('M1.6 collaboration requests (service level)', () => {
  it('records the request and appends exactly one event to derive it from', () => {
    const fixture = createCollaborationFixture();
    expect(
      fixture.registry.isRegistered('Communication.CollaborationRequested'),
    ).toBe(true);

    const outcome = fixture.service.requestCollaboration({
      actor: fixture.ceo,
      fromAgentId: eid('ceo-alex'),
      toAgentId: eid('cto-john'),
      taskId: 'task-1',
      purpose: 'review the technical design',
      simTime: sim(3),
    });
    expect(outcome.ok, JSON.stringify(outcome.ok ? null : outcome.error)).toBe(true);
    if (!outcome.ok) return;

    const record = outcome.value.collaboration;
    expect(record).toMatchObject({
      collaborationId: 'collab-1',
      fromAgentId: 'ceo-alex',
      toAgentId: 'cto-john',
      taskId: 'task-1',
      purpose: 'review the technical design',
      requestedAtSim: 3,
    });
    expect(record.sourceEventId).toBe(outcome.value.event.eventId);

    const event = outcome.value.event;
    expect(event.type).toBe('Communication.CollaborationRequested');
    expect(event.actorId).toBe('ceo-alex');
    expect(event.payload).toMatchObject({
      collaborationId: 'collab-1',
      fromAgentId: 'ceo-alex',
      toAgentId: 'cto-john',
      taskId: 'task-1',
      purpose: 'review the technical design',
    });

    // The record lives in the store and can be read back by id.
    expect(fixture.store.all()).toHaveLength(1);
    expect(fixture.service.getCollaboration('collab-1')).toMatchObject({
      sourceEventId: event.eventId,
    });
    expect(fixture.service.getCollaborations()).toHaveLength(1);
  });

  it('refuses to speak for someone else, to collaborate with oneself, or with a stranger', () => {
    const fixture = createCollaborationFixture();
    const base = {
      taskId: 'task-1',
      purpose: 'review the technical design',
      simTime: sim(3),
    };

    // The actor is the CEO but the request claims to come from the CTO.
    const impersonation = fixture.service.requestCollaboration({
      ...base,
      actor: fixture.ceo,
      fromAgentId: eid('cto-john'),
      toAgentId: eid('engineer-mike'),
    });
    expect(impersonation.ok).toBe(false);
    if (!impersonation.ok) expect(impersonation.error.code).toBe('sender_mismatch');

    // Asking yourself is not collaboration.
    const self = fixture.service.requestCollaboration({
      ...base,
      actor: fixture.ceo,
      fromAgentId: eid('ceo-alex'),
      toAgentId: eid('ceo-alex'),
    });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.code).toBe('invalid_collaboration');

    // An employee the identity system cannot resolve must never receive a record.
    const stranger = fixture.service.requestCollaboration({
      ...base,
      actor: fixture.ceo,
      fromAgentId: eid('ceo-alex'),
      toAgentId: eid('nobody-at-all'),
    });
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.error.code).toBe('invalid_recipient');

    // No event, no record, nothing half-written.
    expect(fixture.store.all()).toEqual([]);
  });

  it('authorizes collaboration through the existing channel SendMessage grant', () => {
    const allowed = createCollaborationFixture(DEFAULT_AGENT_POLICY);
    const granted = allowed.service.requestCollaboration({
      actor: allowed.ceo,
      fromAgentId: eid('ceo-alex'),
      toAgentId: eid('cto-john'),
      taskId: 'task-1',
      purpose: 'review the technical design',
      simTime: sim(3),
    });
    expect(granted.ok).toBe(true);

    const denied = createCollaborationFixture({ grants: [], denies: [] });
    const refused = denied.service.requestCollaboration({
      actor: denied.ceo,
      fromAgentId: eid('ceo-alex'),
      toAgentId: eid('cto-john'),
      taskId: 'task-1',
      purpose: 'review the technical design',
      simTime: sim(3),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('permission_denied');
      expect(refused.error.denial).toBeDefined();
    }
    // Denied before anything is written.
    expect(denied.store.all()).toEqual([]);
  });
});

describe('M1.6 collaboration requests (kernel wiring)', () => {
  it('wakes the requested agent and rebuilds the record after a restart', async () => {
    const h = await createControlHarness();

    // A task worth collaborating on, matched by capability so the assignee is decided too.
    const injected = await h.plane.control.execute(
      h.command('Organization.InjectTask', {
        targetType: 'organization',
        targetId: 'future-ai-lab',
        extra: {
          title: 'Verify the release build',
          goal: 'Run the release verification suite',
          requiredSkills: ['testing'],
        },
      } as never),
    );
    expect(injected.status, JSON.stringify(injected.failure)).toBe('accepted');
    const taskId = h.plane.control.query.getTasks()[0]?.taskId ?? '';

    // Consume the assignment wakeup, then confirm the tick is idle: whatever wakes next has
    // to come from the collaboration request.
    await h.harness.run(1);
    const idle = await h.harness.run(1);
    expect(idle.flatMap((result) => result.turns)).toEqual([]);

    const request = h.simulation.collaboration.requestCollaboration({
      actor: h.simulation.identity.actorContext(
        eid('ceo-alex'),
        'corr-collab' as CorrelationId,
      ),
      fromAgentId: eid('ceo-alex'),
      toAgentId: eid('cto-john'),
      taskId,
      purpose: 'walk through the test report',
      simTime: h.simulation.scheduler.clock.simTime,
    });
    expect(request.ok, JSON.stringify(request.ok ? null : request.error)).toBe(true);
    if (!request.ok) return;
    expect(h.simulation.collaboration.getCollaborations()).toHaveLength(1);

    // Injecting the event is what the runtime does with a plan step's output.
    await h.simulation.inject([request.value.event]);

    const results = await h.harness.run(1);
    expect(results[0]?.turns.map((turn) => String(turn.employeeId))).toContain('cto-john');
    expect(results[0]?.turns[0]?.sourceEventId).toBe(request.value.event.eventId);

    // Restart over the same log: records are log-derived, the id sequence is recovered.
    const restarted = await createSimulationHarness({
      eventStore: h.simulation.eventStore,
    });
    const rebuilt = restarted.simulation.collaboration.getCollaborations();
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toMatchObject({
      collaborationId: request.value.collaboration.collaborationId,
      fromAgentId: 'ceo-alex',
      toAgentId: 'cto-john',
      taskId,
      purpose: 'walk through the test report',
      sourceEventId: request.value.event.eventId,
    });

    const next = restarted.simulation.collaboration.requestCollaboration({
      actor: restarted.simulation.identity.actorContext(
        eid('ceo-alex'),
        'corr-collab-2' as CorrelationId,
      ),
      fromAgentId: eid('ceo-alex') as EmployeeId,
      toAgentId: eid('engineer-mike'),
      taskId,
      purpose: 'second ask',
      simTime: restarted.simulation.scheduler.clock.simTime,
    });
    expect(next.ok, JSON.stringify(next.ok ? null : next.error)).toBe(true);
    if (next.ok) expect(next.value.collaboration.collaborationId).toBe('collab-2');
  });
});
