import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TABLE_SUFFIX } from "../../src/constants.js";
import { LanceDbStore } from "../../src/store/lancedb.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pb-idx-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function vec(seed: number, dim = 4) { return Array.from({ length: dim }, (_, i) => Math.sin(seed + i)); }

/** Index directories lance has materialised for the table, as seen on disk. */
async function indexDirs(project: string): Promise<string[]> {
  const path = join(dir, `${project}${TABLE_SUFFIX}.lance`, "_indices");
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

describe("buildIndexes index churn", () => {
  it("does not rebuild the FTS index when one already exists", async () => {
    // Every rebuild writes a NEW index directory and lance retains the old one
    // for the compaction window. The vector index was guarded by a
    // !hasVectorIndex check; the FTS createIndex had none, resting on a
    // try/catch whose comment assumed "already exists" would throw. It does
    // not — lance's createIndex replaces by default and happily rebuilds.
    //
    // Measured on a real 42k-row table synced by a watcher: 4,481 FTS index
    // copies written in 24 hours, roughly one every 19 seconds, at ~11 MB
    // each — 48 GB of index garbage against 1.5 GB of actual data.
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [
      { id: "a", vector: vec(1), content: "function handleSearch(args) {}", source: "s.ts", module: "src", content_hash: "h1", updated_at: 1 },
      { id: "b", vector: vec(9), content: "function unrelated(x) {}", source: "u.ts", module: "src", content_hash: "h2", updated_at: 1 },
    ]);

    await store.buildIndexes("proj");
    const afterFirst = await indexDirs("proj");
    expect(afterFirst.length).toBeGreaterThan(0); // the FTS index got built

    // Nothing changed in between. A second sync must not materialise another copy.
    await store.buildIndexes("proj");
    await store.buildIndexes("proj");
    const afterRepeats = await indexDirs("proj");

    expect(afterRepeats.length).toBe(afterFirst.length);
  });

  it("settles: repeated buildIndexes on a healthy table stops materialising index copies", async () => {
    // Guards the OTHER half of the story. optimize() is also capable of
    // writing index copies, so it was worth checking whether it needed the
    // same gating. Measured across 50/300/1000-row fixtures: it does not —
    // on a table with no pending compaction work it is a genuine no-op and
    // the directory count settles.
    //
    // What was observed on the real 42k-row table (one 12 MB FTS copy per
    // optimize) is a BACKLOG effect, not a per-call cost: 3,171 data
    // fragments and 13k index dirs accumulated by the unguarded createIndex
    // above, which optimize chips away at while the 7-day retention window
    // forbids reclaiming what it replaces. Clearing that backlog is the
    // `compact` command's job, not a code change.
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", Array.from({ length: 300 }, (_, i) => ({
      id: `c${i}`,
      vector: vec(i),
      content: `function fn${i}(a, b) { return a + b + ${i}; }`,
      source: `src/f${i}.ts`,
      module: "src",
      content_hash: `h${i}`,
      updated_at: 1,
    })));

    // annMinRows low enough that a vector index exists, so the compaction
    // branch is genuinely reachable rather than skipped for being too small.
    await store.buildIndexes("proj", { annMinRows: 1 });
    const settled = (await indexDirs("proj")).length;

    await store.buildIndexes("proj", { annMinRows: 1 });
    await store.buildIndexes("proj", { annMinRows: 1 });

    expect((await indexDirs("proj")).length).toBe(settled);
  });

  it("still builds the FTS index the first time, so hybridSearch keeps working", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [
      { id: "a", vector: vec(1), content: "function handleSearch(args) {}", source: "s.ts", module: "src", content_hash: "h1", updated_at: 1, symbol_name: "handleSearch" },
    ]);
    await store.buildIndexes("proj");

    const res = await store.hybridSearch("proj", vec(1), "handleSearch", 5);
    expect(res.map((r) => r.id)).toContain("a");
  });
});
