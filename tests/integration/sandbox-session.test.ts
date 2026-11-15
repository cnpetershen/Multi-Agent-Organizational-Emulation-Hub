import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmGateway, LlmGenerateInput } from '@maoeh/llm-gateway';
import { createComposedRuntime } from '../../apps/api/src/composition';
import type { SandboxRuntime } from '../../apps/api/src/sandbox-session';
import { SandboxError, createSandboxService } from '../../apps/api/src/sandbox-session';

/**
 * 赛博沙盘, tested against a real composed runtime and a scripted model.
 *
 * The assertions are about the properties the old manual page could not have: the four roles are
 * real employees of a real organization, every line is a `Communication.MessageSent` fact in the
 * event log, the transcript is rebuilt from those events, and the score cites the messages it
 * rests on. The model is scripted on purpose — this test is about the engine, not model quality.
 * The live run is `scripts/verify-sandbox.mjs` (or the workbench at `/api/sandbox`).
 */

const VERDICT = {
  dimensions: [
    { name: 'problem framing', score: 8, evidence: 'the proposal names the user and the mechanism', messageId: 'REPLACED' },
    { name: 'challenge quality', score: 7, evidence: 'the challenge attacks the weakest assumption', messageId: 'REPLACED' },
    { name: 'answer quality', score: 6, evidence: 'the answer concedes one point and explains the rest', messageId: 'REPLACED' },
  ],
  total: 72,
  verdict: 'promising, one unproven assumption',
  rationale: 'well structured, the challenge lands, the answer is partly defensive',
};

function scriptedGateway(calls: { kind: 'speech' | 'verdict'; prompt: string }[]): LlmGateway {
  return {
    async generate(input: LlmGenerateInput) {
      const prompt = input.request.prompt;
      if (prompt.includes('You are the evaluator of this adversarial review')) {
        calls.push({ kind: 'verdict', prompt });
        // Cite the first three message ids the transcript actually contains.
        const ids = [...prompt.matchAll(/\b(msg-\d+)\b/g)].map((match) => match[1]);
        const verdict = {
          ...VERDICT,
          dimensions: VERDICT.dimensions.map((dimension, index) => ({
            ...dimension,
            messageId: ids[Math.min(index, Math.max(0, ids.length - 1))] ?? 'msg-0',
          })),
        };
        return {
          ok: true as const,
          value: {
            text: JSON.stringify(verdict),
            provider: 'scripted',
            model: 'scripted-model',
            latencyMs: 1,
          },
        };
      }
      calls.push({ kind: 'speech', prompt });
      return {
        ok: true as const,
        value: {
          text: `scripted speech ${String(calls.length)}`,
          provider: 'scripted',
          model: 'scripted-model',
          latencyMs: 1,
        },
      };
    },
  };
}

async function fixture(overrides: { calls?: { kind: 'speech' | 'verdict'; prompt: string }[]; runtime?: SandboxRuntime } = {}) {
  const calls: { kind: 'speech' | 'verdict'; prompt: string }[] = overrides.calls ?? [];
  const runtime =
    overrides.runtime
    ?? ((await createComposedRuntime({ eventLogPath: null, requirePlanConfirmation: false })) as SandboxRuntime);
  const sessionsDir = mkdtempSync(join(tmpdir(), 'maoeh-sandbox-'));
  const gateway = scriptedGateway(calls);
  const service = createSandboxService({
    runtime: async () => runtime,
    gateway: () => gateway,
    provenance: () => 'mock',
    provider: () => 'scripted',
    model: () => 'scripted-model',
    sessionsDir,
  });
  return { service, runtime, calls, sessionsDir };
}

describe('赛博沙盘: a real adversarial session on the real communication service', () => {
  it('casts four real seats and records every turn as a message event', async () => {
    const { service, runtime, calls } = await fixture();
    const session = await service.start({ topic: '把这套平台做成高校课程实验平台', rounds: 1 });

    expect(session.turns).toHaveLength(4); // proposer, challenger, defender, evaluator
    expect(calls).toHaveLength(4);
    expect(session.turns.map((turn) => turn.role)).toEqual(['proposer', 'challenger', 'defender', 'evaluator']);
    expect(new Set(session.roles.map((role) => role.employeeId)).size).toBe(4);
    expect(new Set(session.turns.map((turn) => turn.employeeId)).size).toBe(4);

    // Every turn is a real message on the real service, and a real event in the log.
    const messages = runtime.simulation.communication.getMessages().filter((message) => message.channelId === session.channelId);
    expect(messages).toHaveLength(4);
    expect(new Set(session.turns.map((turn) => turn.messageId))).toEqual(new Set(messages.map((message) => message.messageId)));

    const events = await runtime.api.query.getRecentEvents({ eventTypePrefix: 'Communication.', limit: 50 });
    const messageEvents = events.filter((event) => event.type === 'Communication.MessageSent' && (event.payload as Record<string, unknown>)['channelId'] === session.channelId);
    expect(messageEvents).toHaveLength(4);
    expect(events.some((event) => event.type === 'Communication.ChannelOpened' && (event.payload as Record<string, unknown>)['channelId'] === session.channelId)).toBe(true);

    // Delivery is real too: each recipient has a delivery record.
    expect(runtime.simulation.communication.getDeliveries().length).toBeGreaterThanOrEqual(4);
  });

  it('is driven by the rounds asked for', async () => {
    const { service, calls } = await fixture();
    const session = await service.start({ topic: 'topic', rounds: 2 });
    // proposer, (challenger, defender) ×2, proposer again between rounds, verdict
    expect(session.turns.map((turn) => turn.role)).toEqual([
      'proposer',
      'challenger',
      'defender',
      'proposer',
      'challenger',
      'defender',
      'evaluator',
    ]);
    expect(calls).toHaveLength(7);
  });

  it('scores with evidence that cites messages which exist in the transcript', async () => {
    const { service } = await fixture();
    const session = await service.start({ topic: 'topic', rounds: 1 });
    expect(session.scores).not.toBeNull();
    const ids = new Set(session.turns.map((turn) => turn.messageId));
    for (const dimension of session.scores?.dimensions ?? []) {
      expect(dimension.evidence.length).toBeGreaterThan(0);
      expect(dimension.citedMessageId === null || ids.has(dimension.citedMessageId)).toBe(true);
    }
    expect(session.scores?.dimensions.every((dimension) => dimension.citedMessageId !== null)).toBe(true);
  });

  it('rebuilds a finished session from the event log and the index, not from memory', async () => {
    const { service, sessionsDir } = await fixture();
    const started = await service.start({ topic: '可回看的议题', rounds: 1 });

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.channelId).toBe(started.channelId);
    expect(list[0]?.turns.map((turn) => turn.messageId)).toEqual(started.turns.map((turn) => turn.messageId));
    expect(list[0]?.scores?.total).toBe(started.scores?.total);

    const fetched = await service.get(started.sessionId);
    expect(fetched?.topic).toBe('可回看的议题');
    expect(fetched?.turns).toHaveLength(4);

    // The index is small and explicit; the transcript itself lives in the log.
    const index = JSON.parse(readFileSync(join(sessionsDir, 'sessions.json'), 'utf8')) as unknown[];
    expect(index).toHaveLength(1);
  });

  it('refuses an empty topic before spending a model call', async () => {
    const { service, calls } = await fixture();
    await expect(service.start({ topic: '   ' })).rejects.toBeInstanceOf(SandboxError);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a provider failure instead of returning a half-session as success', async () => {
    const runtime = (await createComposedRuntime({ eventLogPath: null, requirePlanConfirmation: false })) as SandboxRuntime;
    const failing: LlmGateway = {
      async generate() {
        return { ok: false as const, error: { code: 'provider_error' as never, issues: [] } };
      },
    };
    const service = createSandboxService({
      runtime: async () => runtime,
      gateway: () => failing,
      provenance: () => 'live',
      provider: () => 'deepseek',
      model: () => 'deepseek-flash',
      sessionsDir: mkdtempSync(join(tmpdir(), 'maoeh-sandbox-')),
    });
    await expect(service.start({ topic: 'x', rounds: 1 })).rejects.toMatchObject({ code: 'provider' });
  });
});
