import { describe, it, expect } from "bun:test";
import { handleIngest } from "../../src/tools/ingest.js";
import { VECTOR_DIM } from "../../src/constants.js";
import type { VectorStore, EmbeddingClient, Chunk } from "../../src/types.js";

function makeMockStore(): VectorStore & { upserted: Chunk[] } {
  const store = {
    upserted: [] as Chunk[],
    ensureTable: async () => {},
    upsert: async (_project: string, chunks: Chunk[]) => {
      store.upserted.push(...chunks);
    },
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
  return store;
}

function makeMockEmbeddings(available = true): EmbeddingClient {
  return {
    embed: async (texts) =>
      available ? texts.map(() => new Array(VECTOR_DIM).fill(0.1)) : null,
    isAvailable: async () => available,
  };
}

describe("add_knowledge tool", () => {
  it("embeds content, generates deterministic ID, and upserts", async () => {
    const store = makeMockStore();
    const result = await handleIngest(
      { project: "demo", content: "JWT auth flow", source: "auth.md", module: "auth" },
      { store, embeddings: makeMockEmbeddings() }
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBeDefined();
    expect(data.source).toBe("auth.md");
    expect(store.upserted.length).toBe(1);
    expect(store.upserted[0].content).toBe("JWT auth flow");
  });

  it("returns isError when embeddings unavailable", async () => {
    const store = makeMockStore();
    const result = await handleIngest(
      { project: "demo", content: "test", source: "x.md", module: "core" },
      { store, embeddings: makeMockEmbeddings(false) }
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("unavailable");
    expect(store.upserted.length).toBe(0);
  });

  it("generates ID from source + content hash (deterministic)", async () => {
    const store = makeMockStore();
    await handleIngest(
      { project: "demo", content: "hello", source: "test.md", module: "core" },
      { store, embeddings: makeMockEmbeddings() }
    );

    // Same input should produce same ID
    const store2 = makeMockStore();
    await handleIngest(
      { project: "demo", content: "hello", source: "test.md", module: "core" },
      { store: store2, embeddings: makeMockEmbeddings() }
    );

    expect(store.upserted[0].id).toBe(store2.upserted[0].id);
  });
});
