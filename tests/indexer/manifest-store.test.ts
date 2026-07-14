import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestStore } from "../../src/indexer/manifest-store.js";

describe("ManifestStore", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "pb-manifest-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("round-trips a file entry with chunk hashes", () => {
    const s = new ManifestStore(root);
    s.upsertFile("src/a.ts", "h1", 111, { "c-0": "x1", "c-1": "x2" });
    expect(s.getEntry("src/a.ts")).toEqual({ hash: "h1", mtime: 111, chunks: { "c-0": "x1", "c-1": "x2" } });
    expect(s.getEntry("missing.ts")).toBeNull();
    s.close();
  });

  it("upsert replaces stale chunk rows (no orphans)", () => {
    const s = new ManifestStore(root);
    s.upsertFile("src/a.ts", "h1", 1, { "c-0": "x1", "c-1": "x2" });
    s.upsertFile("src/a.ts", "h2", 2, { "c-0": "y1" });          // one chunk now
    expect(s.getEntry("src/a.ts")).toEqual({ hash: "h2", mtime: 2, chunks: { "c-0": "y1" } });
    s.close();
  });

  it("deleteFile cascades chunks; listPaths and clear work", () => {
    const s = new ManifestStore(root);
    s.upsertFile("a.ts", "h", 1, { c: "x" });
    s.upsertFile("b.ts", "h", 1, { c: "x" });
    s.deleteFile("a.ts");
    expect(s.listPaths()).toEqual(["b.ts"]);
    s.clear();
    expect(s.listPaths()).toEqual([]);
    s.close();
  });

  it("migrates an existing hashes.json once, then renames it to .bak", async () => {
    await mkdir(join(root, ".project-brain"), { recursive: true });
    await writeFile(
      join(root, ".project-brain", "hashes.json"),
      JSON.stringify({ "old.ts": { hash: "oh", mtime: 5, chunks: { "old-0": "och" } }, "legacy.ts": "barehash" })
    );
    const s = new ManifestStore(root);
    expect(s.getEntry("old.ts")).toEqual({ hash: "oh", mtime: 5, chunks: { "old-0": "och" } });
    expect(s.getEntry("legacy.ts")).toEqual({ hash: "barehash", mtime: 0, chunks: {} }); // legacy string form
    await access(join(root, ".project-brain", "hashes.json.bak"));                      // original renamed
    s.close();
  });

  it("swallows an unreadable legacy hashes.json (worst case: full re-sync)", async () => {
    await mkdir(join(root, ".project-brain"), { recursive: true });
    await writeFile(join(root, ".project-brain", "hashes.json"), "{ not valid json");
    let s: ManifestStore | undefined;
    expect(() => { s = new ManifestStore(root); }).not.toThrow();
    expect(s!.listPaths()).toEqual([]);
    s!.close();
  });
});
