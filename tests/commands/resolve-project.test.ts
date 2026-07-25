import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join, basename } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  findProjectRoot,
  resolveProjectId,
  openProjectGraph,
} from "../../src/commands/resolve-project.js";
import { GRAPH_DB_FILE } from "../../src/constants.js";
import { openGraphDb } from "../../src/graph/db.js";
import { GraphStore } from "../../src/graph/store.js";

describe("findProjectRoot", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pb-resolve-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("returns the root when .project-brain/ exists at the start dir itself", async () => {
    await mkdir(join(dir, ".project-brain"));
    expect(findProjectRoot(dir)).toBe(dir);
  });

  it("walks upward through nested subdirectories to find the root", async () => {
    await mkdir(join(dir, ".project-brain"));
    const nested = join(dir, "src", "commands", "deep");
    await mkdir(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(dir);
  });

  it("returns null when no .project-brain/ exists anywhere up the tree", async () => {
    const nested = join(dir, "no-marker-here");
    await mkdir(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBeNull();
  });
});

describe("resolveProjectId", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pb-resolve-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("reads projectId from .project-brain/project.json when present", async () => {
    await mkdir(join(dir, ".project-brain"));
    await writeFile(
      join(dir, ".project-brain", "project.json"),
      JSON.stringify({ projectId: "my-configured-id" })
    );
    expect(await resolveProjectId(dir)).toBe("my-configured-id");
  });

  it("falls back to the root's basename when project.json is missing", async () => {
    expect(await resolveProjectId(dir)).toBe(basename(dir));
  });

  it("falls back to the root's basename when project.json has no projectId field", async () => {
    await mkdir(join(dir, ".project-brain"));
    await writeFile(join(dir, ".project-brain", "project.json"), JSON.stringify({ other: 1 }));
    expect(await resolveProjectId(dir)).toBe(basename(dir));
  });

  it("falls back to the root's basename when project.json is malformed JSON", async () => {
    await mkdir(join(dir, ".project-brain"));
    await writeFile(join(dir, ".project-brain", "project.json"), "{not valid json");
    expect(await resolveProjectId(dir)).toBe(basename(dir));
  });
});

describe("openProjectGraph", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pb-resolve-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("returns null when graph.db does not exist, WITHOUT creating one as a side effect", async () => {
    await mkdir(join(dir, ".project-brain"));
    const graphPath = join(dir, ".project-brain", GRAPH_DB_FILE);
    expect(existsSync(graphPath)).toBe(false);

    const result = openProjectGraph(dir);
    expect(result).toBeNull();

    // The critical guard: openGraphDb's { create: true } must NEVER be reached
    // when the file doesn't already exist.
    expect(existsSync(graphPath)).toBe(false);
  });

  it("returns a working GraphStore when graph.db already exists", async () => {
    await mkdir(join(dir, ".project-brain"));
    const graphPath = join(dir, ".project-brain", GRAPH_DB_FILE);
    // Pre-create a real graph.db with one symbol, as a prior `sync` would.
    const seedGraph = new GraphStore(openGraphDb(graphPath));
    seedGraph.replaceFile("a.ts", "ts", "hash-a", Date.now(), [
      { name: "foo", kind: "function", signature: "function foo(): void", start_line: 1, end_line: 2, edges: [] },
    ]);
    seedGraph.close();

    const graph = openProjectGraph(dir);
    expect(graph).not.toBeNull();
    expect(graph!.countSymbols()).toBe(1);
    graph!.close();
  });
});
