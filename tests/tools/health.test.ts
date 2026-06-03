import { describe, it, expect } from "bun:test";
import { handleHealth } from "../../src/tools/health.js";
import type { VectorStore, EmbeddingClient } from "../../src/types.js";

function makeMockStore(count = 42): VectorStore {
  return {
    ensureTable: async () => {},
    upsert: async () => {},
    search: async () => [],
    deleteBySource: async () => {},
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async () => count,
  };
}

function makeMockEmbeddings(available = true): EmbeddingClient {
  return {
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
    expect(data.version).toBe("0.1.0");
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
});
