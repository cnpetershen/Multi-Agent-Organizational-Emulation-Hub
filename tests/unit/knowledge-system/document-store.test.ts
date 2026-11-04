import { describe, expect, it } from 'vitest';
import type { KnowledgeDocument } from '@maoeh/knowledge-system';
import { createInMemoryDocumentStore } from '@maoeh/knowledge-system';

const baseDoc: KnowledgeDocument = {
  documentId: 'doc-1',
  companyId: 'future-ai-lab',
  title: 'Release Runbook',
  body: 'Steps to tag the release',
  version: 1,
  tags: ['release', 'ops'],
  createdBy: 'cto-john',
  createdAtSim: 100,
  archived: false,
};

function doc(overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return Object.assign({ ...baseDoc }, overrides);
}

describe('knowledge-system：put / get / all', () => {
  it('put 后 get 读回；未知 documentId → null', () => {
    const store = createInMemoryDocumentStore();
    store.put(doc());
    expect(store.get('doc-1')?.title).toBe('Release Runbook');
    expect(store.get('doc-1')?.companyId).toBe('future-ai-lab');
    expect(store.get('doc-unknown')).toBeNull();
  });

  it('put 同 id 为 upsert：version 递进，all() 长度不变且保持插入序', () => {
    const store = createInMemoryDocumentStore();
    store.put(doc());
    store.put(doc({ version: 2, body: 'Steps to tag the release (v2)' }));
    expect(store.all()).toHaveLength(1);
    expect(store.get('doc-1')?.version).toBe(2);
    expect(store.get('doc-1')?.body).toBe('Steps to tag the release (v2)');
    store.put(doc({ documentId: 'doc-2', title: 'Onboarding' }));
    expect(store.all().map((document) => document.documentId)).toEqual(['doc-1', 'doc-2']);
  });

  it('记录与 tags 冻结（组织知识只读）', () => {
    const store = createInMemoryDocumentStore();
    store.put(doc());
    const stored = store.get('doc-1');
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.tags)).toBe(true);
    expect(Object.isFrozen(store.all())).toBe(true);
    expect(() => {
      (stored as unknown as { title: string }).title = 'tampered';
    }).toThrow();
    expect(store.get('doc-1')?.title).toBe('Release Runbook');
  });

  it('store 工厂实例隔离：新建 store 为空', () => {
    const first = createInMemoryDocumentStore();
    first.put(doc());
    const second = createInMemoryDocumentStore();
    expect(second.all()).toEqual([]);
    expect(second.get('doc-1')).toBeNull();
  });
});

describe('knowledge-system：search（大小写不敏感子串）', () => {
  const store = createInMemoryDocumentStore();
  store.put(doc());
  store.put(doc({ documentId: 'doc-2', title: 'Hiring Plan', body: 'Interview loop', tags: ['people'] }));
  store.put(doc({ documentId: 'doc-3', title: 'Deep Work Guide', body: 'Focus blocks', tags: ['focus'] }));

  it('命中 title / body / tags，大小写不敏感', () => {
    const ids = (query: string): string[] =>
      store.search(query).map((document) => document.documentId);
    expect(ids('runbook')).toEqual(['doc-1']);
    expect(ids('RELEASE')).toEqual(['doc-1']);
    expect(ids('interview')).toEqual(['doc-2']);
    expect(ids('FOCUS')).toEqual(['doc-3']);
    expect(ids('people')).toEqual(['doc-2']);
  });

  it('无匹配 → 空数组；空查询 → 全部文档（插入序）', () => {
    const ids = (query: string): string[] =>
      store.search(query).map((document) => document.documentId);
    expect(store.search('no-such-term')).toEqual([]);
    expect(ids('')).toEqual(['doc-1', 'doc-2', 'doc-3']);
  });
});

describe('knowledge-system：archive', () => {
  it('archive 翻转 archived 标记；未知 id → false；重复归档幂等', () => {
    const store = createInMemoryDocumentStore();
    store.put(doc());
    expect(store.get('doc-1')?.archived).toBe(false);
    expect(store.archive('doc-1')).toBe(true);
    expect(store.get('doc-1')?.archived).toBe(true);
    expect(store.get('doc-1')?.title).toBe('Release Runbook');
    expect(store.archive('doc-1')).toBe(true);
    expect(store.archive('doc-unknown')).toBe(false);
  });

  it('归档为软删除：记录仍在 all() 与 search 中可见', () => {
    const store = createInMemoryDocumentStore();
    store.put(doc());
    store.archive('doc-1');
    expect(store.all()).toHaveLength(1);
    expect(store.search('runbook').map((document) => document.documentId)).toEqual(['doc-1']);
    expect(store.get('doc-1')?.archived).toBe(true);
  });
});
