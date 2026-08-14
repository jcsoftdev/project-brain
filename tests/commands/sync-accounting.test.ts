import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM, MAX_TEXT_FILE_BYTES } from "../../src/constants.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

function makeMemoryStore(): VectorStore {
  const data = new Map<string, Chunk[]>();
  return {
    ensureTable: async () => {},
    upsert: async (project, chunks) => {
      data.set(project, [...(data.get(project) ?? []), ...chunks]);
    },
    search: async (): Promise<SearchResult[]> => [],
    deleteBySource: async () => {},
    listModules: async () => [],
    getModuleChunks: async () => [],
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
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
  isAvailable: async () => true,
};

describe("sync file accounting", () => {
  let tempDir: string;

  beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), "brain-acct-")); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it("counts files dropped by a gate instead of losing them between the totals", async () => {
    // A file the walker scanned but never indexed — over the size ceiling —
    // used to return null from the read stage and increment NEITHER ingested
    // nor skipped. `scanned` therefore never reconciled, and the only signal
    // that real source files had been dropped was arithmetic the caller had
    // to do itself, against counters that did not add up.
    await writeFile(join(tempDir, "small.md"), "# Real content\n\nIndexed normally.");
    await writeFile(join(tempDir, "huge.md"), "x".repeat(MAX_TEXT_FILE_BYTES + 1));

    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({
      root: tempDir,
      projectId: "acct-proj",
      store: makeMemoryStore(),
      embeddings: mockEmbeddings,
    });

    expect(result.excluded).toBe(1);
    expect(result.excludedSources).toContain("huge.md");
    // The whole point: the totals reconcile.
    expect(result.ingested + result.skipped + result.excluded).toBe(result.scanned);
  });

  it("reports zero excluded and reconciles when every scanned file is indexable", async () => {
    await writeFile(join(tempDir, "a.md"), "# A");
    await writeFile(join(tempDir, "b.md"), "# B");

    const { runSync } = await import("../../src/commands/sync.js");
    const result = await runSync({
      root: tempDir,
      projectId: "acct-clean",
      store: makeMemoryStore(),
      embeddings: mockEmbeddings,
    });

    expect(result.excluded).toBe(0);
    expect(result.excludedSources).toEqual([]);
    expect(result.ingested + result.skipped + result.excluded).toBe(result.scanned);
  });
});
