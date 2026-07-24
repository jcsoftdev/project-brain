// Covers every kind string extractBoundaries/DECL_KINDS (src/parser/extract.ts)
// can emit across all supported languages (function, method, class, interface,
// type, enum, struct, impl, trait), plus the legacy/local-only kinds emitted
// outside cAST: "variable" (legacy splitCode extractSymbol), "section"
// (splitMarkdown), and "unknown" (fallback).
export type SymbolKind =
  | "function" | "method" | "class" | "interface" | "type"
  | "enum" | "struct" | "impl" | "trait"
  | "variable" | "section" | "unknown";

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
  symbol_kind?: SymbolKind;
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
  /**
   * Optional: clear any internal circuit-breaker/failure state so the next
   * embed() attempts the network again immediately, bypassing the cooldown.
   * Intended for ONE deliberate recovery attempt (e.g. sync's sequential
   * fallback after a concurrent-batch overload) — not for routine use, which
   * would defeat the breaker's purpose of not hammering a down backend.
   * Implementations without a breaker (e.g. test fakes) can omit this.
   */
  reset?(): void;
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
  /** Create FTS + vector indexes. Safe to call on existing indexes (no-op).
   * `opts.annMinRows` overrides the row-count threshold that gates vector
   * ANN index creation; `opts.ivfPqOptions` overrides IVF_PQ training params
   * (e.g. for small-data tests where default PQ training would throw). */
  buildIndexes(project: string, opts?: { annMinRows?: number; ivfPqOptions?: Record<string, unknown> }): Promise<void>;
  /** Hybrid lexical + vector search with RRF reranking. Falls back to vector-only on FTS miss. */
  hybridSearch(project: string, vector: number[], text: string, topK: number): Promise<SearchResult[]>;
  /** Fetch a single chunk by its id. Returns null if not found. */
  getChunkById(project: string, id: string): Promise<Chunk | null>;
  /**
   * Batch fetch chunks by id — one round-trip instead of N. OPTIONAL: stores
   * that don't implement it (e.g. minimal test mocks) are unaffected; callers
   * fall back to per-id `getChunkById`. Missing ids are simply absent from the
   * returned map.
   */
  getChunksByIds?(project: string, ids: string[]): Promise<Map<string, Chunk>>;
  /** Throw if the stored table dim doesn't match queryDim. No-op when no metadata exists yet. */
  assertDim(project: string, queryDim: number): Promise<void>;
  /**
   * FTS-only keyword search (BM25, no vector/embeddings involved). OPTIONAL:
   * stores that don't implement it (e.g. minimal test mocks) are unaffected;
   * callers must check for its presence before calling.
   */
  ftsSearch?(project: string, query: string, topK: number): Promise<SearchResult[]>;
  /**
   * List all indexed projects with their chunk counts and meta (model/dim when
   * known). OPTIONAL: stores that don't implement it are unaffected; admin
   * tools return an ADMIN_UNSUPPORTED error result when absent.
   */
  listProjects?(): Promise<Array<{ project: string; chunks: number; model?: string; dim?: number }>>;
  /**
   * Drop a project's vector table + meta file ONLY — never touches any
   * project-local `.project-brain/` directory. Returns false when the
   * project doesn't exist. OPTIONAL: stores that don't implement it are
   * unaffected; admin tools return an ADMIN_UNSUPPORTED error result when
   * absent.
   */
  deleteProject?(project: string): Promise<boolean>;
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
  /**
   * Capability-gated destructive-action confirmation. Wired by server.ts to
   * MCP elicitation when the client declares the capability; absent otherwise
   * (and in older/injected test deps) — absent means proceed without asking.
   */
  confirmDestructive?: (message: string) => Promise<boolean>;
  /**
   * Filesystem root of the served project — the same value server.ts already
   * computes for the graph.db path (`options.projectRoot || process.cwd()`).
   * Absent in older/injected test deps; consumers that need it (get_architecture,
   * sync_project) return a PROJECT_ROOT_UNAVAILABLE error result when missing.
   */
  projectRoot?: string;
  /** Base path to look up per-project last-error state (check_health). Absent → lastError omitted. */
  dbPath?: string;
}
