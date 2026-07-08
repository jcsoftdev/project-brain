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
