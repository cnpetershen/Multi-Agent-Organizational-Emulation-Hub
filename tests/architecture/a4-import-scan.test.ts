import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

const providerSpecifiers = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  'ollama',
];

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const skipDirs = new Set(['node_modules', 'dist', '.turbo', '.git']);

const importPattern =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

function walk(pDir: string, pAcc: string[] = []): string[] {
  for (const entry of readdirSync(pDir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const fullPath = join(pDir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, pAcc);
    } else if (sourceExtensions.has(extname(entry.name))) {
      pAcc.push(fullPath);
    }
  }
  return pAcc;
}

function isProviderSpecifier(pSpecifier: string): boolean {
  return providerSpecifiers.some(
    (p) => pSpecifier === p || pSpecifier.startsWith(`${p}/`),
  );
}

function relativePosix(pFile: string): string {
  return relative(root, pFile).replace(/\\/g, '/');
}

const sourceFiles = walk(root);

describe('A4 源码扫描：LLM provider SDK 单出口（F6）', () => {
  it('扫描目标非空', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('openai / @anthropic-ai/sdk / @google/generative-ai / ollama 的导入只允许出现在 packages/llm-gateway', () => {
    const violations: string[] = [];

    for (const file of sourceFiles) {
      const relPath = relativePosix(file);
      if (relPath.startsWith('packages/llm-gateway/')) continue;

      for (const match of readFileSync(file, 'utf8').matchAll(importPattern)) {
        if (isProviderSpecifier(match[1])) {
          violations.push(`${relPath} -> ${match[1]}`);
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });
});
