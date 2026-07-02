import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { VECTOR_DIM } from "../../src/constants.js";
import type { Chunk } from "../../src/types.js";

let tmpDir: string;
let store: LanceDbStore;
const mk = (id: string, content: string): Chunk => ({
  id, vector: new Array(VECTOR_DIM).fill(0.1), content, source: id + ".ts",
  module: "src", content_hash: id, updated_at: 1,
});

describe("LanceDbStore.ftsSearch", () => {
  beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "brain-fts-")); store = new LanceDbStore(tmpDir); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it("finds exact identifiers without any vector/Ollama involvement", async () => {
    await store.ensureTable("demo");
    await store.upsert("demo", [mk("a", "export function chargeCard(amount) {}"), mk("b", "unrelated text about parsing")]);
    await store.buildIndexes("demo");
    const hits = await store.ftsSearch!("demo", "chargeCard", 5);
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe("a");
  });

  it("returns [] on empty table and non-existent project", async () => {
    await store.ensureTable("demo");
    expect(await store.ftsSearch!("demo", "x", 5)).toEqual([]);
    expect(await store.ftsSearch!("ghost", "x", 5)).toEqual([]);
  });
});
