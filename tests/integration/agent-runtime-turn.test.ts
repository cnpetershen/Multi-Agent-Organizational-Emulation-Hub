import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  ActorContext,
  CorrelationId,
  EmployeeId,
  OrgEvent,
  SimTime,
} from '@maoeh/shared-types';
import { PRESENCE_STATES } from '@maoeh/shared-types';
import type { AgentDefinitionSourceReader } from '@maoeh/agent-definition';
import { loadAgentDefinitions } from '@maoeh/agent-definition';
import type { CognitionSourceReader } from '@maoeh/agent-cognition';
import { loadCognitionProfiles } from '@maoeh/agent-cognition';
import { createEventRegistry, createOrgEvent } from '@maoeh/event-system';
import type { Seq } from '@maoeh/event-store';
import { createInMemoryEventStore } from '@maoeh/event-store';
import type { AgentInstance } from '@maoeh/agent-runtime';
import { createRuntimeTurnContext, instantiateAgent, runAgentTurn } from '@maoeh/agent-runtime';
import { createIdentity } from '@maoeh/identity-system';
import type { Identity } from '@maoeh/identity-system';
import type { Company } from '@maoeh/organization-model';
import { loadOrganization } from '@maoeh/organization-model';
import { replayAgentState } from '@maoeh/runtime-state';
import { createNodeFsOrganizationReader } from '../helpers/organization-readers';

const seedRoot = fileURLToPath(new URL('../../agents/future-ai-lab/', import.meta.url));
const sim = (minutes: number): SimTime => minutes as SimTime;

function createAgentSourceReader(): AgentDefinitionSourceReader & CognitionSourceReader {
  return {
    async list(relativeDirectory) {
      const directory = join(seedRoot, relativeDirectory);
      if (!existsSync(directory)) return [];
      return readdirSync(directory)
        .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
        .map((entry) => `${relativeDirectory}/${entry}`)
        .sort();
    },
    async read(relativePath) {
      const filePath = join(seedRoot, relativePath);
      if (!existsSync(filePath)) return null;
      return readFileSync(filePath, 'utf8');
    },
  };
}

const registry = (() => {
  const created = createEventRegistry();
  const result = created.register(
    'Runtime.PresenceChanged',
    z.object({ employeeId: z.string().min(1), presence: z.enum(PRESENCE_STATES) }),
  );
  if (!result.ok) throw new Error('registry setup failed');
  return created;
})();

interface Slice {
  readonly instance: AgentInstance;
  readonly actorContext: ActorContext;
  readonly identity: Identity;
  readonly company: Company;
}

async function bootstrapMike(): Promise<Slice> {
  const organizationResult = loadOrganization(createNodeFsOrganizationReader(seedRoot));
  if (!organizationResult.ok) throw new Error('seed organization failed to load');
  const organization = organizationResult.value;
  const reader = createAgentSourceReader();

  const profilesResult = await loadCognitionProfiles({ reader });
  if (!profilesResult.ok) throw new Error('cognition profiles failed to load');
  const definitionsResult = await loadAgentDefinitions({
    reader,
    organization,
    cognitionProfileIds: profilesResult.value.map((profile) => profile.id),
  });
  if (!definitionsResult.ok) throw new Error('agent definitions failed to load');

  const identity = createIdentity(organization);
  const definition = definitionsResult.value.find(
    (candidate) => candidate.employeeId === 'engineer-mike',
  );
  if (definition === undefined) throw new Error('no definition for engineer-mike');
  expect(definition.id).toBe('agent-engineer-mike');

  const actorContext = identity.actorContext(definition.employeeId, 'corr-m05-1' as CorrelationId);
  const instanceResult = instantiateAgent(definition, actorContext, sim(0));
  if (!instanceResult.ok) throw new Error('instantiate failed for engineer-mike');

  return {
    instance: instanceResult.value,
    actorContext,
    identity,
    company: organization.company,
  };
}

async function collect(
  store: ReturnType<typeof createInMemoryEventStore>,
  from: Seq,
  filter?: { readonly correlationId?: string; readonly subjectId?: string },
): Promise<OrgEvent[]> {
  const events: OrgEvent[] = [];
  for await (const event of store.replay(from, undefined, filter)) events.push(event);
  return events;
}

describe('M0.5 端到端切片：seed org → AgentInstance → runAgentTurn → EventStore → Replay', () => {
  it('engineer-mike 收到属于自己的 Runtime.PresenceChanged → 回合完成、事件落库、回放状态一致', async () => {
    const { instance, actorContext, company } = await bootstrapMike();

    const input = createOrgEvent(registry, {
      companyId: company.id,
      type: 'Runtime.PresenceChanged',
      occurredAtSim: sim(12),
      actorKind: 'employee',
      actorId: 'engineer-mike',
      subjectType: 'employee',
      subjectId: 'engineer-mike',
      correlationId: 'corr-m05-1',
      payload: { employeeId: 'engineer-mike', presence: 'thinking' },
    });
    expect(input.ok).toBe(true);
    if (!input.ok) throw new Error('input event creation failed');

    const turnContext = createRuntimeTurnContext();
    const turnResult = runAgentTurn({
      agent: instance,
      state: instance.state,
      actorContext,
      event: input.value,
      simTime: sim(48),
      registry,
      turnContext,
    });
    expect(turnResult.ok).toBe(true);
    if (!turnResult.ok) throw new Error(turnResult.error.code);
    const turn = turnResult.value;

    expect(turn.status).toBe('completed');
    expect(turn.agentId).toBe('agent:agent-engineer-mike');
    expect(turn.employeeId).toBe('engineer-mike');
    expect(turn.decision.kind).toBe('process');
    expect(turn.decision.presence).toBe('thinking');
    expect(turn.emittedEvents).toHaveLength(1);

    const emitted = turn.emittedEvents[0];
    if (emitted === undefined) throw new Error('expected emitted event');
    expect(emitted.type).toBe('Runtime.PresenceChanged');
    expect(emitted.subjectId).toBe('engineer-mike');
    expect(emitted.actorId).toBe('engineer-mike');
    expect(emitted.causationId).toBe(input.value.eventId);
    expect(emitted.correlationId).toBe('corr-m05-1');
    expect(emitted.occurredAtSim).toBe(48);
    expect(emitted.payload).toEqual({ employeeId: 'engineer-mike', presence: 'thinking' });

    expect(turn.stateBefore.presence).toBe('idle');
    expect(turn.stateBefore.version).toBe(0);
    expect(turn.stateAfter.presence).toBe('thinking');
    expect(turn.stateAfter.version).toBe(1);
    expect(turn.stateAfter.updatedAtSim).toBe(48);

    const store = createInMemoryEventStore({ now: () => '2026-10-01T00:00:00.000Z' });
    const watermark = await store.append(turn.emittedEvents);
    expect(watermark).toBe(1);

    const stored = await collect(store, 1 as Seq, { subjectId: 'engineer-mike' });
    expect(stored.map((event) => event.eventId)).toEqual([emitted.eventId]);
    expect(replayAgentState(turn.stateBefore, stored)).toEqual(turn.stateAfter);

    const duplicate = runAgentTurn({
      agent: instance,
      state: turn.stateAfter,
      actorContext,
      event: input.value,
      simTime: sim(50),
      registry,
      turnContext,
    });
    expect(duplicate.ok).toBe(true);
    if (!duplicate.ok) return;
    expect(duplicate.value.status).toBe('ignored');
    expect(duplicate.value.decision.reason).toBe('duplicate');
    expect(duplicate.value.emittedEvents).toEqual([]);
    expect(duplicate.value.stateAfter).toBe(turn.stateAfter);
  });

  it('属于其他员工（cto-john）的事件交给 mike 回合 → ignored，且不写入事件流', async () => {
    const { instance, actorContext, company } = await bootstrapMike();
    const other = createOrgEvent(registry, {
      companyId: company.id,
      type: 'Runtime.PresenceChanged',
      occurredAtSim: sim(13),
      actorKind: 'employee',
      actorId: 'cto-john',
      subjectType: 'employee',
      subjectId: 'cto-john',
      correlationId: 'corr-m05-2',
      payload: { employeeId: 'cto-john', presence: 'planning' },
    });
    expect(other.ok).toBe(true);
    if (!other.ok) throw new Error('other event creation failed');

    const turnResult = runAgentTurn({
      agent: instance,
      state: instance.state,
      actorContext,
      event: other.value,
      simTime: sim(48),
      registry,
      turnContext: createRuntimeTurnContext(),
    });
    expect(turnResult.ok).toBe(true);
    if (!turnResult.ok) return;
    const turn = turnResult.value;
    expect(turn.status).toBe('ignored');
    expect(turn.decision.reason).toBe('event_for_other_agent');
    expect(turn.emittedEvents).toEqual([]);
    expect(turn.stateAfter).toBe(instance.state);

    const store = createInMemoryEventStore({ now: () => '2026-10-01T00:00:00.000Z' });
    expect(await store.append(turn.emittedEvents)).toBe(0);
    expect(await collect(store, 1 as Seq)).toEqual([]);
  });

  it('ActorContext 错配 → INVALID_TURN_INPUT（回合拒绝执行，不发事件、不改状态）', async () => {
    const { instance, actorContext, identity, company } = await bootstrapMike();
    expect(actorContext.employeeId).toBe('engineer-mike');

    const input = createOrgEvent(registry, {
      companyId: company.id,
      type: 'Runtime.PresenceChanged',
      occurredAtSim: sim(14),
      actorKind: 'employee',
      actorId: 'engineer-mike',
      subjectType: 'employee',
      subjectId: 'engineer-mike',
      correlationId: 'corr-m05-3',
      payload: { employeeId: 'engineer-mike', presence: 'planning' },
    });
    expect(input.ok).toBe(true);
    if (!input.ok) throw new Error('event creation failed');

    const wrongActor = identity.actorContext(
      'ceo-alex' as EmployeeId,
      'corr-m05-3' as CorrelationId,
    );
    const mismatched = runAgentTurn({
      agent: instance,
      state: instance.state,
      actorContext: wrongActor,
      event: input.value,
      simTime: sim(48),
      registry,
      turnContext: createRuntimeTurnContext(),
    });
    expect(mismatched.ok).toBe(false);
    if (mismatched.ok) return;
    expect(mismatched.error.code).toBe('INVALID_TURN_INPUT');
    expect(mismatched.error.issues.map((issue) => issue.field)).toEqual([
      'actorContext.employeeId',
    ]);
    expect(instance.state.presence).toBe('idle');
    expect(instance.state.version).toBe(0);
  });
});
