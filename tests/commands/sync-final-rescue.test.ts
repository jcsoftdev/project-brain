import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

/** Minimal in-memory store for testing (mirrors sync-embed-fallback.test.ts). */
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

describe("sync — final one-by-one rescue pass (ladder step 3)", () => {
  let tempDir: string;
  let prevBatchSize: string | undefined;
  let prevConcurrency: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-sync-rescue-"));
    // Pin small/deterministic knobs so this test doesn't depend on the
    // auto-tune Ollama probe or default batch sizes.
    prevBatchSize = process.env.BRAIN_EMBED_BATCH_SIZE;
    prevConcurrency = process.env.BRAIN_EMBED_CONCURRENCY;
    process.env.BRAIN_EMBED_BATCH_SIZE = "32";
    process.env.BRAIN_EMBED_CONCURRENCY = "1";
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (prevBatchSize === undefined) delete process.env.BRAIN_EMBED_BATCH_SIZE;
    else process.env.BRAIN_EMBED_BATCH_SIZE = prevBatchSize;
    if (prevConcurrency === undefined) delete process.env.BRAIN_EMBED_CONCURRENCY;
    else process.env.BRAIN_EMBED_CONCURRENCY = prevConcurrency;
  });

  it("converges embedFailed to 0 via the final rescue pass when only single-text requests succeed", async () => {
    const store = makeMemoryStore();

    // Enough files that pass 1 (concurrent, batch=32) AND pass 2 (sequential,
    // batch=min(32,8)=8) both submit multi-text batches — both must fail here,
    // forcing the ladder all the way down to pass 3 (batch size 1).
    for (let i = 0; i < 10; i++) {
      await writeFile(join(tempDir, `file-${i}.md`), `Content of file number ${i}`);
    }

    let multiTextCalls = 0;
    let singleTextCalls = 0;
    let resetCalls = 0;

    const client: EmbeddingClient = {
      dim: VECTOR_DIM,
      embed: async (texts) => {
        if (texts.length > 1) {
          multiTextCalls++;
          return null; // even the small sequential pass-2 batch fails
        }
        singleTextCalls++;
        return texts.map(() => new Array(VECTOR_DIM).fill(0.2));
      },
      isAvailable: async () => true,
      reset: () => { resetCalls++; },
    };

    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({ root: tempDir, projectId: "rescue-proj", store, embeddings: client });

    expect(multiTextCalls).toBeGreaterThan(0);
    expect(singleTextCalls).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
    expect(result.embedFailed).toBe(0);
    expect(result.ingested).toBe(10);
    expect(resetCalls).toBeGreaterThan(0);
    await expect(store.countChunks("rescue-proj")).resolves.toBeGreaterThan(0);
  });

  it("still reports the real error when embedding fails absolutely everywhere, even after the rescue pass", async () => {
    const store = makeMemoryStore();
    await writeFile(join(tempDir, "file.md"), "Some content to embed.");

    let resetCalls = 0;
    const deadClient: EmbeddingClient = {
      dim: VECTOR_DIM,
      embed: async () => null,
      isAvailable: async () => true,
      reset: () => { resetCalls++; },
    };

    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({ root: tempDir, projectId: "rescue-proj-2", store, embeddings: deadClient });

    expect(result.error).toBeDefined();
    expect(result.error).toContain("Embedding failed");
    expect(result.ingested).toBe(0);
    expect(resetCalls).toBeGreaterThan(0);
    await expect(store.countChunks("rescue-proj-2")).resolves.toBe(0);
  });

  it("does not call embed at all in the rescue pass when pass 2 already recovered everything", async () => {
    const store = makeMemoryStore();
    await writeFile(join(tempDir, "file.md"), "Single clean file content.");

    let calls = 0;
    const client: EmbeddingClient = {
      dim: VECTOR_DIM,
      embed: async (texts) => {
        calls++;
        return texts.map(() => new Array(VECTOR_DIM).fill(0.3));
      },
      isAvailable: async () => true,
    };

    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({ root: tempDir, projectId: "rescue-proj-3", store, embeddings: client });

    expect(result.embedFailed).toBe(0);
    expect(calls).toBe(1); // only the initial concurrent pass ran — no fallback needed
  });
});
