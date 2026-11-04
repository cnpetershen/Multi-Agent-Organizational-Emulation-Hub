import { describe, expect, it } from 'vitest';
import { cruise } from 'dependency-cruiser';
import ruleSet from '../../.dependency-cruiser.mjs';

describe('dependency-cruiser: F1-F12 + 环禁令（全仓 0 违规）', () => {
  it('cruise(".") 退出码为 0', async () => {
    const result = await cruise(
      ['.'],
      { ruleSet, validate: true, outputType: 'err-long' },
      {},
      {},
    );

    expect(result.exitCode, result.output).toBe(0);
  });
});
