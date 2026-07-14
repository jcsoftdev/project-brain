import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ManifestStore } from "../../src/indexer/manifest-store.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

/** Minimal no-op in-memory store (mirrors pattern in sync-graph.test.ts). */
function makeMemoryStore(): VectorStore {
  const data = new Map<string, Chunk[]>();
  return {
    data,
    ensureTable: async () => {},
    upsert: async () => {},
    search: async (): Promise<SearchResult[]> => [],
    deleteBySource: async (project: string, source: string) => {
      const existing = data.get(project) ?? [];
      data.set(project, existing.filter((c) => c.source !== source));
    },
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async () => 0,
    optimize: async () => {},
    batchReplace: async (project: string, sources: string[], chunks: Chunk[]) => {
      const existing = (data.get(project) ?? []).filter((c) => !sources.includes(c.source));
      data.set(project, [...existing, ...chunks]);
    },
    buildIndexes: async () => {},
    hybridSearch: async (): Promise<SearchResult[]> => [],
    getChunkById: async () => null,
    assertDim: async () => {},
  } as any;
}

/** Embeds every text EXCEPT ones containing the poison marker. */
function makePartialEmbeddings(dim = 4): EmbeddingClient {
  return {
    dim,
    model: "fake",
    async embed(texts: string[]): Promise<number[][] | null> {
      if (texts.some((t) => t.includes("POISON"))) return null; // whole batch fails
      return texts.map(() => new Array(dim).fill(0.5));
    },
    isAvailable: async () => true,
  };
}

let tempDir: string;
let prevBatchSize: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "brain-partial-embed-"));
  mkdirSync(join(tempDir, ".project-brain"), { recursive: true });
  // Force a batch size of 1 so each chunk embeds independently — otherwise
  // the poisoned chunk's text could land in the same embed batch as the
  // clean file's chunk and fail it too (batch failure is all-or-nothing).
  prevBatchSize = process.env.BRAIN_EMBED_BATCH_SIZE;
  process.env.BRAIN_EMBED_BATCH_SIZE = "1";
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (prevBatchSize === undefined) delete process.env.BRAIN_EMBED_BATCH_SIZE;
  else process.env.BRAIN_EMBED_BATCH_SIZE = prevBatchSize;
});

describe("partial embed failure and the hash manifest", () => {
  it("does NOT record a file in the manifest when some of its chunks failed to embed", async () => {
    writeFileSync(join(tempDir, "clean.ts"), "export function clean(a: number){ return a; }");
    // Two functions so poisoned.ts produces >= 2 cAST chunks: one embeds
    // fine, the other contains the POISON marker and fails — a genuinely
    // PARTIAL per-file failure (entryChunks.length > 0 but < rawChunks.length).
    // The cAST chunker (src/indexer/cast.ts) packs adjacent small top-level
    // nodes into ONE chunk up to CAST_MAX_NON_WHITESPACE_CHARS (2000)  —
    // padding `poisonedOk` close to (but under) that budget forces the
    // packer to flush it as its own chunk once `poisonedBad` no longer fits
    // alongside it, instead of silently merging both into a single chunk
    // (which would make this test degenerate into the "whole file failed"
    // case already covered by the pre-existing `entryChunks.length === 0`
    // skip, not the partial-chunk manifest-honesty guard this test targets).
    const pad = "n".repeat(1900);
    const poisonedSrc = [
      `export function poisonedOk(a: number){ const s = "${pad}"; return a + s.length; }`,
      `export function poisonedBad(){ return "POISON"; }`,
    ].join("\n");
    writeFileSync(join(tempDir, "poisoned.ts"), poisonedSrc);

    const { runSync } = await import("../../src/commands/sync.js");
    const store = makeMemoryStore();

    const result = await runSync({
      root: tempDir,
      projectId: "p",
      store,
      embeddings: makePartialEmbeddings(),
    });

    expect(result.embedFailed).toBeGreaterThan(0);

    const manifest = new ManifestStore(tempDir);
    expect(manifest.getEntry("clean.ts")).not.toBeNull(); // fully-embedded file IS recorded
    expect(manifest.getEntry("poisoned.ts")).toBeNull(); // partially-failed file is NOT
    manifest.close();

    // act again: second sync must RETRY the poisoned file (not skip it)
    const second = await runSync({
      root: tempDir,
      projectId: "p",
      store,
      embeddings: makePartialEmbeddings(),
    });
    expect(second.skipped).toBe(1); // clean.ts skipped (hash match)
    expect(second.embedFailed).toBeGreaterThan(0); // poisoned.ts retried, failed again — still visible
  });
});
