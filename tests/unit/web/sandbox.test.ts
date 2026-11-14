import { describe, expect, it } from 'vitest';
import { isSandboxScenario } from '../../../apps/web/src/sandbox';

describe('isSandboxScenario', () => {
  it('recognizes the adversarial sandbox by its own title or goal', () => {
    expect(isSandboxScenario({ title: '赛博沙盘：多角色对抗质询系统' })).toBe(true);
    expect(isSandboxScenario({ title: 'Implementation', goal: '搭建沙盘推演环境，支持多角色在线对抗' })).toBe(true);
    expect(isSandboxScenario({ title: 'Multi-role adversarial review' })).toBe(true);
  });

  it('leaves ordinary deliveries alone', () => {
    expect(isSandboxScenario({ title: 'Product Requirement', goal: 'Write a requirements document' })).toBe(false);
    expect(isSandboxScenario(null, undefined)).toBe(false);
  });
});
