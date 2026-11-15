import { describe, expect, it } from 'vitest';
import type { ControlQuery } from '@maoeh/organization-control';
import { handleApiRequest } from '../../../apps/api/src/api-adapter';

/**
 * M3.0/M3.1 read surfaces over HTTP.
 *
 * The projections are unit-tested on their own; this file pins the wiring the product relies on:
 * the four read endpoints must answer from the query and must not fall through to the 404 branch.
 * They are GETs by contract — the legacy audit proposes repairs, it never applies them on a read.
 */

const TRACE = {
  entries: [],
  sessions: [],
  danglingCausation: [],
};

const LIFECYCLES = [
  {
    messageId: 'msg-1',
    channelId: 'company-future-ai-lab',
    senderId: 'engineer-mike',
    subject: 'take the checklist',
    messageType: 'request',
    sentAtSim: 10,
    sentEventId: 'evt-10',
    recipients: [],
  },
];

const AUDIT = {
  companyId: 'peter-ai-lab',
  evaluatedAtSim: 5000,
  taskCount: 1,
  archivedTaskCount: 0,
  findings: [],
  summary: {
    total: 0,
    byCode: {
      empty_delivery: 0,
      unverified_delivery: 0,
      chronology_violation: 0,
      orphaned_submission: 0,
      stalled_open_task: 0,
      dangling_handoff: 0,
    },
    repairable: 0,
  },
};

const HISTORY = {
  companyId: 'peter-ai-lab',
  latestSeq: 42,
  events: [],
};

function runtime() {
  const query = {
    getCollaborationProtocol: () => [
      {
        kind: 'AgentMessage',
        eventTypes: ['Communication.MessageSent'],
        status: 'implemented',
      },
    ],
    getCollaborationTrace: async () => TRACE,
    getMessageLifecycle: async () => LIFECYCLES,
    getLegacyWorkAudit: async () => AUDIT,
    getTheaterHistory: async () => HISTORY,
  } as unknown as ControlQuery;
  return { control: {} as never, query };
}

async function get(path: string) {
  const response = await handleApiRequest(new Request(`http://localhost${path}`), runtime());
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('M3 read endpoints', () => {
  it('serves the collaboration protocol descriptor', async () => {
    const { status, body } = await get('/api/collaboration/protocol');
    expect(status).toBe(200);
    expect(body).toMatchObject({ kinds: [{ kind: 'AgentMessage' }] });
  });

  it('serves the collaboration trace', async () => {
    const { status, body } = await get('/api/collaboration/trace');
    expect(status).toBe(200);
    expect(body).toEqual(TRACE);
  });

  it('serves the message lifecycle as a named envelope', async () => {
    const { status, body } = await get('/api/collaboration/messages');
    expect(status).toBe(200);
    expect(body).toEqual({ messages: LIFECYCLES });
  });

  it('serves the legacy audit as a read-only report', async () => {
    const { status, body } = await get('/api/legacy-audit');
    expect(status).toBe(200);
    expect(body).toEqual(AUDIT);
  });

  it('serves the theater history window and its resume cursor', async () => {
    const { status, body } = await get('/api/theater/history?limit=5&correlationId=corr-1');
    expect(status).toBe(200);
    expect(body).toEqual(HISTORY);
  });

  it('does not invent a route for a legacy repair', async () => {
    // Applying a repair is a control command with an audit trail, not a GET side effect.
    const response = await handleApiRequest(
      new Request('http://localhost/api/legacy-audit/repair'),
      runtime(),
    );
    expect(response.status).toBe(404);
  });
});
