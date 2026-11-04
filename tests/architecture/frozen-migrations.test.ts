import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const migrationsDir = join(root, 'database/migrations');

const expected = [
  '001_identity.sql',
  '002_organization.sql',
  '003_events.sql',
  '004_memory.sql',
  '005_runtime.sql',
];

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

describe('database/migrations 冻结状态（M0.1 不允许任何 DDL）', () => {
  it('迁移文件集合与冻结基线一致', () => {
    expect(files).toEqual(expected);
  });

  it('所有迁移文件均为 0 字节', () => {
    for (const file of files) {
      expect(statSync(join(migrationsDir, file)).size, file).toBe(0);
    }
  });
});
