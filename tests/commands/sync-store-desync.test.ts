import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runSync } from "../../src/commands/sync.js";
import type { EmbeddingClient, VectorStore, Chunk, SearchResult } from "../../src/types.js";

const DIM = 8;
const PROJECT = "desync-proj";

/** In-memory store whose table can be dropped out from under the manifest, like a LanceDB table recreated on a dim change. */
function makeMemoryStore(): VectorStore & { dropTable(): void } {
  const data = new Map<string, Chunk[]>();
  const rows = (project: string) => data.get(project) ?? [];
  return {
    dropTable: () => data.clear(),
    ensureTable: async () => {},
    upsert: async (project, chunks) => {
      const ids = new Set(chunks.map((c) => c.id));
      data.set(project, [...rows(project).filter((c) => !ids.has(c.id)), ...chunks]);
    },
    batchReplace: async (project, sources, chunks) => {
      data.set(project, [...rows(project).filter((c) => !sources.includes(c.source)), ...chunks]);
    },
    search: async (): Promise<SearchResult[]> => [],
    deleteBySource: async (project, source) => {
      data.set(project, rows(project).filter((c) => c.source !== source));
    },
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async (project) => rows(project).length,
    optimize: async () => {},
    buildIndexes: async () => {},
    hybridSearch: async (): Promise<SearchResult[]> => [],
    getChunkById: async (project, id) => rows(project).find((c) => c.id === id) ?? null,
    assertDim: async () => {},
  };
}

const embeddings: EmbeddingClient = {
  dim: DIM,
  model: "fake-embed",
  embed: async (texts) => texts.map(() => new Array(DIM).fill(0.1)),
  isAvailable: async () => true,
};

describe("sync when the vector store no longer matches the manifest", () => {
  let root: string;
  let store: ReturnType<typeof makeMemoryStore>;
  let stderr: ReturnType<typeof spyOn>;

  const sync = (changedFiles?: string[]) =>
    runSync({ root, projectId: PROJECT, store, embeddings, changedFiles });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-desync-"));
    await writeFile(join(root, "a.md"), "# A\n\nalpha notes");
    await writeFile(join(root, "b.md"), "# B\n\nbeta notes");
    await writeFile(join(root, "c.md"), "# C\n\ngamma notes");
    store = makeMemoryStore();
    stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    stderr.mockRestore();
    await rm(root, { recursive: true, force: true });
  });

  it("skips every file when the store still holds what the manifest describes", async () => {
    await sync();
    const second = await sync();

    expect(second.skipped).toBe(3);
    expect(second.ingested).toBe(0);
  });

  it("re-adds unchanged files after the table was recreated empty", async () => {
    await sync();
    const indexed = await store.countChunks(PROJECT);
    store.dropTable();

    const result = await sync();

    expect(result.ingested).toBe(3);
    expect(await store.countChunks(PROJECT)).toBe(indexed);
  });

  it("repairs the whole project even when asked to sync only one changed file", async () => {
    await sync();
    const indexed = await store.countChunks(PROJECT);
    store.dropTable();

    await sync([join(root, "a.md")]);

    expect(await store.countChunks(PROJECT)).toBe(indexed);
  });

  it("says once why it is re-adding everything", async () => {
    await sync();
    store.dropTable();

    await sync();

    const lines = stderr.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.includes("out of sync"));
    expect(lines).toHaveLength(1);
  });
});
