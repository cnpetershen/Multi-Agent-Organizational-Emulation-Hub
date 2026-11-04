import type { DocumentStore, KnowledgeDocument } from './types.js';

function freezeDocument(doc: KnowledgeDocument): KnowledgeDocument {
  return Object.freeze({ ...doc, tags: Object.freeze([...doc.tags]) });
}

function haystack(doc: KnowledgeDocument): string {
  return [doc.title, doc.body, ...doc.tags].join('\u0000').toLowerCase();
}

export function createInMemoryDocumentStore(): DocumentStore {
  const documents = new Map<string, KnowledgeDocument>();

  return {
    put(doc) {
      documents.set(doc.documentId, freezeDocument(doc));
    },
    get(documentId) {
      return documents.get(documentId) ?? null;
    },
    all() {
      return Object.freeze([...documents.values()]);
    },
    search(query) {
      const needle = query.toLowerCase();
      return Object.freeze([...documents.values()].filter((doc) => haystack(doc).includes(needle)));
    },
    archive(documentId) {
      const doc = documents.get(documentId);
      if (doc === undefined) return false;
      documents.set(documentId, freezeDocument({ ...doc, archived: true }));
      return true;
    },
  };
}
