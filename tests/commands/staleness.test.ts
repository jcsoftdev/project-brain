import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

function makeMemoryStore(): VectorStore {
  const data = new Map<string, Chunk[]>();
  return {
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
  };
}

const mockEmbeddings: EmbeddingClient = {
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
  isAvailable: async () => true,
};

/**
 * T-9.1: Hash manifest persists between runs and correctly tracks
 *         which files have been indexed.
 *
 * T-9.2: checkStaleness() reports accurate counts of stale vs. current files.
 */
describe("Staleness Enhancement", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-stale-"));
    await mkdir(join(tempDir, ".project-brain"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("T-9.1: hash manifest persistence", () => {
    it("hash manifest file is created after first sync", async () => {
      const store = makeMemoryStore();
      await writeFile(join(tempDir, "file.md"), "Content here.");

      const { runSync } = await import("../../src/commands/sync.js");
      await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });

      const manifestPath = join(tempDir, ".project-brain", "hashes.json");
      const raw = await readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(raw);

      expect(typeof manifest).toBe("object");
      expect(Object.keys(manifest).length).toBeGreaterThan(0);
    });

    it("manifest records the correct hash for indexed files", async () => {
      const store = makeMemoryStore();
      const content = "Known content for hashing.";
      await writeFile(join(tempDir, "known.md"), content);

      const { runSync } = await import("../../src/commands/sync.js");
      await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });

      const manifestPath = join(tempDir, ".project-brain", "hashes.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));

      // Compute expected hash
      const { computeHash } = await import("../../src/indexer/hash.js");
      const expectedHash = computeHash(content);

      expect(manifest["known.md"]?.hash ?? manifest["known.md"]).toBe(expectedHash);
    });

    it("manifest updates when file content changes", async () => {
      const store = makeMemoryStore();
      await writeFile(join(tempDir, "evolving.md"), "Version 1.");

      const { runSync } = await import("../../src/commands/sync.js");
      await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });

      // Change the file
      await writeFile(join(tempDir, "evolving.md"), "Version 2 — completely different.");
      await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });

      const manifestPath = join(tempDir, ".project-brain", "hashes.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));

      const { computeHash } = await import("../../src/indexer/hash.js");
      const v = manifest["evolving.md"];
      expect(v?.hash ?? v).toBe(computeHash("Version 2 — completely different."));
    });
  });

  describe("T-9.2: checkStaleness reports", () => {
    it("exports checkStaleness function", async () => {
      const mod = await import("../../src/commands/sync.js");
      expect(typeof mod.checkStaleness).toBe("function");
    });

    it("returns all files as stale when no manifest exists", async () => {
      await writeFile(join(tempDir, "a.md"), "Content A.");
      await writeFile(join(tempDir, "b.md"), "Content B.");

      const { checkStaleness } = await import("../../src/commands/sync.js");
      const report = await checkStaleness({ root: tempDir });

      // No manifest yet → all files are stale
      expect(report.stale).toBeGreaterThanOrEqual(2);
      expect(report.current).toBe(0);
      expect(report.total).toBeGreaterThanOrEqual(2);
    });

    it("returns files as current after a full sync", async () => {
      const store = makeMemoryStore();
      await writeFile(join(tempDir, "synced.md"), "Synced content.");

      const { runSync, checkStaleness } = await import("../../src/commands/sync.js");
      await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });

      const report = await checkStaleness({ root: tempDir });

      // After sync the synced.md file should be current
      expect(report.current).toBeGreaterThan(0);
    });

    it("counts stale files after content change", async () => {
      const store = makeMemoryStore();
      await writeFile(join(tempDir, "changing.md"), "Original content.");

      const { runSync, checkStaleness } = await import("../../src/commands/sync.js");
      await runSync({ root: tempDir, projectId: "p", store, embeddings: mockEmbeddings });

      // Modify the file without syncing
      await writeFile(join(tempDir, "changing.md"), "Modified content — now stale.");

      const report = await checkStaleness({ root: tempDir });
      expect(report.stale).toBeGreaterThan(0);
    });
  });
});
