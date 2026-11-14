import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, sanitizeHref } from '../../../apps/web/src/markdown';

/**
 * The document sheet's reader. It must turn a delivered Markdown file into the blocks a person
 * reads, and it must never turn a delivery into executable HTML: the parser produces a tree, and
 * only whitelisted link schemes survive.
 */

describe('parseInline', () => {
  it('reads emphasis, code and safe links', () => {
    const nodes = parseInline('Ship **v1** with `tests` and [notes](https://example.com/x).');
    expect(nodes.map((node) => node.kind)).toEqual(['text', 'strong', 'text', 'code', 'text', 'link', 'text']);
    expect(nodes.find((node) => node.kind === 'strong')).toEqual({ kind: 'strong', text: 'v1' });
    expect(nodes.find((node) => node.kind === 'link')).toEqual({
      kind: 'link',
      text: 'notes',
      href: 'https://example.com/x',
    });
  });

  it('treats an unsafe scheme as plain text instead of a link', () => {
    const nodes = parseInline('[click](javascript:alert(1))');
    expect(nodes.some((node) => node.kind === 'link')).toBe(false);
    expect(nodes.map((node) => (node.kind === 'text' ? node.text : '')).join('')).toContain('javascript');
  });

  it('does not italicize a word-internal underscore', () => {
    const nodes = parseInline('product_name is stable');
    expect(nodes.every((node) => node.kind === 'text')).toBe(true);
  });
});

describe('sanitizeHref', () => {
  it('allows http, https, mailto, fragments and relative paths', () => {
    expect(sanitizeHref('https://example.com')).toBe('https://example.com');
    expect(sanitizeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(sanitizeHref('#section')).toBe('#section');
    expect(sanitizeHref('/api/tasks/task-1')).toBe('/api/tasks/task-1');
    expect(sanitizeHref('./notes.md')).toBe('./notes.md');
  });

  it('rejects anything that could execute or exfiltrate', () => {
    expect(sanitizeHref('javascript:alert(1)')).toBeNull();
    expect(sanitizeHref('data:text/html,<script>')).toBeNull();
    expect(sanitizeHref('  ')).toBeNull();
  });
});

describe('parseMarkdown', () => {
  it('reads headings, paragraphs and lists in order', () => {
    const blocks = parseMarkdown('# Product Requirement\n\n实时追踪工单。\n\n- Context: what it asks for\n- Approach: the smallest slice');
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'list']);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    const list = blocks[2];
    expect(list?.kind === 'list' && list.items).toHaveLength(2);
    expect(list?.kind === 'list' && list.ordered).toBe(false);
  });

  it('keeps fenced code verbatim, including blank lines and heading-like lines', () => {
    const blocks = parseMarkdown('```python\n# not a heading\nprint("hi")\n\nprint("bye")\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      kind: 'code',
      language: 'python',
      content: '# not a heading\nprint("hi")\n\nprint("bye")',
    });
  });

  it('reads a table with alignment', () => {
    const blocks = parseMarkdown('| Key | Value |\n| --- | :---: |\n| a | 1 |\n| b | 2 |');
    expect(blocks[0]).toEqual({
      kind: 'table',
      header: ['Key', 'Value'],
      align: [null, 'center'],
      rows: [['a', '1'], ['b', '2']],
    });
  });

  it('reads a quote, an ordered list and a rule', () => {
    const blocks = parseMarkdown('> a finding\n\n1. first\n2. second\n\n---');
    expect(blocks.map((block) => block.kind)).toEqual(['quote', 'list', 'hr']);
    expect(blocks[1]?.kind === 'list' && blocks[1].ordered).toBe(true);
  });

  it('treats malformed input as prose instead of throwing', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('**unclosed and `code')).toHaveLength(1);
    expect(parseMarkdown('```\nunclosed fence')).toEqual([{ kind: 'code', language: '', content: 'unclosed fence' }]);
  });
});
