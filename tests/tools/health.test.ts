import { describe, it, expect, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHealth } from "../../src/tools/health.js";
import { VECTOR_DIM } from "../../src/constants.js";
import { HOOK_TIMEOUT_MS } from "../../src/commands/search.js";
import type { VectorStore, EmbeddingClient } from "../../src/types.js";
import { writeLastError } from "../../src/store/error-state.js";

function makeMockStore(count = 42): VectorStore {
  return {
    ensureTable: async () => {},
    upsert: async () => {},
    search: async () => [],
    deleteBySource: async () => {},
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async () => count,
    optimize: async () => {},
      batchReplace: async () => {},
      buildIndexes: async () => {},
      hybridSearch: async () => [],
      getChunkById: async () => null,
      assertDim: async () => {},
  };
}

function makeMockEmbeddings(available = true): EmbeddingClient {
  return {
    dim: VECTOR_DIM,
    embed: async () => (available ? [[0.1]] : null),
    isAvailable: async () => available,
  };
}

describe("check_health tool", () => {
  it("returns structured report when all healthy", async () => {
    const result = await handleHealth(
      { project: "demo" },
      { store: makeMockStore(42), embeddings: makeMockEmbeddings(true) }
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.store).toBe("connected");
    expect(data.embeddings).toBe("available");
    expect(data.model).toBe("nomic-embed-text");
    expect(data.chunks).toBe(42);
    expect(typeof data.version).toBe("string");
  });

  it("reports degraded state when embeddings down", async () => {
    const result = await handleHealth(
      { project: "demo" },
      { store: makeMockStore(10), embeddings: makeMockEmbeddings(false) }
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.store).toBe("connected");
    expect(data.embeddings).toBe("unavailable");
    expect(data.chunks).toBe(10);
  });

  it("never sets isError (reports status, not failure)", async () => {
    const result = await handleHealth(
      { project: "ghost" },
      { store: makeMockStore(0), embeddings: makeMockEmbeddings(false) }
    );
    expect(result.isError).toBeFalsy();
  });

  it("uses embeddingsFor(project) when provided — reports the resolved client's model + availability", async () => {
    const sentinel: EmbeddingClient = {
      dim: VECTOR_DIM,
      model: "sentinel-model",
      embed: async () => [[0.9]],
      isAvailable: async () => false,
    };

    const result = await handleHealth(
      { project: "myproj" },
      {
        store: makeMockStore(7),
        embeddings: makeMockEmbeddings(true), // default — should NOT be used
        embeddingsFor: async (project) => {
          expect(project).toBe("myproj");
          return sentinel;
        },
      }
    );

    const data = JSON.parse(result.content[0].text);
    expect(data.model).toBe("sentinel-model");
    expect(data.embeddings).toBe("unavailable");
    expect(data.chunks).toBe(7);
  });

  it("falls back to deps.embeddings + global EMBEDDING_MODEL when embeddingsFor is absent (back-compat)", async () => {
    const result = await handleHealth(
      { project: "demo" },
      { store: makeMockStore(1), embeddings: makeMockEmbeddings(true) }
      // embeddingsFor absent
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.model).toBe("nomic-embed-text");
    expect(data.embeddings).toBe("available");
  });

  it("omits lastError when dbPath is not provided", async () => {
    const result = await handleHealth(
      { project: "demo" },
      { store: makeMockStore(1), embeddings: makeMockEmbeddings(true) }
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.lastError).toBeUndefined();
  });

  it("includes lastError when dbPath is provided and an error is recorded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-tool-health-"));
    try {
      await writeLastError(dir, "demo", "sync-parser-init", new Error("wasm load failed"));

      const result = await handleHealth(
        { project: "demo" },
        { store: makeMockStore(1), embeddings: makeMockEmbeddings(true), dbPath: dir }
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.lastError.phase).toBe("sync-parser-init");
      expect(data.lastError.message).toBe("wasm load failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("times a real embed and reports embedLatencyMs + slowEmbeddings", async () => {
    const slowEmbeddings: EmbeddingClient = {
      dim: VECTOR_DIM,
      embed: async (texts) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return texts.map(() => [0.1]);
      },
      isAvailable: async () => true,
    };

    const result = await handleHealth(
      { project: "demo" },
      { store: makeMockStore(1), embeddings: slowEmbeddings }
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.embedLatencyMs).toBeGreaterThanOrEqual(20);
    expect(data.slowEmbeddings).toBe(false);
  });

  it("flags slowEmbeddings when embed latency exceeds the hook's timeout budget", async () => {
    const verySlowEmbeddings: EmbeddingClient = {
      dim: VECTOR_DIM,
      embed: async (texts) => texts.map(() => [0.1]),
      isAvailable: async () => true,
    };

    // Fake the clock instead of sleeping past HOOK_TIMEOUT_MS: measureEmbedLatency
    // reads performance.now() exactly twice (start, then after the embed resolves).
    const nowSpy = spyOn(performance, "now")
      .mockImplementationOnce(() => 0)
      .mockImplementationOnce(() => HOOK_TIMEOUT_MS + 5);
    try {
      const result = await handleHealth(
        { project: "demo" },
        { store: makeMockStore(1), embeddings: verySlowEmbeddings }
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.embedLatencyMs).toBe(HOOK_TIMEOUT_MS + 5);
      expect(data.slowEmbeddings).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("reports manifest desync when projectRoot is provided and the store lags the manifest", async () => {
    const { ManifestStore } = await import("../../src/indexer/manifest-store.js");
    const dir = await mkdtemp(join(tmpdir(), "pb-tool-health-manifest-"));
    try {
      const manifest = new ManifestStore(dir);
      manifest.upsertFile("a.ts", "hash-a", 1, { c1: "h1", c2: "h2" });
      manifest.upsertFile("b.ts", "hash-b", 1, { c3: "h3" });
      manifest.close();

      const result = await handleHealth(
        { project: "demo" },
        { store: makeMockStore(1), embeddings: makeMockEmbeddings(true), projectRoot: dir }
      );
      const data = JSON.parse(result.content[0].text);
      expect(data.manifestChunks).toBe(3);
      expect(data.desynced).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("omits manifest fields when projectRoot has no manifest", async () => {
    const result = await handleHealth(
      { project: "demo" },
      { store: makeMockStore(1), embeddings: makeMockEmbeddings(true) }
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.manifestChunks).toBeUndefined();
    expect(data.desynced).toBeUndefined();
  });

  it("reports reranker: off when no reranker is injected (no token configured)", async () => {
    const result = await handleHealth(
      { project: "demo" },
      { store: makeMockStore(1), embeddings: makeMockEmbeddings(true) }
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.reranker).toBe("off");
  });

  it("reports reranker: configured when a reranker is injected", async () => {
    const result = await handleHealth(
      { project: "demo" },
      {
        store: makeMockStore(1),
        embeddings: makeMockEmbeddings(true),
        reranker: { rerank: async () => [] },
      }
    );
    const data = JSON.parse(result.content[0].text);
    expect(data.reranker).toBe("configured");
  });
});
