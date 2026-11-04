import { describe, expect, it } from 'vitest';
import type { ArtifactRecord } from '@maoeh/artifact-system';
import { createInMemoryArtifactStore } from '@maoeh/artifact-system';

const baseArtifact: ArtifactRecord = {
  artifactId: 'artifact-1',
  companyId: 'future-ai-lab',
  kind: 'document',
  name: 'release-notes.md',
  producedBy: 'engineer-mike',
  taskId: 'task-1',
  workflowInstanceId: 'wf-1',
  stepId: 'step-2',
  sourceEventId: 'event-9',
  createdAtSim: 120,
  validated: false,
};

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return Object.assign({ ...baseArtifact }, overrides);
}

describe('artifact-system：put / get / all', () => {
  it('put 后 get 读回；未知 artifactId → null；all() 保持插入序', () => {
    const store = createInMemoryArtifactStore();
    store.put(artifact());
    store.put(artifact({ artifactId: 'artifact-2', name: 'design.pdf', kind: 'design' }));
    expect(store.get('artifact-1')?.name).toBe('release-notes.md');
    expect(store.get('artifact-2')?.kind).toBe('design');
    expect(store.get('artifact-unknown')).toBeNull();
    expect(store.all().map((record) => record.artifactId)).toEqual(['artifact-1', 'artifact-2']);
  });

  it('put 同 id 覆盖元数据（校验状态可更新）；记录冻结', () => {
    const store = createInMemoryArtifactStore();
    store.put(artifact());
    store.put(artifact({ validated: true, kind: 'release-notes' }));
    expect(store.all()).toHaveLength(1);
    expect(store.get('artifact-1')?.validated).toBe(true);
    expect(store.get('artifact-1')?.kind).toBe('release-notes');
    const stored = store.get('artifact-1');
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(store.all())).toBe(true);
    expect(() => {
      (stored as unknown as { name: string }).name = 'tampered';
    }).toThrow();
    expect(store.get('artifact-1')?.name).toBe('release-notes.md');
  });

  it('store 工厂实例隔离：新建 store 为空', () => {
    const first = createInMemoryArtifactStore();
    first.put(artifact());
    const second = createInMemoryArtifactStore();
    expect(second.all()).toEqual([]);
    expect(second.get('artifact-1')).toBeNull();
  });
});

describe('artifact-system：provenanceOf 溯源链', () => {
  const store = createInMemoryArtifactStore();
  store.put(artifact());

  it('按 [taskId, workflowInstanceId, stepId, sourceEventId] 顺序返回全部引用', () => {
    expect(store.provenanceOf('artifact-1')).toEqual(['task-1', 'wf-1', 'step-2', 'event-9']);
  });

  it('null 字段跳过，剩余引用保持规定顺序', () => {
    store.put(
      artifact({
        artifactId: 'artifact-partial',
        taskId: null,
        workflowInstanceId: 'wf-7',
        stepId: null,
        sourceEventId: 'event-42',
      }),
    );
    expect(store.provenanceOf('artifact-partial')).toEqual(['wf-7', 'event-42']);
  });

  it('全部来源为空 → 空数组；未知 artifactId → 空数组', () => {
    store.put(
      artifact({
        artifactId: 'artifact-orphan',
        taskId: null,
        workflowInstanceId: null,
        stepId: null,
        sourceEventId: null,
      }),
    );
    expect(store.provenanceOf('artifact-orphan')).toEqual([]);
    expect(store.provenanceOf('artifact-unknown')).toEqual([]);
  });
});
