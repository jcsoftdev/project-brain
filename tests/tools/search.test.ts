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
    hybridSearch: async () => results,
    deleteBySource: async () => {},
    listModules: async () => ["auth", "billing"],
    getModuleChunks: async () => [],
    countChunks: async () => 10,
    optimize: async () => {},
    batchReplace: async () => {},
    buildIndexes: async () => {},
  };
}

function makeMockEmbeddings(available = true): EmbeddingClient {
  return {
    dim: VECTOR_DIM,
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
    expect(data.results.length).toBeGreaterThan(0);
    // new shape: chunk_id + source + score
    expect(data.results[0].chunk_id).toBe("a::0");
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

  it("respects limit param — passes enlarged topK to hybridSearch", async () => {
    const store = makeMockStore();
    const searchSpy = { calledWith: null as any };
    store.hybridSearch = async (_project, _vector, _text, topK) => {
      searchSpy.calledWith = topK;
      return mockResults.slice(0, topK);
    };

    await handleSearch(
      { project: "demo", query: "test", limit: 1 },
      { store, embeddings: makeMockEmbeddings() }
    );
    // limit=1, so topK = Math.max(1*3, 20) = 20
    expect(searchSpy.calledWith).toBe(20);
  });
});

describe("handleSearch adaptive output", () => {
  it("returns snippets with chunk_id, not full bodies + internal id", async () => {
    function deps() {
      return {
        embeddings: { dim: 4, async embed() { return [[0.1, 0.2, 0.3, 0.4]]; }, async isAvailable() { return true; } } as any,
        store: {
          async hybridSearch() {
            return [{ id: "a", content: "function handleSearch() { return 1; }", source: "s.ts", module: "src", score: 0.9, symbol_name: "handleSearch", signature: "function handleSearch()" }];
          },
        } as any,
      } as any;
    }
    const res = await handleSearch({ project: "p", query: "handleSearch" }, deps());
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.results[0].chunk_id).toBe("a");
    expect(parsed.results[0]).not.toHaveProperty("id");
    expect(parsed.results[0].symbol).toBe("handleSearch");
  });
});
