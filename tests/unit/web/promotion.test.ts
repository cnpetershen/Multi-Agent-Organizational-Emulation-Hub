import { describe, expect, it } from 'vitest';
import { parsePromotion, parsePromotionRecord, parsePromotions } from '../../../apps/web/src/promotion';

const PLAN = {
  promotionId: 'promotion-1',
  version: 2,
  status: 'confirmed',
  executionId: 'exec-1',
  planId: 'plan-1',
  planVersion: 2,
  approvalId: 'approval-1',
  approvedAt: '2026-11-15T10:00:00.000Z',
  approvedBy: 'ceo-alex',
  sourceTitle: '周报生成器',
  title: '周报生成器推广',
  goal: '让管理层了解价值',
  valueProposition: '自动汇总周报',
  audience: ['管理层'],
  audienceNeeds: ['减少汇总时间'],
  coreMessages: ['自动汇总'],
  channels: [{ channelId: 'channel-1', name: '图文', reason: '可读', contentType: '图文' }],
  materials: [
    {
      materialId: 'material-1',
      type: 'project-intro',
      platform: 'general',
      title: '项目介绍',
      body: '正文',
      source: 'human',
      sourceArtifact: 'technical-design.md',
    },
  ],
  schedule: ['第 1 周准备'],
  metrics: ['材料完成数'],
  risks: ['未验证市场数据'],
  contributors: [{ employeeId: 'marketing-jack', name: 'Jack', role: '推广策略', capability: 'marketing', basis: 'capability' }],
  provenance: {
    mode: 'mock',
    provider: 'mock',
    model: 'mock',
    approvedArtifacts: ['technical-design.md'],
    aiFields: ['goal', 'materials'],
    humanEdits: ['materials'],
  },
  summary: { materialCount: 1, channelCount: 1, artifactCount: 1 },
  summaryText: '周报生成器推广：让管理层了解价值；受众：管理层；渠道：图文；材料：1 份。',
  createdAt: '2026-11-15T10:00:00.000Z',
  updatedAt: '2026-11-15T10:01:00.000Z',
  confirmedAt: '2026-11-15T10:01:00.000Z',
  confirmedBy: 'ceo-alex',
  confirmationNote: 'ready for release',
};

describe('M3.7 promotion read model', () => {
  it('parses source, materials, provenance and confirmation', () => {
    const plan = parsePromotion(PLAN);
    expect(plan?.status).toBe('confirmed');
    expect(plan?.executionId).toBe('exec-1');
    expect(plan?.approvalId).toBe('approval-1');
    expect(plan?.materials[0]?.source).toBe('human');
    expect(plan?.provenance.humanEdits).toContain('materials');
    expect(plan?.contributors[0]?.employeeId).toBe('marketing-jack');
    expect(plan?.summaryText).toContain('材料：1');
  });

  it('parses a version record and a summary list', () => {
    const record = parsePromotionRecord({ promotionId: 'promotion-1', currentVersion: 2, versions: [PLAN] });
    expect(record?.versions).toHaveLength(1);
    const list = parsePromotions({ promotions: [{ ...PLAN, materials: [], channels: [] }] });
    expect(list[0]?.promotionId).toBe('promotion-1');
    expect(list[0]?.status).toBe('confirmed');
  });

  it('rejects a payload without a promotion id', () => {
    expect(parsePromotion({})).toBeNull();
    expect(parsePromotionRecord({ versions: [PLAN] })).toBeNull();
  });
});
