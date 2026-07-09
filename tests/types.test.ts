import { describe, it, expect } from "bun:test";
import type {
  VectorStore,
  EmbeddingClient,
  Chunk,
  SearchResult,
  ToolDeps,
} from "../src/types.js";
import {
  VECTOR_DIM,
  EMBEDDING_MODEL,
  DB_PATH,
  TABLE_SUFFIX,
  OLLAMA_HOST,
  HEALTH_COOLDOWN_MS,
} from "../src/constants.js";

describe("types", () => {
  it("exports all interfaces (compile-time check)", () => {
    const chunk: Chunk = {
      id: "test::0",
      vector: new Array(768).fill(0),
      content: "hello",
      source: "test.md",
      module: "core",
      content_hash: "abc123",
      updated_at: Date.now(),
    };

    const result: SearchResult = {
      id: "test::0",
      content: "hello",
      source: "test.md",
      module: "core",
      score: 0.95,
    };

    expect(chunk.id).toBe("test::0");
    expect(result.score).toBe(0.95);
  });

  it("ToolDeps composes VectorStore + EmbeddingClient", () => {
    const mockStore: VectorStore = {
      ensureTable: async () => {},
      upsert: async () => {},
      search: async () => [],
      deleteBySource: async () => {},
      listModules: async () => [],
      getModuleChunks: async () => [],
      countChunks: async () => 0,
      optimize: async () => {},
      batchReplace: async () => {},
      buildIndexes: async () => {},
      hybridSearch: async () => [],
      getChunkById: async () => null,
      assertDim: async () => {},
    };

    const mockEmbeddings: EmbeddingClient = {
      dim: VECTOR_DIM,
      embed: async () => null,
      isAvailable: async () => false,
    };

    const deps: ToolDeps = {
      store: mockStore,
      embeddings: mockEmbeddings,
    };

    expect(deps.store).toBeDefined();
    expect(deps.embeddings).toBeDefined();
  });
});

describe("Chunk symbol metadata", () => {
  it("carries symbol fields", () => {
    const c: Chunk = {
      id: "h-0", vector: [0], content: "x", source: "a.ts", module: "src",
      content_hash: "h", updated_at: 1,
      symbol_name: "handleSearch", symbol_kind: "function",
      signature: "async function handleSearch(args, deps)",
      start_line: 18, end_line: 41,
    };
    expect(c.symbol_name).toBe("handleSearch");
  });

  it("SearchResult exposes symbol + signature + chunk_id", () => {
    const r: SearchResult = {
      id: "h-0", content: "x", source: "a.ts", module: "src", score: 0.9,
      symbol_name: "handleSearch", signature: "async function handleSearch(args, deps)",
      start_line: 18, end_line: 41,
    };
    expect(r.signature).toContain("handleSearch");
  });

  it("accepts non-TS DECL_KINDS vocabulary (struct/impl/trait) emitted by extractBoundaries for Rust/C/C#", () => {
    const c: Chunk = {
      id: "h-0", vector: [0], content: "x", source: "lib.rs", module: "src",
      content_hash: "h", updated_at: 1,
      symbol_name: "MyStruct", symbol_kind: "struct",
      signature: "struct MyStruct", start_line: 1, end_line: 5,
    };
    expect(c.symbol_kind).toBe("struct");

    // Mirrors sync.ts's `raw.symbol_kind as SymbolKind` flow — a raw string
    // kind coming out of parser.ts's RawChunk cast into a Chunk field.
    const rawKind: string = "impl";
    const asserted = rawKind as import("../src/types.js").SymbolKind;
    const traitChunk: Chunk = {
      id: "h-1", vector: [0], content: "y", source: "lib.rs", module: "src",
      content_hash: "h", updated_at: 1,
      symbol_kind: asserted,
    };
    expect(traitChunk.symbol_kind).toBe("impl");
  });
});

describe("VectorStore.getChunksByIds", () => {
  it("VectorStore.getChunksByIds is optional — a minimal store without it still type-checks", () => {
    const minimal: VectorStore = {
      ensureTable: async () => {},
      upsert: async () => {},
      batchReplace: async () => {},
      search: async () => [],
      deleteBySource: async () => {},
      listModules: async () => [],
      getModuleChunks: async () => [],
      countChunks: async () => 0,
      optimize: async () => {},
      buildIndexes: async () => {},
      hybridSearch: async () => [],
      getChunkById: async () => null,
      assertDim: async () => {},
    };
    expect(minimal.getChunksByIds).toBeUndefined();
  });
});

describe("constants", () => {
  it("exports all required constants", () => {
    expect(VECTOR_DIM).toBe(768);
    expect(EMBEDDING_MODEL).toBe("nomic-embed-text");
    expect(DB_PATH).toContain(".project-brain");
    expect(TABLE_SUFFIX).toBe("_chunks");
    expect(OLLAMA_HOST).toBe("http://127.0.0.1:11434");
    expect(HEALTH_COOLDOWN_MS).toBe(30_000);
  });
});
