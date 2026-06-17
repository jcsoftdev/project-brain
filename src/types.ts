export type SymbolKind =
  | "function" | "method" | "class" | "interface" | "type"
  | "enum" | "variable" | "section" | "unknown";

/** A chunk of knowledge stored in the vector database. */
export interface Chunk {
  id: string;
  vector: number[];
  content: string;
  source: string;
  module: string;
  content_hash: string;
  updated_at: number;
  symbol_name?: string;
  symbol_kind?: SymbolKind;
  signature?: string;
  start_line?: number;
  end_line?: number;
}

/** A search result with normalized similarity score. */
export interface SearchResult {
  id: string;
  content: string;
  source: string;
  module: string;
  score: number;
  symbol_name?: string;
  symbol_kind?: string;
  signature?: string;
  start_line?: number;
  end_line?: number;
}

/** Embedding client contract — returns null on failure for graceful degradation. */
export interface EmbeddingClient {
  readonly dim: number;
  readonly model?: string;
  embed(texts: string[]): Promise<number[][] | null>;
  isAvailable(): Promise<boolean>;
}

/** Per-table metadata (model name + vector dim). */
export interface TableMeta { model: string; dim: number; }

/** Vector store contract — all operations are project-namespaced. */
export interface VectorStore {
  ensureTable(project: string, meta?: TableMeta): Promise<void>;
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
  /** Create FTS + vector indexes. Safe to call on existing indexes (no-op). */
  buildIndexes(project: string): Promise<void>;
  /** Hybrid lexical + vector search with RRF reranking. Falls back to vector-only on FTS miss. */
  hybridSearch(project: string, vector: number[], text: string, topK: number): Promise<SearchResult[]>;
  /** Fetch a single chunk by its id. Returns null if not found. */
  getChunkById(project: string, id: string): Promise<Chunk | null>;
  /** Throw if the stored table dim doesn't match queryDim. No-op when no metadata exists yet. */
  assertDim(project: string, queryDim: number): Promise<void>;
}

import type { GraphStore } from "./graph/store.js";

/** Dependencies injected into MCP tool handlers. */
export interface ToolDeps {
  store: VectorStore;
  embeddings: EmbeddingClient;
  /**
   * Per-project embedding resolver. When present, handleSearch uses this to
   * obtain an EmbeddingClient whose model/dim matches the project's indexed table.
   * When absent, handlers fall back to `embeddings` (backward-compatible).
   */
  embeddingsFor?: (project: string) => Promise<EmbeddingClient>;
  /** Structural graph store for exact symbol lookups (find_symbol and related tools). */
  graph?: GraphStore;
}
