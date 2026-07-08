import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { VECTOR_DIM } from "../../src/constants.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pb-tblcache-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("table handle cache — bounded LRU (16 entries)", () => {
  it("evicts the least-recently-used table handle once more than 16 projects are opened", async () => {
    const store = new LanceDbStore(dir);

    // Create 17 distinct project tables — one over the cap.
    for (let i = 0; i < 17; i++) {
      await store.ensureTable(`proj${i}`, { model: "m", dim: VECTOR_DIM });
    }

    const db = await (store as any).getDb();
    const openTableSpy = spyOn(Object.getPrototypeOf(db), "openTable");
    try {
      // proj0 was the first ever inserted — with a 16-entry cap and 17
      // inserts, it must have been evicted, forcing a fresh openTable() call.
      await store.listModules("proj0");
      expect(openTableSpy.mock.calls.length).toBe(1);
      expect(openTableSpy.mock.calls[0][0]).toContain("proj0");

      // proj16, the most recently created, must still be cached — no reopen.
      openTableSpy.mockClear();
      await store.listModules("proj16");
      expect(openTableSpy.mock.calls.length).toBe(0);
    } finally {
      openTableSpy.mockRestore();
    }
  });

  it("accessing a cached entry marks it as recently used, protecting it from eviction", async () => {
    const store = new LanceDbStore(dir);

    for (let i = 0; i < 16; i++) {
      await store.ensureTable(`proj${i}`, { model: "m", dim: VECTOR_DIM });
    }
    // Touch proj0 again — should move it to "most recently used".
    await store.listModules("proj0");

    // Now insert one more — a normal LRU would evict proj1 (now the oldest
    // untouched entry), NOT proj0 (which was just re-touched).
    await store.ensureTable("proj16", { model: "m", dim: VECTOR_DIM });

    const db = await (store as any).getDb();
    const openTableSpy = spyOn(Object.getPrototypeOf(db), "openTable");
    try {
      await store.listModules("proj0");
      expect(openTableSpy.mock.calls.length).toBe(0); // still cached — protected by the touch

      openTableSpy.mockClear();
      await store.listModules("proj1");
      expect(openTableSpy.mock.calls.length).toBe(1); // evicted — needed a fresh open
    } finally {
      openTableSpy.mockRestore();
    }
  });

  it("cache size never exceeds the 16-entry cap regardless of access pattern", async () => {
    const store = new LanceDbStore(dir);
    for (let i = 0; i < 25; i++) {
      await store.ensureTable(`proj${i}`, { model: "m", dim: VECTOR_DIM });
    }
    const tables = (store as any).tables as Map<string, unknown>;
    expect(tables.size).toBeLessThanOrEqual(16);
  });
});
