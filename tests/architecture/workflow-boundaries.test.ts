import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const registryText = readFileSync(join(root, 'docs/architecture/package-registry.md'), 'utf8');

const packageNames = ['authority-engine', 'task-system', 'workflow-engine'] as const;

const skipDirs = new Set(['node_modules', 'dist', '.turbo', '.git']);

const importPattern =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, acc);
    } else if (extname(entry.name) === '.ts') {
      acc.push(fullPath);
    }
  }
  return acc;
}

function relativePosix(file: string): string {
  return relative(root, file).replace(/\\/g, '/');
}

function registryAllowed(packageName: string): Set<string> {
  const heading = registryText.indexOf(`### ${packageName}\n`);
  if (heading < 0) throw new Error(`registry heading missing for ${packageName}`);
  const section = registryText.slice(
    heading,
    registryText.indexOf('\n### ', heading + 1) < 0
      ? registryText.length
      : registryText.indexOf('\n### ', heading + 1),
  );
  const allowedLine = section
    .split('\n')
    .find((line) => line.startsWith('- **Allowed**'));
  if (allowedLine === undefined) {
    throw new Error(`registry Allowed line missing for ${packageName}`);
  }
  const names = [...allowedLine.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
  if (names.length === 0) throw new Error(`registry Allowed empty for ${packageName}`);
  return new Set(names.map((name) => `@maoeh/${name}`));
}

interface PackageScan {
  readonly packageName: string;
  readonly sources: readonly string[];
  readonly combined: string;
  readonly manifestWorkspaceDeps: readonly string[];
  readonly sourceWorkspaceImports: readonly string[];
  readonly allowed: Set<string>;
}

const scans: PackageScan[] = packageNames.map((packageName) => {
  const packageRoot = join(root, 'packages', packageName);
  const sourceFiles = walk(join(packageRoot, 'src'));
  const sources = sourceFiles.map((file) => ({
    file: relativePosix(file),
    source: readFileSync(file, 'utf8'),
  }));
  const combined = sources.map((entry) => entry.source).join('\n');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const workspaceImports = new Set<string>();
  for (const entry of sources) {
    for (const match of entry.source.matchAll(importPattern)) {
      const specifier = match[1] ?? '';
      if (specifier.startsWith('@maoeh/')) workspaceImports.add(specifier);
    }
  }
  return {
    packageName,
    sources: sources.map((entry) => entry.file),
    combined,
    manifestWorkspaceDeps: Object.keys(manifest.dependencies).filter((name) =>
      name.startsWith('@maoeh/'),
    ),
    sourceWorkspaceImports: [...workspaceImports].sort(),
    allowed: registryAllowed(packageName),
  };
});

const forbiddenModuleSubstrings = [
  '@maoeh/llm-gateway',
  '@maoeh/agent-cognition',
  '@maoeh/agent-runtime',
  '@maoeh/agent-definition',
  '@maoeh/agent-memory',
  '@maoeh/agent-tools',
  '@maoeh/agent-communication',
  '@maoeh/event-store',
  '@maoeh/persistence',
  '@maoeh/runtime-state',
  '@maoeh/runtime-scheduler',
  '@maoeh/meeting-engine',
  'apps/',
  'openai',
  '@anthropic-ai/sdk',
  'node:http',
  'node:net',
];

const forbiddenAgentTokens = [
  'AgentInstance',
  'AgentDefinition',
  'AgentState',
  'sendTo(',
  'agentToAgent',
  'AgentToAgent',
];

describe('M0.8 边界守卫：authority-engine / task-system / workflow-engine', () => {
  it('扫描目标非空（三包 src 均有源码，守卫不空转）', () => {
    for (const scan of scans) {
      expect(scan.sources.length, scan.packageName).toBeGreaterThan(0);
    }
  });

  it('manifest 的 workspace 依赖 ⊆ Registry Allowed', () => {
    for (const scan of scans) {
      const violations = scan.manifestWorkspaceDeps.filter(
        (name) => !scan.allowed.has(name),
      );
      expect(violations, `${scan.packageName}: ${violations.join('\n')}`).toEqual([]);
    }
  });

  it('源码 @maoeh/* import ⊆ Registry Allowed', () => {
    for (const scan of scans) {
      const violations = scan.sourceWorkspaceImports.filter(
        (name) => !scan.allowed.has(name),
      );
      expect(violations, `${scan.packageName}: ${violations.join('\n')}`).toEqual([]);
      expect(scan.sourceWorkspaceImports.length, scan.packageName).toBeGreaterThan(0);
    }
  });

  it('源码不 import 禁止模块（LLM / 认知 / 持久化 / 事件存储 / 应用层 / 网络）', () => {
    for (const scan of scans) {
      const violations = forbiddenModuleSubstrings.filter((forbidden) =>
        scan.combined.includes(forbidden),
      );
      expect(violations, `${scan.packageName}: ${violations.join('\n')}`).toEqual([]);
    }
  });

  it('authority-engine 不 import permission-system（Registry 显式禁止 permission 与 authority 解耦）', () => {
    const authority = scans.find((scan) => scan.packageName === 'authority-engine');
    if (authority === undefined) throw new Error('authority-engine scan missing');
    expect(authority.sourceWorkspaceImports).not.toContain('@maoeh/permission-system');
    expect(authority.manifestWorkspaceDeps).not.toContain('@maoeh/permission-system');
  });

  it('三包源码不含 Agent 实体直接引用（编排层不直接调用 Agent，只经事件协作）', () => {
    for (const scan of scans) {
      const violations = forbiddenAgentTokens.filter((token) => scan.combined.includes(token));
      expect(violations, `${scan.packageName}: ${violations.join('\n')}`).toEqual([]);
    }
  });
});
