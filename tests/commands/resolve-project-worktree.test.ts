import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { findProjectRoot } from "../../src/commands/resolve-project.js";

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

describe("findProjectRoot across a worktree boundary", () => {
  let dir: string;
  let repo: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-find-wt-"));
    repo = join(dir, "checkout");
    await mkdir(repo);
    await makeRepo(repo);
    // The main checkout IS initialized — that is what makes the bug reachable.
    await mkdir(join(repo, ".project-brain"), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("does not climb out of an uninitialized worktree into the main checkout", async () => {
    // EnterWorktree nests worktrees inside the main checkout, so a naive upward
    // walk finds main's marker and answers every structural query from main's
    // graph while the caller is on the worktree's branch.
    const wt = join(repo, ".claude", "worktrees", "agent-a");
    git(repo, "worktree", "add", "-q", "-b", "t/a", wt);

    expect(findProjectRoot(wt)).toBeNull();
  });

  it("does not climb out from a subdirectory of an uninitialized worktree either", async () => {
    const wt = join(repo, "wt-b");
    git(repo, "worktree", "add", "-q", "-b", "t/b", wt);
    const nested = join(wt, "src", "deep");
    await mkdir(nested, { recursive: true });

    expect(findProjectRoot(nested)).toBeNull();
  });

  it("returns the worktree's own root once it has been initialized", async () => {
    const wt = join(repo, "wt-c");
    git(repo, "worktree", "add", "-q", "-b", "t/c", wt);
    await mkdir(join(wt, ".project-brain"), { recursive: true });

    expect(findProjectRoot(join(wt, "src"))).toBe(wt);
  });

  it("still walks upward normally inside the main checkout", async () => {
    const nested = join(repo, "src", "commands", "deep");
    await mkdir(nested, { recursive: true });

    expect(findProjectRoot(nested)).toBe(repo);
  });
});
