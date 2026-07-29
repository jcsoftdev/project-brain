/**
 * Regression: a long-lived GraphStore must notice when its backing file was
 * replaced by another process and reopen it.
 *
 * Real-world failure this reproduces: the MCP server opens
 * `.project-brain/graph.db` once at startup (src/server.ts) and holds the
 * handle for the life of the process. When `reindex`/`init` (or the user)
 * rebuilds that file, the server keeps reading the now-unlinked inode and
 * serves pre-rebuild data forever. Observed live: `repo_map` over MCP kept
 * returning vendored node_modules symbols while the on-disk graph was already
 * clean, and only a server restart fixed it.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGraphDb } from "../../src/graph/db";
import { GraphStore } from "../../src/graph/store";

const sym = (name: string) => [
  { name, kind: "function", signature: `fn ${name}`, start_line: 1, end_line: 2, edges: [] },
];

describe("GraphStore reopens a replaced backing file", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-graph-reopen-"));
    path = join(dir, "graph.db");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function rebuildOnDisk(files: string[]): Promise<void> {
    await rm(path, { force: true });
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
    const fresh = new GraphStore(openGraphDb(path));
    for (const f of files) fresh.replaceFile(f, "typescript", "h", 1, sym(f.replace(/\W/g, "_")));
    fresh.close();
  }

  it("serves the rebuilt file's contents after an external rebuild", async () => {
    const store = new GraphStore(openGraphDb(path), path);
    store.replaceFile("before.ts", "typescript", "h", 1, sym("before"));
    expect(store.listFiles()).toEqual(["before.ts"]);

    await rebuildOnDisk(["after.ts"]);

    expect(store.listFiles()).toEqual(["after.ts"]);
    store.close();
  });

  it("reflects the rebuild through pageRank too, not just listFiles", async () => {
    const store = new GraphStore(openGraphDb(path), path);
    store.replaceFile("before.ts", "typescript", "h", 1, sym("before"));

    await rebuildOnDisk(["after.ts"]);

    const ranked = store.pageRank();
    expect(ranked.map((r) => r.file)).toEqual(["after.ts"]);
    store.close();
  });

  it("keeps its own writes visible when the file was NOT replaced", async () => {
    const store = new GraphStore(openGraphDb(path), path);
    store.replaceFile("a.ts", "typescript", "h", 1, sym("a"));
    store.replaceFile("b.ts", "typescript", "h", 1, sym("b"));

    // No external rebuild happened — a spurious reopen here would drop
    // anything still buffered and is exactly what we must not do.
    expect(store.listFiles().sort()).toEqual(["a.ts", "b.ts"]);
    store.close();
  });

  it("does not throw when the backing file disappears entirely", async () => {
    const store = new GraphStore(openGraphDb(path), path);
    store.replaceFile("gone.ts", "typescript", "h", 1, sym("gone"));

    await rm(path, { force: true });
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });

    expect(() => store.listFiles()).not.toThrow();
    store.close();
  });

  it("never reopens when constructed without a path (in-memory / injected db)", () => {
    const store = new GraphStore(openGraphDb(":memory:"));
    store.replaceFile("mem.ts", "typescript", "h", 1, sym("mem"));
    expect(store.listFiles()).toEqual(["mem.ts"]);
    store.close();
  });
});
