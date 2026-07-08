import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { TABLE_SUFFIX } from "../../src/constants.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pb-hard-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("dim guard", () => {
  it("throws when query vector dim != table dim", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("p", { model: "m", dim: 4 });
    await expect(store.assertDim("p", 8)).rejects.toThrow(/dim/i);
  });
});

/** Corrupt an already-opened table's on-disk data fragment(s) — countRows()
 * (metadata only) still succeeds, but a real query throws a genuine lance IO
 * error. Mirrors the technique in the "search" hardness test below. */
async function corruptFragment(dir: string, project: string) {
  const tableDir = join(dir, `${project}${TABLE_SUFFIX}.lance`, "data");
  const files = await readdir(tableDir);
  for (const f of files) await rm(join(tableDir, f), { force: true });
}

function vec(seed: number, dim = 4) {
  return Array.from({ length: dim }, (_, i) => Math.sin(seed + i));
}

describe("search — real failure is not silently swallowed", () => {
  /**
   * search()'s catch used to blanket-swallow ANY failure (dim mismatch,
   * connection error, corrupted fragment) and return [], making a genuine
   * failure indistinguishable from "no matches". We can't easily fabricate
   * a LanceDB-internal error through the public API (dim mismatches are
   * padded/ignored rather than thrown), so we force a REAL IO error the way
   * a corrupted index would surface one: delete the on-disk data fragment
   * backing an already-opened table handle. countRows() still succeeds
   * (metadata only), but vectorSearch() throws a genuine lance IO error —
   * this is the exact "broken index" scenario the fix targets.
   */
  it("logs via console.warn before returning [] when vectorSearch throws", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [
      { id: "a", vector: [0.1, 0.1, 0.1, 0.1], content: "x", source: "s.ts", module: "m", content_hash: "h", updated_at: 1 },
    ]);

    // Corrupt the fragment data file(s) for this table only — table handle
    // stays cached in `store`, so getTable() won't need to reopen from disk.
    const tableDir = join(dir, `proj${TABLE_SUFFIX}.lance`, "data");
    const files = await readdir(tableDir);
    for (const f of files) {
      await rm(join(tableDir, f), { force: true });
    }

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const results = await store.search("proj", [0.1, 0.1, 0.1, 0.1], 5);
      expect(results).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      const [msg, ...rest] = warnSpy.mock.calls[0];
      expect(String(msg)).toContain("search failed");
      expect(String(msg)).toContain("proj");
      expect(rest.join(" ")).not.toBe("");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("countRows pre-checks removed — empty/missing tables still return [] without throwing", () => {
  it("search: empty table returns [] without throwing", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await expect(store.search("proj", vec(1), 5)).resolves.toEqual([]);
  });

  it("listModules: empty table returns [] without throwing", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await expect(store.listModules("proj")).resolves.toEqual([]);
  });

  it("getModuleChunks: empty table returns [] without throwing", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await expect(store.getModuleChunks("proj", "src")).resolves.toEqual([]);
  });

  it("hybridSearch: empty table (no FTS index built) returns [] without throwing", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await expect(store.hybridSearch("proj", vec(1), "x", 5)).resolves.toEqual([]);
  });

  it("ftsSearch: empty table (no FTS index built) returns [] without throwing", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await expect(store.ftsSearch!("proj", "x", 5)).resolves.toEqual([]);
  });
});

describe("countRows pre-checks removed — genuine failures still logged, not silently swallowed", () => {
  it("listModules: logs via console.warn before returning [] on a genuine failure", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [
      { id: "a", vector: vec(1), content: "x", source: "s.ts", module: "m", content_hash: "h", updated_at: 1 },
    ]);
    await corruptFragment(dir, "proj");

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const results = await store.listModules("proj");
      expect(results).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      const [msg] = warnSpy.mock.calls[0];
      expect(String(msg)).toContain("listModules failed");
      expect(String(msg)).toContain("proj");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("getModuleChunks: logs via console.warn before returning [] on a genuine failure", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [
      { id: "a", vector: vec(1), content: "x", source: "s.ts", module: "m", content_hash: "h", updated_at: 1 },
    ]);
    await corruptFragment(dir, "proj");

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const results = await store.getModuleChunks("proj", "m");
      expect(results).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      const [msg] = warnSpy.mock.calls[0];
      expect(String(msg)).toContain("getModuleChunks failed");
      expect(String(msg)).toContain("proj");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("ftsSearch: logs via console.warn before returning [] on a genuine failure (FTS index present)", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [
      { id: "a", vector: vec(1), content: "hello world", source: "s.ts", module: "m", content_hash: "h", updated_at: 1 },
    ]);
    await store.buildIndexes("proj");
    await corruptFragment(dir, "proj");

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const results = await store.ftsSearch!("proj", "hello", 5);
      expect(results).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      const [msg] = warnSpy.mock.calls[0];
      expect(String(msg)).toContain("ftsSearch failed");
      expect(String(msg)).toContain("proj");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("ftsSearch: missing FTS index (expected condition, not a failure) stays silent and returns []", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [
      { id: "a", vector: vec(1), content: "hello world", source: "s.ts", module: "m", content_hash: "h", updated_at: 1 },
    ]);
    // Deliberately do NOT call buildIndexes — no FTS index exists.

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const results = await store.ftsSearch!("proj", "hello", 5);
      expect(results).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
