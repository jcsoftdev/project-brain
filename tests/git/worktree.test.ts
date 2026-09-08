import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join, basename } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { detectGitContext, listLiveWorktrees } from "../../src/git/worktree.js";

/** Run git with identity flags so commits work on a bare CI machine. */
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    "git",
    ["-c", "user.email=t@t.t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf-8" }
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A real repo with one commit, so `git worktree add` has something to point at. */
async function makeRepo(dir: string): Promise<void> {
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), "x\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
}

describe("detectGitContext", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-wt-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the main checkout as worktree \"main\" regardless of the branch", async () => {
    const repo = join(dir, "myrepo");
    await mkdir(repo);
    await makeRepo(repo);
    git(repo, "checkout", "-q", "-b", "feature/x");

    const ctx = detectGitContext(repo);
    expect(ctx.worktree).toBe("main");
    expect(ctx.isMain).toBe(true);
  });

  it("names a linked worktree by its directory basename, not its branch", async () => {
    const repo = join(dir, "myrepo");
    await mkdir(repo);
    await makeRepo(repo);
    const wt = join(repo, ".claude", "worktrees", "agent-a");
    git(repo, "worktree", "add", "-q", "-b", "task/one", wt);

    const ctx = detectGitContext(wt);
    expect(ctx.worktree).toBe("agent-a");
    expect(ctx.isMain).toBe(false);
  });

  it("keeps the worktree id stable when the branch inside it changes", async () => {
    const repo = join(dir, "myrepo");
    await mkdir(repo);
    await makeRepo(repo);
    const wt = join(repo, "wt-b");
    git(repo, "worktree", "add", "-q", "-b", "task/two", wt);
    const before = detectGitContext(wt).worktree;
    git(wt, "checkout", "-q", "-b", "task/three");

    expect(detectGitContext(wt).worktree).toBe(before);
  });

  it("derives the project from the origin remote, lowercased", async () => {
    const repo = join(dir, "some-dir-name");
    await mkdir(repo);
    await makeRepo(repo);
    git(repo, "remote", "add", "origin", "git@github.com:jcsoftdev/Project-Brain.git");

    expect(detectGitContext(repo).project).toBe("project-brain");
  });

  it("falls back to the main checkout's directory name when there is no remote", async () => {
    const repo = join(dir, "NoRemote");
    await mkdir(repo);
    await makeRepo(repo);

    expect(detectGitContext(repo).project).toBe("noremote");
  });

  it("gives a linked worktree the same project as its main checkout", async () => {
    const repo = join(dir, "myrepo");
    await mkdir(repo);
    await makeRepo(repo);
    git(repo, "remote", "add", "origin", "https://github.com/jcsoftdev/shared-name.git");
    const wt = join(repo, "wt-c");
    git(repo, "worktree", "add", "-q", "-b", "task/four", wt);

    expect(detectGitContext(wt).project).toBe(detectGitContext(repo).project);
  });

  it("treats a directory outside any repo as a main checkout named after itself", async () => {
    const plain = join(dir, "Plain-Dir");
    await mkdir(plain);

    const ctx = detectGitContext(plain);
    expect(ctx.worktree).toBe("main");
    expect(ctx.isMain).toBe(true);
    expect(ctx.project).toBe("plain-dir");
  });

  it("treats a submodule as a main checkout, not a worktree", async () => {
    // A submodule also has git-dir != git-common-dir, which is exactly the
    // test for a linked worktree. Without the superproject guard every
    // submodule would be indexed as a throwaway worktree of its parent.
    const outer = join(dir, "outer");
    const inner = join(dir, "inner");
    await mkdir(outer);
    await mkdir(inner);
    await makeRepo(outer);
    await makeRepo(inner);

    const r = spawnSync(
      "git",
      ["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "sub"],
      { cwd: outer, encoding: "utf-8" }
    );
    if (r.status !== 0) throw new Error(`submodule add: ${r.stderr}`);

    const ctx = detectGitContext(join(outer, "sub"));
    expect(ctx.isMain).toBe(true);
    expect(ctx.worktree).toBe("main");
  });

  it("reports the worktree's own toplevel as root", async () => {
    const repo = join(dir, "myrepo");
    await mkdir(repo);
    await makeRepo(repo);
    const wt = join(repo, "wt-d");
    git(repo, "worktree", "add", "-q", "-b", "task/five", wt);

    expect(basename(detectGitContext(wt).root)).toBe("wt-d");
  });
});

describe("listLiveWorktrees", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-wt-list-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the main checkout as \"main\" plus every linked worktree by basename", async () => {
    const repo = join(dir, "myrepo");
    await mkdir(repo);
    await makeRepo(repo);
    git(repo, "worktree", "add", "-q", "-b", "t/a", join(repo, "wt-a"));
    git(repo, "worktree", "add", "-q", "-b", "t/b", join(repo, "wt-b"));

    expect(listLiveWorktrees(repo).sort()).toEqual(["main", "wt-a", "wt-b"]);
  });

  it("returns an empty list outside a repo", async () => {
    expect(listLiveWorktrees(dir)).toEqual([]);
  });
});
