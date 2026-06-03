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
    };

    const mockEmbeddings: EmbeddingClient = {
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
