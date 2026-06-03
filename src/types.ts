/** A chunk of knowledge stored in the vector database. */
export interface Chunk {
  id: string;
  vector: number[];
  content: string;
  source: string;
  module: string;
  content_hash: string;
  updated_at: number;
}

/** A search result with normalized similarity score. */
export interface SearchResult {
  id: string;
  content: string;
  source: string;
  module: string;
  score: number;
}

/** Embedding client contract — returns null on failure for graceful degradation. */
export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][] | null>;
  isAvailable(): Promise<boolean>;
}

/** Vector store contract — all operations are project-namespaced. */
export interface VectorStore {
  ensureTable(project: string): Promise<void>;
  upsert(project: string, chunks: Chunk[]): Promise<void>;
  /** Delete all sources then add all chunks in ONE table.add() — minimizes fragments. */
  batchReplace(project: string, sources: string[], chunks: Chunk[]): Promise<void>;
  search(project: string, vector: number[], topK: number): Promise<SearchResult[]>;
  deleteBySource(project: string, source: string): Promise<void>;
  listModules(project: string): Promise<string[]>;
  getModuleChunks(project: string, module: string): Promise<Chunk[]>;
  countChunks(project: string): Promise<number>;
  /** Compact fragments and release memory. Call after bulk writes. */
  optimize(project: string): Promise<void>;
}

/** Dependencies injected into MCP tool handlers. */
export interface ToolDeps {
  store: VectorStore;
  embeddings: EmbeddingClient;
}
