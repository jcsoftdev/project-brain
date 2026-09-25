import { describe, it, expect } from "bun:test";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchCommand } from "../../src/commands/bench.js";
import { VECTOR_DIM } from "../../src/constants.js";
import type { VectorStore, EmbeddingClient, SearchResult } from "../../src/types.js";

// One result clearly above SCORE_THRESHOLD (0.2), one clearly below it — the
// low-score one distinguishes "hybrid" (raw hybridSearch, no post-processing)
// from "full" (applyThreshold drops it) without needing a real index.
const results: SearchResult[] = [
  { id: "hit::0", content: "the real answer lives here", source: "src/target.ts", module: "src", score: 0.9 },
  { id: "noise::0", content: "unrelated low-signal chunk", source: "src/noise.ts", module: "src", score: 0.05 },
];

function makeStore(): VectorStore {
  return {
    ensureTable: async () => {},
    upsert: async () => {},
    search: async () => results,
    hybridSearch: async () => results,
    deleteBySource: async () => {},
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async () => results.length,
    optimize: async () => {},
    batchReplace: async () => {},
    buildIndexes: async () => {},
    getChunkById: async () => null,
    assertDim: async () => {},
    ftsSearch: async () => results,
  };
}

function makeEmbeddings(model: string): EmbeddingClient {
  return {
    dim: VECTOR_DIM,
    model,
    embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
    isAvailable: async () => true,
  };
}

async function withQueriesFile(fn: (queriesPath: string, dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bench-test-"));
  const path = join(dir, "queries.jsonl");
  try {
    await writeFile(path, '{"query":"find the target","expect":"src/target.ts"}\n', "utf-8");
    // No real LanceDB table lives here — readTableMeta resolves to null for a
    // missing meta file, which is fine since embeddings are injected anyway.
    await fn(path, join(dir, "db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("benchCommand pipeline mode", () => {
  it("defaults to hybrid: measures hybridSearch raw, unaffected by the score threshold", async () => {
    await withQueriesFile(async (queriesPath, dbPath) => {
      const report = await benchCommand({
        project: "demo",
        queriesPath,
        dbPath,
        store: makeStore(),
        embeddings: makeEmbeddings("hybrid-model"),
      });
      // Both results pass through untouched, including the sub-threshold one —
      // src/target.ts still ranks 1st since hybridSearch already ordered it first.
      expect(report.results[0]!.rank).toBe(1);
    });
  });

  it("--pipeline full runs the same threshold/MMR/budget path search_context uses", async () => {
    await withQueriesFile(async (queriesPath, dbPath) => {
      const store = makeStore();
      let hybridCalls = 0;
      store.hybridSearch = async () => {
        hybridCalls++;
        return results;
      };

      const report = await benchCommand({
        project: "demo",
        queriesPath,
        dbPath,
        pipeline: "full",
        store,
        embeddings: makeEmbeddings("full-model"),
      });

      // Full pipeline still finds the gold file — applyThreshold only drops
      // the sub-threshold noise result, not the 0.9-scored hit.
      expect(report.results[0]!.rank).toBe(1);
      expect(hybridCalls).toBe(1);
    });
  });
});
