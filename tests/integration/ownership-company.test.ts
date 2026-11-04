import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EmployeeId, SimTime } from '@maoeh/shared-types';
import type { AgentCreateCommand } from '@maoeh/organization-control';
import { startApiServer } from '../../apps/api/src/composition';

/**
 * M1.5 · `User (Founder) owns Organization (AI company) employs Agents`, over real HTTP.
 *
 * This is the "Create Your AI Company" flow end to end: the gate reads `/api/ownership`, the
 * founder names themselves and their company, and the runtime that answers `/api/snapshot`
 * becomes *their* company — new name, new id, one generated CEO agent, and an organization
 * chart they can hire into through the control plane that M1.3 already shipped. Signing back
 * into the Future AI Lab must return the original six agents, because every company owns its
 * own roster, its own channel and its own memory.
 */

const FOUNDER = { id: 'user-ada-lovelace', name: 'Ada Lovelace' };
const sim = (minutes: number): SimTime => minutes as SimTime;

async function getJson(base: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`);
  expect(response.status, `${path} should answer 200`).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function postJson(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function rows(payload: Record<string, unknown>, field: string): readonly Record<string, unknown>[] {
  const value = payload[field];
  expect(Array.isArray(value), `${field} must be an array`).toBe(true);
  return (value ?? []) as readonly Record<string, unknown>[];
}

function companyOf(snapshot: Record<string, unknown>): { id: string; name: string; ownerId: string | null } {
  const company = snapshot['company'] as Record<string, unknown>;
  return {
    id: String(company['id']),
    name: String(company['name']),
    ownerId: company['ownerId'] === null ? null : String(company['ownerId']),
  };
}

function agentIds(snapshot: Record<string, unknown>): string[] {
  return rows(snapshot, 'agents').map((agent) => String(agent['employeeId']));
}

function hireCommand(commandId: string, input: { employeeId: string; name: string; positionId: string }): AgentCreateCommand {
  return {
    commandId,
    commandType: 'Agent.Create',
    actor: {
      operatorId: 'ceo-alex' as EmployeeId,
      displayName: 'Alex',
      positionId: 'ceo',
      kind: 'human',
    },
    target: { targetType: 'organization', targetId: 'neural-bakery' },
    reason: 'first hire of the new company',
    correlationId: commandId,
    causationId: null,
    createdAtSim: sim(0),
    employeeId: input.employeeId,
    name: input.name,
    positionId: input.positionId,
    responsibilities: ['product_roadmap'],
  };
}

describe('M1.5 Create Your AI Company: founder owns the company the console runs', () => {
  it('boots the default lab, founds a new company, runs it, hires into it, and signs back in', async () => {
    // A real (temporary) event log: M1.5 gives every company its own file beside the lab's, so
    // a company switch is a change of *which* memory is loaded, never a loss of memory.
    const stateDirectory = mkdtempSync(join(tmpdir(), 'maoeh-m15-'));
    const server = await startApiServer(0, {
      tick: { activeIntervalMs: 5, idleIntervalMs: 50 },
      eventLogPath: join(stateDirectory, 'events.jsonl'),
    });
    const base = `http://127.0.0.1:${String(server.port)}`;
    try {
      // 1. A fresh install already has a founder and a company, so "Sign in" is a real place
      //    to go before anyone has created anything.
      const initialOwnership = await getJson(base, '/api/ownership');
      expect(initialOwnership['users']).toEqual([
        { id: 'user-guest-founder', name: 'Guest Founder' },
      ]);
      expect(initialOwnership['organizations']).toEqual([
        {
          id: 'future-ai-lab',
          name: 'Future AI Lab',
          ownerId: 'user-guest-founder',
          seed: 'lab',
        },
      ]);
      expect(initialOwnership['activeOrganizationId']).toBe('future-ai-lab');

      const labSnapshot = await getJson(base, '/api/snapshot');
      expect(companyOf(labSnapshot)).toEqual({
        id: 'future-ai-lab',
        name: 'Future AI Lab',
        ownerId: 'user-guest-founder',
      });
      const labAgents = agentIds(labSnapshot);
      expect(labAgents).toHaveLength(6);
      expect(
        rows(labSnapshot, 'agents').every((agent) => agent['organizationId'] === 'future-ai-lab'),
      ).toBe(true);

      // 2. Founder → Company Name → the company exists and the runtime is now running it.
      const created = await postJson(base, '/api/ownership/companies', {
        founderName: FOUNDER.name,
        companyName: 'Neural Bakery',
      });
      expect(created.status).toBe(201);
      expect(created.body['user']).toEqual(FOUNDER);
      expect(created.body['organization']).toEqual({
        id: 'neural-bakery',
        name: 'Neural Bakery',
        ownerId: FOUNDER.id,
        seed: 'starter',
      });

      const starterSnapshot = await getJson(base, '/api/snapshot');
      expect(companyOf(starterSnapshot)).toEqual({
        id: 'neural-bakery',
        name: 'Neural Bakery',
        ownerId: FOUNDER.id,
      });

      // 3. The company opens with its CEO — the seat at the top of the seed chart — and with
      //    the full chart below it, so the console's hire flow works the moment you land.
      expect(agentIds(starterSnapshot)).toEqual(['ceo-alex']);
      expect(rows(starterSnapshot, 'agents')[0]?.['organizationId']).toBe('neural-bakery');
      expect(rows(starterSnapshot, 'positions')).toHaveLength(rows(labSnapshot, 'positions').length);
      expect(
        rows(starterSnapshot, 'positions').some((position) => position['positionId'] === 'product-manager'),
      ).toBe(true);

      // 4. Hiring is the existing M1.3 control plane, not a new path invented for M1.5.
      const hire = await postJson(base, '/api/command', hireCommand('m15-hire-1', {
        employeeId: 'pm-priya',
        name: 'Priya',
        positionId: 'product-manager',
      }));
      expect(hire.body['status'], JSON.stringify(hire.body)).toBe('accepted');
      const afterHire = await getJson(base, '/api/snapshot');
      expect(agentIds(afterHire)).toEqual(['ceo-alex', 'pm-priya']);
      expect(
        rows(afterHire, 'agents').find((agent) => agent['employeeId'] === 'pm-priya')?.['managerEmployeeId'],
      ).toBe('ceo-alex');

      // 5. Both companies are listed and the new one is the active one.
      const owned = await getJson(base, '/api/ownership');
      expect(rows(owned, 'organizations').map((organization) => organization['id'])).toEqual([
        'future-ai-lab',
        'neural-bakery',
      ]);
      expect(owned['activeOrganizationId']).toBe('neural-bakery');

      // 6. Sign in to the lab: the original company comes back untouched — its six agents, not
      //    the new company's two.
      const signIn = await postJson(base, '/api/ownership/session', { organizationId: 'future-ai-lab' });
      expect(signIn.status).toBe(200);
      expect(signIn.body['user']).toEqual({ id: 'user-guest-founder', name: 'Guest Founder' });
      const labAgain = await getJson(base, '/api/snapshot');
      expect(companyOf(labAgain)).toEqual({
        id: 'future-ai-lab',
        name: 'Future AI Lab',
        ownerId: 'user-guest-founder',
      });
      expect(agentIds(labAgain)).toEqual(labAgents);

      // 7. And back again — the new company still has exactly the two agents it hired.
      // 7. And back again: the hire is still there, because the company kept its own log while
      //    the lab was running — one company's events can never replay into another.
      expect(existsSync(join(stateDirectory, 'events.jsonl'))).toBe(true);
      const starterLog = join(stateDirectory, 'neural-bakery', 'events.jsonl');
      expect(existsSync(starterLog)).toBe(true);
      const signInAgain = await postJson(base, '/api/ownership/session', { organizationId: 'neural-bakery' });
      expect(signInAgain.status).toBe(200);
      const starterAgain = await getJson(base, '/api/snapshot');
      expect(companyOf(starterAgain).id).toBe('neural-bakery');
      expect(agentIds(starterAgain)).toEqual(['ceo-alex', 'pm-priya']);

      // 8. Refusals answer with a machine-readable code, never prose.
      const unknown = await postJson(base, '/api/ownership/session', { organizationId: 'acme' });
      expect(unknown.status).toBe(422);
      expect(unknown.body['error']).toBe('unknown_organization');

      const namelessFounder = await postJson(base, '/api/ownership/companies', {
        founderName: '   ',
        companyName: 'Something',
      });
      expect(namelessFounder.status).toBe(422);
      expect(namelessFounder.body['error']).toBe('founder_name_required');

      const namelessCompany = await postJson(base, '/api/ownership/companies', {
        founderName: 'Ada',
        companyName: '',
      });
      expect(namelessCompany.status).toBe(422);
      expect(namelessCompany.body['error']).toBe('company_name_required');
    } finally {
      await server.close();
    }
  });

  it('refuses a company name it cannot use without leaving the runtime on the old company', async () => {
    const server = await startApiServer(0, {
      tick: { activeIntervalMs: 5, idleIntervalMs: 50 },
      eventLogPath: null,
    });
    const base = `http://127.0.0.1:${String(server.port)}`;
    try {
      const refused = await postJson(base, '/api/ownership/companies', {
        founderName: 'Ada',
        companyName: '',
      });
      expect(refused.status).toBe(422);

      const ownership = await getJson(base, '/api/ownership');
      expect(ownership['activeOrganizationId']).toBe('future-ai-lab');
      const snapshot = await getJson(base, '/api/snapshot');
      expect(companyOf(snapshot).id).toBe('future-ai-lab');
      expect(agentIds(snapshot)).toHaveLength(6);
    } finally {
      await server.close();
    }
  });
});
