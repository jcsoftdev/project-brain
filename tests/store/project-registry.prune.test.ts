import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  readRegistry,
  registerProject,
  PROJECTS_FILE,
} from "../../src/store/project-registry.js";

describe("registry marks missing roots instead of erasing them", () => {
  let dataDir: string;
  let liveRoot: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "pb-registry-"));
    liveRoot = await mkdtemp(join(tmpdir(), "pb-live-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await rm(liveRoot, { recursive: true, force: true });
  });

  async function seed(registry: Record<string, unknown>) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, PROJECTS_FILE),
      JSON.stringify(registry, null, 2),
      "utf-8"
    );
  }

  it("keeps an entry whose root has vanished, stamping missingSince", async () => {
    // Erasing it drops the only record of which table that data belonged to,
    // so the storage becomes an unattributable orphan nobody can safely prune.
    await seed({ gone: { root: "/nope/not/here", updatedAt: 1 } });

    await registerProject(dataDir, "live", liveRoot, 5_000);

    const registry = await readRegistry(dataDir);
    expect(registry.gone).toBeDefined();
    expect(registry.gone?.missingSince).toBe(5_000);
  });

  it("does not re-stamp missingSince on later runs", async () => {
    await seed({ gone: { root: "/nope", updatedAt: 1, missingSince: 100 } });

    await registerProject(dataDir, "live", liveRoot, 9_000);

    expect((await readRegistry(dataDir)).gone?.missingSince).toBe(100);
  });

  it("clears missingSince when the root comes back", async () => {
    // The unmounted-drive case: absence is not proof of deletion.
    await seed({ back: { root: liveRoot, updatedAt: 1, missingSince: 100 } });

    await registerProject(dataDir, "other", liveRoot, 9_000);

    expect((await readRegistry(dataDir)).back?.missingSince).toBeUndefined();
  });

  it("leaves a present root untouched", async () => {
    await seed({ here: { root: liveRoot, updatedAt: 1 } });

    await registerProject(dataDir, "here", liveRoot, 7_000);

    const entry = (await readRegistry(dataDir)).here;
    expect(entry?.root).toBe(liveRoot);
    expect(entry?.missingSince).toBeUndefined();
  });
});
