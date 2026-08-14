import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";

const DIM = 8;
const chunk = (i: number, source: string) => ({
  id: `c${i}`,
  vector: new Array(DIM).fill(i % 7),
  content: `function f${i}() {}`,
  source,
  module: "root",
  content_hash: `h${i}`,
  updated_at: 1,
});

/**
 * Exercises deleteBySources against a REAL LanceDB table.
 *
 * The predicate-builder unit tests cover string assembly; they cannot show
 * that the predicate actually deletes the right rows, nor that batching
 * reduces version count — which is the entire reason this exists.
 */
describe("deleteBySources against a real table", () => {
  let dir: string;
  let store: LanceDbStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-batchdel-"));
    store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "fake", dim: DIM });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const versionCount = async () =>
    (await readdir(join(dir, "proj_chunks.lance", "_versions"))).length;

  it("deletes exactly the named sources and leaves the rest", async () => {
    const chunks = [
      chunk(1, "src/keep.ts"),
      chunk(2, "src/gone-a.ts"),
      chunk(3, "src/gone-b.ts"),
    ];
    await store.batchReplace("proj", chunks.map((c) => c.source), chunks);

    await store.deleteBySources("proj", ["src/gone-a.ts", "src/gone-b.ts"]);

    const table = await (store as any).getTable("proj");
    const rows = await table.query().limit(100).toArray();
    expect(rows.map((r: any) => r.source)).toEqual(["src/keep.ts"]);
  });

  it("handles a source containing a single quote without corrupting the delete", async () => {
    const chunks = [chunk(1, "src/it's.ts"), chunk(2, "src/keep.ts")];
    await store.batchReplace("proj", chunks.map((c) => c.source), chunks);

    await store.deleteBySources("proj", ["src/it's.ts"]);

    const table = await (store as any).getTable("proj");
    const rows = await table.query().limit(100).toArray();
    expect(rows.map((r: any) => r.source)).toEqual(["src/keep.ts"]);
  });

  it("costs far fewer versions than deleting one source at a time", async () => {
    // The whole point: one lance delete = one version manifest. 600 sources
    // deleted individually cost 600 versions; batched at 500 they cost 2.
    const chunks = Array.from({ length: 600 }, (_, i) => chunk(i, `src/f${i}.ts`));
    await store.batchReplace("proj", chunks.map((c) => c.source), chunks);

    const before = await versionCount();
    await store.deleteBySources("proj", chunks.map((c) => c.source));
    const added = (await versionCount()) - before;

    expect(added).toBeLessThanOrEqual(3);

    const table = await (store as any).getTable("proj");
    expect(await table.countRows()).toBe(0);
  });

  it("is a no-op for an empty list", async () => {
    const chunks = [chunk(1, "src/keep.ts")];
    await store.batchReplace("proj", chunks.map((c) => c.source), chunks);
    const before = await versionCount();

    await store.deleteBySources("proj", []);

    expect(await versionCount()).toBe(before);
    const table = await (store as any).getTable("proj");
    expect(await table.countRows()).toBe(1);
  });
});
