/**
 * A small, safe Markdown reader for delivered documents.
 *
 * A document delivery is prose the AI company wrote, not a web page, so the console renders it as
 * a document sheet — never by assigning its text to `innerHTML`. This module is therefore a
 * *parser*, not a Markdown library: it turns the subset a delivered document actually uses
 * (headings, paragraphs, lists, fenced code, quotes, rules, tables, links) into a block tree, and
 * the React layer maps that tree to elements. No raw HTML from the delivery ever reaches the DOM.
 *
 * The one security decision lives in `sanitizeHref`: only `http(s)`, `mailto`, fragment and
 * same-origin paths are links. A `javascript:` URL in a delivery is rendered as plain text.
 */

export type InlineNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'em'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string };

export type MarkdownBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly inlines: readonly InlineNode[] }
  | { readonly kind: 'paragraph'; readonly inlines: readonly InlineNode[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly InlineNode[])[] }
  | { readonly kind: 'code'; readonly language: string; readonly content: string }
  | { readonly kind: 'quote'; readonly inlines: readonly InlineNode[] }
  | { readonly kind: 'hr' }
  | {
      readonly kind: 'table';
      readonly header: readonly string[];
      readonly align: readonly ('left' | 'center' | 'right' | null)[];
      readonly rows: readonly (readonly string[])[];
    };

/**
 * A link target the document sheet is allowed to navigate to.
 *
 * Relative paths are allowed because a delivered document may link its own files; the browser
 * resolves them against the console, which is harmless. Anything else (notably `javascript:` and
 * `data:`) is not a link at all.
 */
export function sanitizeHref(href: string): string | null {
  const value = href.trim();
  if (value === '') return null;
  if (/^(https?:|mailto:)/i.test(value)) return value;
  if (value.startsWith('#') || value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return value;
  return null;
}

/** Split one line of inline Markdown into text/code/strong/em/link nodes. */
export function parseInline(source: string): readonly InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer !== '') {
      nodes.push({ kind: 'text', text: buffer });
      buffer = '';
    }
  };

  let index = 0;
  while (index < source.length) {
    const character = source[index] ?? '';

    if (character === '`') {
      const end = source.indexOf('`', index + 1);
      if (end > index + 1) {
        flush();
        nodes.push({ kind: 'code', text: source.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    if (source.startsWith('**', index)) {
      const end = source.indexOf('**', index + 2);
      if (end > index + 2) {
        flush();
        nodes.push({ kind: 'strong', text: source.slice(index + 2, end) });
        index = end + 2;
        continue;
      }
    }

    if (character === '[') {
      const close = source.indexOf('](', index + 1);
      const end = close === -1 ? -1 : source.indexOf(')', close + 2);
      if (close > index + 1 && end > close + 2) {
        const href = sanitizeHref(source.slice(close + 2, end));
        if (href !== null) {
          flush();
          nodes.push({ kind: 'link', text: source.slice(index + 1, close), href });
          index = end + 1;
          continue;
        }
      }
    }

    if (character === '*' || character === '_') {
      const previous = index === 0 ? '' : source[index - 1] ?? '';
      const next = source[index + 1] ?? '';
      const after = source[index + 2] ?? '';
      // A word-internal `_` (`product_name`) is not emphasis; neither is an empty `**`.
      if (!/[A-Za-z0-9]/.test(previous) && next !== ' ' && next !== character && after !== '') {
        const end = source.indexOf(character, index + 1);
        if (end > index + 1) {
          flush();
          nodes.push({ kind: 'em', text: source.slice(index + 1, end) });
          index = end + 1;
          continue;
        }
      }
    }

    buffer += character;
    index += 1;
  }

  flush();
  return nodes;
}

/* --- Block parsing -------------------------------------------------------- */

const HEADING = /^(#{1,6})\s+(.*)$/;
const UNORDERED_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function tableCells(line: string): readonly string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function alignmentOf(cell: string): 'left' | 'center' | 'right' | null {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function isBlockStart(line: string): boolean {
  return (
    line.trim() === '' ||
    HEADING.test(line) ||
    RULE.test(line) ||
    /^\s*>/.test(line) ||
    FENCE.test(line) ||
    UNORDERED_ITEM.test(line) ||
    ORDERED_ITEM.test(line)
  );
}

/**
 * Parse delivered Markdown into a block tree.
 *
 * Unknown constructs degrade to a paragraph rather than throwing: a document written by a live
 * model is data, and a strange line must not take down the delivery page.
 */
export function parseMarkdown(source: string): readonly MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? '```';
      const language = fence[2] ?? '';
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trimStart().startsWith(marker)) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code', language, content: code.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: (heading[1] ?? '#').length, inlines: parseInline((heading[2] ?? '').trim()) });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'hr' });
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', inlines: parseInline(quoted.join(' ')) });
      continue;
    }

    const unordered = UNORDERED_ITEM.exec(line);
    const ordered = ORDERED_ITEM.exec(line);
    if (unordered !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const pattern = isOrdered ? ORDERED_ITEM : UNORDERED_ITEM;
      const items: InlineNode[][] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const match = pattern.exec(current);
        if (match !== null) {
          items.push([...parseInline((match[1] ?? '').trim())]);
          index += 1;
          continue;
        }
        if (isBlockStart(current) || items.length === 0) break;
        // A wrapped line continues the item above it rather than starting a new block.
        const previous = items[items.length - 1] ?? [];
        items[items.length - 1] = [...previous, { kind: 'text', text: ' ' }, ...parseInline(current.trim())];
        index += 1;
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1] ?? '')) {
      const header = tableCells(line);
      const align = tableCells(lines[index + 1] ?? '').map(alignmentOf);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim() !== '') {
        rows.push([...tableCells(lines[index] ?? '')]);
        index += 1;
      }
      blocks.push({ kind: 'table', header, align, rows });
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && !isBlockStart(lines[index] ?? '')) {
      if ((lines[index] ?? '').includes('|') && index + 1 < lines.length && TABLE_SEPARATOR.test(lines[index + 1] ?? '')) break;
      paragraph.push((lines[index] ?? '').trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join(' ')) });
  }

  return blocks;
}
