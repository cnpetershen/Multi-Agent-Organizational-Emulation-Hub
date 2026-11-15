/**
 * Role identity for the console.
 *
 * An operator should be able to read the company without reading every name: the badge in
 * front of each agent is a *role* mark, not a monogram. Two axes are kept separate on purpose:
 *
 * - the **glyph** says what the seat does — engineering, QA, design, marketing, …
 * - the **family** says where the mark sits tonally — a discipline colour, or the executive
 *   gold that a chief/director/head keeps even when their work is technical.
 *
 * Both are derived from the same vocabulary the read model already carries (`positionId`,
 * `positionTitle`, and the seat's `capabilities`), so an organization authored in the console
 * or a company created from YAML resolves the same way. Nothing is stored and no API field is
 * added: a role that cannot be recognized degrades to a neutral "person" mark rather than to a
 * blank or an initial.
 *
 * The vocabulary is bilingual because the console is: position titles authored through the UI
 * can be Chinese (`测试工程师`) while the shipped YAML is English (`QA Engineer`).
 */

export type RoleGlyph =
  | 'crown'
  | 'chip'
  | 'code'
  | 'server'
  | 'shield'
  | 'palette'
  | 'compass'
  | 'clipboard'
  | 'flask'
  | 'megaphone'
  | 'trend'
  | 'gear'
  | 'users'
  | 'wallet'
  | 'person';

/**
 * The tonal family behind a glyph. `executive` is the one family that is decided by seniority
 * rather than discipline: a "Head of Design" keeps the design glyph but reads gold.
 */
export type RoleFamily =
  | 'executive'
  | 'engineering'
  | 'quality'
  | 'design'
  | 'product'
  | 'research'
  | 'marketing'
  | 'business'
  | 'operations'
  | 'people'
  | 'finance'
  | 'general';

export interface RoleIdentity {
  readonly glyph: RoleGlyph;
  readonly family: RoleFamily;
}

export interface RoleInput {
  /** The seat id (`ceo`, `qa`, `backend-engineer`, or a slug a founder authored). */
  readonly positionId?: string | undefined;
  /** The seat's display title, which may be English or Chinese. */
  readonly positionTitle?: string | undefined;
  /** What the seat is routed work by — the fallback when its title says nothing recognizable. */
  readonly capabilities?: readonly string[] | undefined;
  /** The person's own specializations, used only when both title and seat say nothing. */
  readonly expertise?: readonly string[] | undefined;
}

export const ROLE_FAMILIES: readonly RoleFamily[] = Object.freeze([
  'executive',
  'engineering',
  'quality',
  'design',
  'product',
  'research',
  'marketing',
  'business',
  'operations',
  'people',
  'finance',
  'general',
]);

export const ROLE_GLYPHS: readonly RoleGlyph[] = Object.freeze([
  'crown',
  'chip',
  'code',
  'server',
  'shield',
  'palette',
  'compass',
  'clipboard',
  'flask',
  'megaphone',
  'trend',
  'gear',
  'users',
  'wallet',
  'person',
]);

/**
 * Words that mark a seat as leadership. They do not change the glyph — a "Head of Engineering"
 * is still code — they only move the family to gold, which is what tells an operator at a
 * glance that this mark is a decision-maker and not an individual contributor.
 */
const LEADERSHIP = /\b(ceo|cto|coo|cfo|cio|cmo|cpo|ciso|chro)\b|\bchief\b|\bfounder\b|co-?founder|\bpresident\b|\bchair(man|woman|person)?\b|\bvp\b|vice president|\bdirector\b|\bhead\b|总监|主管|负责人|总裁|创始|董事/;

/**
 * The work a seat does, most specific first. "QA Engineer" must reach the shield before the
 * generic engineer rule, and "DevOps Engineer" the server before it too — which is why this is
 * an ordered list rather than one lookup map.
 */
const GLYPH_RULES: readonly { readonly glyph: RoleGlyph; readonly test: RegExp }[] = [
  // Leadership first: a CTO is a technologist *and* a chief; the chip keeps the technology legible.
  {
    glyph: 'chip',
    test: /\b(cto|cio|ciso)\b|chief technolog|\btechnology officer\b|\btechnolog|技术总监|技术负责人|技术主管/,
  },
  {
    glyph: 'crown',
    test: /\bceo\b|chief executive|\bpresident\b|\bfounder\b|co-?founder|\bchair(man|woman|person)?\b|首席执行官|总裁|创始人|董事长/,
  },
  // Disciplines.
  { glyph: 'shield', test: /\b(qa|quality|sdet)\b|\btest(ing|er|ers)?\b|verification|测试|质量|验收/ },
  {
    glyph: 'palette',
    test: /\b(ux|ui|design|designer|creative)\b|visual design|interaction design|设计|交互|视觉/,
  },
  { glyph: 'flask', test: /\bresearch(er|ers)?\b|\bscientist\b|\bresearch lab\b|研究/ },
  { glyph: 'server', test: /\b(devops|sre|platform|infrastructure|infra)\b|运维|基础设施/ },
  {
    glyph: 'clipboard',
    test: /\bproject manager\b|\bprogram manager\b|\bproducer\b|项目经理|项目管理|制作人/,
  },
  { glyph: 'compass', test: /\bproduct( manager| owner| lead)?\b|\bpm\b|roadmap|产品/ },
  {
    glyph: 'megaphone',
    test: /\bmarketing\b|\bbrand(ing)?\b|\bcontent\b|\bseo\b|\bsocial\b|\bcommunity\b|\bpr\b|市场|营销|品牌|内容|公关/,
  },
  {
    glyph: 'trend',
    test: /\bgrowth\b|\bsales\b|\bbusiness\b|business development|bizdev|partnership|\banalyst\b|\bstrategy\b|\bconsult|增长|销售|商务|商业|战略|分析/,
  },
  {
    glyph: 'gear',
    test: /\boperations\b|\boperating\b|\bops\b|\bsupport\b|\blegal\b|\bcompliance\b|\badmin\b|\bcoordinator\b|\bassistant\b|运营|法务|行政|客服|支持/,
  },
  {
    glyph: 'users',
    test: /\bhr\b|\bpeople\b|\brecruit(er|ing|ment)?\b|\btalent\b|human resources|人力|人事|招聘/,
  },
  {
    glyph: 'wallet',
    test: /\bfinance\b|\bfinancial\b|\baccount(ing|ant)?\b|\bbudget\b|\btreasurer\b|财务|会计|预算/,
  },
  {
    glyph: 'code',
    test: /\bengineer\b|\bengineering\b|\bdeveloper\b|\bprogrammer\b|\bsoftware\b|\barchitect\b|\bfrontend\b|\bbackend\b|\bfull[- ]?stack\b|\bdev\b|\bandroid\b|\bios\b|\bgames?\b|工程师|开发/,
  },
];

/** The colour a glyph reads in when the seat is not leadership. */
const FAMILY_OF_GLYPH: Readonly<Record<RoleGlyph, RoleFamily>> = {
  crown: 'executive',
  chip: 'engineering',
  code: 'engineering',
  server: 'engineering',
  shield: 'quality',
  palette: 'design',
  compass: 'product',
  clipboard: 'product',
  flask: 'research',
  megaphone: 'marketing',
  trend: 'business',
  gear: 'operations',
  users: 'people',
  wallet: 'finance',
  person: 'general',
};

/**
 * When a seat's title is authored in a language or shorthand the vocabulary does not know, the
 * capabilities it routes work by still say what the seat is for. Only consulted while the glyph
 * is still the neutral `person`.
 */
const CAPABILITY_HINTS: readonly { readonly capability: string; readonly identity: RoleIdentity }[] = [
  { capability: 'testing', identity: { glyph: 'shield', family: 'quality' } },
  { capability: 'product_requirement', identity: { glyph: 'compass', family: 'product' } },
  { capability: 'roadmapping', identity: { glyph: 'compass', family: 'product' } },
  { capability: 'ux_research', identity: { glyph: 'palette', family: 'design' } },
  { capability: 'marketing', identity: { glyph: 'megaphone', family: 'marketing' } },
  { capability: 'technical_design', identity: { glyph: 'code', family: 'engineering' } },
  { capability: 'implementation', identity: { glyph: 'code', family: 'engineering' } },
  { capability: 'frontend', identity: { glyph: 'code', family: 'engineering' } },
  { capability: 'backend', identity: { glyph: 'code', family: 'engineering' } },
];

const GENERAL: RoleIdentity = Object.freeze({ glyph: 'person', family: 'general' });

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hintFromCapabilities(values: readonly string[] | undefined): RoleIdentity | null {
  if (values === undefined) return null;
  for (const entry of values) {
    const normalized = normalize(entry);
    if (normalized === '') continue;
    const hint = CAPABILITY_HINTS.find((candidate) => normalize(candidate.capability) === normalized);
    if (hint !== undefined) return hint.identity;
  }
  return null;
}

/**
 * Resolve the role mark for one seat.
 *
 * The id and the title are matched together so either source can carry the meaning: a seat
 * titled `Chief Technology Officer` with id `cto` resolves through both, while a founder-authored
 * seat titled `游戏开发者` resolves through the title alone.
 */
export function roleIdentityOf(input: RoleInput): RoleIdentity {
  const text = normalize(`${input.positionId ?? ''} ${input.positionTitle ?? ''}`);

  const rule = text === '' ? undefined : GLYPH_RULES.find((candidate) => candidate.test.test(text));
  const glyph = rule === undefined ? 'person' : rule.glyph;

  // A title that says nothing recognizable may still be routed by capability — but a title the
  // vocabulary *did* understand is never overruled by the seat's generic capability list.
  const hinted = glyph === 'person'
    ? hintFromCapabilities(input.capabilities) ?? hintFromCapabilities(input.expertise)
    : null;
  const identity = hinted ?? {
    glyph,
    family: FAMILY_OF_GLYPH[glyph],
  };
  if (LEADERSHIP.test(text)) {
    // A chief/director/head keeps the discipline glyph but reads gold. When even the discipline
    // is unknown, the seniority itself is the one fact worth drawing: a crown.
    return Object.freeze({ glyph: identity.glyph === 'person' ? 'crown' : identity.glyph, family: 'executive' });
  }
  return identity.glyph === 'person' ? GENERAL : identity;
}
