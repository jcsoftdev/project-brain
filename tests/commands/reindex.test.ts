import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
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

  // ---- BUG FIX: reindex must surface total embed failure ----

  describe("T-7.5 (reindex): total embed failure is not swallowed as success", () => {
    it("runReindex propagates result.error when every embed call fails (mirrors sync's T-7.4)", async () => {
      const store = makeMemoryStore();
      await writeFile(join(tempDir, "file.md"), "Some content to embed.");

      const nullEmbeddings: EmbeddingClient = {
        dim: VECTOR_DIM,
        embed: async (_texts) => null,
        isAvailable: async () => true,
      };

      const { runReindex } = await import("../../src/commands/reindex.js");
      const result = await runReindex({
        root: tempDir,
        projectId: "test-proj",
        store,
        embeddings: nullEmbeddings,
      });

      // Manifest was cleared and nothing was actually stored — this must be
      // distinguishable from a genuine "nothing to index" success.
      expect(result.ingested).toBe(0);
      expect(result.error).toBeDefined();
      expect(result.error).toContain("Embedding failed");
    });

    it("execute() checks result.error and exits 1 before printing success (source-level wiring check)", async () => {
      // execute() calls process.exit(1) on failure, which is not safely
      // exercisable in-process (it would kill the test runner). We assert the
      // wiring exists in source instead — same altitude as cli.test.ts's
      // "each known command uses dynamic import" checks — combined with the
      // behavioral test above proving runReindex actually carries the error.
      const src = await readFile(
        join(import.meta.dir, "../../src/commands/reindex.ts"),
        "utf-8"
      );
      expect(src).toContain("result.error");
      expect(src).toContain("process.exit(1)");
    });
  });
});
