import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_FAMILIES, ROLE_GLYPHS, roleIdentityOf } from '../../../apps/web/src/roles';

/**
 * Role identity is what lets an operator scan the console by what each seat *is* instead of by
 * reading every name. It is a pure lookup over the same vocabulary the read model already
 * carries (`positionId`, `positionTitle`, `capabilities`), so it is pinned here rather than
 * through a render — the console has no browser in CI.
 *
 * Two axes matter independently: the glyph is the work, the family is the tone. A "Head of
 * Design" and a designer share the palette; only the family moves to executive gold.
 */

describe('role identity', () => {
  it('recognizes the seats the starter company ships', () => {
    const seeded: readonly [string, string, { glyph: string; family: string }][] = [
      ['ceo', 'Chief Executive Officer', { glyph: 'crown', family: 'executive' }],
      ['cto', 'Chief Technology Officer', { glyph: 'chip', family: 'executive' }],
      ['product-manager', 'Product Manager', { glyph: 'compass', family: 'product' }],
      ['ux-designer', 'UX Designer', { glyph: 'palette', family: 'design' }],
      ['qa', 'QA Engineer', { glyph: 'shield', family: 'quality' }],
      ['engineer', 'Software Engineer', { glyph: 'code', family: 'engineering' }],
      ['backend-engineer', 'Backend Engineer', { glyph: 'code', family: 'engineering' }],
      ['devops-engineer', 'DevOps Engineer', { glyph: 'server', family: 'engineering' }],
      ['ai-researcher', 'AI Researcher', { glyph: 'flask', family: 'research' }],
      ['marketing-manager', 'Marketing Manager', { glyph: 'megaphone', family: 'marketing' }],
      ['growth-manager', 'Growth Manager', { glyph: 'trend', family: 'business' }],
      ['business-analyst', 'Business Analyst', { glyph: 'trend', family: 'business' }],
    ];
    for (const [positionId, positionTitle, expected] of seeded) {
      expect(roleIdentityOf({ positionId, positionTitle }), positionTitle).toEqual(expected);
    }
  });

  it('keeps the work glyph and moves the tone to gold for leadership seats', () => {
    expect(roleIdentityOf({ positionTitle: 'Head of Design' })).toEqual({ glyph: 'palette', family: 'executive' });
    expect(roleIdentityOf({ positionTitle: 'Engineering Director' })).toEqual({ glyph: 'code', family: 'executive' });
    expect(roleIdentityOf({ positionTitle: 'Head of Marketing' })).toEqual({ glyph: 'megaphone', family: 'executive' });
    expect(roleIdentityOf({ positionTitle: 'Designer' })).toEqual({ glyph: 'palette', family: 'design' });
    // A chief's discipline is still worth drawing: gold says leadership, the glyph says which.
    expect(roleIdentityOf({ positionTitle: 'Chief Financial Officer' })).toEqual({ glyph: 'wallet', family: 'executive' });
    expect(roleIdentityOf({ positionTitle: 'Chief Operating Officer' })).toEqual({ glyph: 'gear', family: 'executive' });
    expect(roleIdentityOf({ positionTitle: 'Chief Marketing Officer' })).toEqual({ glyph: 'megaphone', family: 'executive' });
  });

  it('reads Chinese seats authored in the console', () => {
    expect(roleIdentityOf({ positionTitle: '测试工程师' })).toEqual({ glyph: 'shield', family: 'quality' });
    expect(roleIdentityOf({ positionTitle: '产品经理' })).toEqual({ glyph: 'compass', family: 'product' });
    expect(roleIdentityOf({ positionTitle: 'UI 设计师' })).toEqual({ glyph: 'palette', family: 'design' });
    expect(roleIdentityOf({ positionTitle: '游戏开发者' })).toEqual({ glyph: 'code', family: 'engineering' });
    expect(roleIdentityOf({ positionTitle: '财务主管' })).toEqual({ glyph: 'wallet', family: 'executive' });
    expect(roleIdentityOf({ positionTitle: '人力资源专员' })).toEqual({ glyph: 'users', family: 'people' });
  });

  it('falls back to the capabilities a seat routes work by', () => {
    expect(roleIdentityOf({ positionTitle: 'Synergy Catalyst', capabilities: ['testing'] })).toEqual({ glyph: 'shield', family: 'quality' });
    expect(roleIdentityOf({ positionTitle: 'Synergy Catalyst', capabilities: ['product_requirement'] })).toEqual({ glyph: 'compass', family: 'product' });
    expect(roleIdentityOf({ capabilities: ['implementation'] })).toEqual({ glyph: 'code', family: 'engineering' });
    // A title the vocabulary understood is never overruled by the seat's capability list.
    expect(roleIdentityOf({ positionTitle: 'QA Engineer', capabilities: ['implementation'] })).toEqual({ glyph: 'shield', family: 'quality' });
  });

  it('normalizes case, spacing and slug separators', () => {
    expect(roleIdentityOf({ positionTitle: '  CHIEF   EXECUTIVE   OFFICER ' })).toEqual({ glyph: 'crown', family: 'executive' });
    expect(roleIdentityOf({ positionId: 'product_manager' })).toEqual({ glyph: 'compass', family: 'product' });
    expect(roleIdentityOf({ positionId: 'frontend-engineer' })).toEqual({ glyph: 'code', family: 'engineering' });
  });

  it('degrades an unknown seat to the neutral person mark instead of guessing', () => {
    // Seniority is the one thing still worth drawing when the discipline is unknown.
    expect(roleIdentityOf({ positionTitle: 'Chief of Everything' })).toEqual({ glyph: 'crown', family: 'executive' });
    expect(roleIdentityOf({ positionTitle: 'Head of Office' })).toEqual({ glyph: 'crown', family: 'executive' });
    expect(roleIdentityOf({ positionTitle: 'Synergy Catalyst' })).toEqual({ glyph: 'person', family: 'general' });
    expect(roleIdentityOf({})).toEqual({ glyph: 'person', family: 'general' });
  });

  it('only ever returns a declared glyph and family', () => {
    const samples = [
      {},
      { positionTitle: 'Chief Technology Officer' },
      { positionTitle: 'Director of Sales' },
      { positionTitle: '自定义岗位' },
      { capabilities: ['marketing'] },
    ];
    for (const sample of samples) {
      const identity = roleIdentityOf(sample);
      expect(ROLE_GLYPHS).toContain(identity.glyph);
      expect(ROLE_FAMILIES).toContain(identity.family);
    }
  });
});

/**
 * The stylesheet contract. A family added to `roles.ts` without a rule in `roles.css` would
 * render as an uncoloured badge, which is exactly the failure the role marks exist to prevent.
 * Read from the stylesheet rather than from a render, for the same reason as the team-card
 * layout contract.
 */

const stylesheet = readFileSync(path.join(process.cwd(), 'apps', 'web', 'src', 'roles.css'), 'utf8');

describe('role marks stylesheet', () => {
  it('paints every declared family', () => {
    for (const family of ROLE_FAMILIES) {
      expect(stylesheet, family).toContain(`.agent-avatar[data-family='${family}']`);
    }
  });

  it('sizes every variant the console uses', () => {
    for (const size of ['xs', 'sm', 'md', 'lg']) {
      expect(stylesheet, size).toContain(`.agent-avatar[data-size='${size}']`);
    }
  });

  it('carries the state rules that keep identity and status separate', () => {
    expect(stylesheet).toContain(".agent-avatar[data-status='working']::after");
    expect(stylesheet).toContain(".agent-avatar[data-status='paused']::after");
    expect(stylesheet).toContain(".agent-avatar[data-status='archived']");
    expect(stylesheet).toContain(".agent-avatar[data-status='vacant']");
    // The two dark decks must repaint the badge, or a role mark on Network would keep its light tone.
    expect(stylesheet).toContain('.network-deck .agent-avatar');
    expect(stylesheet).toContain('.assignment-studio .agent-avatar');
  });
});
