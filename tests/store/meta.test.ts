import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTableMeta, writeTableMeta, deleteTableMeta } from "../../src/store/meta.js";

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
  it("deleteTableMeta removes the file; safe to call again when absent", async () => {
    await writeTableMeta(dir, "proj", { model: "m", dim: 1 });
    await deleteTableMeta(dir, "proj");
    expect(await readTableMeta(dir, "proj")).toBeNull();
    await deleteTableMeta(dir, "proj"); // no throw when already gone
  });
});
