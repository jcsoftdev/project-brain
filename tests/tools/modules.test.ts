import { describe, it, expect } from "bun:test";
import { handleListModules, handleGetModule } from "../../src/tools/modules.js";
import { VECTOR_DIM } from "../../src/constants.js";
import type { VectorStore, EmbeddingClient, Chunk } from "../../src/types.js";

function makeMockStore(modules: string[] = ["api", "auth", "core"], chunks: Chunk[] = []): VectorStore {
  return {
    ensureTable: async () => {},
    upsert: async () => {},
    search: async () => [],
    deleteBySource: async () => {},
    listModules: async () => modules,
    getModuleChunks: async (_project, _module) => chunks,
    countChunks: async () => chunks.length,
    optimize: async () => {},
      batchReplace: async () => {},
      buildIndexes: async () => {},
      hybridSearch: async () => [],
      getChunkById: async () => null,
      assertDim: async () => {},
  };
}

const mockEmbeddings: EmbeddingClient = {
  dim: VECTOR_DIM,
  embed: async () => null,
  isAvailable: async () => false,
};

describe("list_modules tool", () => {
  it("returns sorted deduplicated module names", async () => {
    const result = await handleListModules(
      { project: "demo" },
      { store: makeMockStore(["auth", "core", "api"]), embeddings: mockEmbeddings }
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.modules).toEqual(["auth", "core", "api"]);
  });

  it("returns empty for non-existent project", async () => {
    const result = await handleListModules(
      { project: "ghost" },
      { store: makeMockStore([]), embeddings: mockEmbeddings }
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.modules).toEqual([]);
  });

  it("works without embeddings", async () => {
    const result = await handleListModules(
      { project: "demo" },
      { store: makeMockStore(), embeddings: mockEmbeddings }
    );
    expect(result.isError).toBeFalsy();
  });
});

describe("get_module tool", () => {
  it("returns all chunks for a module ordered by source", async () => {
    const chunks: Chunk[] = [
      { id: "a::0", vector: [], content: "auth logic", source: "a.ts", module: "auth", content_hash: "h1", updated_at: 1 },
      { id: "b::0", vector: [], content: "auth util", source: "b.ts", module: "auth", content_hash: "h2", updated_at: 2 },
    ];
    const result = await handleGetModule(
      { project: "demo", module: "auth" },
      { store: makeMockStore(["auth"], chunks), embeddings: mockEmbeddings }
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.chunks.length).toBe(2);
    expect(data.chunks[0].source).toBe("a.ts");
  });

  it("returns empty for non-existent module", async () => {
    const result = await handleGetModule(
      { project: "demo", module: "payments" },
      { store: makeMockStore([], []), embeddings: mockEmbeddings }
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.chunks).toEqual([]);
  });

  it("works without embeddings", async () => {
    const result = await handleGetModule(
      { project: "demo", module: "core" },
      { store: makeMockStore([], []), embeddings: mockEmbeddings }
    );
    expect(result.isError).toBeFalsy();
  });
});
