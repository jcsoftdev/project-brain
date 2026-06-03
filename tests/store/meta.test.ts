import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTableMeta, writeTableMeta } from "../../src/store/meta.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pb-meta-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("table meta", () => {
  it("returns null when absent", async () => {
    expect(await readTableMeta(dir, "proj")).toBeNull();
  });
  it("round-trips model + dim", async () => {
    await writeTableMeta(dir, "proj", { model: "nomic-embed-code", dim: 768 });
    expect(await readTableMeta(dir, "proj")).toEqual({ model: "nomic-embed-code", dim: 768 });
  });
});
