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
});
