/**
 * `init` is the one moment project-brain knows both a project's id AND its
 * filesystem root. If it does not record that pair, nothing else can: the
 * structural graph is project-local and there is no other index of roots.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/commands/init.js";
import { lookupProjectRoot, readRegistry } from "../../src/store/project-registry.js";

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pb-init-reg-root-"));
  dataDir = await mkdtemp(join(tmpdir(), "pb-init-reg-data-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

const opts = { skipGitHook: true, skipRules: true, skipIndex: true, skipClaudeHook: true };

describe("runInit registers the project root", () => {
  it("records projectId → root so other roots can resolve it", async () => {
    const result = await runInit({ root, dataDir, ...opts });
    expect(await lookupProjectRoot(dataDir, result.projectId)).toBe(root);
  });

  it("is idempotent — re-running does not duplicate or corrupt the entry", async () => {
    const first = await runInit({ root, dataDir, ...opts });
    await runInit({ root, dataDir, ...opts });

    const registry = await readRegistry(dataDir);
    expect(Object.keys(registry)).toEqual([first.projectId]);
    expect(registry[first.projectId]?.root).toBe(root);
  });

  it("still succeeds when the registry cannot be written", async () => {
    // A registry failure must never take down init.
    const result = await runInit({ root, dataDir: join(root, ".project-brain", "project.json"), ...opts });
    expect(result.projectId.length).toBeGreaterThan(0);
  });
});
