import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceDbStore } from "../../src/store/lancedb.js";
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
