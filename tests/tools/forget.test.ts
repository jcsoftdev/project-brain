import { describe, it, expect } from "bun:test";
import { handleForget } from "../../src/tools/forget.js";
import type { VectorStore, EmbeddingClient, Chunk } from "../../src/types.js";

function makeMockStore(chunksWithSource: number = 3): VectorStore & { deletedSource: string | null } {
  const store = {
    deletedSource: null as string | null,
    ensureTable: async () => {},
    upsert: async () => {},
    search: async () => [],
    deleteBySource: async (_project: string, source: string) => {
      store.deletedSource = source;
    },
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async () => chunksWithSource,
    optimize: async () => {},
  };
  return store;
}

const mockEmbeddings: EmbeddingClient = {
  embed: async () => null,
  isAvailable: async () => false,
};

describe("delete_knowledge tool", () => {
  it("deletes all chunks matching source", async () => {
    const store = makeMockStore(3);
    const result = await handleForget(
      { project: "demo", source: "old-docs.md" },
      { store, embeddings: mockEmbeddings }
    );
    expect(result.isError).toBeFalsy();
    expect(store.deletedSource).toBe("old-docs.md");
    const data = JSON.parse(result.content[0].text);
    expect(data.source).toBe("old-docs.md");
    expect(data.status).toBe("deleted");
  });

  it("returns successfully for non-existent source", async () => {
    const store = makeMockStore(0);
    const result = await handleForget(
      { project: "demo", source: "ghost.md" },
      { store, embeddings: mockEmbeddings }
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.source).toBe("ghost.md");
    expect(data.status).toBe("deleted");
  });

  it("works without embeddings", async () => {
    const store = makeMockStore();
    const result = await handleForget(
      { project: "demo", source: "test.md" },
      { store, embeddings: mockEmbeddings }
    );
    expect(result.isError).toBeFalsy();
  });
});
