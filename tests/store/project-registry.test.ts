/**
 * The structural graph is a project-LOCAL file (<root>/.project-brain/graph.db)
 * while the vector store is a single global multi-project LanceDB. That
 * asymmetry is why the structural tools could not accept a `project` argument:
 * nothing mapped a project id back to its filesystem root. This registry is
 * that missing map.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRegistry,
  registerProject,
  lookupProjectRoot,
  PROJECTS_FILE,
} from "../../src/store/project-registry.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-registry-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readRegistry", () => {
  it("returns {} when the file does not exist", async () => {
    expect(await readRegistry(dir)).toEqual({});
  });

  it("returns {} on malformed JSON instead of throwing", async () => {
    await writeFile(join(dir, PROJECTS_FILE), "{ not json");
    expect(await readRegistry(dir)).toEqual({});
  });

  it("drops entries whose shape is wrong", async () => {
    await writeFile(
      join(dir, PROJECTS_FILE),
      JSON.stringify({ good: { root: "/a", updatedAt: 1 }, bad: "nope", alsoBad: { root: 42 } })
    );
    expect(Object.keys(await readRegistry(dir))).toEqual(["good"]);
  });
});

describe("registerProject", () => {
  /** Roots must exist on disk — lookupProjectRoot rejects dead paths by design. */
  async function realRoot(name: string): Promise<string> {
    const path = join(dir, "roots", name);
    await mkdir(path, { recursive: true });
    return path;
  }

  it("round-trips a project id to its root", async () => {
    const root = await realRoot("my-proj");
    await registerProject(dir, "my-proj", root, 1000);
    expect(await lookupProjectRoot(dir, "my-proj")).toBe(root);
  });

  it("creates the data directory when missing", async () => {
    const nested = join(dir, "deep", "data");
    const root = await realRoot("p");
    await registerProject(nested, "p", root, 1);
    expect(await lookupProjectRoot(nested, "p")).toBe(root);
  });

  it("updates the root when a project moves", async () => {
    const oldRoot = await realRoot("old");
    const newRoot = await realRoot("new");
    await registerProject(dir, "moved", oldRoot, 1);
    await registerProject(dir, "moved", newRoot, 2);
    expect(await lookupProjectRoot(dir, "moved")).toBe(newRoot);
  });

  it("keeps other projects intact", async () => {
    const rootA = await realRoot("a");
    const rootB = await realRoot("b");
    await registerProject(dir, "a", rootA, 1);
    await registerProject(dir, "b", rootB, 2);
    expect(await lookupProjectRoot(dir, "a")).toBe(rootA);
    expect(await lookupProjectRoot(dir, "b")).toBe(rootB);
  });

  it("marks a vanished root with missingSince instead of erasing the entry", async () => {
    // Erasing on sight had two costs. An absent root can mean an unmounted
    // volume, not a deleted repo; and the entry is the only record of which
    // stored table that data belongs to, so deleting it turned a reclaimable
    // orphan into storage nobody could attribute. `prune` acts on the stamp.
    const alive = await realRoot("alive");
    const doomed = await realRoot("doomed");
    await registerProject(dir, "alive", alive, 1);
    await registerProject(dir, "doomed", doomed, 2);

    await rm(doomed, { recursive: true, force: true });
    await registerProject(dir, "alive", alive, 3);

    const registry = await readRegistry(dir);
    expect(Object.keys(registry).sort()).toEqual(["alive", "doomed"]);
    expect(registry.doomed?.missingSince).toBe(3);
    expect(registry.alive?.missingSince).toBeUndefined();
  });

  it("never prunes the entry being registered", async () => {
    const root = await realRoot("self");
    await registerProject(dir, "self", root, 1);
    expect(await lookupProjectRoot(dir, "self")).toBe(root);
  });

  it("does not throw when the data dir is unwritable", async () => {
    const asFile = join(dir, "not-a-dir");
    await writeFile(asFile, "x");
    // Registration is a side benefit of init/sync — it must never break them.
    await expect(registerProject(asFile, "p", "/root/p", 1)).resolves.toBeUndefined();
  });
});

describe("lookupProjectRoot", () => {
  it("returns null for an unknown project", async () => {
    await registerProject(dir, "known", "/known", 1);
    expect(await lookupProjectRoot(dir, "unknown")).toBeNull();
  });

  it("returns null when the registry does not exist at all", async () => {
    expect(await lookupProjectRoot(dir, "anything")).toBeNull();
  });

  it("returns null when the recorded root no longer exists on disk", async () => {
    const gone = join(dir, "deleted-project");
    await mkdir(gone);
    await registerProject(dir, "gone", gone, 1);
    await rm(gone, { recursive: true, force: true });
    expect(await lookupProjectRoot(dir, "gone")).toBeNull();
  });
});
