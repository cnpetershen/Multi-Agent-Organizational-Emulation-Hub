import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The console's components must call their hooks before they can return early.
 *
 * The bug this pins: `/results/:taskId` rendered its loading state first (no task yet) and
 * returned before a `useState` that lives further down the component. The moment the record
 * arrived, React found one more hook than on the previous render and threw
 * "Rendered more hooks than during the previous render" — the whole console showed
 * 「控制台渲染失败」. No unit test can see that, because it needs *two* renders of one component;
 * the rule is static, so the guard is static too.
 *
 * The heuristic (documented because it is one): inside a component, a hook call is a 2-space
 * indented line whose text calls `useXxx(`, and an early return is a 2-space `return`, a
 * `if (…) return`, or an `if (…) {` block that returns before it closes. Hooks nested deeper
 * than two spaces are inside callbacks and are not component hooks, so they are ignored.
 */

/** Component functions of a console source file, with the source slice of each body. */
function components(source: string): readonly { readonly name: string; readonly body: string }[] {
  const marker = /^(?:export )?function ([A-Z][A-Za-z0-9]*)\s*\(/gm;
  const matches = [...source.matchAll(marker)];
  return matches.map((match, index) => ({
    name: match[1] ?? '',
    body: source.slice(match.index ?? 0, index + 1 < matches.length ? (matches[index + 1]?.index ?? source.length) : source.length),
  }));
}

function hookLines(lines: readonly string[]): readonly number[] {
  const found: number[] = [];
  lines.forEach((line, index) => {
    const text = line.trimStart();
    if (text.startsWith('//') || text.startsWith('*')) return;
    if (/^ {2}.*\buse[A-Z][A-Za-z0-9]*[<(]/.test(line)) found.push(index);
  });
  return found;
}

/** Line index of the first early return inside a component body, or `null`. */
function earlyReturnLine(lines: readonly string[]): number | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const text = line.trimStart();
    if (text.startsWith('//') || text.startsWith('*')) continue;
    if (/^ {2}return\b/.test(line) || /^ {2}if \(.+\) return\b/.test(line)) return index;
    if (/^ {2}if \(.+\) \{$/.test(line)) {
      for (let inner = index + 1; inner < lines.length; inner += 1) {
        const innerLine = lines[inner] ?? '';
        if (/^ {2}\}/.test(innerLine)) break;
        if (/^\s+return\b/.test(innerLine)) return index;
      }
    }
  }
  return null;
}

/** `Component: last hook line N, early return line M` for every component that violates the rule. */
export function hookOrderViolations(source: string): readonly string[] {
  const violations: string[] = [];
  for (const component of components(source)) {
    const lines = component.body.split('\n');
    const hooks = hookLines(lines);
    if (hooks.length === 0) continue;
    const early = earlyReturnLine(lines);
    const lastHook = hooks[hooks.length - 1];
    if (early !== null && lastHook !== undefined && lastHook > early) {
      violations.push(`${component.name}: hook line ${String(lastHook + 1)} runs after return line ${String(early + 1)}`);
    }
  }
  return violations;
}

function consoleSources(directory = join('apps', 'web', 'src')): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...consoleSources(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('console hook order', () => {
  it('flags a hook that runs after an early return', () => {
    const broken = [
      'export function Page() {',
      '  const [busy] = useState(false);',
      '  const task = useThing();',
      '  if (task === null) {',
      '    return <p>loading</p>;',
      '  }',
      '  const [extra, setExtra] = useState(0);',
      '  return <p>{String(extra)}</p>;',
      '}',
    ].join('\n');
    expect(hookOrderViolations(broken)).toEqual(['Page: hook line 7 runs after return line 4']);
  });

  it('accepts a component whose hooks all precede its early returns', () => {
    const fixed = [
      'export function Page() {',
      '  const [busy] = useState(false);',
      '  const [extra, setExtra] = useState(0);',
      '  const task = useThing();',
      '  if (task === null) {',
      '    return <p>loading</p>;',
      '  }',
      '  return <p>{String(busy)}{String(extra)}</p>;',
      '}',
    ].join('\n');
    expect(hookOrderViolations(fixed)).toEqual([]);
  });

  it('keeps every console component honest', () => {
    const offenders = consoleSources().flatMap((file) =>
      hookOrderViolations(readFileSync(file, 'utf8')).map((violation) => `${relative('.', file)} ${violation}`),
    );
    expect(offenders).toEqual([]);
  });
});
