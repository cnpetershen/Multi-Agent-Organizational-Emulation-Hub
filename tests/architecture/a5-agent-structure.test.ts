import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

const skipDirs = new Set(['node_modules', 'dist', '.turbo', '.git']);

function walk(pDir: string, pAcc: string[] = []): string[] {
  for (const entry of readdirSync(pDir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const fullPath = join(pDir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, pAcc);
    } else if (extname(entry.name) === '.ts') {
      pAcc.push(fullPath);
    }
  }
  return pAcc;
}

function agentPackageSources(): string[] {
  const agentDirs = readdirSync(join(root, 'packages'), {
    withFileTypes: true,
  }).filter((e) => e.isDirectory() && e.name.startsWith('agent-'));

  return agentDirs.flatMap((e) => walk(join(root, 'packages', e.name)));
}

function extractInterfaceAgentBody(pSource: string): string | null {
  const start = pSource.search(
    /interface\s+Agent\b(?:\s*<[^>]*>)?\s*\{/,
  );
  if (start < 0) return null;

  const open = pSource.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < pSource.length; i += 1) {
    if (pSource[i] === '{') {
      depth += 1;
    } else if (pSource[i] === '}') {
      depth -= 1;
      if (depth === 0) return pSource.slice(open + 1, i);
    }
  }
  return null;
}

function relativePosix(pFile: string): string {
  return relative(root, pFile).replace(/\\/g, '/');
}

const agentSources = agentPackageSources();
const agentSourceContents = agentSources.map((file) => ({
  file: relativePosix(file),
  source: readFileSync(file, 'utf8'),
}));

describe(
  'A5 结构守卫（仅文本结构启发式，不构成 Agent 行为的语义证明）',
  () => {
    it('扫描目标非空（守卫不空转）', () => {
      expect(agentSources.length).toBeGreaterThan(0);
    });

    it('agent-* 包源码中不存在 sendTo( 直接投递调用', () => {
      const violations = agentSourceContents
        .filter((e) => e.source.includes('sendTo('))
        .map((e) => e.file);

      expect(violations, violations.join('\n')).toEqual([]);
    });

    it('interface Agent 内不存在 Agent 类型成员（跨 Agent 引用）', () => {
      const violations: string[] = [];

      for (const entry of agentSourceContents) {
        const body = extractInterfaceAgentBody(entry.source);
        if (body === null) continue;
        if (/:\s*[^;{}\n]*\bAgent\b/.test(body)) {
          violations.push(entry.file);
        }
      }

      expect(violations, violations.join('\n')).toEqual([]);
    });

    it('agent-* 包源码中不存在 agentToAgent / AgentToAgent 标识符', () => {
      const violations = agentSourceContents
        .filter((e) => /\b(agentToAgent|AgentToAgent)\b/.test(e.source))
        .map((e) => e.file);

      expect(violations, violations.join('\n')).toEqual([]);
    });
  },
);
