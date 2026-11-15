import { describe, expect, it } from 'vitest';
import type { SandboxSession } from '../../../apps/api/src/sandbox-session';
import {
  SandboxBriefError,
  briefContextOf,
  buildSandboxBriefCommand,
  buildSandboxBriefDraft,
  goalWithCapabilities,
  normalizeSandboxBriefInput,
} from '../../../apps/api/src/sandbox-brief';

function session(overrides: Partial<SandboxSession> = {}): SandboxSession {
  const turns = [
    {
      seq: 1,
      messageId: 'msg-1',
      eventId: 'evt-1',
      channelId: 'chan-1',
      atSim: 0,
      role: 'proposer' as const,
      employeeId: 'cto-john' as never,
      name: 'John',
      title: 'CTO',
      body: 'We should build a web platform for university courses. It needs implementation and testing.',
    },
    {
      seq: 2,
      messageId: 'msg-2',
      eventId: 'evt-2',
      channelId: 'chan-1',
      atSim: 1,
      role: 'challenger' as const,
      employeeId: 'qa-peter' as never,
      name: 'Peter',
      title: 'QA',
      body: 'The risk is that teachers will not adopt it without a clear onboarding flow.',
    },
    {
      seq: 3,
      messageId: 'msg-3',
      eventId: 'evt-3',
      channelId: 'chan-1',
      atSim: 2,
      role: 'defender' as const,
      employeeId: 'engineer-mike' as never,
      name: 'Mike',
      title: 'Engineer',
      body: 'We can ship a guided demo and measure adoption in the first cohort.',
    },
    {
      seq: 4,
      messageId: 'msg-4',
      eventId: 'evt-4',
      channelId: 'chan-1',
      atSim: 3,
      role: 'evaluator' as const,
      employeeId: 'ceo-alex' as never,
      name: 'Alex',
      title: 'CEO',
      body: '{"dimensions":[],"total":82,"verdict":"worth a pilot","rationale":"clear scope"}',
    },
  ];
  return {
    sessionId: 'sandbox-session-1',
    companyId: 'future-ai-lab',
    channelId: 'chan-1',
    topic: 'course lab platform',
    rounds: 1,
    roles: [],
    turns,
    scores: {
      dimensions: [
        { name: 'Scope', score: 8, evidence: 'the platform has a clear user', citedMessageId: 'msg-1' },
      ],
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
    ...overrides,
  };
}

describe('M2 sandbox → brief draft', () => {
  it('derives the structured fields from the real session, with provenance', () => {
    const draft = buildSandboxBriefDraft(session());
    expect(draft.sessionId).toBe('sandbox-session-1');
    expect(draft.title).toBe('course lab platform');
    expect(draft.goal).toContain('We should build a web platform');
    expect(draft.capabilities).toContain('implementation');
    expect(draft.capabilities).toContain('testing');
    expect(draft.requirements.length).toBeGreaterThan(0);
    expect(draft.constraints.join(' ')).toContain('teachers');
    expect(draft.acceptanceCriteria.join(' ')).toContain('82/100');
    expect(draft.warnings).toEqual([]);
    expect(draft.context).toContain('msg-1');
    expect(draft.context).toContain('【验收标准】');
    expect(draft.source.total).toBe(82);
  });

  it('warns instead of inventing a score when the evaluator JSON did not parse', () => {
    const draft = buildSandboxBriefDraft(session({ scores: null }));
    expect(draft.warnings.length).toBeGreaterThan(0);
    expect(draft.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(draft.acceptanceCriteria.join(' ')).toContain('未产生可解析评分');
  });

  it('refuses a session with fewer than two turns', () => {
    expect(() => buildSandboxBriefDraft(session({ turns: [] }))).toThrow(SandboxBriefError);
  });

  it('keeps edits and falls back for cleared structured fields', () => {
    const draft = buildSandboxBriefDraft(session());
    const input = normalizeSandboxBriefInput(
      {
        title: 'Edited title',
        goal: 'Edited goal',
        requirements: ['one'],
        capabilities: ['implementation'],
        constraints: [],
        acceptanceCriteria: [],
        verificationKeys: ['custom-key'],
        notes: 'checked by the board',
      },
      draft,
    );
    expect(input.title).toBe('Edited title');
    expect(input.goal).toBe('Edited goal');
    expect(input.capabilities).toEqual(['implementation']);
    expect(input.constraints).toEqual(draft.constraints);
    expect(input.acceptanceCriteria).toEqual(draft.acceptanceCriteria);
    expect(input.verificationKeys).toEqual(['custom-key']);
    expect(input.notes).toBe('checked by the board');
    const context = briefContextOf(draft, input, session().turns);
    expect(context).toContain('【补充说明】');
    expect(context).toContain('checked by the board');
  });

  it('rejects an empty title and an over-long title', () => {
    const draft = buildSandboxBriefDraft(session());
    expect(() => normalizeSandboxBriefInput({ title: '  ' }, draft)).toThrow(SandboxBriefError);
    expect(() => normalizeSandboxBriefInput({ title: 'x'.repeat(201) }, draft)).toThrow(SandboxBriefError);
  });

  it('builds the Work.SubmitBrief command with the capability route and source id', () => {
    const draft = buildSandboxBriefDraft(session());
    const input = normalizeSandboxBriefInput({}, draft);
    const command = buildSandboxBriefCommand({
      commandId: 'sandbox-brief-sandbox-session-1',
      actor: {
        operatorId: 'ceo-alex' as never,
        displayName: 'Alex',
        positionId: 'ceo' as never,
        kind: 'human',
      },
      targetAgentId: 'ceo-alex',
      simTime: 7,
      draft,
      input,
      turns: session().turns,
      reason: 'convert',
    });
    expect(command.commandType).toBe('Work.SubmitBrief');
    expect(command.workBrief.sourceSessionId).toBe('sandbox-session-1');
    expect(command.workBrief.goal).toContain('所需能力：');
    expect(command.workBrief.goal).toContain('implementation');
    expect(command.workBrief.context).toContain('【任务拆分】');
    expect(command.workBrief.verificationKeys.length).toBeGreaterThan(0);
    expect(command.target).toEqual({ targetType: 'agent', targetId: 'ceo-alex' });
    expect(goalWithCapabilities('base', ['testing'])).toContain('Testing (testing)');
  });
});
