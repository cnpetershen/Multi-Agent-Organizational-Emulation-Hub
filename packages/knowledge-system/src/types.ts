export interface KnowledgeDocument {
  readonly documentId: string;
  readonly companyId: string;
  readonly title: string;
  readonly body: string;
  readonly version: number;
  readonly tags: readonly string[];
  readonly createdBy: string;
  readonly createdAtSim: number;
  readonly archived: boolean;
}

export interface DocumentStore {
  put(doc: KnowledgeDocument): void;
  get(documentId: string): KnowledgeDocument | null;
  all(): readonly KnowledgeDocument[];
  search(query: string): readonly KnowledgeDocument[];
  archive(documentId: string): boolean;
}
