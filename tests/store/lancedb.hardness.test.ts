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
