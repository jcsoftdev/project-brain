import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";
import * as meta from "../../src/store/meta.js";
import { readTableMeta } from "../../src/store/meta.js";
import { VECTOR_DIM } from "../../src/constants.js";
import type { Chunk } from "../../src/types.js";

let tmpDir: string;
let store: LanceDbStore;

const mk = (id: string, content: string): Chunk => ({
  id, vector: new Array(VECTOR_DIM).fill(0.1), content, source: id + ".ts",
  module: "src", content_hash: id, updated_at: 1,
});

describe("LanceDbStore — listProjects / deleteProject", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "brain-projects-"));
    store = new LanceDbStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("lists all projects with chunk counts and meta", async () => {
    await store.ensureTable("alpha", { model: "nomic-embed-text", dim: VECTOR_DIM });
    await store.upsert("alpha", [mk("a1", "one"), mk("a2", "two")]);
    await store.ensureTable("beta", { model: "nomic-embed-text", dim: VECTOR_DIM });
    await store.upsert("beta", [mk("b1", "three")]);

    const projects = await store.listProjects!();
    const alpha = projects.find((p) => p.project === "alpha");
    const beta = projects.find((p) => p.project === "beta");

    expect(alpha).toBeDefined();
    expect(alpha!.chunks).toBe(2);
    expect(alpha!.model).toBe("nomic-embed-text");
    expect(alpha!.dim).toBe(VECTOR_DIM);
    expect(beta).toBeDefined();
    expect(beta!.chunks).toBe(1);
  });

  it("lists 3+ projects with correct per-project chunk counts and meta, preserving tableNames() order", async () => {
    // Created deliberately OUT of alphabetical order — tableNames() itself
    // returns names sorted, so the assertion below both proves per-project
    // data is correct AND that Promise.all-based concurrency doesn't scramble
    // result ordering (each result must land at the same index as its source
    // name in `names`, regardless of which promise settles first).
    await store.ensureTable("zeta", { model: "nomic-embed-text", dim: VECTOR_DIM });
    await store.upsert("zeta", [mk("z1", "one"), mk("z2", "two"), mk("z3", "three")]);
    await store.ensureTable("alpha", { model: "nomic-embed-text", dim: VECTOR_DIM });
    await store.upsert("alpha", [mk("a1", "one")]);
    await store.ensureTable("mid", { model: "nomic-embed-text", dim: VECTOR_DIM });
    await store.upsert("mid", [mk("m1", "one"), mk("m2", "two")]);

    const projects = await store.listProjects!();

    expect(projects.map((p) => p.project)).toEqual(["alpha", "mid", "zeta"]);
    expect(projects.map((p) => p.chunks)).toEqual([1, 2, 3]);
    for (const p of projects) {
      expect(p.model).toBe("nomic-embed-text");
      expect(p.dim).toBe(VECTOR_DIM);
    }
  });

  it("runs per-project countChunks + readTableMeta lookups concurrently, not sequentially", async () => {
    await store.ensureTable("alpha", { model: "m", dim: VECTOR_DIM });
    await store.upsert("alpha", [mk("a1", "one")]);
    await store.ensureTable("beta", { model: "m", dim: VECTOR_DIM });
    await store.upsert("beta", [mk("b1", "one")]);
    await store.ensureTable("gamma", { model: "m", dim: VECTOR_DIM });
    await store.upsert("gamma", [mk("g1", "one")]);

    // Delay each readTableMeta call so overlapping (concurrent) calls are
    // observable: if listProjects awaited each project sequentially, total
    // elapsed time would be >= 3 * delay. Run concurrently, it should be
    // close to a single delay.
    // Capture the REAL implementation before spying — spyOn replaces the
    // module-namespace property, so referencing the imported binding after
    // installing the spy would recurse into the mock itself.
    const DELAY_MS = 60;
    const realReadTableMeta = meta.readTableMeta;
    const readTableMetaSpy = spyOn(meta, "readTableMeta").mockImplementation(
      async (dbPath: string, project: string) => {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        return realReadTableMeta(dbPath, project);
      }
    );

    try {
      const start = performance.now();
      await store.listProjects!();
      const elapsed = performance.now() - start;

      expect(readTableMetaSpy.mock.calls.length).toBe(3);
      // Sequential would take >= 3 * DELAY_MS (~180ms); concurrent should
      // stay well under 2 * DELAY_MS. Generous margin to avoid CI flakiness.
      expect(elapsed).toBeLessThan(DELAY_MS * 2.5);
    } finally {
      readTableMetaSpy.mockRestore();
    }
  });

  it("deletes a project's table + meta; second call returns false", async () => {
    await store.ensureTable("alpha");
    await store.upsert("alpha", [mk("a1", "one")]);
    await store.ensureTable("beta");
    await store.upsert("beta", [mk("b1", "two")]);

    const result = await store.deleteProject!("alpha");
    expect(result).toBe(true);

    const projects = await store.listProjects!();
    expect(projects.find((p) => p.project === "alpha")).toBeUndefined();
    expect(projects.find((p) => p.project === "beta")).toBeDefined();

    expect(await readTableMeta(tmpDir, "alpha")).toBeNull();

    const second = await store.deleteProject!("alpha");
    expect(second).toBe(false);
  });
});
