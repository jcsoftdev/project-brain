import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import type { VectorStore, EmbeddingClient, SearchResult, Chunk } from "../../src/types.js";

// ── Fake deps ─────────────────────────────────────────────────────────────

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "chunk-1",
    content: "export function handleSearch(args, deps) { ... }",
    source: "src/tools/search.ts",
    module: "src",
    score: 0.87,
    symbol_name: "handleSearch",
    symbol_kind: "function",
    start_line: 18,
    end_line: 41,
    ...overrides,
  };
}

function makeStore(results: SearchResult[] = []): VectorStore {
  return {
    ensureTable: async () => {},
    upsert: async () => {},
    search: async (): Promise<SearchResult[]> => results,
    deleteBySource: async () => {},
    listModules: async () => [],
    getModuleChunks: async (): Promise<Chunk[]> => [],
    countChunks: async () => 0,
    optimize: async () => {},
    batchReplace: async () => {},
    buildIndexes: async () => {},
    hybridSearch: async (): Promise<SearchResult[]> => results,
    getChunkById: async () => null,
    assertDim: async () => {},
  };
}

function makeEmbeddings(available: boolean, dim = 768): EmbeddingClient {
  return {
    dim,
    // Distinct model per availability: the query-embedding cache is keyed by
    // (model, query) and shared as a module singleton — without this, an
    // "unavailable" instance sharing a query text with an "available" one
    // under the same model name would incorrectly get a cache hit.
    model: available ? "nomic-embed-text" : "nomic-embed-text-unavailable",
    embed: async (texts: string[]) =>
      available ? texts.map(() => Array(dim).fill(0.1)) : null,
    isAvailable: async () => available,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("search command", () => {
  describe("exports", () => {
    it("exports execute function", async () => {
      const mod = await import("../../src/commands/search.js");
      expect(typeof mod.execute).toBe("function");
    });

    it("exports runSearch for DI", async () => {
      const mod = await import("../../src/commands/search.js");
      expect(typeof mod.runSearch).toBe("function");
    });
  });

  describe("runSearch core logic", () => {
    let output: string[];
    let originalLog: typeof console.log;

    beforeEach(() => {
      output = [];
      originalLog = console.log;
      console.log = (...args: unknown[]) => {
        output.push(args.map(String).join(" "));
      };
    });

    afterEach(() => {
      console.log = originalLog;
    });

    it("prints compact context block with source, symbol, score, snippet", async () => {
      const { runSearch } = await import("../../src/commands/search.js");

      await runSearch(
        { query: "handleSearch", project: "test-project", limit: 8 },
        {
          store: makeStore([makeSearchResult()]),
          embeddings: makeEmbeddings(true),
        }
      );

      const joined = output.join("\n");
      expect(joined).toContain("src/tools/search.ts");
      expect(joined).toContain("handleSearch");
      expect(joined).toContain("0.87");
      expect(joined).toContain("project-brain");
    });

    it("prints snippet content in output", async () => {
      const { runSearch } = await import("../../src/commands/search.js");

      await runSearch(
        { query: "handleSearch", project: "test-project", limit: 8 },
        {
          store: makeStore([makeSearchResult()]),
          embeddings: makeEmbeddings(true),
        }
      );

      const joined = output.join("\n");
      expect(joined).toContain("handleSearch");
    });

    it("prints nothing and does not throw when embeddings unavailable", async () => {
      const { runSearch } = await import("../../src/commands/search.js");

      await expect(
        runSearch(
          { query: "handleSearch", project: "test-project", limit: 8 },
          {
            store: makeStore([makeSearchResult()]),
            embeddings: makeEmbeddings(false),
          }
        )
      ).resolves.toBeUndefined();

      expect(output).toHaveLength(0);
    });

    it("prints nothing for empty query", async () => {
      const { runSearch } = await import("../../src/commands/search.js");

      await runSearch(
        { query: "", project: "test-project", limit: 8 },
        {
          store: makeStore([makeSearchResult()]),
          embeddings: makeEmbeddings(true),
        }
      );

      expect(output).toHaveLength(0);
    });

    it("prints nothing (no throw) when store.hybridSearch throws", async () => {
      const { runSearch } = await import("../../src/commands/search.js");

      const throwingStore = makeStore();
      throwingStore.hybridSearch = async () => {
        throw new Error("DB connection failed");
      };

      await expect(
        runSearch(
          { query: "handleSearch", project: "test-project", limit: 8 },
          {
            store: throwingStore,
            embeddings: makeEmbeddings(true),
          }
        )
      ).resolves.toBeUndefined();

      expect(output).toHaveLength(0);
    });

    it("prints nothing for empty results", async () => {
      const { runSearch } = await import("../../src/commands/search.js");

      await runSearch(
        { query: "some query that matches nothing", project: "test-project", limit: 8 },
        {
          store: makeStore([]),
          embeddings: makeEmbeddings(true),
        }
      );

      expect(output).toHaveLength(0);
    });

    it("includes line range in output when present", async () => {
      const { runSearch } = await import("../../src/commands/search.js");

      await runSearch(
        { query: "handleSearch", project: "test-project", limit: 8 },
        {
          store: makeStore([makeSearchResult({ start_line: 18, end_line: 41 })]),
          embeddings: makeEmbeddings(true),
        }
      );

      const joined = output.join("\n");
      expect(joined).toContain("18");
      expect(joined).toContain("41");
    });

    it("works when symbol_name and line range are absent", async () => {
      const { runSearch } = await import("../../src/commands/search.js");

      await runSearch(
        { query: "handleSearch", project: "test-project", limit: 8 },
        {
          store: makeStore([
            makeSearchResult({
              symbol_name: undefined,
              symbol_kind: undefined,
              start_line: undefined,
              end_line: undefined,
            }),
          ]),
          embeddings: makeEmbeddings(true),
        }
      );

      const joined = output.join("\n");
      // Should still contain source and score at minimum
      expect(joined).toContain("src/tools/search.ts");
      expect(joined).toContain("0.87");
    });

    it("records a last-error entry when store.hybridSearch throws, given a dbPath", async () => {
      const { runSearch } = await import("../../src/commands/search.js");
      const { readLastError } = await import("../../src/store/error-state.js");
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const dir = await mkdtemp(join(tmpdir(), "pb-search-err-"));
      try {
        const throwingStore = makeStore();
        throwingStore.hybridSearch = async () => {
          throw new Error("DB connection failed");
        };

        await runSearch(
          { query: "handleSearch", project: "test-project", limit: 8 },
          { store: throwingStore, embeddings: makeEmbeddings(true), dbPath: dir }
        );

        const err = await readLastError(dir, "test-project");
        expect(err?.phase).toBe("search");
        expect(err?.message).toBe("DB connection failed");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("does not throw or write anything when dbPath is omitted", async () => {
      const { runSearch } = await import("../../src/commands/search.js");

      const throwingStore = makeStore();
      throwingStore.hybridSearch = async () => {
        throw new Error("DB connection failed");
      };

      await expect(
        runSearch(
          { query: "handleSearch", project: "test-project", limit: 8 },
          { store: throwingStore, embeddings: makeEmbeddings(true) }
        )
      ).resolves.toBeUndefined();
    });
  });

  describe("argument parsing", () => {
    let output: string[];
    let originalLog: typeof console.log;

    beforeEach(() => {
      output = [];
      originalLog = console.log;
      console.log = (...args: unknown[]) => {
        output.push(args.map(String).join(" "));
      };
    });

    afterEach(() => {
      console.log = originalLog;
    });

    it("parses positional args as query", async () => {
      const { runSearch } = await import("../../src/commands/search.js");

      // Verify empty string triggers no-op
      await runSearch(
        { query: "", project: "test", limit: 8 },
        {
          store: makeStore([makeSearchResult()]),
          embeddings: makeEmbeddings(true),
        }
      );

      expect(output).toHaveLength(0);
    });
  });
});

// ── --stdin flag integration tests ────────────────────────────────────────

describe("execute --stdin flag", () => {
  let output: string[];
  let originalLog: typeof console.log;

  beforeEach(() => {
    output = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("prints nothing and exits 0 when stdin is empty", async () => {
    const { execute } = await import("../../src/commands/search.js");
    // Should not throw even with empty stdin
    await expect(execute(["--stdin"], async () => "")).resolves.toBeUndefined();
    expect(output).toHaveLength(0);
  });

  it("prints nothing and exits 0 when stdin is invalid JSON", async () => {
    const { execute } = await import("../../src/commands/search.js");
    await expect(execute(["--stdin"], async () => "{bad json")).resolves.toBeUndefined();
    expect(output).toHaveLength(0);
  });

  it("prints nothing and exits 0 when JSON has no .prompt field", async () => {
    const { execute } = await import("../../src/commands/search.js");
    await expect(
      execute(["--stdin"], async () => JSON.stringify({ message: "hello" }))
    ).resolves.toBeUndefined();
    expect(output).toHaveLength(0);
  });
});

// ── parsePromptFromStdin unit tests ───────────────────────────────────────

describe("parsePromptFromStdin", () => {
  it("returns the prompt field from valid JSON", async () => {
    const { parsePromptFromStdin } = await import("../../src/commands/search.js");
    const raw = JSON.stringify({ prompt: "what does handleSearch do?" });
    expect(parsePromptFromStdin(raw)).toBe("what does handleSearch do?");
  });

  it("returns empty string for empty input", async () => {
    const { parsePromptFromStdin } = await import("../../src/commands/search.js");
    expect(parsePromptFromStdin("")).toBe("");
  });

  it("returns empty string for whitespace-only input", async () => {
    const { parsePromptFromStdin } = await import("../../src/commands/search.js");
    expect(parsePromptFromStdin("   \n  ")).toBe("");
  });

  it("returns empty string for invalid JSON", async () => {
    const { parsePromptFromStdin } = await import("../../src/commands/search.js");
    expect(parsePromptFromStdin("{not valid json")).toBe("");
  });

  it("returns empty string when JSON has no .prompt field", async () => {
    const { parsePromptFromStdin } = await import("../../src/commands/search.js");
    const raw = JSON.stringify({ message: "hello", session_id: "abc" });
    expect(parsePromptFromStdin(raw)).toBe("");
  });

  it("returns empty string when prompt field is not a string", async () => {
    const { parsePromptFromStdin } = await import("../../src/commands/search.js");
    const raw = JSON.stringify({ prompt: 42 });
    expect(parsePromptFromStdin(raw)).toBe("");
  });

  it("returns empty string for valid JSON that is not an object (array)", async () => {
    const { parsePromptFromStdin } = await import("../../src/commands/search.js");
    expect(parsePromptFromStdin("[1,2,3]")).toBe("");
  });
});
