import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACTIONS } from '@maoeh/shared-types';

const root = fileURLToPath(new URL('../../', import.meta.url));

function sourcesUnder(relative: string): { readonly path: string; readonly text: string }[] {
  const base = join(root, relative);
  const collected: { path: string; text: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      collected.push({ path: full.slice(root.length).split('\\').join('/'), text: readFileSync(full, 'utf8') });
    }
  };
  walk(base);
  return collected;
}

const runtimeSources = sourcesUnder('packages/agent-runtime/src');
const cognitionSources = sourcesUnder('packages/agent-cognition/src');

describe('M0.6 架构边界：agent-runtime 只调用认知端口，Prompt 唯一归属 agent-cognition', () => {
  it('agent-runtime 不 import llm-gateway、不 import agent-cognition 的 prompts/', () => {
    expect(runtimeSources.length).toBeGreaterThan(0);
    for (const file of runtimeSources) {
      expect(file.text, `${file.path} must not reach llm-gateway`).not.toMatch(
        /@maoeh\/llm-gateway/,
      );
      expect(file.text, `${file.path} must not import prompts`).not.toMatch(
        /from\s+'[^']*agent-cognition[^']*prompt/i,
      );
      expect(file.text, `${file.path} must not define prompts`).not.toMatch(
        /\bprompt\s*:/i,
      );
      expect(file.text, `${file.path} must not mention a model identifier`).not.toMatch(
        /\bmodel\s*:/i,
      );
    }
  });

  it('agent-runtime 无网络出口与 provider SDK 依赖', () => {
    for (const file of runtimeSources) {
      expect(file.text, `${file.path} must not call fetch`).not.toMatch(/\bfetch\s*\(/);
      expect(file.text, `${file.path} must not use http endpoints`).not.toMatch(
        /https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i,
      );
      expect(file.text, `${file.path} must not import provider SDK`).not.toMatch(
        /from\s+'(openai|@anthropic-ai\/sdk|@google\/generative-ai|ollama)'/,
      );
    }
  });

  it('agent-cognition 的 prompts/ 只被自身索引外的执行器引用，index 不外泄 prompts', () => {
    expect(cognitionSources.length).toBeGreaterThan(0);
    const index = cognitionSources.find((file) => file.path.endsWith('src/index.ts'));
    if (index === undefined) throw new Error('agent-cognition index not found');
    expect(index.text).not.toMatch(/prompts\//);
    expect(index.text).not.toMatch(/Prompt/);

    const promptFiles = cognitionSources.filter((file) => file.path.includes('prompts/'));
    expect(promptFiles.length).toBeGreaterThan(0);
    expect(promptFiles.every((file) => file.path.startsWith('packages/agent-cognition/src/prompts/'))).toBe(true);
  });

  it('agent-cognition 不依赖 persistence / event-system / organization-model / runtime-state / agent-runtime', () => {
    for (const file of cognitionSources) {
      expect(file.text, `${file.path} must stay inside the agent-cognition allowed list`).not.toMatch(
        /@maoeh\/(persistence|event-system|event-store|organization-model|runtime-state|agent-runtime|agent-communication|permission-system|agent-memory)\b/,
      );
    }
  });

  it('闭合 Action Space：ACTIONS 无重复且覆盖运行时动作（ADR-011）', () => {
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length);
    expect(ACTIONS).toContain('UpdatePresence');
    expect(ACTIONS).toContain('AcceptTask');
    expect(ACTIONS).toContain('InvokeTool');
    expect(ACTIONS).toContain('Speak');
  });
});
