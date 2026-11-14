import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EmployeeId, SimTime } from '@maoeh/shared-types';
import { createComposedRuntime } from '../../apps/api/src/composition';
import { createOwnershipStore } from '../../apps/api/src/ownership-store';

/**
 * M-COMMUNICATION regression: a starter company had no company channel at all.
 *
 * The live company (`peter-ai-lab`) was founded as a starter — one employee, the CEO — and every
 * colleague was hired afterwards, each hire a `Control.AgentCreated` fact. Company formation ran
 * *before* the log replay, so it looked at a one-member roster, found it below the channel
 * contract's minimum of two, and returned without opening anything. The result was a running
 * organization with seven agents and **zero** `Communication.*` events: every `SendMessage` would
 * have been refused with `unknown_channel`, and no amount of prompt work could have fixed it.
 *
 * The fix is ordering: recover first (which restores the roster from the log), then form the
 * company. This test walks exactly the failing sequence and then restarts, so a regression in
 * either half is caught.
 */

const sim = (minutes: number): SimTime => minutes as SimTime;

function freshLogPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'maoeh-starter-channel-')), 'events.jsonl');
}

function createSecondAgent(): {
  readonly commandId: string;
  readonly commandType: 'Agent.Create';
  readonly actor: { readonly operatorId: EmployeeId; readonly displayName: string; readonly positionId: string; readonly kind: 'human' };
  readonly target: { readonly targetType: 'organization'; readonly targetId: string };
  readonly reason: string;
  readonly correlationId: string;
  readonly causationId: null;
  readonly createdAtSim: SimTime;
  readonly employeeId: string;
  readonly name: string;
  readonly positionId: string;
  readonly responsibilities: readonly string[];
} {
  return {
    commandId: 'starter-channel-hire-1',
    commandType: 'Agent.Create',
    actor: { operatorId: 'ceo-alex' as EmployeeId, displayName: 'Alex', positionId: 'ceo', kind: 'human' },
    target: { targetType: 'organization', targetId: 'starter' },
    reason: 'starter company needs a second member before it can have a channel',
    correlationId: 'starter-channel-hire-1',
    causationId: null,
    createdAtSim: sim(0),
    employeeId: 'pm-priya',
    name: 'Priya',
    positionId: 'product-manager',
    responsibilities: ['product_roadmap'],
  };
}

describe('M-COMMUNICATION: a starter company opens its channel once its roster can hold one', () => {
  it('opens no channel for a one-person company, then opens exactly one after a hire and a restart', async () => {
    const ownership = createOwnershipStore({ path: null });
    ownership.ensureDefaults();
    const founded = ownership.createCompany({ founderName: 'Audit Founder', companyName: 'Starter Lab' });
    expect(founded.ok).toBe(true);
    if (!founded.ok) return;

    const eventLogPath = freshLogPath();
    const first = await createComposedRuntime({ eventLogPath, ownership });

    // One employee: the channel contract's minimum of two is not met, so nothing is opened.
    expect(first.simulation.organization.employees).toHaveLength(1);
    expect(first.simulation.communication.getChannels()).toHaveLength(0);

    const hired = await first.api.control.execute(createSecondAgent());
    expect(hired.status).toBe('accepted');
    expect(first.simulation.organization.employees).toHaveLength(2);

    // A restart replays both facts before forming the company: the channel now exists, with both
    // members, and exactly one formation record (formation stays idempotent across boots).
    const restarted = await createComposedRuntime({ eventLogPath, ownership });
    const channelId = `company-${String(founded.organization.id)}`;
    const channels = restarted.simulation.communication.getChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]?.channelId).toBe(channelId);
    expect([...(channels[0]?.memberAgentIds ?? [])].sort()).toEqual(['ceo-alex', 'pm-priya']);

    const opened = await restarted.api.query.getRecentEvents({ eventTypePrefix: 'Communication.' });
    expect(opened.filter((event) => event.type === 'Communication.ChannelOpened')).toHaveLength(1);

    // And the agent on that channel can actually send: the whole point of formation.
    const sent = restarted.simulation.communication.sendMessage({
      actor: restarted.simulation.identity.actorContext('ceo-alex' as never, 'corr-starter-channel' as never),
      senderEmployeeId: 'ceo-alex' as never,
      channelId,
      recipientIds: ['pm-priya' as never],
      subject: 'welcome',
      body: 'Welcome to the company channel.',
      messageType: 'request',
      simTime: sim(0),
    });
    expect(sent.ok, sent.ok ? '' : JSON.stringify(sent.error)).toBe(true);
  });
});
