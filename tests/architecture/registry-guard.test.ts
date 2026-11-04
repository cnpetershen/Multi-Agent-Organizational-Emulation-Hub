import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

const registry = readFileSync(
  join(root, 'docs/architecture/package-registry.md'),
  'utf8',
);
const headings = [...registry.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());
const packageHeadings = headings
  .filter((h) => !h.startsWith('apps/'))
  .sort();
const appHeadings = headings
  .filter((h) => h.startsWith('apps/'))
  .map((h) => h.slice('apps/'.length))
  .sort();

function dirsOf(pDir: string): string[] {
  return readdirSync(join(root, pDir), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

describe('package-registry.md ↔ 目录结构 双向一致', () => {
  it('28 个 packages/* 目录 ↔ Registry 的 ### 条目', () => {
    expect(packageHeadings).toEqual(dirsOf('packages'));
  });

  it('4 个 apps/* 目录 ↔ Registry 的 ### apps/* 条目', () => {
    expect(appHeadings).toEqual(dirsOf('apps'));
  });

  it('每个目录的 package.json name 为 @maoeh/<目录名>', () => {
    for (const group of ['packages', 'apps']) {
      for (const dir of dirsOf(group)) {
        const pkg = JSON.parse(
          readFileSync(join(root, group, dir, 'package.json'), 'utf8'),
        ) as { name?: string };

        expect(pkg.name, `${group}/${dir}`).toBe(`@maoeh/${dir}`);
      }
    }
  });
});
