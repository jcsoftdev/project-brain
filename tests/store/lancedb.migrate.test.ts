/**
 * Tests for ensureTable dim-change migration.
 * FIX A: when the embedding model/dim changes, ensureTable must detect the mismatch
 * and rebuild the table rather than silently keeping the old incompatible schema.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pb-migrate-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/**
 * Helper: upsert one chunk with vectors of the given dim.
 * Uses the store's upsert method directly.
 */
async function upsertRow(store: LanceDbStore, project: string, dim: number, id = "row1") {
  const { upsert } = store as unknown as {
    upsert: (project: string, chunks: unknown[]) => Promise<void>;
  };
  await store.upsert(project, [
    {
      id,
      vector: new Array(dim).fill(0.5),
      content: "test content",
      source: "test/file.ts",
      module: "test",
      content_hash: "abc123",
      updated_at: Date.now(),
    },
  ]);
}

describe("ensureTable dim migration", () => {
  it("does NOT recreate the table when called again with the same dim (rows survive)", async () => {
    const store = new LanceDbStore(dir);

    // First ensureTable + upsert a row
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await upsertRow(store, "proj", 4);

    // Sanity: 1 row present
    expect(await store.countChunks("proj")).toBe(1);

    // Call ensureTable again with the SAME dim
    await store.ensureTable("proj", { model: "m", dim: 4 });

    // Row must still be there — no drop on equal dim
    expect(await store.countChunks("proj")).toBe(1);
  });

  it("recreates the table when dim changes (old rows gone, new dim works)", async () => {
    const store = new LanceDbStore(dir);

    // Create table with dim 4, upsert a row
    await store.ensureTable("proj", { model: "m-old", dim: 4 });
    await upsertRow(store, "proj", 4);
    expect(await store.countChunks("proj")).toBe(1);

    // Re-open with a different store instance to clear in-memory cache
    const store2 = new LanceDbStore(dir);

    // Now call ensureTable with dim 8 — must trigger migration
    await store2.ensureTable("proj", { model: "m-new", dim: 8 });

    // Table must be empty (old rows dropped)
    expect(await store2.countChunks("proj")).toBe(0);

    // Upsert a dim-8 row — must succeed
    await upsertRow(store2, "proj", 8, "newrow");
    expect(await store2.countChunks("proj")).toBe(1);
  });

  it("reads actual schema dim even when meta sidecar is missing", async () => {
    const store = new LanceDbStore(dir);

    // Create table with dim 4 (writes meta sidecar)
    await store.ensureTable("proj", { model: "m-old", dim: 4 });
    await upsertRow(store, "proj", 4);

    // Delete the meta sidecar manually to simulate missing meta
    const { rm: rmFile } = await import("node:fs/promises");
    const { join: pathJoin } = await import("node:path");
    try {
      await rmFile(pathJoin(dir, "proj_chunks.meta.json"), { force: true });
    } catch { /* ignore */ }

    const store2 = new LanceDbStore(dir);
    // Even without meta, dim 4 vs dim 8 must still trigger migration
    await store2.ensureTable("proj", { model: "m-new", dim: 8 });
    expect(await store2.countChunks("proj")).toBe(0);

    // And dim 4 again (matching existing schema after migration?) — actually store2 now
    // has dim 8. Let's just confirm upsert works with dim 8.
    await upsertRow(store2, "proj", 8, "row-after");
    expect(await store2.countChunks("proj")).toBe(1);
  });
});
