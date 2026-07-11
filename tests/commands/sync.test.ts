import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

/** Minimal in-memory store for testing. */
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
      data.set(
        project,
        existing.filter((c) => c.source !== source)
      );
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

const mockEmbeddings: EmbeddingClient = {
  dim: VECTOR_DIM,
  embed: async (texts) =>
    texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
  isAvailable: async () => true,
};

describe("sync command", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-sync-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("T-7.1: exports", () => {
    it("exports execute function", async () => {
      const mod = await import("../../src/commands/sync.js");
      expect(typeof mod.execute).toBe("function");
    });

    it("exports runSync function for DI", async () => {
      const mod = await import("../../src/commands/sync.js");
      expect(typeof mod.runSync).toBe("function");
    });
  });

  describe("T-7.2: indexes new files", () => {
    it("indexes a file and returns ingested count > 0", async () => {
      const store = makeMemoryStore();

      // Write a simple file to be indexed
      await writeFile(join(tempDir, "README.md"), "# Hello World\n\nThis is a test project.");

      const { runSync } = await import("../../src/commands/sync.js");
      const result = await runSync({
        root: tempDir,
        projectId: "test-proj",
        store,
        embeddings: mockEmbeddings,
      });

      expect(result.ingested).toBeGreaterThan(0);
    });

    it("returns zero skipped when all files are new", async () => {
      const store = makeMemoryStore();
      await writeFile(join(tempDir, "notes.md"), "Some notes.");

      const { runSync } = await import("../../src/commands/sync.js");
      const result = await runSync({
        root: tempDir,
        projectId: "test-proj",
        store,
        embeddings: mockEmbeddings,
      });

      // All files are new, so nothing skipped
      expect(result.skipped).toBe(0);
    });
  });

  describe("T-7.3: skips unchanged files", () => {
    it("skips a file whose hash has not changed on re-sync", async () => {
      const store = makeMemoryStore();
      await writeFile(join(tempDir, "stable.md"), "Stable content.");

      const { runSync } = await import("../../src/commands/sync.js");

      // First sync — indexes the file
      await runSync({
        root: tempDir,
        projectId: "test-proj",
        store,
        embeddings: mockEmbeddings,
      });

      // Second sync — same file, same content
      const result2 = await runSync({
        root: tempDir,
        projectId: "test-proj",
        store,
        embeddings: mockEmbeddings,
      });

      // File should be skipped (hash unchanged)
      expect(result2.skipped).toBeGreaterThan(0);
      expect(result2.ingested).toBe(0);
    });
  });

  // ---- FIX 3: embed failure surfacing ----

  describe("T-7.4: total embed failure is distinguishable from zero-changed success", () => {
    it("returns embedFailed count > 0 and error string when embed returns null for all batches", async () => {
      const store = makeMemoryStore();
      await writeFile(join(tempDir, "file.md"), "Some content to embed.");

      const nullEmbeddings: EmbeddingClient = {
        dim: VECTOR_DIM,
        embed: async (_texts) => null,
        isAvailable: async () => true,
      };

      const { runSync } = await import("../../src/commands/sync.js");
      const result = await runSync({
        root: tempDir,
        projectId: "test-proj",
        store,
        embeddings: nullEmbeddings,
      });

      // Must be distinguishable from a real "nothing changed" run
      expect(result.ingested).toBe(0);
      // Must signal total embed failure
      expect(result.embedFailed).toBeGreaterThan(0);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("Embedding failed");
    });

    it("zero-changed success has embedFailed=0 and no error", async () => {
      const store = makeMemoryStore();
      await writeFile(join(tempDir, "stable.md"), "Stable.");

      const { runSync } = await import("../../src/commands/sync.js");

      // First sync to build manifest
      await runSync({
        root: tempDir,
        projectId: "test-proj",
        store,
        embeddings: mockEmbeddings,
      });

      // Second sync — nothing changed
      const result2 = await runSync({
        root: tempDir,
        projectId: "test-proj",
        store,
        embeddings: mockEmbeddings,
      });

      expect(result2.ingested).toBe(0);
      expect(result2.embedFailed).toBe(0);
      expect(result2.error).toBeUndefined();
    });
  });

  describe("T-7.5: partial embed failure — only succeeded chunks stored, warning provided", () => {
    it("embedFailed tracks only the texts that returned null, not the whole run", async () => {
      const store = makeMemoryStore();
      // We need 2 batches. EMBED_BATCH_SIZE=64, so write 65 tiny files.
      for (let i = 0; i < 65; i++) {
        await writeFile(join(tempDir, `file-${i}.md`), `Content of file ${i}`);
      }

      // Content-based (not call-count-based) failure: since sync now retries
      // failed chunks sequentially before giving up (see
      // sync-embed-fallback.test.ts), a purely call-count-keyed failure would
      // get healed by the retry pass. Fail deterministically for one specific
      // "poison" file's content instead — a failure that is genuinely
      // permanent (survives sequential retry too), so this test still
      // exercises the "some succeed, some genuinely fail" partial-failure path.
      const partialEmbeddings: EmbeddingClient = {
        dim: VECTOR_DIM,
        embed: async (texts) => {
          if (texts.some((t) => t.includes("file 42"))) return null;
          return texts.map(() => new Array(VECTOR_DIM).fill(0.1));
        },
        isAvailable: async () => true,
      };

      const { runSync } = await import("../../src/commands/sync.js");
      const result = await runSync({
        root: tempDir,
        projectId: "test-proj",
        store,
        embeddings: partialEmbeddings,
      });

      // Some ingested (most files succeeded), some failed (the poison file)
      expect(result.ingested).toBeGreaterThan(0);
      expect(result.embedFailed).toBeGreaterThan(0);
      // Partial failure: error should NOT be set (only total failure triggers it)
      expect(result.error).toBeUndefined();
    });
  });

  describe("T-7.6: embedDone progress reflects only successful embeds", () => {
    it("progress events only advance for non-null vector batches", async () => {
      const store = makeMemoryStore();
      await writeFile(join(tempDir, "c.md"), "Content C");

      const progressEvents: Array<{ phase: string; current: number }> = [];

      const nullEmbeddings: EmbeddingClient = {
        dim: VECTOR_DIM,
        embed: async (_texts) => null,
        isAvailable: async () => true,
      };

      const { runSync } = await import("../../src/commands/sync.js");
      await runSync({
        root: tempDir,
        projectId: "test-proj",
        store,
        embeddings: nullEmbeddings,
        onProgress: (p) => progressEvents.push(p),
      });

      // Embedding phase progress events with current > 0 should only come
      // from successful embeds. With all-null embed, current should stay 0
      // for all embedding progress events (or have no embedding events).
      const embedEvents = progressEvents.filter((e) => e.phase === "embedding" && e.current > 0);
      expect(embedEvents.length).toBe(0);
    });
  });
});
