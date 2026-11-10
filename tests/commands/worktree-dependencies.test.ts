import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { decideClone, type DependencyFingerprint } from "../../src/commands/worktree-dependencies.js";
import { createWorktree, type LifecycleDeps } from "../../src/commands/worktree-lifecycle.js";

const same: DependencyFingerprint = { lockfileHash: "aaa" };

describe("decideClone", () => {
  const cases: Array<[string, DependencyFingerprint | null, DependencyFingerprint | null, string | null]> = [
    ["identical", same, { ...same }, null],
    ["different lockfile", same, { ...same, lockfileHash: "bbb" }, "lockfile differs from the main checkout"],
    ["no lockfile in main", null, same, "no lockfile to compare"],
    ["no lockfile in worktree", same, null, "no lockfile to compare"],
  ];

  for (const [name, main, worktree, reason] of cases) {
    it(name, () => {
      const decision = decideClone(main, worktree);
      expect(decision.clone).toBe(reason === null);
      if (!decision.clone) expect(decision.reason).toBe(reason!);
    });
  }
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

describe("createWorktree dependency cloning", () => {
  let dir: string;
  let repo: string;
  let deps: LifecycleDeps;

  beforeEach(async () => {
    dir = realpathSync(await mkdtemp(join(tmpdir(), "pb-wt-deps-")));
    repo = join(dir, "checkout");
    await mkdir(repo);
    git(repo, "init", "-q", "-b", "main");
    await writeFile(join(repo, "bun.lock"), "lock\n");
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    await mkdir(join(repo, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(repo, "node_modules", "pkg", "index.js"), "original\n");
    deps = { spawn: spawnSync, cwd: repo, holders: () => [], now: Date.now, dropIndex: async () => {} };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("clones node_modules so a change in the worktree leaves the main checkout untouched", async () => {
    const { path, dependencies } = await createWorktree(deps, { name: "clone", init: async () => {} });
    if (!dependencies.cloned) {
      console.warn(`skipped independence check: ${dependencies.note}`);
      return;
    }
    const clonedFile = join(path, "node_modules", "pkg", "index.js");
    expect(await readFile(clonedFile, "utf-8")).toBe("original\n");

    await writeFile(clonedFile, "changed in worktree\n");
    await writeFile(join(path, "node_modules", "pkg", "added.js"), "new\n");

    expect(await readFile(join(repo, "node_modules", "pkg", "index.js"), "utf-8")).toBe("original\n");
    expect(existsSync(join(repo, "node_modules", "pkg", "added.js"))).toBe(false);
    expect(git(path, "status", "--porcelain")).toBe("");
  });

  it("keeps today's behavior and says why when the clone command fails", async () => {
    const failingCp = ((command: string, args: string[], options: object) =>
      command === "cp" ? { status: 1, stdout: "", stderr: "not supported" } : spawnSync(command, args, options)) as unknown as LifecycleDeps["spawn"];
    const { path, dependencies } = await createWorktree({ ...deps, spawn: failingCp }, { name: "nofs", init: async () => {} });

    if (process.platform === "darwin" || process.platform === "linux") {
      expect(dependencies.cloned).toBe(false);
      expect(dependencies.note).toContain("filesystem cannot clone (not supported)");
    }
    expect(existsSync(join(path, "node_modules"))).toBe(false);
  });

  it("does not clone when the worktree's lockfile differs from the main checkout's", async () => {
    await writeFile(join(repo, "bun.lock"), "lock v2\n");
    git(repo, "add", "bun.lock");
    git(repo, "commit", "-q", "-m", "bump");
    await writeFile(join(repo, "bun.lock"), "uncommitted edit\n");

    const { path, dependencies } = await createWorktree(deps, { name: "drift", init: async () => {} });

    expect(dependencies).toEqual({ cloned: false, note: "node_modules not cloned: lockfile differs from the main checkout" });
    expect(existsSync(join(path, "node_modules"))).toBe(false);
  });
});
