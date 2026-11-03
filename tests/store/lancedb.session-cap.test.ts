import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore, resolveLanceCacheBytes } from "../../src/store/lancedb.js";
import type { Chunk } from "../../src/types.js";

const MB = 1024n * 1024n;
const DIM = 8;

describe("resolveLanceCacheBytes", () => {
  it("defaults to 128 MB index and 32 MB metadata", () => {
    expect(resolveLanceCacheBytes({})).toEqual({ index: 128n * MB, metadata: 32n * MB });
  });

  it("honours valid overrides", () => {
    const env = { BRAIN_LANCE_INDEX_CACHE_MB: "64", BRAIN_LANCE_METADATA_CACHE_MB: "8" };
    expect(resolveLanceCacheBytes(env)).toEqual({ index: 64n * MB, metadata: 8n * MB });
  });

  it.each(["0", "-5", "abc", "NaN", "", "1.5"])("falls back on invalid value %p", (bad) => {
    const env = { BRAIN_LANCE_INDEX_CACHE_MB: bad, BRAIN_LANCE_METADATA_CACHE_MB: bad };
    expect(resolveLanceCacheBytes(env)).toEqual({ index: 128n * MB, metadata: 32n * MB });
  });
});

describe("LanceDbStore session cache cap", () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-sessioncap-"));
    process.env.BRAIN_LANCE_INDEX_CACHE_MB = "1";
    process.env.BRAIN_LANCE_METADATA_CACHE_MB = "1";
  });

  afterEach(async () => {
    process.env.BRAIN_LANCE_INDEX_CACHE_MB = saved.BRAIN_LANCE_INDEX_CACHE_MB;
    process.env.BRAIN_LANCE_METADATA_CACHE_MB = saved.BRAIN_LANCE_METADATA_CACHE_MB;
    if (saved.BRAIN_LANCE_INDEX_CACHE_MB === undefined) delete process.env.BRAIN_LANCE_INDEX_CACHE_MB;
    if (saved.BRAIN_LANCE_METADATA_CACHE_MB === undefined) delete process.env.BRAIN_LANCE_METADATA_CACHE_MB;
    await rm(dir, { recursive: true, force: true });
  });

  const chunk = (i: number): Chunk => ({
    id: `f${i % 20}::${i}`,
    vector: Array.from({ length: DIM }, (_, d) => Math.sin(i * 7 + d)),
    content: `content ${i}`,
    source: `f${i % 20}.ts`,
    module: "core",
    content_hash: `h${i}`,
    updated_at: Date.now(),
  });

  it("keeps the connection's session within the configured cap across write+search cycles", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "fake", dim: DIM });

    // Caps total 2 MB; a non-trivial peak proves the connection is bound to this session.
    let peak = 0n;
    for (let i = 0; i < 60; i++) {
      const batch = Array.from({ length: 50 }, (_, j) => chunk(i * 50 + j));
      await store.batchReplace("proj", [`f${i % 20}.ts`], batch);
      await store.search("proj", batch[0]!.vector, 5);
      const size = store.session!.sizeBytes();
      if (size > peak) peak = size;
    }

    expect(peak).toBeGreaterThan(64n * 1024n);
    expect(peak).toBeLessThanOrEqual(2n * MB);
  }, 15_000);
});
