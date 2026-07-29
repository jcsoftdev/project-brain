import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Chunk, EmbeddingClient, VectorStore } from "../../src/types.js";

/**
 * Indexing a bundle into the store — the payoff of the whole format. Once a
 * concept is in, asking "why does wasm.ts read bytes" returns the decision
 * rather than the lines, which is the thing project-brain could not do before.
 *
 * Removal matters as much as insertion: a concept deleted from the bundle must
 * leave the index too, or the brain keeps answering with knowledge its owners
 * already retracted.
 */
function fakeStore() {
  const calls: Array<{ sources: string[]; chunks: Chunk[] }> = [];
  let existing: Chunk[] = [];
  const store = {
    ensureTable: async () => {},
    upsert: async () => {},
    batchReplace: async (_p: string, sources: string[], chunks: Chunk[]) => {
      calls.push({ sources, chunks });
    },
    search: async () => [],
    deleteBySource: async () => {},
    listModules: async () => [],
    getModuleChunks: async () => existing,
    countChunks: async () => 0,
    optimize: async () => {},
    buildIndexes: async () => {},
    hybridSearch: async () => [],
    getChunkById: async () => null,
    assertDim: async () => {},
  } as unknown as VectorStore;
  return {
    store,
    calls,
    seed(chunks: Partial<Chunk>[]) {
      existing = chunks as Chunk[];
    },
  };
}

function fakeEmbeddings(available = true): EmbeddingClient {
  return {
    dim: 4,
    model: "fake",
    embed: async (texts: string[]) => (available ? texts.map(() => [0, 0, 0, 0]) : null),
    isAvailable: async () => available,
  } as unknown as EmbeddingClient;
}

describe("syncBundle", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-okf-sync-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(relPath: string, content: string): Promise<void> {
    const full = join(root, relPath);
    await mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await writeFile(full, content);
  }

  const concept = (type: string, title: string, body = "Because of a real constraint.") =>
    ["---", `type: ${type}`, `title: ${title}`, "---", "", "# Why", body].join("\n");

  it("indexes concepts under the okf module", async () => {
    const { syncBundle } = await import("../../src/okf/sync.js");
    const { store, calls } = fakeStore();
    await write("decisions/wasm.md", concept("Decision", "Load grammars from bytes"));

    const result = await syncBundle(root, { project: "p", store, embeddings: fakeEmbeddings() });

    expect(result.concepts).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.chunks.every((c) => c.module === "okf")).toBe(true);
    expect(calls[0]?.chunks.every((c) => c.source === "decisions/wasm.md")).toBe(true);
  });

  it("stores sources relative to the repo root, matching the ids the regular indexer writes", async () => {
    const { syncBundle } = await import("../../src/okf/sync.js");
    const { store, calls } = fakeStore();
    await mkdir(join(root, "docs", "knowledge"), { recursive: true });
    await write("docs/knowledge/wasm.md", concept("Decision", "Load grammars from bytes"));

    // Bundle lives at <repo>/docs/knowledge; the store id must be the real repo
    // path, because sync.ts writes exactly that for the same file and both
    // pipelines share one table.
    await syncBundle(join(root, "docs", "knowledge"), {
      project: "p",
      store,
      embeddings: fakeEmbeddings(),
      repoRoot: root,
    });

    expect(calls[0]?.chunks.every((c) => c.source === "docs/knowledge/wasm.md")).toBe(true);
  });

  it("attaches an embedding vector to every chunk it stores", async () => {
    const { syncBundle } = await import("../../src/okf/sync.js");
    const { store, calls } = fakeStore();
    await write("decisions/wasm.md", concept("Decision", "Load grammars from bytes"));

    await syncBundle(root, { project: "p", store, embeddings: fakeEmbeddings() });

    expect(calls[0]?.chunks.length).toBeGreaterThan(0);
    expect(calls[0]?.chunks.every((c) => Array.isArray(c.vector) && c.vector.length === 4)).toBe(true);
  });

  it("deletes concepts that no longer exist in the bundle", async () => {
    const { syncBundle } = await import("../../src/okf/sync.js");
    const { store, calls, seed } = fakeStore();
    seed([
      { source: "decisions/gone.md", module: "okf" },
      { source: "decisions/kept.md", module: "okf" },
    ]);
    await write("decisions/kept.md", concept("Decision", "Kept"));

    const result = await syncBundle(root, { project: "p", store, embeddings: fakeEmbeddings() });

    expect(calls[0]?.sources).toContain("decisions/gone.md");
    expect(result.removed).toEqual(["decisions/gone.md"]);
  });

  it("replaces the sources it re-indexes so repeated syncs do not duplicate chunks", async () => {
    const { syncBundle } = await import("../../src/okf/sync.js");
    const { store, calls, seed } = fakeStore();
    seed([{ source: "decisions/kept.md", module: "okf" }]);
    await write("decisions/kept.md", concept("Decision", "Kept"));

    await syncBundle(root, { project: "p", store, embeddings: fakeEmbeddings() });

    expect(calls[0]?.sources).toContain("decisions/kept.md");
  });

  it("does not index reserved navigation or reference material", async () => {
    const { syncBundle } = await import("../../src/okf/sync.js");
    const { store, calls } = fakeStore();
    await write("index.md", "# Bundle\n* [d](decisions/)");
    await write("log.md", "# Log\n## 2026-07-29\n* **Creation**: Init.");
    await write("references/upstream.md", "# Upstream notes");
    await write("decisions/wasm.md", concept("Decision", "Only me"));

    const result = await syncBundle(root, { project: "p", store, embeddings: fakeEmbeddings() });

    expect(result.concepts).toBe(1);
    expect(calls[0]?.chunks.every((c) => c.source === "decisions/wasm.md")).toBe(true);
  });

  it("reports conformance issues without refusing to index the good concepts", async () => {
    const { syncBundle } = await import("../../src/okf/sync.js");
    const { store } = fakeStore();
    await write("decisions/good.md", concept("Decision", "Good"));
    await write("decisions/bad.md", "# No frontmatter");

    const result = await syncBundle(root, { project: "p", store, embeddings: fakeEmbeddings() });

    expect(result.concepts).toBe(1);
    expect(result.issues.map((i) => i.rule)).toEqual(["frontmatter-required"]);
  });

  it("handles an empty bundle without calling the store", async () => {
    const { syncBundle } = await import("../../src/okf/sync.js");
    const { store, calls } = fakeStore();

    const result = await syncBundle(root, { project: "p", store, embeddings: fakeEmbeddings() });

    expect(result.concepts).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("throws a typed error when the embedding service is unavailable", async () => {
    const { syncBundle } = await import("../../src/okf/sync.js");
    const { OkfBundleError } = await import("../../src/okf/bundle.js");
    const { store } = fakeStore();
    await write("decisions/wasm.md", concept("Decision", "Load grammars from bytes"));

    const promise = syncBundle(root, { project: "p", store, embeddings: fakeEmbeddings(false) });

    await expect(promise).rejects.toBeInstanceOf(OkfBundleError);
  });
});
