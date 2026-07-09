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
    getChunkById: async () => null,
    assertDim: async () => {},
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

  it("clamps limit 0 to the minimum (1) instead of mmr silently returning empty results", async () => {
    const store = makeMockStore();
    store.hybridSearch = async () => mockResults;

    const result = await handleSearch(
      { project: "demo", query: "test", limit: 0 },
      { store, embeddings: makeMockEmbeddings() }
    );

    // Pre-fix: mmr(kept, 0, lambda) returns [] because `picked.length < k`
    // is `0 < 0` = false on the very first iteration — limit 0 silently
    // produced empty results instead of being rejected/clamped.
    const data = JSON.parse(result.content[0].text);
    expect(result.isError).toBeFalsy();
    expect(data.results.length).toBeGreaterThan(0);
  });

  it("clamps a negative limit to the minimum (1) instead of unpredictable mmr behavior", async () => {
    const store = makeMockStore();
    store.hybridSearch = async () => mockResults;

    const result = await handleSearch(
      { project: "demo", query: "test", limit: -5 },
      { store, embeddings: makeMockEmbeddings() }
    );

    const data = JSON.parse(result.content[0].text);
    expect(result.isError).toBeFalsy();
    expect(data.results.length).toBeGreaterThan(0);
  });

  it("clamps a limit above 50 down to 50", async () => {
    const store = makeMockStore();
    const searchSpy = { topK: null as any };
    store.hybridSearch = async (_project, _vector, _text, topK) => {
      searchSpy.topK = topK;
      return mockResults;
    };

    await handleSearch(
      { project: "demo", query: "test", limit: 500 },
      { store, embeddings: makeMockEmbeddings() }
    );

    // clamped to 50 -> topK = Math.max(50*3, 20) = 150
    expect(searchSpy.topK).toBe(150);
  });
});

describe("handleSearch — embeddingsFor per-project resolver", () => {
  const SENTINEL_DIM = 42;

  function makeSentinelClient(): EmbeddingClient {
    return {
      dim: SENTINEL_DIM,
      model: "sentinel-model",
      embed: async (texts) => texts.map(() => new Array(SENTINEL_DIM).fill(0.9)),
      isAvailable: async () => true,
    };
  }

  it("uses embeddingsFor(project) when provided — hybridSearch receives vector from resolved client", async () => {
    const sentinel = makeSentinelClient();
    let capturedVector: number[] | null = null;

    const store = makeMockStore();
    store.hybridSearch = async (_project, vector, _text, _topK) => {
      capturedVector = vector;
      return mockResults;
    };

    await handleSearch(
      { project: "myproj", query: "auth flow" },
      {
        store,
        embeddings: makeMockEmbeddings(), // default — should NOT be used
        embeddingsFor: async (project) => {
          expect(project).toBe("myproj");
          return sentinel;
        },
      }
    );

    // The vector passed to hybridSearch must come from the sentinel (dim=42, value=0.9)
    expect(capturedVector).not.toBeNull();
    expect(capturedVector!.length).toBe(SENTINEL_DIM);
    expect(capturedVector![0]).toBeCloseTo(0.9);
  });

  it("falls back to deps.embeddings when embeddingsFor is absent (back-compat)", async () => {
    let capturedVector: number[] | null = null;
    const defaultDim = VECTOR_DIM;

    const store = makeMockStore();
    store.hybridSearch = async (_project, vector, _text, _topK) => {
      capturedVector = vector;
      return mockResults;
    };

    await handleSearch(
      { project: "myproj", query: "auth flow" },
      {
        store,
        embeddings: makeMockEmbeddings(), // value = 0.1, dim = VECTOR_DIM
        // embeddingsFor absent
      }
    );

    expect(capturedVector).not.toBeNull();
    expect(capturedVector!.length).toBe(defaultDim);
    expect(capturedVector![0]).toBeCloseTo(0.1);
  });

  it("returns EMBEDDINGS_UNAVAILABLE when resolved client embed returns null", async () => {
    const nullClient: EmbeddingClient = {
      dim: 768,
      model: "unavailable-model",
      embed: async () => null,
      isAvailable: async () => false,
    };

    const result = await handleSearch(
      { project: "myproj", query: "test" },
      {
        store: makeMockStore(),
        embeddings: makeMockEmbeddings(),
        embeddingsFor: async () => nullClient,
      }
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.code).toBe("EMBEDDINGS_UNAVAILABLE");
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
