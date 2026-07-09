import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";
import type { Chunk } from "../../src/types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pb-sym-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function vec(seed: number, dim = 4) {
  return Array.from({ length: dim }, (_, i) => Math.sin(seed + i));
}

const symbolChunk: Chunk = {
  id: "sym-1",
  vector: vec(1),
  content: "function handleSearch(args: SearchArgs): Promise<SearchResult[]> {}",
  source: "src/tools/search.ts",
  module: "src",
  content_hash: "abc123",
  updated_at: 1_000_000,
  symbol_name: "handleSearch",
  symbol_kind: "function",
  signature: "handleSearch(args: SearchArgs): Promise<SearchResult[]>",
  start_line: 18,
  end_line: 41,
};

describe("LanceDbStore symbol field round-trip", () => {
  it("getChunkById returns all 5 symbol fields after upsert", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [symbolChunk]);

    const got = await store.getChunkById("proj", "sym-1");
    expect(got).not.toBeNull();
    expect(got!.symbol_name).toBe("handleSearch");
    expect(got!.symbol_kind).toBe("function");
    expect(got!.signature).toBe("handleSearch(args: SearchArgs): Promise<SearchResult[]>");
    expect(got!.start_line).toBe(18);
    expect(got!.end_line).toBe(41);
  });

  it("hybridSearch result carries symbol_name after buildIndexes", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [
      symbolChunk,
      { id: "other", vector: vec(9), content: "function unrelated() {}", source: "src/other.ts", module: "src", content_hash: "def456", updated_at: 1 },
    ]);
    await store.buildIndexes("proj");

    const results = await store.hybridSearch("proj", vec(1), "handleSearch", 5);
    const match = results.find((r) => r.id === "sym-1");
    expect(match).toBeDefined();
    expect(match!.symbol_name).toBe("handleSearch");
  });

  it("getModuleChunks returns symbol fields", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [symbolChunk]);

    const chunks = await store.getModuleChunks("proj", "src");
    expect(chunks.length).toBe(1);
    expect(chunks[0].symbol_name).toBe("handleSearch");
    expect(chunks[0].symbol_kind).toBe("function");
    expect(chunks[0].start_line).toBe(18);
    expect(chunks[0].end_line).toBe(41);
  });

  it("batchReplace preserves symbol fields", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.batchReplace("proj", ["src/tools/search.ts"], [symbolChunk]);

    const got = await store.getChunkById("proj", "sym-1");
    expect(got).not.toBeNull();
    expect(got!.symbol_kind).toBe("function");
    expect(got!.start_line).toBe(18);
    expect(got!.end_line).toBe(41);
  });
});

describe("LanceDbStore degrades legacy/unknown symbol_kind on all read paths", () => {
  // Legacy pre-normalization chunks stored a raw keyword like "def"/"fn"
  // instead of the current SymbolKind union. upsert() writes symbol_kind
  // as a bare string (no validation on the write path), so casting through
  // Chunk here faithfully reproduces a row that predates normalization.
  const legacyChunk = {
    id: "legacy-1",
    vector: vec(2),
    content: "def handle_search(args): pass",
    source: "src/legacy.py",
    module: "src",
    content_hash: "legacy123",
    updated_at: 1_000_000,
    symbol_name: "handle_search",
    symbol_kind: "def",
    signature: "handle_search(args)",
    start_line: 1,
    end_line: 3,
  } as unknown as Chunk;

  it("search (vector-only) degrades legacy symbol_kind to unknown", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [legacyChunk]);

    const results = await store.search("proj", vec(2), 5);
    const match = results.find((r) => r.id === "legacy-1");
    expect(match).toBeDefined();
    expect(match!.symbol_kind).toBe("unknown");
  });

  it("hybridSearch degrades legacy symbol_kind to unknown", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [legacyChunk]);
    await store.buildIndexes("proj");

    const results = await store.hybridSearch("proj", vec(2), "handle_search", 5);
    const match = results.find((r) => r.id === "legacy-1");
    expect(match).toBeDefined();
    expect(match!.symbol_kind).toBe("unknown");
  });

  it("ftsSearch degrades legacy symbol_kind to unknown", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "m", dim: 4 });
    await store.upsert("proj", [legacyChunk]);
    await store.buildIndexes("proj");

    const results = await store.ftsSearch!("proj", "handle_search", 5);
    const match = results.find((r) => r.id === "legacy-1");
    expect(match).toBeDefined();
    expect(match!.symbol_kind).toBe("unknown");
  });
});
