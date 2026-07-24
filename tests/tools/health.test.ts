import { describe, it, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleHealth } from "../../src/tools/health.js";
import { VECTOR_DIM } from "../../src/constants.js";
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
});
