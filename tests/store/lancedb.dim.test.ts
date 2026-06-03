import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";
import { readTableMeta } from "../../src/store/meta.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pb-lance-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("ensureTable dim metadata", () => {
  it("persists model + dim and creates a vector of that dim", async () => {
    const store = new LanceDbStore(dir);
    await store.ensureTable("proj", { model: "nomic-embed-code", dim: 4 });
    expect(await readTableMeta(dir, "proj")).toEqual({ model: "nomic-embed-code", dim: 4 });
  });
});
