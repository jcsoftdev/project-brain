import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pruneWorktrees } from "../../src/commands/worktree.js";
import { readRegistry, registerProject } from "../../src/store/project-registry.js";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    "git",
    ["-c", "user.email=t@t.t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf-8" }
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

async function makeRepo(dir: string): Promise<void> {
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), "x\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
}

/** Records what was dropped so the test can assert on the storage side too. */
function fakeStore() {
  const dropped: string[] = [];
  return {
    dropped,
    deleteProject: async (project: string) => {
      dropped.push(project);
      return true;
    },
  };
}

describe("pruneWorktrees", () => {
  let dir: string;
  let repo: string;
  let dataDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-wt-prune-"));
    repo = join(dir, "checkout");
    dataDir = join(dir, "data");
    await mkdir(repo);
    await mkdir(dataDir);
    await makeRepo(repo);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a scoped index whose worktree is still live", async () => {
    const wt = join(repo, "wt-live");
    git(repo, "worktree", "add", "-q", "-b", "t/live", wt);
    await registerProject(dataDir, "demo@wt-live", wt);

    const store = fakeStore();
    const report = await pruneWorktrees({ dataDir, store });

    expect(store.dropped).toEqual([]);
    expect(report.kept.map((k) => k.projectId)).toContain("demo@wt-live");
  });

  it("reclaims a scoped index whose worktree directory is gone", async () => {
    const wt = join(repo, "wt-gone");
    git(repo, "worktree", "add", "-q", "-b", "t/gone", wt);
    await registerProject(dataDir, "demo@wt-gone", wt);
    git(repo, "worktree", "remove", "--force", wt);

    const store = fakeStore();
    const report = await pruneWorktrees({ dataDir, store });

    expect(store.dropped).toEqual(["demo@wt-gone"]);
    expect(report.reclaimed.map((r) => r.projectId)).toEqual(["demo@wt-gone"]);
  });

  it("removes the reclaimed entry from the registry", async () => {
    const wt = join(repo, "wt-x");
    git(repo, "worktree", "add", "-q", "-b", "t/x", wt);
    await registerProject(dataDir, "demo@wt-x", wt);
    git(repo, "worktree", "remove", "--force", wt);

    await pruneWorktrees({ dataDir, store: fakeStore() });

    expect(await readRegistry(dataDir)).not.toHaveProperty("demo@wt-x");
  });

  it("never touches an unscoped project, even one whose root is gone", async () => {
    const dead = join(dir, "deleted-main");
    await mkdir(dead);
    await registerProject(dataDir, "demo", dead);
    await rm(dead, { recursive: true, force: true });

    const store = fakeStore();
    await pruneWorktrees({ dataDir, store });

    expect(store.dropped).toEqual([]);
    expect(await readRegistry(dataDir)).toHaveProperty("demo");
  });

  it("reports without deleting when dryRun is set", async () => {
    const wt = join(repo, "wt-dry");
    git(repo, "worktree", "add", "-q", "-b", "t/dry", wt);
    await registerProject(dataDir, "demo@wt-dry", wt);
    git(repo, "worktree", "remove", "--force", wt);

    const store = fakeStore();
    const report = await pruneWorktrees({ dataDir, store, dryRun: true });

    expect(report.reclaimed.map((r) => r.projectId)).toEqual(["demo@wt-dry"]);
    expect(store.dropped).toEqual([]);
    expect(await readRegistry(dataDir)).toHaveProperty("demo@wt-dry");
  });

  it("reclaims a scoped index whose root exists but is no longer a worktree", async () => {
    // `git worktree remove` deletes the directory, but a crashed run can leave
    // the directory behind with git no longer tracking it. git is the authority.
    const wt = join(repo, "wt-orphan");
    git(repo, "worktree", "add", "-q", "-b", "t/orphan", wt);
    await registerProject(dataDir, "demo@wt-orphan", wt);
    git(repo, "worktree", "remove", "--force", wt);
    await mkdir(wt, { recursive: true });

    const store = fakeStore();
    await pruneWorktrees({ dataDir, store });

    expect(store.dropped).toEqual(["demo@wt-orphan"]);
  });
});
