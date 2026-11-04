import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The team panel's layout contract.
 *
 * `.people-grid` is one grid, so a row stretches every card in it to the tallest card there. A
 * `.person-card` is itself a grid, which means the default `align-content: stretch` redistributes
 * the height a stretched card receives between its own tracks. In the shipped console that put the
 * CEO's tall card next to the two vacancies and pulled the vacancies' blocks apart — measured on a
 * production render, the gap above the vacancy's `创建 Agent` button grew from 14px to 109px while
 * the neighbouring card kept 14px.
 *
 * These tests pin the rules that make a stretched card keep its own rhythm. They are read from the
 * stylesheet rather than through a render because the console has no browser in CI: the layout is a
 * property of the CSS, so the CSS is what the contract has to be asserted against.
 */

const stylesheet = readFileSync(path.join(process.cwd(), 'apps', 'web', 'src', 'phase3.css'), 'utf8');

/**
 * The declarations a selector receives, in stylesheet order.
 *
 * Comments are removed first: this stylesheet annotates several rules with a `/* … *\/` block, and a
 * comment left in place would be read as the selector of the rule that follows it. A rule's
 * selector list is then split on commas, so `.person-card{…}` and `.person-card:hover{…}` are
 * separate blocks even when they share one line; later blocks win a tie in the cascade, so callers
 * assert on the tail.
 */
function declarationsFor(selector: string): string[] {
  const found: string[] = [];
  const withoutComments = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? '').split(',').map((entry) => entry.trim());
    if (selectors.includes(selector)) found.push((match[2] ?? '').trim());
  }
  return found;
}

describe('team card layout contract', () => {
  it('keeps a stretched card from spreading its own content', () => {
    const declarations = declarationsFor('.person-card');
    expect(declarations.length).toBeGreaterThan(0);
    // The card is a grid of stacked blocks; `align-content:start` is the last word on where the
    // spare height a stretched row hands it goes, so it must not be missing or overridden later.
    expect(declarations.at(-1)).toContain('align-content:start');
  });

  it('still lays a card out as a grid of blocks', () => {
    expect(declarationsFor('.person-card')[0]).toContain('display:grid');
  });

  it('leaves the team grid and the vacancy card styling intact', () => {
    expect(declarationsFor('.people-grid')[0]).toContain('display:grid');
    expect(declarationsFor('.vacancy-card')[0]).toContain('border-style:dashed');
  });
});
