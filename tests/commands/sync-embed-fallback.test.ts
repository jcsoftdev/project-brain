import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

/** Minimal in-memory store for testing (mirrors tests/commands/sync.test.ts). */
function makeMemoryStore(): VectorStore & { data: Map<string, Chunk[]> } {
  const data = new Map<string, Chunk[]>();
  return {
    data,
    ensureTable: async () => {},
    upsert: async (project, chunks) => {
      const existing = data.get(project) ?? [];
      for (const chunk of chunks) {
        const idx = existing.findIndex((c) => c.id === chunk.id);
        if (idx >= 0) existing[idx] = chunk;
        else existing.push(chunk);
      }
      data.set(project, existing);
    },
    search: async (): Promise<SearchResult[]> => [],
    deleteBySource: async (project, source) => {
      const existing = data.get(project) ?? [];
      data.set(project, existing.filter((c) => c.source !== source));
    },
    listModules: async (project) => {
      const chunks = data.get(project) ?? [];
      return [...new Set(chunks.map((c) => c.module))].sort();
    },
    getModuleChunks: async (project, module) => {
      const chunks = data.get(project) ?? [];
      return chunks.filter((c) => c.module === module);
    },
    countChunks: async (project) => (data.get(project) ?? []).length,
    optimize: async () => {},
    batchReplace: async (project, sources, chunks) => {
      const existing = (data.get(project) ?? []).filter((c) => !sources.includes(c.source));
      data.set(project, [...existing, ...chunks]);
    },
    buildIndexes: async () => {},
    hybridSearch: async (): Promise<SearchResult[]> => [],
    getChunkById: async () => null,
    assertDim: async () => {},
  };
}

describe("sync — sequential embedding fallback", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-sync-fallback-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("recovers via sequential retry when concurrent batches overload the client, and stores all chunks", async () => {
    const store = makeMemoryStore();

    // 65 files → 2 concurrent batches at EMBED_BATCH_SIZE=64 (default).
    for (let i = 0; i < 65; i++) {
      await writeFile(join(tempDir, `file-${i}.md`), `Content of file ${i}`);
    }

    let concurrentCalls = 0; // calls with texts.length > 8 (the sequential fallback batch cap)
    let sequentialCalls = 0;
    let resetCalled = 0;

    const flakyEmbeddings: EmbeddingClient & { reset: () => void } = {
      dim: VECTOR_DIM,
      embed: async (texts) => {
        // Simulate an overloaded llama-server: any "concurrent-style" large
        // batch call fails outright. Small (<=8) sequential-style batches
        // succeed reliably — exactly like the real spike findings.
        if (texts.length > 8) {
          concurrentCalls++;
          return null;
        }
        sequentialCalls++;
        return texts.map(() => new Array(VECTOR_DIM).fill(0.1));
      },
      isAvailable: async () => true,
      reset: () => {
        resetCalled++;
      },
    };

    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({
      root: tempDir,
      projectId: "test-proj",
      store,
      embeddings: flakyEmbeddings,
    });

    // Fallback engaged: concurrent pass failed, sequential pass rescued it.
    expect(concurrentCalls).toBeGreaterThan(0);
    expect(sequentialCalls).toBeGreaterThan(0);

    // Sync succeeds fully — no error, everything ingested, nothing left failed.
    expect(result.error).toBeUndefined();
    expect(result.embedFailed).toBe(0);
    expect(result.ingested).toBe(65);
    expect(store.countChunks("test-proj")).resolves.toBeGreaterThan(0);

    // The breaker bypass is scoped to the one recovery pass — not left open.
    // isAvailable must still reflect a normal (non-bypassed, non-broken) client.
    expect(resetCalled).toBeGreaterThan(0);
    expect(await flakyEmbeddings.isAvailable()).toBe(true);
  });

  it("still aborts and reports the real error when the client fails everywhere (fallback exhausted)", async () => {
    const store = makeMemoryStore();
    await writeFile(join(tempDir, "file.md"), "Some content to embed.");

    let resetCalled = 0;
    const deadEmbeddings: EmbeddingClient & { reset: () => void } = {
      dim: VECTOR_DIM,
      embed: async (_texts) => null,
      isAvailable: async () => true,
      reset: () => {
        resetCalled++;
      },
    };

    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({
      root: tempDir,
      projectId: "test-proj",
      store,
      embeddings: deadEmbeddings,
    });

    // Genuine outage: fallback attempted (reset called at least once for the
    // recovery pass) but still fails everywhere — no partial/corrupt store.
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Embedding failed");
    expect(result.ingested).toBe(0);
    expect(store.countChunks("test-proj")).resolves.toBe(0);
  });

  it("does not engage the fallback when the embedding client has no reset() (older DI clients)", async () => {
    // A client without reset() must not crash the sync — fallback logic
    // should be optional/duck-typed, never a hard requirement of the
    // EmbeddingClient contract.
    const store = makeMemoryStore();
    await writeFile(join(tempDir, "file.md"), "Some content to embed.");

    const noResetEmbeddings: EmbeddingClient = {
      dim: VECTOR_DIM,
      embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
      isAvailable: async () => true,
    };

    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({
      root: tempDir,
      projectId: "test-proj",
      store,
      embeddings: noResetEmbeddings,
    });

    expect(result.error).toBeUndefined();
    expect(result.ingested).toBe(1);
  });
});
