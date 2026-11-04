import type { ArtifactRecord, ArtifactStore } from './types.js';

const PROVENANCE_KEYS = ['taskId', 'workflowInstanceId', 'stepId', 'sourceEventId'] as const;

export function createInMemoryArtifactStore(): ArtifactStore {
  const artifacts = new Map<string, ArtifactRecord>();

  return {
    put(record) {
      artifacts.set(record.artifactId, Object.freeze({ ...record }));
    },
    get(artifactId) {
      return artifacts.get(artifactId) ?? null;
    },
    all() {
      return Object.freeze([...artifacts.values()]);
    },
    provenanceOf(artifactId) {
      const record = artifacts.get(artifactId);
      if (record === undefined) return Object.freeze([]);
      const refs: string[] = [];
      for (const key of PROVENANCE_KEYS) {
        const ref = record[key];
        if (ref !== null) refs.push(ref);
      }
      return Object.freeze(refs);
    },
  };
}
