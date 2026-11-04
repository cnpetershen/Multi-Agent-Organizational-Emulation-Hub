import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEventType } from '@maoeh/event-system';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packageRoot = join(root, 'packages', 'agent-communication');

const skipDirs = new Set(['node_modules', 'dist', '.turbo', '.git']);

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

const sourceFiles = walk(join(packageRoot, 'src'));
const sources = sourceFiles.map((file) => ({
  file: relativePosix(file),
  source: readFileSync(file, 'utf8'),
}));
const combined = sources.map((entry) => entry.source).join('\n');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

const allowedWorkspaceDependencies = new Set([
  '@maoeh/organization-model',
  '@maoeh/permission-system',
  '@maoeh/event-system',
  '@maoeh/shared-types',
]);

const forbiddenModuleSubstrings = [
  '@maoeh/llm-gateway',
  '@maoeh/agent-cognition',
  '@maoeh/agent-definition',
  '@maoeh/agent-runtime',
  '@maoeh/agent-memory',
  '@maoeh/agent-tools',
  '@maoeh/event-store',
  '@maoeh/persistence',
  '@maoeh/runtime-state',
  '@maoeh/runtime-scheduler',
  '@maoeh/workflow-engine',
  '@maoeh/task-system',
  '@maoeh/meeting-engine',
  'apps/',
  'openai',
  '@anthropic-ai/sdk',
  'node:http',
  'node:net',
];

const forbiddenTokens = [
  'sendTo(',
  'agentToAgent',
  'AgentToAgent',
  'AgentState',
  'AgentInstance',
  'AgentDefinition',
];

describe('A7 通信边界守卫（agent-communication）', () => {
  it('扫描目标非空（守卫不空转）', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it('依赖仅限注册表 Allowed：organization-model / permission-system / event-system / shared-types', () => {
    const workspaceDependencies = Object.keys(manifest.dependencies).filter((name) =>
      name.startsWith('@maoeh/'),
    );
    const violations = workspaceDependencies.filter(
      (name) => !allowedWorkspaceDependencies.has(name),
    );
    expect(violations, violations.join('\n')).toEqual([]);
    expect(workspaceDependencies.length).toBeGreaterThan(0);
  });

  it('源码不 import 禁止模块（LLM / Agent 实体 / 持久化 / 网络 / 应用层）', () => {
    const violations = forbiddenModuleSubstrings.filter((forbidden) =>
      combined.includes(forbidden),
    );
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('不存在直接投递到另一 Agent 实例的标识（A5：通信只能经事件）', () => {
    const violations = forbiddenTokens.filter((token) => combined.includes(token));
    expect(violations, violations.join('\n')).toEqual([]);
    expect(/\binterface\s+Agent\b/.test(combined)).toBe(false);
  });

  it('通信事件类型符合 taxonomy，且仅使用 Communication 聚合', () => {
    const eventTypes = [...combined.matchAll(/'([A-Z][A-Za-z0-9]*\.[A-Z][A-Za-z0-9]*)'/g)].map(
      (match) => match[1] ?? '',
    );
    expect(eventTypes.length).toBeGreaterThan(0);
    expect(eventTypes.every((type) => parseEventType(type) !== null)).toBe(true);
    expect(
      eventTypes.every((type) => type.startsWith('Communication.')),
    ).toBe(true);
    expect(new Set(eventTypes)).toEqual(
      new Set([
        'Communication.MessageSent',
        'Communication.ChannelOpened',
        'Communication.CollaborationRequested',
      ]),
    );
  });

  it('源码持有 Agent 引用面为零，且权限裁决统一委托给 permission-system', () => {
    expect(combined.includes('authz.can(')).toBe(true);
    expect(combined.includes('permissionFailure')).toBe(true);
  });
});
