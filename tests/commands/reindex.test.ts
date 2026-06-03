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
  };
}

const mockEmbeddings: EmbeddingClient = {
  embed: async (texts) =>
    texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
  isAvailable: async () => true,
};

describe("reindex command", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-reindex-"));
    // Create .project-brain dir so manifests can be saved
    await mkdir(join(tempDir, ".project-brain"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("T-7.1 (reindex): exports", () => {
    it("exports execute function", async () => {
      const mod = await import("../../src/commands/reindex.js");
      expect(typeof mod.execute).toBe("function");
    });

    it("exports runReindex for DI", async () => {
      const mod = await import("../../src/commands/reindex.js");
      expect(typeof mod.runReindex).toBe("function");
    });
  });

  describe("T-7.2 (reindex): full re-index", () => {
    it("indexes files after clearing stale hashes", async () => {
      const store = makeMemoryStore();
      await writeFile(join(tempDir, "doc.md"), "# Documentation\n\nSome content here.");

      const { runReindex } = await import("../../src/commands/reindex.js");
      const result = await runReindex({
        root: tempDir,
        projectId: "test-proj",
        store,
        embeddings: mockEmbeddings,
      });

      expect(result.ingested).toBeGreaterThan(0);
    });

    it("re-ingests all files even if previously synced (no skipping)", async () => {
      const store = makeMemoryStore();
      await writeFile(join(tempDir, "notes.md"), "Note content.");

      const { runSync } = await import("../../src/commands/sync.js");
      // First: sync to populate hashes
      await runSync({
        root: tempDir,
        projectId: "test-proj",
        store,
        embeddings: mockEmbeddings,
      });

      // Now reindex — should ingest everything from scratch (0 skipped)
      const { runReindex } = await import("../../src/commands/reindex.js");
      const result = await runReindex({
        root: tempDir,
        projectId: "test-proj",
        store,
        embeddings: mockEmbeddings,
      });

      // Reindex always re-ingests — no skipping
      expect(result.skipped).toBe(0);
      expect(result.ingested).toBeGreaterThan(0);
    });
  });
});
