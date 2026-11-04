/**
 * The capability vocabulary — how a goal text turns into "which kinds of work this needs".
 *
 * Routing is **capability → position**, never title → position: the CEO (or its cognition)
 * analyses a task and asks for `implementation`, `testing`, …; the organization answers with
 * the seats that declare those capabilities (`Position.capabilities`). Nothing in this module
 * reads a position's name, so a seat called "Game Developer" is callable the same way as the
 * stock `engineer` seat.
 *
 * The vocabulary is deliberately small and open:
 *
 * - `CORE_CAPABILITIES` is the default chain a vague instruction falls back to — the delivery
 *   arc (requirements → design → implementation → testing) a software company always runs.
 * - `hints` are bilingual substring/word cues used only for *analysis of the goal text*;
 *   they never appear in matching, which is an exact id comparison against seat tags.
 */

export interface CapabilityVocabularyEntry {
  /** Stable id, also the tag a position declares in its `capabilities` list. */
  readonly id: string;
  /** Human label, used for generated workflow step names. */
  readonly label: string;
  /** Bilingual cues that a goal text needs this capability (English words match on word boundaries). */
  readonly hints: readonly string[];
}

export const CAPABILITY_VOCABULARY: readonly CapabilityVocabularyEntry[] = Object.freeze([
  Object.freeze({
    id: 'product_requirement',
    label: 'Product Requirement',
    hints: Object.freeze([
      'requirement',
      'requirements',
      'prd',
      'spec',
      'specs',
      'specification',
      'brief',
      'scope',
      '需求',
      '需求分析',
      '产品需求',
      '规格',
    ]),
  }),
  Object.freeze({
    id: 'technical_design',
    label: 'Technical Design',
    hints: Object.freeze([
      'design',
      'designs',
      'architecture',
      'technical',
      '方案',
      '架构',
      '设计',
      '技术',
    ]),
  }),
  Object.freeze({
    id: 'implementation',
    label: 'Implementation',
    hints: Object.freeze([
      'develop',
      'development',
      'developing',
      'build',
      'implement',
      'implementation',
      'code',
      'coding',
      'demo',
      'demos',
      'prototype',
      'engineer',
      'engineering',
      '开发',
      '实现',
      '编码',
      '研发',
      '构建',
      '写一个',
      '写个',
      '做一个',
      '做个',
      '制作',
      '搭建',
    ]),
  }),
  Object.freeze({
    id: 'frontend',
    label: 'Frontend',
    hints: Object.freeze([
      'frontend',
      'front-end',
      'front end',
      'ui',
      'web',
      'website',
      'webapp',
      'web app',
      'page',
      'pages',
      '官网',
      '网站',
      '网页',
      '前端',
      '页面',
      '前台',
    ]),
  }),
  Object.freeze({
    id: 'backend',
    label: 'Backend',
    hints: Object.freeze([
      'backend',
      'back-end',
      'back end',
      'api',
      'apis',
      'server',
      'servers',
      'service',
      'services',
      'database',
      'db',
      '后端',
      '服务端',
      '接口',
      '数据库',
      '服务',
    ]),
  }),
  Object.freeze({
    id: 'testing',
    label: 'Testing',
    hints: Object.freeze([
      'test',
      'tests',
      'testing',
      'qa',
      'verify',
      'verification',
      'validate',
      'validation',
      '测试',
      '验证',
      '质检',
    ]),
  }),
  Object.freeze({
    id: 'marketing',
    label: 'Marketing',
    hints: Object.freeze([
      'marketing',
      'campaign',
      'campaigns',
      'growth',
      'promotion',
      'seo',
      '营销',
      '市场',
      '增长',
      '推广',
      '获客',
    ]),
  }),
]);

/**
 * What a vague instruction ("Own the churn problem.") still schedules: the core delivery chain.
 * Explicit cues narrow it — "开发贪吃蛇 Demo" is implementation work first, so it matches only
 * what the text asks for.
 *
 * Pinned as an explicit list rather than "every entry except marketing": the vocabulary is open
 * and grows with the organization (`frontend`, `backend`, …), and adding a specialization tag must
 * never silently widen what an unclear mandate schedules. The delivery arc is a decision, not a
 * by-product of the table's size.
 */
export const CORE_CAPABILITIES: readonly string[] = Object.freeze([
  'product_requirement',
  'technical_design',
  'implementation',
  'testing',
]);

const ASCII_HINT = /^[a-z0-9 ]+$/;

/**
 * Capabilities a specialization *implies*: `frontend` and `backend` are kinds of
 * implementation, so a goal that asks for one is asking for implementation as well.
 *
 * Without this, a goal whose only explicit cue is a specialization schedules a single narrow
 * step and the organization never stacks the capabilities the work actually needs — the
 * reported symptom was "做一个Web 端的贪吃蛇小游戏" resolving to `['frontend']` alone, one
 * execution step, while the same idea phrased with the word "demo" resolved to
 * `['implementation', 'frontend']`. The implication is structural, not textual: no new hint is
 * needed, and it holds for any phrasing.
 */
const SPECIALIZATION_PARENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  frontend: Object.freeze(['implementation']),
  backend: Object.freeze(['implementation']),
});

/** Add every implied capability, then re-emit in vocabulary order so the answer is sentence-independent. */
function withImpliedCapabilities(matched: readonly string[]): readonly string[] {
  const wanted = new Set<string>(matched);
  for (const capability of matched) {
    for (const parent of SPECIALIZATION_PARENTS[capability] ?? []) wanted.add(parent);
  }
  return Object.freeze(
    CAPABILITY_VOCABULARY.filter((entry) => wanted.has(entry.id)).map((entry) => entry.id),
  );
}

function hintMatches(hint: string, lowered: string, original: string): boolean {
  if (ASCII_HINT.test(hint)) {
    const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(original);
  }
  return lowered.includes(hint.toLowerCase());
}

/**
 * Which capabilities a goal text signals, in vocabulary order (deterministic).
 * May be empty — callers decide the fallback (`CORE_CAPABILITIES` for "start work" routing).
 */
export function analyzeCapabilities(goalText: string): readonly string[] {
  const original = goalText;
  const lowered = goalText.toLowerCase();
  return Object.freeze(
    CAPABILITY_VOCABULARY.filter((entry) =>
      entry.hints.some((hint) => hintMatches(hint, lowered, original)),
    ).map((entry) => entry.id),
  );
}

/**
 * The capabilities to schedule for a goal: explicit cues when the text carries any, the core
 * delivery chain otherwise. Never empty. A matched specialization pulls in its parent delivery
 * capability (see `SPECIALIZATION_PARENTS`), so "needs frontend" also schedules implementation.
 */
export function requiredCapabilitiesFor(goalText: string): readonly string[] {
  const matched = analyzeCapabilities(goalText);
  return matched.length > 0 ? withImpliedCapabilities(matched) : CORE_CAPABILITIES;
}

/** Display label for a capability id — unknown ids display as-is (open vocabulary). */
export function capabilityLabel(capabilityId: string): string {
  const entry = CAPABILITY_VOCABULARY.find((candidate) => candidate.id === capabilityId);
  return entry === undefined ? capabilityId : entry.label;
}
