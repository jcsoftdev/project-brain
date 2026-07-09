import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../../src/constants.js";
import type { VectorStore, EmbeddingClient, Chunk, SearchResult } from "../../src/types.js";

function makeStore(count: number): VectorStore {
  return {
    ensureTable: async () => {},
    upsert: async () => {},
    search: async (): Promise<SearchResult[]> => [],
    deleteBySource: async () => {},
    listModules: async () => [],
    getModuleChunks: async (): Promise<Chunk[]> => [],
    countChunks: async () => count,
    optimize: async () => {},
      batchReplace: async () => {},
      buildIndexes: async () => {},
      hybridSearch: async (): Promise<SearchResult[]> => [],
      getChunkById: async () => null,
      assertDim: async () => {},
  };
}

function makeEmbeddings(available: boolean): EmbeddingClient {
  return {
    dim: VECTOR_DIM,
    embed: async (texts) => (available ? texts.map(() => [0.1]) : null),
    isAvailable: async () => available,
  };
}

describe("health command", () => {
  describe("exports", () => {
    it("exports execute function", async () => {
      const mod = await import("../../src/commands/health.js");
      expect(typeof mod.execute).toBe("function");
    });

    it("exports runHealth for DI", async () => {
      const mod = await import("../../src/commands/health.js");
      expect(typeof mod.runHealth).toBe("function");
    });
  });

  describe("runHealth core logic", () => {
    it("returns connected store status and available embeddings", async () => {
      const { runHealth } = await import("../../src/commands/health.js");
      const result = await runHealth({
        projectId: "demo",
        store: makeStore(42),
        embeddings: makeEmbeddings(true),
      });

      expect(result.store).toBe("connected");
      expect(result.embeddings).toBe("available");
      expect(result.chunks).toBe(42);
      expect(typeof result.version).toBe("string");
    });

    it("reports unavailable embeddings accurately", async () => {
      const { runHealth } = await import("../../src/commands/health.js");
      const result = await runHealth({
        projectId: "demo",
        store: makeStore(0),
        embeddings: makeEmbeddings(false),
      });

      expect(result.store).toBe("connected");
      expect(result.embeddings).toBe("unavailable");
      expect(result.chunks).toBe(0);
    });

    it("returns zero chunks for empty project", async () => {
      const { runHealth } = await import("../../src/commands/health.js");
      const result = await runHealth({
        projectId: "ghost",
        store: makeStore(0),
        embeddings: makeEmbeddings(true),
      });

      expect(result.chunks).toBe(0);
    });

    it("reports the version from package.json, not a hardcoded literal", async () => {
      const { runHealth } = await import("../../src/commands/health.js");
      const pkg = await import("../../package.json", {
        with: { type: "json" },
      });

      const result = await runHealth({
        projectId: "p",
        store: makeStore(0),
        embeddings: makeEmbeddings(true),
      });

      expect(result.version).toBe(pkg.default.version);
    });
  });
});
