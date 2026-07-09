import { describe, it, expect } from "bun:test";
import { handleForget } from "../../src/tools/forget.js";
import { VECTOR_DIM } from "../../src/constants.js";
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
      batchReplace: async () => {},
      buildIndexes: async () => {},
      hybridSearch: async () => [],
      getChunkById: async () => null,
      assertDim: async () => {},
  };
  return store;
}

const mockEmbeddings: EmbeddingClient = {
  dim: VECTOR_DIM,
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

  it("asks confirmDestructive when present and aborts on false", async () => {
    let deleted = false, asked = "";
    const deps = {
      store: { deleteBySource: async () => { deleted = true; } },
      confirmDestructive: async (msg: string) => { asked = msg; return false; },
    } as any;
    const r = await handleForget({ project: "p", source: "notes.md" }, deps);
    expect(asked).toContain("notes.md");
    expect(deleted).toBe(false);
    expect((r.structuredContent as any).status).toBe("cancelled");
    expect(r.isError).toBeFalsy(); // decline is not an error
  });

  it("proceeds when confirmDestructive returns true", async () => {
    let deleted = false;
    const deps = {
      store: { deleteBySource: async () => { deleted = true; } },
      confirmDestructive: async () => true,
    } as any;
    const r = await handleForget({ project: "p", source: "s" }, deps);
    expect(deleted).toBe(true);
    expect((r.structuredContent as any).status).toBe("deleted");
  });

  it("proceeds without asking when confirmDestructive is absent (no capability)", async () => {
    let deleted = false;
    const deps = { store: { deleteBySource: async () => { deleted = true; } } } as any;
    await handleForget({ project: "p", source: "s" }, deps);
    expect(deleted).toBe(true);
  });
});
