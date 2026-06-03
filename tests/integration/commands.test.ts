import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

/** Deterministic in-memory store for integration tests. */
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

const mockEmbeddings: EmbeddingClient = {
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.2)),
  isAvailable: async () => true,
};

/**
 * T-10.1: Full init → sync → health lifecycle.
 * T-10.2: Incremental sync correctly handles add / modify / delete.
 * T-10.3: Reindex clears and rebuilds from scratch.
 */
describe("Integration: command lifecycle", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-cmd-integ-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("T-10.1: init → sync → health", () => {
    it("init creates project config that sync can load", async () => {
      const { runInit } = await import("../../src/commands/init.js");
      const store = makeMemoryStore();

      const initResult = await runInit({ root: tempDir, skipGitHook: true, skipRules: true, skipIndex: true, skipClaudeHook: true });
      expect(initResult.projectId).toBeTruthy();

      // Config must exist and be valid JSON
      const raw = await readFile(
        join(tempDir, ".project-brain", "project.json"),
        "utf-8"
      );
      const config = JSON.parse(raw);
      expect(config.projectId).toBe(initResult.projectId);
    });

    it("sync after init indexes files and health shows correct chunk count", async () => {
      const { runInit } = await import("../../src/commands/init.js");
      const { runSync } = await import("../../src/commands/sync.js");
      const { runHealth } = await import("../../src/commands/health.js");
      const store = makeMemoryStore();

      const initResult = await runInit({ root: tempDir, skipGitHook: true, skipRules: true, skipIndex: true, skipClaudeHook: true });

      // Create a file to index
      await writeFile(join(tempDir, "README.md"), "# My Project\n\nThis is the README.");

      const syncResult = await runSync({
        root: tempDir,
        projectId: initResult.projectId,
        store,
        embeddings: mockEmbeddings,
      });
      expect(syncResult.ingested).toBeGreaterThan(0);

      // Health should now show chunks > 0
      const health = await runHealth({
        projectId: initResult.projectId,
        store,
        embeddings: mockEmbeddings,
      });
      expect(health.store).toBe("connected");
      expect(health.chunks).toBeGreaterThan(0);
    });

    it("health reports correctly even before any sync", async () => {
      const { runInit } = await import("../../src/commands/init.js");
      const { runHealth } = await import("../../src/commands/health.js");
      const store = makeMemoryStore();

      const initResult = await runInit({ root: tempDir, skipGitHook: true, skipRules: true, skipIndex: true, skipClaudeHook: true });

      const health = await runHealth({
        projectId: initResult.projectId,
        store,
        embeddings: mockEmbeddings,
      });

      expect(health.store).toBe("connected");
      expect(health.embeddings).toBe("available");
      expect(health.chunks).toBe(0);
    });
  });

  describe("T-10.2: incremental sync — add / modify / delete", () => {
    it("adds newly created files on second sync", async () => {
      const { runInit } = await import("../../src/commands/init.js");
      const { runSync } = await import("../../src/commands/sync.js");
      const store = makeMemoryStore();

      const initResult = await runInit({ root: tempDir, skipGitHook: true, skipRules: true, skipIndex: true, skipClaudeHook: true });

      // First sync — no files
      const r1 = await runSync({
        root: tempDir,
        projectId: initResult.projectId,
        store,
        embeddings: mockEmbeddings,
      });

      // Add a file
      await writeFile(join(tempDir, "new-doc.md"), "# New Document\n\nSome content.");

      // Second sync — should pick up the new file
      const r2 = await runSync({
        root: tempDir,
        projectId: initResult.projectId,
        store,
        embeddings: mockEmbeddings,
      });

      expect(r2.ingested).toBeGreaterThan(0);
    });

    it("updates chunks when file content changes", async () => {
      const { runInit } = await import("../../src/commands/init.js");
      const { runSync } = await import("../../src/commands/sync.js");
      const store = makeMemoryStore();

      const initResult = await runInit({ root: tempDir, skipGitHook: true, skipRules: true, skipIndex: true, skipClaudeHook: true });
      await writeFile(join(tempDir, "doc.md"), "Version 1 content.");

      // First sync
      await runSync({
        root: tempDir,
        projectId: initResult.projectId,
        store,
        embeddings: mockEmbeddings,
      });

      // Modify file
      await writeFile(join(tempDir, "doc.md"), "Version 2 content — changed.");

      // Second sync — should detect hash change and re-ingest
      const r2 = await runSync({
        root: tempDir,
        projectId: initResult.projectId,
        store,
        embeddings: mockEmbeddings,
      });

      expect(r2.ingested).toBeGreaterThan(0);
      expect(r2.skipped).toBe(0);
    });

    it("removes deleted file chunks from store on sync", async () => {
      const { runInit } = await import("../../src/commands/init.js");
      const { runSync } = await import("../../src/commands/sync.js");
      const store = makeMemoryStore();

      const initResult = await runInit({ root: tempDir, skipGitHook: true, skipRules: true, skipIndex: true, skipClaudeHook: true });
      await writeFile(join(tempDir, "to-delete.md"), "Temporary file.");

      // Sync to index the file
      await runSync({
        root: tempDir,
        projectId: initResult.projectId,
        store,
        embeddings: mockEmbeddings,
      });

      const countBefore = await store.countChunks(initResult.projectId);
      expect(countBefore).toBeGreaterThan(0);

      // Delete the file from disk
      await rm(join(tempDir, "to-delete.md"));

      // Sync again — deleted file should be removed
      const r2 = await runSync({
        root: tempDir,
        projectId: initResult.projectId,
        store,
        embeddings: mockEmbeddings,
      });

      expect(r2.deleted).toBeGreaterThan(0);
      const countAfter = await store.countChunks(initResult.projectId);
      expect(countAfter).toBe(0);
    });
  });

  describe("T-10.3: reindex rebuilds from scratch", () => {
    it("reindex after sync re-ingests all files without skipping", async () => {
      const { runInit } = await import("../../src/commands/init.js");
      const { runSync } = await import("../../src/commands/sync.js");
      const { runReindex } = await import("../../src/commands/reindex.js");
      const store = makeMemoryStore();

      const initResult = await runInit({ root: tempDir, skipGitHook: true, skipRules: true, skipIndex: true, skipClaudeHook: true });
      await writeFile(join(tempDir, "content.md"), "# Content\n\nFull content here.");

      // Sync first to populate hashes
      await runSync({
        root: tempDir,
        projectId: initResult.projectId,
        store,
        embeddings: mockEmbeddings,
      });

      // Reindex — clears hashes and re-ingests
      const reindexResult = await runReindex({
        root: tempDir,
        projectId: initResult.projectId,
        store,
        embeddings: mockEmbeddings,
      });

      // Reindex always ingests everything
      expect(reindexResult.ingested).toBeGreaterThan(0);
      expect(reindexResult.skipped).toBe(0);
    });

    it("chunk count is consistent after sync then reindex", async () => {
      const { runInit } = await import("../../src/commands/init.js");
      const { runSync } = await import("../../src/commands/sync.js");
      const { runReindex } = await import("../../src/commands/reindex.js");

      // Use separate stores to compare
      const storeAfterSync = makeMemoryStore();
      const storeAfterReindex = makeMemoryStore();

      const initResult = await runInit({ root: tempDir, skipGitHook: true, skipRules: true, skipIndex: true, skipClaudeHook: true });
      await writeFile(join(tempDir, "a.md"), "# Section A\n\nContent for A.");

      // Sync path
      await runSync({
        root: tempDir,
        projectId: initResult.projectId,
        store: storeAfterSync,
        embeddings: mockEmbeddings,
      });

      // Reindex path (uses fresh store)
      await runReindex({
        root: tempDir,
        projectId: initResult.projectId,
        store: storeAfterReindex,
        embeddings: mockEmbeddings,
      });

      const countSync = await storeAfterSync.countChunks(initResult.projectId);
      const countReindex = await storeAfterReindex.countChunks(initResult.projectId);

      // Both should produce the same chunk count
      expect(countSync).toBe(countReindex);
      expect(countSync).toBeGreaterThan(0);
    });
  });
});
