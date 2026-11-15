import { describe, expect, it } from 'vitest';
import {
  joinCapabilities,
  parseOrchestration,
  parseRequirementList,
  parseRequirementRecord,
  splitCapabilities,
  splitLines,
} from '../../../apps/web/src/planning';

/**
 * M3.3 · planning read models.
 *
 * The editor is a list-of-lines surface, and the console must not fabricate missing fields. These
 * tests pin both: textarea parsing is deterministic, and a payload that omits a field yields an
 * empty list rather than an invented one.
 */

const PLAN = {
  requirementId: 'req-1',
  companyId: 'future-ai-lab',
  version: 2,
  status: 'needs_clarification',
  source: { kind: 'goal', sessionId: null, goal: 'build a report app' },
  title: 'Report app',
  background: null,
  audience: ['management'],
  constraints: ['keep history'],
  scope: { inScope: ['submit'], outOfScope: [] },
  deliverables: ['runnable app'],
  acceptanceCriteria: ['employees can submit'],
  risks: [],
  requiredCapabilities: ['implementation', 'testing'],
  clarifications: [
    { id: 'q1', question: 'Who is it for?', why: 'affects acceptance', blocking: true, answer: null, status: 'open' },
  ],
  gaps: [],
  provenance: {
    mode: 'deterministic',
    provider: 'mock',
    model: null,
    stated: ['source.goal'],
    inferred: ['title'],
  },
  createdAt: '2026-11-15T00:00:00.000Z',
  updatedAt: '2026-11-15T00:00:00.000Z',
  confirmedAt: null,
  confirmedBy: null,
};

describe('M3.3 planning view', () => {
  it('parses a requirement record with its versions', () => {
    const record = parseRequirementRecord({
      requirementId: 'req-1',
      companyId: 'future-ai-lab',
      currentVersion: 2,
      versions: [PLAN],
    });
    expect(record.currentVersion).toBe(2);
    expect(record.versions[0]).toMatchObject({
      requirementId: 'req-1',
      status: 'needs_clarification',
      deliverables: ['runnable app'],
    });
    expect(record.versions[0]?.requiredCapabilities).toEqual(['implementation', 'testing']);
    expect(record.versions[0]?.clarifications[0]).toMatchObject({ blocking: true, status: 'open' });
  });

  it('parses list envelopes and orchestration drafts without inventing fields', () => {
    const list = parseRequirementList({
      requirements: [
        {
          requirementId: 'req-1',
          title: 'Report app',
          status: 'confirmed',
          version: 3,
          sourceKind: 'goal',
          updatedAt: 'now',
          deliverableCount: 1,
          capabilityCount: 2,
        },
      ],
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ version: 3, status: 'confirmed' });

    const draft = parseOrchestration({
      orchestrationId: 'orch-1',
      status: 'blocked',
      requirementId: 'req-1',
      requirementVersion: 3,
      nodes: [],
      conflicts: [{ code: 'missing_capability', severity: 'blocking', detail: 'x', nodeIds: [] }],
      missingCapabilities: ['quantum_chip_design'],
      basis: { capabilities: ['implementation'], employees: [] },
    });
    expect(draft.status).toBe('blocked');
    expect(draft.missingCapabilities).toEqual(['quantum_chip_design']);
    expect(draft.workflowInstanceId).toBeNull();
  });

  it('converts between the line editor and lists deterministically', () => {
    expect(splitLines(' one \n\n two \n one ')).toEqual(['one', 'two']);
    expect(splitLines('a\nb\nc', 2)).toEqual(['a', 'b']);
    expect(splitCapabilities(' Implementation, TESTING ,implementation\nfrontend ')).toEqual([
      'implementation',
      'testing',
      'frontend',
    ]);
    expect(joinCapabilities(['implementation', 'testing'])).toBe('implementation, testing');
  });
});
