import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";

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
