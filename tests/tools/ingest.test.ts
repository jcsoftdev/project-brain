import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleIngest } from "../../src/tools/ingest.js";
import { handleSearch } from "../../src/tools/search.js";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { VECTOR_DIM } from "../../src/constants.js";
import type { VectorStore, EmbeddingClient, Chunk } from "../../src/types.js";

function makeMockStore(): VectorStore & { upserted: Chunk[]; buildIndexesCalls: number } {
  const store = {
    upserted: [] as Chunk[],
    buildIndexesCalls: 0,
    ensureTable: async () => {},
    upsert: async (_project: string, chunks: Chunk[]) => {
      store.upserted.push(...chunks);
    },
    search: async () => [],
    deleteBySource: async () => {},
    listModules: async () => [],
    getModuleChunks: async () => [],
    countChunks: async () => 0,
      optimize: async () => {},
      batchReplace: async () => {},
      buildIndexes: async () => { store.buildIndexesCalls++; },
      hybridSearch: async () => [],
      getChunkById: async () => null,
      assertDim: async () => {},
  };
  return store;
}

function makeMockEmbeddings(available = true): EmbeddingClient {
  return {
    dim: VECTOR_DIM,
    embed: async (texts) =>
      available ? texts.map(() => new Array(VECTOR_DIM).fill(0.1)) : null,
    isAvailable: async () => available,
  };
}

describe("add_knowledge tool", () => {
  it("embeds content, generates deterministic ID, and upserts", async () => {
    const store = makeMockStore();
    const result = await handleIngest(
      { project: "demo", content: "JWT auth flow", source: "auth.md", module: "auth" },
      { store, embeddings: makeMockEmbeddings() }
    );

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBeDefined();
    expect(data.source).toBe("auth.md");
    expect(store.upserted.length).toBe(1);
    expect(store.upserted[0].content).toBe("JWT auth flow");
  });

  it("returns isError when embeddings unavailable", async () => {
    const store = makeMockStore();
    const result = await handleIngest(
      { project: "demo", content: "test", source: "x.md", module: "core" },
      { store, embeddings: makeMockEmbeddings(false) }
    );

    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0].text);
    expect(data.error).toContain("unavailable");
    expect(store.upserted.length).toBe(0);
  });

  it("generates ID from source + content hash (deterministic)", async () => {
    const store = makeMockStore();
    await handleIngest(
      { project: "demo", content: "hello", source: "test.md", module: "core" },
      { store, embeddings: makeMockEmbeddings() }
    );

    // Same input should produce same ID
    const store2 = makeMockStore();
    await handleIngest(
      { project: "demo", content: "hello", source: "test.md", module: "core" },
      { store: store2, embeddings: makeMockEmbeddings() }
    );

    expect(store.upserted[0].id).toBe(store2.upserted[0].id);
  });

  it("does NOT call store.buildIndexes — sync.ts owns batch FTS index maintenance", async () => {
    const store = makeMockStore();
    await handleIngest(
      { project: "demo", content: "some note", source: "note.md", module: "core" },
      { store, embeddings: makeMockEmbeddings() }
    );

    expect(store.buildIndexesCalls).toBe(0);
  });
});

describe("add_knowledge — findability after removing per-note buildIndexes", () => {
  let dir: string;
  let store: LanceDbStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-ingest-"));
    store = new LanceDbStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("a newly-ingested chunk is findable via search() (vector path) without buildIndexes ever running", async () => {
    const embeddings = makeMockEmbeddings();
    const ingestResult = await handleIngest(
      { project: "demo", content: "JWT auth flow explanation", source: "auth.md", module: "auth" },
      { store, embeddings }
    );
    expect(ingestResult.isError).toBeFalsy();

    // Query with the exact same embedding the mock produces — proves the
    // chunk is retrievable purely through the vector path, no FTS index
    // ever built for this table.
    const query = new Array(VECTOR_DIM).fill(0.1);
    const results = await store.search("demo", query, 5);
    expect(results.length).toBe(1);
    expect(results[0].source).toBe("auth.md");
  });

  it("a newly-ingested chunk is findable via handleSearch tool end-to-end", async () => {
    const embeddings = makeMockEmbeddings();
    await handleIngest(
      { project: "demo", content: "JWT auth flow explanation", source: "auth.md", module: "auth" },
      { store, embeddings }
    );

    const res = await handleSearch({ project: "demo", query: "irrelevant text, mock embeds identically" }, { store, embeddings });
    const { results } = JSON.parse(res.content[0].text);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r: any) => r.source === "auth.md")).toBe(true);
  });
});

describe("add_knowledge on a project indexed with a model other than the server default", () => {
  let dir: string;
  let store: LanceDbStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-ingest-model-"));
    store = new LanceDbStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const client = (model: string, dim: number): EmbeddingClient => ({
    dim,
    model,
    embed: async (texts) => texts.map(() => new Array(dim).fill(0.1)),
    isAvailable: async () => true,
  });

  it("embeds with the project's own model instead of dropping its table", async () => {
    const projectModel = client("project-model", 16);
    await store.ensureTable("demo", { model: "project-model", dim: 16 });
    await store.upsert("demo", [{
      id: "indexed-file-0", vector: new Array(16).fill(0.2), content: "indexed code",
      source: "src/a.ts", module: "src", content_hash: "h", updated_at: 1,
    }]);

    const result = await handleIngest(
      { project: "demo", content: "we chose X over Y", source: "decisions.md", module: "docs" },
      { store, embeddings: client("server-default", 32), embeddingsFor: async () => projectModel }
    );

    expect(result.isError).toBeFalsy();
    expect(await store.countChunks("demo")).toBe(2);
  });
});
