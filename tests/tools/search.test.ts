import { describe, it, expect } from "bun:test";
import { handleSearch } from "../../src/tools/search.js";
import { VECTOR_DIM } from "../../src/constants.js";
import type { VectorStore, EmbeddingClient, SearchResult } from "../../src/types.js";

const mockResults: SearchResult[] = [
  { id: "a::0", content: "auth uses JWT", source: "auth.ts", module: "auth", score: 0.95 },
  { id: "b::0", content: "billing stripe", source: "billing.ts", module: "billing", score: 0.80 },
];

function makeMockStore(results: SearchResult[] = mockResults): VectorStore {
  return {
    ensureTable: async () => {},
    upsert: async () => {},
    search: async () => results,
    deleteBySource: async () => {},
    listModules: async () => ["auth", "billing"],
    getModuleChunks: async () => [],
    countChunks: async () => 10,
    optimize: async () => {},
  };
}

function makeMockEmbeddings(available = true): EmbeddingClient {
  return {
    embed: async (texts) =>
      available ? texts.map(() => new Array(VECTOR_DIM).fill(0.1)) : null,
    isAvailable: async () => available,
  };
}

describe("search_context tool", () => {
  it("returns search results on success", async () => {
    const result = await handleSearch(
      { project: "demo", query: "auth flow", limit: 10 },
      { store: makeMockStore(), embeddings: makeMockEmbeddings() }
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.results.length).toBe(2);
    expect(data.results[0].source).toBe("auth.ts");
    expect(data.results[0].score).toBe(0.95);
  });

  it("returns isError when embeddings unavailable", async () => {
    const result = await handleSearch(
      { project: "demo", query: "anything" },
      { store: makeMockStore(), embeddings: makeMockEmbeddings(false) }
    );
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("unavailable");
  });

  it("returns empty results for non-existent project", async () => {
    const result = await handleSearch(
      { project: "ghost", query: "test" },
      { store: makeMockStore([]), embeddings: makeMockEmbeddings() }
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.results).toEqual([]);
  });

  it("respects limit param", async () => {
    const store = makeMockStore();
    const searchSpy = { calledWith: null as any };
    store.search = async (_project, _vector, topK) => {
      searchSpy.calledWith = topK;
      return mockResults.slice(0, topK);
    };

    await handleSearch(
      { project: "demo", query: "test", limit: 1 },
      { store, embeddings: makeMockEmbeddings() }
    );
    expect(searchSpy.calledWith).toBe(1);
  });
});
