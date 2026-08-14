import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rerankers } from "@lancedb/lancedb";
import { LanceDbStore } from "../../src/store/lancedb.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pb-hy-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function vec(seed: number, dim = 4) { return Array.from({ length: dim }, (_, i) => Math.sin(seed + i)); }

describe("hybridSearch", () => {
  it("returns the chunk whose content matches the lexical term", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [
      { id: "a", vector: vec(1), content: "function handleSearch(args) {}", source: "s.ts", module: "src", content_hash: "h1", updated_at: 1, symbol_name: "handleSearch" },
      { id: "b", vector: vec(9), content: "function unrelated(x) {}", source: "u.ts", module: "src", content_hash: "h2", updated_at: 1, symbol_name: "unrelated" },
    ]);
    await store.buildIndexes("proj");
    const res = await store.hybridSearch("proj", vec(1), "handleSearch", 5);
    expect(res.map((r) => r.id)).toContain("a");
  });

  it("carries the reranker's relevance signal into score instead of a constant", async () => {
    // RRF fuses the vector and FTS rankings by RANK, so the reranked rows
    // expose `_relevance_score` and drop `_distance` entirely. Reading the
    // absent `_distance` with a `?? 0` fallback silently scored every row
    // 1/(1+0) = 1, which collapses applyThreshold (nothing is ever below
    // the threshold) and degenerates MMR into pure diversity selection —
    // its relevance term becomes a constant and cancels out.
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [
      { id: "a", vector: vec(1), content: "function handleSearch(args) { return search(args); }", source: "a.ts", module: "src", content_hash: "h1", updated_at: 1, symbol_name: "handleSearch" },
      { id: "b", vector: vec(2), content: "function handleSearchResults(x) {}", source: "b.ts", module: "src", content_hash: "h2", updated_at: 1, symbol_name: "handleSearchResults" },
      { id: "c", vector: vec(3), content: "class Unrelated { toString() {} }", source: "c.ts", module: "src", content_hash: "h3", updated_at: 1, symbol_name: "Unrelated" },
      { id: "d", vector: vec(4), content: "const timeout = 5000;", source: "d.ts", module: "src", content_hash: "h4", updated_at: 1, symbol_name: "timeout" },
      { id: "e", vector: vec(5), content: "export function parseConfig() {}", source: "e.ts", module: "src", content_hash: "h5", updated_at: 1, symbol_name: "parseConfig" },
    ]);
    await store.buildIndexes("proj");

    const res = await store.hybridSearch("proj", vec(1), "handleSearch", 5);
    expect(res.length).toBeGreaterThan(1);

    const scores = res.map((r) => r.score);
    // Every score must be a usable number in (0, 1].
    for (const s of scores) {
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    // The bug: all scores identical. A real ranking signal has spread.
    expect(new Set(scores).size).toBeGreaterThan(1);
    // Scores must agree with the order the reranker returned.
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });

  it("memoizes the RRFReranker instance — RRFReranker.create is called at most once across multiple hybridSearch calls", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [
      { id: "a", vector: vec(1), content: "function handleSearch(args) {}", source: "s.ts", module: "src", content_hash: "h1", updated_at: 1, symbol_name: "handleSearch" },
      { id: "b", vector: vec(9), content: "function unrelated(x) {}", source: "u.ts", module: "src", content_hash: "h2", updated_at: 1, symbol_name: "unrelated" },
    ]);
    await store.buildIndexes("proj");

    const createSpy = spyOn(rerankers.RRFReranker, "create");
    try {
      await store.hybridSearch("proj", vec(1), "handleSearch", 5);
      await store.hybridSearch("proj", vec(1), "handleSearch", 5);
      await store.hybridSearch("proj", vec(1), "handleSearch", 5);

      expect(createSpy.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      createSpy.mockRestore();
    }
  });
});
