import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultEventLogPath,
  ownershipStorePath,
  resolveEventLogPath,
  resolveOwnershipStorePath,
} from '../../../apps/api/src/composition';

/**
 * Where the company lives between restarts.
 *
 * This is a regression test with a specific history: the state directory used to sit inside the
 * checkout (`.maoeh/`), where a `pnpm install` purge, a `git clean`, deleting the checkout — or a
 * developer tidying the working tree — could destroy every agent an operator had hired. The path
 * must therefore resolve *outside* the repository, and the in-memory opt-outs must keep working
 * for tests and the e2e.
 */

const originalValue = process.env['MAOEH_EVENT_LOG'];
const originalOwnership = process.env['MAOEH_OWNERSHIP'];

afterEach(() => {
  if (originalValue === undefined) delete process.env['MAOEH_EVENT_LOG'];
  else process.env['MAOEH_EVENT_LOG'] = originalValue;
  if (originalOwnership === undefined) delete process.env['MAOEH_OWNERSHIP'];
  else process.env['MAOEH_OWNERSHIP'] = originalOwnership;
});

describe('公司状态的存放位置（事件日志路径解析）', () => {
  it('默认落在仓库之外的用户状态目录，含公司名与 events.jsonl', () => {
    delete process.env['MAOEH_EVENT_LOG'];
    const path = resolveEventLogPath(undefined);
    expect(path).toBe(defaultEventLogPath());
    expect(path).not.toBeNull();
    if (path === null) return;

    const repositoryRoot = process.cwd().toLowerCase();
    expect(
      path.toLowerCase().startsWith(repositoryRoot),
      `默认日志路径不能落在仓库内：${path}`,
    ).toBe(false);
    expect(path).toContain('future-ai-lab');
    expect(path.endsWith('events.jsonl')).toBe(true);
  });

  it('MAOEH_EVENT_LOG 覆盖路径；off / memory / 空值 = 纯内存运行', () => {
    process.env['MAOEH_EVENT_LOG'] = 'off';
    expect(resolveEventLogPath(undefined)).toBeNull();
    process.env['MAOEH_EVENT_LOG'] = 'memory';
    expect(resolveEventLogPath(undefined)).toBeNull();
    process.env['MAOEH_EVENT_LOG'] = '   ';
    expect(resolveEventLogPath(undefined)).toBeNull();

    process.env['MAOEH_EVENT_LOG'] = './state/events.jsonl';
    expect(resolveEventLogPath(undefined)).toBe(resolve('./state/events.jsonl'));
  });

  it('显式参数优先于环境变量（null = 强制内存）', () => {
    process.env['MAOEH_EVENT_LOG'] = '/tmp/from-env.jsonl';
    expect(resolveEventLogPath(null)).toBeNull();
    expect(resolveEventLogPath('/tmp/explicit.jsonl')).toBe('/tmp/explicit.jsonl');
  });
});

/**
 * M1.5：所有权记录（谁拥有哪家公司）与事件日志同一条规则 —— 默认在仓库之外的用户状态目录，
 * `MAOEH_OWNERSHIP` 可覆盖，而**显式 eventLogPath = 隔离运行**，此时所有权记录也必须隔离，
 * 否则一个测试会把公司写进开发者自己的 `companies.json`。
 */
describe('所有权记录的存放位置（M1.5）', () => {
  it('默认与事件日志同规则：仓库之外的状态目录下的 companies.json', () => {
    delete process.env['MAOEH_OWNERSHIP'];
    const path = resolveOwnershipStorePath(undefined);
    expect(path).toBe(ownershipStorePath());
    expect(path).not.toBeNull();
    if (path === null) return;
    expect(path.toLowerCase().startsWith(process.cwd().toLowerCase())).toBe(false);
    expect(path.endsWith('companies.json')).toBe(true);
  });

  it('MAOEH_OWNERSHIP 覆盖路径；off / memory / 空值 = 纯内存记录', () => {
    process.env['MAOEH_OWNERSHIP'] = 'off';
    expect(resolveOwnershipStorePath(undefined)).toBeNull();
    process.env['MAOEH_OWNERSHIP'] = 'memory';
    expect(resolveOwnershipStorePath(undefined)).toBeNull();
    process.env['MAOEH_OWNERSHIP'] = '   ';
    expect(resolveOwnershipStorePath(undefined)).toBeNull();

    process.env['MAOEH_OWNERSHIP'] = './state/companies.json';
    expect(resolveOwnershipStorePath(undefined)).toBe(resolve('./state/companies.json'));
  });

  it('显式 eventLogPath 意味着隔离运行：所有权记录跟着一起隔离', () => {
    process.env['MAOEH_OWNERSHIP'] = join(tmpdir(), 'real-companies.json');
    expect(resolveOwnershipStorePath(null)).toBeNull();
    expect(resolveOwnershipStorePath(join(tmpdir(), 'isolated', 'events.jsonl'))).toBeNull();
    expect(resolveOwnershipStorePath(undefined)).toBe(join(tmpdir(), 'real-companies.json'));
  });
});
