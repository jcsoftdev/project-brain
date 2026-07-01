import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { VECTOR_DIM } from "../../src/constants.js";
import type { Chunk } from "../../src/types.js";

let tmpDir: string;
let store: LanceDbStore;

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    id: "test::0",
    vector: new Array(VECTOR_DIM).fill(0.1),
    content: "hello world",
    source: "test.md",
    module: "core",
    content_hash: "abc123",
    updated_at: Date.now(),
    ...overrides,
  };
}

describe("LanceDbStore — ensureTable", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "brain-test-"));
    store = new LanceDbStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a new table idempotently", async () => {
    await store.ensureTable("demo");
    // Second call should not throw
    await store.ensureTable("demo");
    const count = await store.countChunks("demo");
    expect(count).toBe(0);
  });

  it("does not leave sentinel records after creation", async () => {
    await store.ensureTable("demo");
    const count = await store.countChunks("demo");
    expect(count).toBe(0);
  });
});

describe("LanceDbStore — upsert", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "brain-test-"));
    store = new LanceDbStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("inserts new chunks", async () => {
    await store.ensureTable("demo");
    await store.upsert("demo", [makeChunk()]);
    const count = await store.countChunks("demo");
    expect(count).toBe(1);
  });

  it("upserts existing chunks by id (overwrites)", async () => {
    await store.ensureTable("demo");
    await store.upsert("demo", [makeChunk({ content: "original" })]);
    await store.upsert("demo", [makeChunk({ content: "updated" })]);
    const count = await store.countChunks("demo");
    expect(count).toBe(1);
  });

  it("inserts multiple chunks", async () => {
    await store.ensureTable("demo");
    const chunks = [
      makeChunk({ id: "a::0" }),
      makeChunk({ id: "b::0" }),
      makeChunk({ id: "c::0" }),
    ];
    await store.upsert("demo", chunks);
    const count = await store.countChunks("demo");
    expect(count).toBe(3);
  });
});

describe("LanceDbStore — search", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "brain-test-"));
    store = new LanceDbStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns ranked results by similarity", async () => {
    await store.ensureTable("demo");
    // Create chunks with distinct vectors
    const close = makeChunk({ id: "close::0", vector: new Array(VECTOR_DIM).fill(0.9) });
    const far = makeChunk({ id: "far::0", vector: new Array(VECTOR_DIM).fill(0.1) });
    await store.upsert("demo", [close, far]);

    const query = new Array(VECTOR_DIM).fill(0.9);
    const results = await store.search("demo", query, 10);

    expect(results.length).toBe(2);
    expect(results[0].id).toBe("close::0");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("respects topK limit", async () => {
    await store.ensureTable("demo");
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk({ id: `chunk::${i}`, vector: new Array(VECTOR_DIM).fill(0.1 * (i + 1)) })
    );
    await store.upsert("demo", chunks);

    const query = new Array(VECTOR_DIM).fill(0.5);
    const results = await store.search("demo", query, 2);
    expect(results.length).toBe(2);
  });

  it("returns empty array for empty table", async () => {
    await store.ensureTable("demo");
    const query = new Array(VECTOR_DIM).fill(0.5);
    const results = await store.search("demo", query, 5);
    expect(results).toEqual([]);
  });

  it("returns scores between 0 and 1", async () => {
    await store.ensureTable("demo");
    await store.upsert("demo", [makeChunk()]);
    const query = new Array(VECTOR_DIM).fill(0.1);
    const results = await store.search("demo", query, 5);
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].score).toBeLessThanOrEqual(1);
  });
});

describe("LanceDbStore — deleteBySource, listModules, getModuleChunks", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "brain-test-"));
    store = new LanceDbStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("deleteBySource removes matching chunks", async () => {
    await store.ensureTable("demo");
    await store.upsert("demo", [
      makeChunk({ id: "a::0", source: "readme.md" }),
      makeChunk({ id: "b::0", source: "readme.md" }),
      makeChunk({ id: "c::0", source: "api.md" }),
    ]);
    await store.deleteBySource("demo", "readme.md");
    const count = await store.countChunks("demo");
    expect(count).toBe(1);
  });

  it("deleteBySource is no-op for missing source", async () => {
    await store.ensureTable("demo");
    await store.upsert("demo", [makeChunk()]);
    await store.deleteBySource("demo", "ghost.md");
    const count = await store.countChunks("demo");
    expect(count).toBe(1);
  });

  it("listModules returns deduplicated sorted module names", async () => {
    await store.ensureTable("demo");
    await store.upsert("demo", [
      makeChunk({ id: "a::0", module: "auth" }),
      makeChunk({ id: "b::0", module: "core" }),
      makeChunk({ id: "c::0", module: "auth" }),
      makeChunk({ id: "d::0", module: "api" }),
    ]);
    const modules = await store.listModules("demo");
    expect(modules).toEqual(["api", "auth", "core"]);
  });

  it("getModuleChunks returns chunks ordered by source", async () => {
    await store.ensureTable("demo");
    await store.upsert("demo", [
      makeChunk({ id: "b::0", module: "auth", source: "b.ts" }),
      makeChunk({ id: "a::0", module: "auth", source: "a.ts" }),
      makeChunk({ id: "c::0", module: "core", source: "c.ts" }),
    ]);
    const chunks = await store.getModuleChunks("demo", "auth");
    expect(chunks.length).toBe(2);
    expect(chunks[0].source).toBe("a.ts");
    expect(chunks[1].source).toBe("b.ts");
  });

  it("operations on non-existent project return empty/zero", async () => {
    const count = await store.countChunks("ghost");
    expect(count).toBe(0);

    const modules = await store.listModules("ghost");
    expect(modules).toEqual([]);

    const chunks = await store.getModuleChunks("ghost", "any");
    expect(chunks).toEqual([]);

    // deleteBySource should not throw
    await store.deleteBySource("ghost", "any");
  });

  it("search on non-existent project returns empty array", async () => {
    const query = new Array(VECTOR_DIM).fill(0.5);
    const results = await store.search("ghost", query, 5);
    expect(results).toEqual([]);
  });
});

describe("LanceDbStore — getChunksByIds", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "brain-test-"));
    store = new LanceDbStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a map of the requested chunks in ONE call, missing ids simply absent", async () => {
    await store.ensureTable("demo");
    await store.upsert("demo", [
      makeChunk({ id: "a::0", content: "alpha" }),
      makeChunk({ id: "b::0", content: "beta" }),
      makeChunk({ id: "c::0", content: "gamma" }),
    ]);

    const result = await store.getChunksByIds("demo", ["a::0", "c::0", "ghost::0"]);

    expect(result.size).toBe(2);
    expect(result.get("a::0")?.content).toBe("alpha");
    expect(result.get("c::0")?.content).toBe("gamma");
    expect(result.has("b::0")).toBe(false);
    expect(result.has("ghost::0")).toBe(false);
  });

  it("returns an empty map for an empty id list without querying the table", async () => {
    await store.ensureTable("demo");
    const result = await store.getChunksByIds("demo", []);
    expect(result.size).toBe(0);
  });

  it("returns an empty map for a non-existent project", async () => {
    const result = await store.getChunksByIds("ghost-project", ["a::0"]);
    expect(result.size).toBe(0);
  });
});
