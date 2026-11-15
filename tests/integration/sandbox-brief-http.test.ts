import { describe, expect, it } from 'vitest';
import type { ApiRuntime } from '../../apps/api/src/api-adapter';
import { handleApiRequest } from '../../apps/api/src/api-adapter';
import type { SandboxSession } from '../../apps/api/src/sandbox-session';

const SESSION: SandboxSession = {
  sessionId: 'sandbox-session-1',
  companyId: 'future-ai-lab',
  channelId: 'chan-1',
  topic: 'a course lab platform',
  rounds: 1,
  roles: [],
  turns: [
    {
      seq: 1,
      messageId: 'msg-1',
      eventId: 'evt-1',
      channelId: 'chan-1',
      atSim: 0,
      role: 'proposer',
      employeeId: 'cto-john' as never,
      name: 'John',
      title: 'CTO',
      body: 'Build a web platform for course labs; it needs implementation and testing.',
    },
    {
      seq: 2,
      messageId: 'msg-2',
      eventId: 'evt-2',
      channelId: 'chan-1',
      atSim: 1,
      role: 'challenger',
      employeeId: 'qa-peter' as never,
      name: 'Peter',
      title: 'QA',
      body: 'Teachers need onboarding.',
    },
  ],
  scores: {
    dimensions: [{ name: 'Scope', score: 8, evidence: 'clear user', citedMessageId: 'msg-1' }],
    total: 82,
    verdict: 'worth a pilot',
    rationale: 'clear scope',
  },
  scoringRaw: null,
  provenance: 'mock',
  provider: 'mock',
  model: 'deterministic',
  startedAt: '2026-11-14T00:00:00.000Z',
  finishedAt: '2026-11-14T00:00:10.000Z',
  durationMs: 10000,
};

const AGENT = {
  employeeId: 'ceo-alex',
  positionId: 'ceo',
  lifecycle: 'active',
};

interface FakeOptions {
  readonly session?: SandboxSession | null;
  readonly briefs?: readonly unknown[];
  readonly companyId?: string;
  readonly accepted?: boolean;
}

function runtimeWith(options: FakeOptions = {}): {
  readonly api: ApiRuntime;
  readonly commands: unknown[];
} {
  const commands: unknown[] = [];
  const briefs = [...(options.briefs ?? [])];
  const api: ApiRuntime = {
    companyId: options.companyId ?? 'future-ai-lab',
    control: {
      execute: async (command: unknown) => {
        commands.push(command);
        const accepted = options.accepted ?? true;
        if (accepted) {
          briefs.push({
            briefId: 'brief-1',
            commandId: (command as { commandId: string }).commandId,
            sourceSessionId: SESSION.sessionId,
          });
        }
        return {
          status: accepted ? 'accepted' : 'rejected',
          commandId: (command as { commandId: string }).commandId,
          commandType: 'Work.SubmitBrief',
          replayed: false,
          events: accepted ? ['evt-brief'] : [],
          auditId: 'audit-1',
          failure: accepted ? null : { code: 'INVALID_COMMAND', issues: [] },
        };
      },
    } as never,
    query: {
      listWorkBriefs: async () => briefs,
      getAgents: () => [AGENT],
      getSimulationState: () => ({ simTime: 5 }),
    } as never,
    sandbox: {
      page: () => '',
      start: async () => SESSION,
      list: async () => [],
      get: async () => (options.session === undefined ? SESSION : options.session),
    },
  };
  return { api, commands };
}

const get = (path: string): Request => new Request(`http://localhost${path}`);
const post = (path: string, body: unknown): Request =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const PATH = '/api/sandbox/sessions/sandbox-session-1/brief';

describe('M2 sandbox → brief over HTTP', () => {
  it('serves an editable draft on GET and writes nothing', async () => {
    const { api, commands } = runtimeWith();
    const response = await handleApiRequest(get(PATH), api);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      draft: { title: string; goal: string; capabilities: string[]; acceptanceCriteria: string[] };
      submitted: unknown;
    };
    expect(payload.draft.title).toBe('a course lab platform');
    expect(payload.draft.goal).toContain('Build a web platform');
    expect(payload.draft.capabilities).toContain('implementation');
    expect(payload.draft.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(payload.submitted).toBeNull();
    expect(commands).toHaveLength(0);
  });

  it('refuses a POST without explicit confirmation', async () => {
    const { api, commands } = runtimeWith();
    const response = await handleApiRequest(post(PATH, { title: 'x', goal: 'y' }), api);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'confirmation_required' });
    expect(commands).toHaveLength(0);
  });

  it('submits the edited brief once and returns the created brief id', async () => {
    const { api, commands } = runtimeWith();
    const response = await handleApiRequest(
      post(PATH, {
        confirm: true,
        title: 'Edited title',
        goal: 'Edited goal',
        capabilities: ['implementation', 'testing'],
        acceptanceCriteria: ['the board can open the page'],
        notes: 'checked by the board',
      }),
      api,
    );
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { submitted: { briefId: string; commandId: string } };
    expect(payload.submitted.briefId).toBe('brief-1');
    expect(commands).toHaveLength(1);
    const command = commands[0] as {
      commandType: string;
      workBrief: { title: string; goal: string; context: string; sourceSessionId: string };
      target: { targetId: string };
    };
    expect(command.commandType).toBe('Work.SubmitBrief');
    expect(command.workBrief.title).toBe('Edited title');
    expect(command.workBrief.goal).toContain('Edited goal');
    expect(command.workBrief.goal).toContain('所需能力：');
    expect(command.workBrief.context).toContain('checked by the board');
    expect(command.workBrief.sourceSessionId).toBe('sandbox-session-1');
    expect(command.target.targetId).toBe('ceo-alex');
  });

  it('does not create a second brief for the same session', async () => {
    const { api, commands } = runtimeWith({
      briefs: [{ briefId: 'brief-existing', commandId: 'cmd-existing', sourceSessionId: SESSION.sessionId }],
    });
    const draft = await handleApiRequest(get(PATH), api);
    expect(draft.status).toBe(200);
    expect(await draft.json()).toMatchObject({
      submitted: { briefId: 'brief-existing', commandId: 'cmd-existing' },
    });
    const second = await handleApiRequest(post(PATH, { confirm: true }), api);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: 'already_converted', briefId: 'brief-existing' });
    expect(commands).toHaveLength(0);
  });

  it('refuses unknown, legacy, other-company and too-short sessions', async () => {
    const missing = await handleApiRequest(get(PATH), runtimeWith({ session: null }).api);
    expect(missing.status).toBe(404);

    const legacy = await handleApiRequest(
      get(PATH),
      runtimeWith({ session: { ...SESSION, companyId: undefined } }).api,
    );
    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toMatchObject({ error: 'sandbox_session_legacy' });

    const other = await handleApiRequest(
      get(PATH),
      runtimeWith({ session: { ...SESSION, companyId: 'other-co' } }).api,
    );
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: 'sandbox_session_other_company' });

    const short = await handleApiRequest(
      get(PATH),
      runtimeWith({ session: { ...SESSION, turns: SESSION.turns.slice(0, 1) } }).api,
    );
    expect(short.status).toBe(422);
    expect(await short.json()).toMatchObject({ error: 'sandbox_session_not_ready' });
  });

  it('surfaces a refused command instead of reporting success', async () => {
    const { api } = runtimeWith({ accepted: false });
    const response = await handleApiRequest(
      post(PATH, { confirm: true, acceptanceCriteria: ['x'] }),
      api,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'command_refused', code: 'INVALID_COMMAND' });
  });
});
