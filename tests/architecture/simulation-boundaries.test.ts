import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const registryText = readFileSync(join(root, 'docs/architecture/package-registry.md'), 'utf8');

const domainPackages = [
  'organization-model',
  'identity-system',
  'permission-system',
  'authority-engine',
  'policy-engine',
  'shared-types',
] as const;

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

interface AllowedMatcher {
  readonly names: ReadonlySet<string>;
  readonly hasWildcardAgent: boolean;
  readonly hasWildcardEngine: boolean;
  readonly hasDomainGroup: boolean;
  accepts(specifier: string): boolean;
}

function registryAllowed(heading: string): AllowedMatcher {
  const start = registryText.indexOf(`${heading}\n`);
  if (start < 0) throw new Error(`registry heading missing for ${heading}`);
  const next = registryText.indexOf('\n### ', start + 1);
  const section = registryText.slice(start, next < 0 ? registryText.length : next);
  const allowedLine = section.split('\n').find((line) => line.startsWith('- **Allowed**'));
  if (allowedLine === undefined) throw new Error(`registry Allowed missing for ${heading}`);
  const names = new Set([...allowedLine.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ''));
  const hasWildcardAgent = names.has('agent-*');
  const hasWildcardEngine = names.has('*-engine');
  const hasDomainGroup = allowedLine.includes('Domain 包');
  return {
    names,
    hasWildcardAgent,
    hasWildcardEngine,
    hasDomainGroup,
    accepts(specifier) {
      if (!specifier.startsWith('@maoeh/')) return true;
      const name = specifier.slice('@maoeh/'.length).split('/')[0] ?? '';
      if (names.has(name)) return true;
      if (hasWildcardAgent && name.startsWith('agent-')) return true;
      if (hasWildcardEngine && name.endsWith('-engine')) return true;
      if (hasDomainGroup && (domainPackages as readonly string[]).includes(name)) return true;
      return false;
    },
  };
}

interface Scan {
  readonly label: string;
  readonly sources: readonly { readonly file: string; readonly source: string }[];
  readonly combined: string;
  readonly workspaceImports: readonly string[];
  readonly manifestWorkspaceDeps: readonly string[];
  readonly allowed: AllowedMatcher;
}

function scan(absDir: string, pkgRoot: string, label: string, heading: string): Scan {
  const sourceFiles = walk(absDir);
  const sources = sourceFiles.map((file) => ({
    file: relativePosix(file),
    source: readFileSync(file, 'utf8'),
  }));
  const combined = sources.map((entry) => entry.source).join('\n');
  const workspaceImports = new Set<string>();
  for (const entry of sources) {
    for (const match of entry.source.matchAll(importPattern)) {
      const specifier = match[1] ?? '';
      if (specifier.startsWith('@maoeh/')) workspaceImports.add(specifier);
    }
  }
  const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const manifestWorkspaceDeps = Object.keys(manifest.dependencies ?? {}).filter((name) =>
    name.startsWith('@maoeh/'),
  );
  return {
    label,
    sources,
    combined,
    workspaceImports: [...workspaceImports].sort(),
    manifestWorkspaceDeps,
    allowed: registryAllowed(heading),
  };
}

const kernel = scan(
  join(root, 'apps/kernel/src'),
  join(root, 'apps/kernel'),
  'apps/kernel',
  '### apps/kernel',
);
const scheduler = scan(
  join(root, 'packages/runtime-scheduler/src'),
  join(root, 'packages/runtime-scheduler'),
  'runtime-scheduler',
  '### runtime-scheduler',
);

const scans = [kernel, scheduler];

describe('M0.9 boundary guard: apps/kernel + runtime-scheduler', () => {
  it('scans non-empty sources (guard never idles)', () => {
    for (const scanEntry of scans) {
      expect(scanEntry.sources.length, scanEntry.label).toBeGreaterThan(0);
    }
  });

  it('manifest workspace dependencies are within the Registry Allowed set', () => {
    for (const scanEntry of scans) {
      const violations = scanEntry.manifestWorkspaceDeps.filter(
        (name) => !scanEntry.allowed.accepts(name),
      );
      expect(violations, `${scanEntry.label}: ${violations.join(', ')}`).toEqual([]);
    }
  });

  it('source @maoeh/* imports are within the Registry Allowed set', () => {
    for (const scanEntry of scans) {
      const violations = scanEntry.workspaceImports.filter(
        (name) => !scanEntry.allowed.accepts(name),
      );
      expect(violations, `${scanEntry.label}: ${violations.join(', ')}`).toEqual([]);
      expect(scanEntry.workspaceImports.length, scanEntry.label).toBeGreaterThan(0);
    }
  });

  it('registry Allowed grants the M0.9 orchestration deviation (workflow-engine, task-system)', () => {
    expect(kernel.allowed.accepts('@maoeh/workflow-engine')).toBe(true);
    expect(kernel.allowed.accepts('@maoeh/task-system')).toBe(true);
    expect(kernel.allowed.accepts('@maoeh/agent-runtime')).toBe(true);
    expect(kernel.allowed.accepts('@maoeh/organization-model')).toBe(true);
  });

  it('registry must not grant the kernel unrelated application or provider packages', () => {
    expect(kernel.allowed.accepts('@maoeh/api')).toBe(false);
    expect(kernel.allowed.accepts('@maoeh/persistence')).toBe(true);
  });

  it('kernel sources never import llm-gateway directly (only via agent-cognition)', () => {
    expect(kernel.combined).not.toContain('@maoeh/llm-gateway');
  });

  it('kernel sources never import other apps, node http/net, or provider SDKs', () => {
    for (const forbidden of [
      'node:http',
      'node:net',
      'openai',
      '@anthropic-ai/sdk',
      "'../../api",
      'apps/api',
    ]) {
      expect(kernel.combined, forbidden).not.toContain(forbidden);
    }
  });

  it('simulation core is forbidden from wall-clock and timer side effects', () => {
    const simulationCore = kernel.sources
      .filter((entry) => entry.file.includes('/simulation/'))
      .map((entry) => entry.source)
      .join('\n');
    for (const forbidden of [
      'setInterval(',
      'setTimeout(',
      'performance.now(',
      'Date.now(',
      'while (true)',
      'while(true)',
    ]) {
      expect(simulationCore, forbidden).not.toContain(forbidden);
    }
  });

  it('simulation core uses a bounded loop rather than an unguarded while', () => {
    const runTick = kernel.sources.find((entry) => entry.file.endsWith('run-tick.ts'));
    expect(runTick).toBeDefined();
    expect(runTick?.source).toContain('for (;;)');
  });

  it('introduces no separate simulation-engine package', () => {
    expect(existsSync(join(root, 'packages/simulation-engine'))).toBe(false);
  });

  it('exposes the simulation engine through the kernel entrypoint', () => {
    const index = kernel.sources.find((entry) => entry.file.endsWith('apps/kernel/src/index.ts'));
    expect(index?.source).toContain('createSimulation');
    expect(index?.source).toContain('runSimulationTick');
  });
});
