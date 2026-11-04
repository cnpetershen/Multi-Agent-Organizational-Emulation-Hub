export interface ArtifactRecord {
  readonly artifactId: string;
  readonly companyId: string;
  readonly kind: string;
  readonly name: string;
  readonly producedBy: string;
  readonly taskId: string | null;
  readonly workflowInstanceId: string | null;
  readonly stepId: string | null;
  readonly sourceEventId: string | null;
  readonly createdAtSim: number;
  readonly validated: boolean;
}

export interface ArtifactStore {
  put(record: ArtifactRecord): void;
  get(artifactId: string): ArtifactRecord | null;
  all(): readonly ArtifactRecord[];
  provenanceOf(artifactId: string): readonly string[];
}
