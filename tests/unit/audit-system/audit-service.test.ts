import { describe, expect, it } from 'vitest';
import type { AuditRecord } from '@maoeh/audit-system';
import {
  AUDIT_VERDICTS,
  createAuditService,
  createInMemoryAuditStore,
} from '@maoeh/audit-system';

type AuditInput = Omit<AuditRecord, 'auditId'>;

const baseInput: AuditInput = {
  actorKind: 'employee',
  actorId: 'engineer-mike',
  action: { type: 'CompleteTask', reason: 'plan authorized', resource: 'task:task-1' },
  target: { targetType: 'task', targetId: 'task-1' },
  verdict: 'accepted',
  commandId: 'cmd-1',
  correlationId: 'corr-1',
  causationId: null,
  resultCode: null,
  eventIds: ['event-1'],
  createdAtSim: 10,
  details: { cycleId: 'cycle-1' },
};

function auditInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return Object.assign({ ...baseInput }, overrides);
}

describe('audit-system：append 与不可变性', () => {
  it('默认 auditId 为 audit-N 序列，record 结果可直接读回', () => {
    const service = createAuditService();
    const first = service.record(auditInput());
    const second = service.record(auditInput({ commandId: 'cmd-2' }));
    expect(first.auditId).toBe('audit-1');
    expect(second.auditId).toBe('audit-2');
    expect(service.find('cmd-1')).toBe(first);
    expect(service.trail('task-1')).toEqual([first, second]);
  });

  it('auditIdGenerator 可注入（覆盖默认序列）', () => {
    let next = 0;
    const service = createAuditService({
      auditIdGenerator: () => {
        next += 1;
        return `custom-${next}`;
      },
    });
    expect(service.record(auditInput()).auditId).toBe('custom-1');
    expect(service.record(auditInput({ commandId: 'cmd-2' })).auditId).toBe('custom-2');
  });

  it('record 深冻结：顶层与 action/target/eventIds/details 嵌套对象', () => {
    const service = createAuditService();
    const details = { trace: { spanId: 'span-1', tags: ['act'] }, attempts: 2 };
    const record = service.record(
      auditInput({ eventIds: ['event-1', 'event-2'], details }),
    );
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.action)).toBe(true);
    expect(Object.isFrozen(record.target)).toBe(true);
    expect(Object.isFrozen(record.eventIds)).toBe(true);
    expect(Object.isFrozen(record.details)).toBe(true);
    expect(Object.isFrozen(record.details.trace)).toBe(true);
    expect(Object.isFrozen((record.details.trace as { tags: string[] }).tags)).toBe(true);
    details.attempts = 3;
    expect(record.details.attempts).toBe(2);
    expect(() => {
      (record as unknown as { verdict: string }).verdict = 'rejected';
    }).toThrow();
    expect(record.verdict).toBe('accepted');
  });

  it('直接 append 的原始记录同样被冻结（append-only 不可篡改）', () => {
    const store = createInMemoryAuditStore();
    const raw: AuditRecord = { auditId: 'audit-raw', ...auditInput() };
    store.append(raw);
    expect(Object.isFrozen(raw)).toBe(true);
    expect(Object.isFrozen(raw.action)).toBe(true);
    expect(Object.isFrozen(store.byCommandId('cmd-1'))).toBe(true);
  });

  it('返回集合为冻结快照，store 内部顺序不受外部影响', () => {
    const service = createAuditService();
    service.record(auditInput());
    const snapshot = service.query({});
    expect(Object.isFrozen(snapshot)).toBe(true);
    service.record(auditInput({ commandId: 'cmd-2' }));
    expect(snapshot).toHaveLength(1);
    expect(service.query({})).toHaveLength(2);
  });
});

describe('audit-system：byCommandId 首条命中（幂等查询）', () => {
  it('同一 commandId 多条记录 → find 返回首条（拒绝结果不被重试覆盖）', () => {
    const store = createInMemoryAuditStore();
    const service = createAuditService({ store });
    service.record(auditInput({ verdict: 'rejected', resultCode: 'DENIED' }));
    service.record(auditInput({ verdict: 'accepted', resultCode: null }));
    expect(service.find('cmd-1')?.verdict).toBe('rejected');
    expect(store.byCommandId('cmd-1')?.resultCode).toBe('DENIED');
    expect(store.byCommandId('cmd-unknown')).toBeNull();
    expect(service.find('cmd-unknown')).toBeNull();
  });
});

describe('audit-system：query 过滤与 limit', () => {
  const service = createAuditService();
  service.record(auditInput({ commandId: 'cmd-1', createdAtSim: 1 }));
  service.record(
    auditInput({
      commandId: 'cmd-2',
      actorId: 'cto-john',
      verdict: 'rejected',
      target: { targetType: 'task', targetId: 'task-2' },
      createdAtSim: 2,
    }),
  );
  service.record(
    auditInput({
      commandId: 'cmd-3',
      actorKind: 'system',
      actorId: null,
      correlationId: 'corr-2',
      verdict: 'failed',
      createdAtSim: 3,
    }),
  );

  it('单条件过滤：actorId / commandId / targetId / correlationId / verdict', () => {
    const ids = (q: Parameters<typeof service.query>[0]): string[] =>
      service.query(q).map((record) => record.commandId);
    expect(ids({ actorId: 'engineer-mike' })).toEqual(['cmd-1']);
    expect(ids({ actorId: 'no-such-actor' })).toEqual([]);
    expect(ids({ commandId: 'cmd-2' })).toEqual(['cmd-2']);
    expect(ids({ commandId: 'cmd-3' })).toEqual(['cmd-3']);
    expect(ids({ targetId: 'task-1' })).toEqual(['cmd-1', 'cmd-3']);
    expect(ids({ correlationId: 'corr-2' })).toEqual(['cmd-3']);
    expect(ids({ verdict: 'failed' })).toEqual(['cmd-3']);
  });

  it('组合过滤后再应用 limit；limit 0 → 空；缺省 limit → 全部匹配', () => {
    const ids = (q: Parameters<typeof service.query>[0]): string[] =>
      service.query(q).map((record) => record.commandId);
    expect(ids({ correlationId: 'corr-1', verdict: 'rejected' })).toEqual(['cmd-2']);
    expect(ids({ correlationId: 'corr-1', verdict: 'failed' })).toEqual([]);
    expect(ids({ limit: 2 })).toEqual(['cmd-1', 'cmd-2']);
    expect(ids({ targetId: 'task-1', limit: 1 })).toEqual(['cmd-1']);
    expect(ids({ limit: 0 })).toEqual([]);
    expect(service.query({})).toHaveLength(3);
  });
});

describe('audit-system：maxRecords 保留策略', () => {
  it('service maxRecords 超限 → 淘汰最旧记录', () => {
    const service = createAuditService({ maxRecords: 2 });
    service.record(auditInput({ commandId: 'cmd-1' }));
    service.record(auditInput({ commandId: 'cmd-2' }));
    service.record(auditInput({ commandId: 'cmd-3' }));
    expect(service.recent().map((record) => record.commandId)).toEqual(['cmd-3', 'cmd-2']);
    expect(service.find('cmd-1')).toBeNull();
    expect(service.query({})).toHaveLength(2);
  });

  it('注入 store 时由 store 保留策略兜底（maxRecords: 2）', () => {
    const store = createInMemoryAuditStore({ maxRecords: 2 });
    const service = createAuditService({ store });
    service.record(auditInput({ commandId: 'cmd-1' }));
    service.record(auditInput({ commandId: 'cmd-2' }));
    service.record(auditInput({ commandId: 'cmd-3' }));
    expect(store.size()).toBe(2);
    expect(store.all().map((record) => record.auditId)).toEqual(['audit-2', 'audit-3']);
    expect(store.byCommandId('cmd-1')).toBeNull();
  });

  it('默认上限 5000：第 5001 条淘汰最旧', () => {
    const store = createInMemoryAuditStore();
    const service = createAuditService({ store });
    for (let index = 0; index < 5001; index += 1) {
      service.record(auditInput({ commandId: `cmd-${index}`, createdAtSim: index }));
    }
    expect(store.size()).toBe(5000);
    expect(store.byCommandId('cmd-0')).toBeNull();
    expect(store.byCommandId('cmd-1')).not.toBeNull();
    expect(store.byCommandId('cmd-5000')?.createdAtSim).toBe(5000);
  });
});

describe('audit-system：trail / recent / forCorrelation', () => {
  it('trail 保持时间序；forCorrelation 按 correlationId 过滤', () => {
    const service = createAuditService();
    service.record(auditInput({ commandId: 'cmd-a', correlationId: 'corr-x' }));
    service.record(auditInput({ commandId: 'cmd-b', correlationId: 'corr-y' }));
    service.record(
      auditInput({
        commandId: 'cmd-c',
        correlationId: 'corr-x',
        target: { targetType: 'task', targetId: 'task-2' },
      }),
    );
    expect(service.trail('task-1').map((record) => record.commandId)).toEqual(['cmd-a', 'cmd-b']);
    expect(service.trail('task-unknown')).toEqual([]);
    expect(service.forCorrelation('corr-x').map((record) => record.commandId)).toEqual([
      'cmd-a',
      'cmd-c',
    ]);
    expect(service.forCorrelation('corr-unknown')).toEqual([]);
  });

  it('recent 最新在前；缺省为全部；limit 0 → 空', () => {
    const service = createAuditService();
    service.record(auditInput({ commandId: 'cmd-1', createdAtSim: 1 }));
    service.record(auditInput({ commandId: 'cmd-2', createdAtSim: 2 }));
    service.record(auditInput({ commandId: 'cmd-3', createdAtSim: 3 }));
    expect(service.recent(2).map((record) => record.commandId)).toEqual(['cmd-3', 'cmd-2']);
    expect(service.recent().map((record) => record.commandId)).toEqual([
      'cmd-3',
      'cmd-2',
      'cmd-1',
    ]);
    expect(service.recent(0)).toEqual([]);
    expect(service.recent(99)).toHaveLength(3);
  });

  it('AUDIT_VERDICTS 常量与判定值取值集合一致', () => {
    expect(AUDIT_VERDICTS).toEqual(['accepted', 'rejected', 'failed']);
    for (const verdict of AUDIT_VERDICTS) {
      const service = createAuditService();
      expect(service.record(auditInput({ verdict })).verdict).toBe(verdict);
    }
  });
});
