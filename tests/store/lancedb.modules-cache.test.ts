import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { VECTOR_DIM } from "../../src/constants.js";
import type { Chunk } from "../../src/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pb-modcache-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

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

/** Spy on the underlying table's query() method — the only way listModules
 * pulls the module column from disk. Table handle must already be open
 * (via ensureTable/upsert) before spying on its prototype. */
async function spyOnTableQuery(store: LanceDbStore, project: string) {
  // Force the table handle open by making any call that resolves it.
  await store.listModules(project);
  const table = await (store as any).getTable(project);
  return spyOn(Object.getPrototypeOf(table), "query");
}

describe("listModules — distinct-module cache per project", () => {
  it("cache hit: two listModules calls only query the table once", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj");
    await store.upsert("proj", [
      makeChunk({ id: "a::0", module: "auth" }),
      makeChunk({ id: "b::0", module: "core" }),
    ]);

    const querySpy = await spyOnTableQuery(store, "proj");
    try {
      const first = await store.listModules("proj");
      const second = await store.listModules("proj");

      expect(first).toEqual(["auth", "core"]);
      expect(second).toEqual(["auth", "core"]);
      expect(querySpy.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      querySpy.mockRestore();
    }
  });

  it("cache invalidation on write: listModules -> upsert -> listModules reflects the write", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj");
    await store.upsert("proj", [makeChunk({ id: "a::0", module: "auth" })]);

    const before = await store.listModules("proj");
    expect(before).toEqual(["auth"]);

    await store.upsert("proj", [makeChunk({ id: "b::0", module: "billing" })]);

    const after = await store.listModules("proj");
    expect(after).toEqual(["auth", "billing"]);
  });

  it("cache invalidation on deleteBySource: removed module no longer appears", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj");
    await store.upsert("proj", [
      makeChunk({ id: "a::0", module: "auth", source: "a.ts" }),
      makeChunk({ id: "b::0", module: "billing", source: "b.ts" }),
    ]);

    const before = await store.listModules("proj");
    expect(before).toEqual(["auth", "billing"]);

    await store.deleteBySource("proj", "b.ts");

    const after = await store.listModules("proj");
    expect(after).toEqual(["auth"]);
  });

  it("returned array is not the live cache — mutating the result does not corrupt subsequent reads", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj");
    await store.upsert("proj", [makeChunk({ id: "a::0", module: "auth" })]);

    const first = await store.listModules("proj");
    first.push("mutated");

    const second = await store.listModules("proj");
    expect(second).toEqual(["auth"]);
  });
});
