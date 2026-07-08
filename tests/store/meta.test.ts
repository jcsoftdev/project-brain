import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTableMeta, writeTableMeta, deleteTableMeta } from "../../src/store/meta.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pb-meta-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("table meta", () => {
  it("returns null when absent", async () => {
    expect(await readTableMeta(dir, "proj")).toBeNull();
  });
  it("round-trips model + dim", async () => {
    await writeTableMeta(dir, "proj", { model: "nomic-embed-code", dim: 768 });
    expect(await readTableMeta(dir, "proj")).toEqual({ model: "nomic-embed-code", dim: 768 });
  });
  it("deleteTableMeta removes the file; safe to call again when absent", async () => {
    await writeTableMeta(dir, "proj", { model: "m", dim: 1 });
    await deleteTableMeta(dir, "proj");
    expect(await readTableMeta(dir, "proj")).toBeNull();
    await deleteTableMeta(dir, "proj"); // no throw when already gone
  });
});

describe("table meta — read cache", () => {
  it("readTableMeta only touches disk once across repeated reads for the same project", async () => {
    await writeTableMeta(dir, "proj", { model: "nomic-embed-code", dim: 768 });

    const fileSpy = spyOn(Bun, "file");
    try {
      const first = await readTableMeta(dir, "proj");
      const second = await readTableMeta(dir, "proj");
      const third = await readTableMeta(dir, "proj");

      expect(first).toEqual({ model: "nomic-embed-code", dim: 768 });
      expect(second).toEqual({ model: "nomic-embed-code", dim: 768 });
      expect(third).toEqual({ model: "nomic-embed-code", dim: 768 });
      expect(fileSpy.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      fileSpy.mockRestore();
    }
  });

  it("writeTableMeta invalidates the cache — next readTableMeta sees the NEW value", async () => {
    await writeTableMeta(dir, "proj", { model: "old-model", dim: 4 });
    expect(await readTableMeta(dir, "proj")).toEqual({ model: "old-model", dim: 4 });

    await writeTableMeta(dir, "proj", { model: "new-model", dim: 8 });
    expect(await readTableMeta(dir, "proj")).toEqual({ model: "new-model", dim: 8 });
  });

  it("deleteTableMeta invalidates the cache — next readTableMeta returns null", async () => {
    await writeTableMeta(dir, "proj", { model: "m", dim: 1 });
    expect(await readTableMeta(dir, "proj")).toEqual({ model: "m", dim: 1 });

    await deleteTableMeta(dir, "proj");
    expect(await readTableMeta(dir, "proj")).toBeNull();
  });

  it("cache is keyed by dbPath+project — different dbPath for same project name stays isolated", async () => {
    const dir2 = await mkdtemp(join(tmpdir(), "pb-meta2-"));
    try {
      await writeTableMeta(dir, "proj", { model: "dir1-model", dim: 4 });
      await writeTableMeta(dir2, "proj", { model: "dir2-model", dim: 8 });

      expect(await readTableMeta(dir, "proj")).toEqual({ model: "dir1-model", dim: 4 });
      expect(await readTableMeta(dir2, "proj")).toEqual({ model: "dir2-model", dim: 8 });
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("detects external writes (e.g. a separate reindex process) via mtime and invalidates the stale cache entry", async () => {
    await writeTableMeta(dir, "proj", { model: "old-model", dim: 4 });
    expect(await readTableMeta(dir, "proj")).toEqual({ model: "old-model", dim: 4 });

    // Simulate a SEPARATE process (e.g. `project-brain reindex`) writing the
    // meta file directly on disk, bypassing this process's in-memory cache.
    const safe = "proj".toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 64);
    const metaFilePath = join(dir, `${safe}.meta.json`);
    await writeFile(metaFilePath, JSON.stringify({ model: "new-model", dim: 8 }));

    // Force the mtime forward explicitly so it differs from the cached mtime
    // even under coarse filesystem timestamp granularity (avoid same-ms flakes).
    const future = new Date(Date.now() + 60_000);
    await utimes(metaFilePath, future, future);

    expect(await readTableMeta(dir, "proj")).toEqual({ model: "new-model", dim: 8 });
  });
});
