import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";

const DIM = 8;
const chunk = (i: number) => ({
  id: `c${i}`, vector: new Array(DIM).fill(i % 7), content: `function f${i}() {}`,
  source: `src/f${i}.ts`, module: "root", content_hash: `h${i}`, updated_at: 1,
});

describe("buildIndexes ANN behavior", () => {
  let dir: string; let store: LanceDbStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-ann-"));
    store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "fake", dim: DIM });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("creates a vector index when row count >= annMinRows", async () => {
    const chunks = Array.from({ length: 300 }, (_, i) => chunk(i));
    await store.batchReplace("proj", chunks.map((c) => c.source), chunks);
    await store.buildIndexes("proj", {
      annMinRows: 100,
      ivfPqOptions: { numPartitions: 2, numSubVectors: 2 },
    });

    const table = await (store as any).getTable("proj");
    const indices = await table.listIndices();
    expect(indices.some((ix: { columns: string[] }) => ix.columns.includes("vector"))).toBe(true);
  });

  it("does NOT create a vector index below the threshold", async () => {
    const chunks = Array.from({ length: 50 }, (_, i) => chunk(i));
    await store.batchReplace("proj", chunks.map((c) => c.source), chunks);
    await store.buildIndexes("proj", { annMinRows: 100 });

    const table = await (store as any).getTable("proj");
    const indices = await table.listIndices();
    expect(indices.some((ix: { columns: string[] }) => ix.columns.includes("vector"))).toBe(false);
  });

  it("does not throw calling createIndex again when a vector index already exists (skip pre-check)", async () => {
    const chunks = Array.from({ length: 300 }, (_, i) => chunk(i));
    await store.batchReplace("proj", chunks.map((c) => c.source), chunks);
    await store.buildIndexes("proj", {
      annMinRows: 100,
      ivfPqOptions: { numPartitions: 2, numSubVectors: 2 },
    });
    // second call: index already exists — must skip createIndex, not throw-and-swallow
    await store.buildIndexes("proj", {
      annMinRows: 100,
      ivfPqOptions: { numPartitions: 2, numSubVectors: 2 },
    });

    const table = await (store as any).getTable("proj");
    const indices = await table.listIndices();
    expect(indices.some((ix: { columns: string[] }) => ix.columns.includes("vector"))).toBe(true);
  });
});
