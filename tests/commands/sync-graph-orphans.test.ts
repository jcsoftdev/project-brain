/**
 * Regression: the structural graph must be reconciled against its OWN contents
 * on a full sync, not only against the manifest.
 *
 * Real-world failure this reproduces: `.project-brain/graph.db` in the
 * project-brain repo itself held 2791 node_modules files / 16020 symbols
 * (90%+ of the graph) left over from an older indexing pass. The manifest was
 * clean, so `priorPaths` (sync.ts, sourced from manifestStore.listPaths())
 * never saw those rows and the deletion sweep never visited them. They were
 * immortal — `reindex` did not help either, since it clears the manifest only.
 * repo_map's PageRank then ranked zod internals above every project symbol.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { VECTOR_DIM } from "../../src/constants.js";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

function makeStore(): VectorStore {
  const data = new Map<string, Chunk[]>();
  return {
    ensureTable: async () => {},
    upsert: async (project: string, chunks: Chunk[]) => {
      data.set(project, [...(data.get(project) ?? []), ...chunks]);
    },
    search: async (): Promise<SearchResult[]> => [],
    hybridSearch: async (): Promise<SearchResult[]> => [],
    deleteBySource: async (project: string, source: string) => {
      data.set(project, (data.get(project) ?? []).filter((c) => c.source !== source));
    },
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async (project: string) => (data.get(project) ?? []).length,
    optimize: async () => {},
    batchReplace: async (project: string, sources: string[], chunks: Chunk[]) => {
      const kept = (data.get(project) ?? []).filter((c) => !sources.includes(c.source));
      data.set(project, [...kept, ...chunks]);
    },
    buildIndexes: async () => {},
    getChunkById: async (): Promise<Chunk | null> => null,
    assertDim: async () => {},
  };
}

const mockEmbeddings: EmbeddingClient = {
  dim: VECTOR_DIM,
  embed: async (texts) => texts.map(() => new Array(VECTOR_DIM).fill(0.1)),
  isAvailable: async () => true,
};

describe("full sync reconciles the graph against its own contents", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-graph-orphan-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("deletes graph files that are absent from disk AND from the manifest", async () => {
    await writeFile(join(tempDir, "keep.ts"), "export function keep() {\n  return 1;\n}\n");

    const db = openGraphDb(":memory:");
    const graph = new GraphStore(db);

    // Leftover from an older index pass: present in the graph, never in the manifest.
    graph.replaceFile("node_modules/ghost/index.js", "javascript", "stale", 1, [
      { name: "ghost", kind: "function", signature: "fn ghost", start_line: 1, end_line: 2, edges: [] },
    ]);
    expect(graph.listFiles()).toContain("node_modules/ghost/index.js");

    const { runSync } = await import("../../src/commands/sync.js");
    await runSync({
      root: tempDir,
      projectId: "orphan-proj",
      store: makeStore(),
      embeddings: mockEmbeddings,
      graph,
    });

    expect(graph.listFiles()).not.toContain("node_modules/ghost/index.js");
    db.close();
  });

  it("keeps graph files that are still on disk", async () => {
    await writeFile(join(tempDir, "keep.ts"), "export function keep() {\n  return 1;\n}\n");

    const db = openGraphDb(":memory:");
    const graph = new GraphStore(db);

    const { runSync } = await import("../../src/commands/sync.js");
    await runSync({
      root: tempDir,
      projectId: "orphan-proj",
      store: makeStore(),
      embeddings: mockEmbeddings,
      graph,
    });

    expect(graph.listFiles()).toContain("keep.ts");
    db.close();
  });

  it("does not prune the graph on an incremental (changedFiles) sync", async () => {
    await writeFile(join(tempDir, "keep.ts"), "export function keep() {\n  return 1;\n}\n");

    const db = openGraphDb(":memory:");
    const graph = new GraphStore(db);
    graph.replaceFile("other.ts", "typescript", "h", 1, [
      { name: "other", kind: "function", signature: "fn other", start_line: 1, end_line: 2, edges: [] },
    ]);

    const { runSync } = await import("../../src/commands/sync.js");
    await runSync({
      root: tempDir,
      projectId: "orphan-proj",
      store: makeStore(),
      embeddings: mockEmbeddings,
      graph,
      changedFiles: [join(tempDir, "keep.ts")],
    });

    // The incremental path has no authoritative view of the tree, so it must
    // not delete anything it simply did not look at.
    expect(graph.listFiles()).toContain("other.ts");
    db.close();
  });
});
