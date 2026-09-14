import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { decideSeed, seedWorktreeIndex } from "../../src/store/worktree-seed.js";

const qwen = { model: "qwen3-embedding:0.6b", dim: 1024 };

describe("decideSeed", () => {
  const ready = {
    isMain: false,
    worktreeIndexed: false,
    baseIndexed: true,
    baseMeta: qwen,
    target: qwen,
  };

  it("allows a fresh worktree whose base is indexed with the same embeddings", () => {
    expect(decideSeed(ready)).toBeNull();
  });

  it("refuses the main checkout, which has nothing to copy from", () => {
    expect(decideSeed({ ...ready, isMain: true })).toBe("not-a-worktree");
  });

  it("refuses a worktree that already has an index, rather than clobbering it", () => {
    expect(decideSeed({ ...ready, worktreeIndexed: true })).toBe("already-indexed");
  });

  it("refuses when the base was never indexed", () => {
    expect(decideSeed({ ...ready, baseIndexed: false })).toBe("no-base-index");
    expect(decideSeed({ ...ready, baseMeta: null })).toBe("no-base-index");
  });

  it("refuses when the base vectors came from another model or dimension", () => {
    expect(decideSeed({ ...ready, target: { model: "nomic-embed-text", dim: 768 } })).toBe(
      "embedding-mismatch",
    );
    expect(decideSeed({ ...ready, target: { ...qwen, dim: 768 } })).toBe("embedding-mismatch");
  });

  it("allows when this run cannot name its model, since the dimension still agrees", () => {
    expect(decideSeed({ ...ready, target: { dim: 1024 } })).toBeNull();
  });
});

describe("seedWorktreeIndex", () => {
  let dir: string;
  let dbPath: string;
  let baseRoot: string;
  let worktreeRoot: string;

  const rows = (path: string) => {
    const db = new Database(path, { readonly: true });
    try {
      return (db.query("SELECT count(*) AS c FROM manifest_files").get() as { c: number }).c;
    } finally {
      db.close();
    }
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-seed-"));
    dbPath = join(dir, "data");
    baseRoot = join(dir, "repo");
    worktreeRoot = join(dir, "repo", ".worktrees", "feature");
    await mkdir(join(dbPath, "base_chunks.lance", "data"), { recursive: true });
    await mkdir(join(baseRoot, ".project-brain"), { recursive: true });
    await mkdir(join(worktreeRoot, ".project-brain"), { recursive: true });

    await writeFile(join(dbPath, "base_chunks.lance", "data", "frag.lance"), "vectors");
    await writeFile(join(dbPath, "base.meta.json"), JSON.stringify(qwen));

    const manifest = new Database(join(baseRoot, ".project-brain", "manifest.db"));
    manifest.run("CREATE TABLE manifest_files (path TEXT PRIMARY KEY, hash TEXT, mtime INTEGER)");
    manifest.run("INSERT INTO manifest_files VALUES ('src/a.ts', 'h1', 1), ('src/b.ts', 'h2', 2)");
    manifest.close();

    const graph = new Database(join(baseRoot, ".project-brain", "graph.db"));
    graph.run("CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT)");
    graph.run("INSERT INTO files VALUES (1, 'src/a.ts')");
    graph.close();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const seed = (overrides: Record<string, unknown> = {}) =>
    seedWorktreeIndex({
      dbPath,
      baseRoot,
      worktreeRoot,
      baseProject: "base",
      worktreeProject: "base@feature",
      isMain: false,
      target: qwen,
      ...overrides,
    });

  it("copies the vectors, the meta, the manifest and the graph", async () => {
    const outcome = await seed();

    expect(outcome.seeded).toBe(true);
    expect(
      await readFile(join(dbPath, "base_feature_chunks.lance", "data", "frag.lance"), "utf8"),
    ).toBe("vectors");
    expect(JSON.parse(await readFile(join(dbPath, "base_feature.meta.json"), "utf8"))).toEqual(qwen);
    expect(rows(join(worktreeRoot, ".project-brain", "manifest.db"))).toBe(2);
    expect(existsSync(join(worktreeRoot, ".project-brain", "graph.db"))).toBe(true);
  });

  it("reports why it declined, and writes nothing, when the embeddings disagree", async () => {
    const outcome = await seed({ target: { model: "nomic-embed-text", dim: 768 } });

    expect(outcome).toEqual({ seeded: false, reason: "embedding-mismatch" });
    expect(existsSync(join(dbPath, "base_feature_chunks.lance"))).toBe(false);
    expect(existsSync(join(worktreeRoot, ".project-brain", "manifest.db"))).toBe(false);
  });

  it("leaves an existing worktree index alone", async () => {
    const existing = join(worktreeRoot, ".project-brain", "manifest.db");
    await writeFile(existing, "do not touch");

    expect(await seed()).toEqual({ seeded: false, reason: "already-indexed" });
    expect(await readFile(existing, "utf8")).toBe("do not touch");
  });

  it("declines rather than throwing when the base has no table on disk", async () => {
    await rm(join(dbPath, "base_chunks.lance"), { recursive: true, force: true });
    expect(await seed()).toEqual({ seeded: false, reason: "no-base-index" });
  });

  it("leaves no half-copied table behind when the copy cannot be verified", async () => {
    const outcome = await seed({ verify: async () => false });

    expect(outcome).toEqual({ seeded: false, reason: "unverifiable-copy" });
    expect(existsSync(join(dbPath, "base_feature_chunks.lance"))).toBe(false);
    expect(existsSync(join(worktreeRoot, ".project-brain", "manifest.db"))).toBe(false);
  });

  it("copies a manifest that is mid-write without tearing it", async () => {
    const live = new Database(join(baseRoot, ".project-brain", "manifest.db"));
    live.run("PRAGMA journal_mode = WAL");
    live.run("INSERT INTO manifest_files VALUES ('src/c.ts', 'h3', 3)");

    const outcome = await seed();
    live.close();

    expect(outcome.seeded).toBe(true);
    expect(rows(join(worktreeRoot, ".project-brain", "manifest.db"))).toBe(3);
  });
});
