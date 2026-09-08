import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runInit } from "../../src/commands/init.js";
import { readRegistry } from "../../src/store/project-registry.js";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    "git",
    ["-c", "user.email=t@t.t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf-8" }
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

async function makeRepo(dir: string, remote: string): Promise<void> {
  git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), "x\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "remote", "add", "origin", remote);
}

const initOpts = {
  skipGitHook: true,
  skipIndex: true,
  skipRules: true,
  skipClaudeHook: true,
};

describe("init inside a git worktree", () => {
  let dir: string;
  let repo: string;
  let dataDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-init-wt-"));
    repo = join(dir, "checkout");
    dataDir = join(dir, "data");
    await mkdir(repo);
    await mkdir(dataDir);
    await makeRepo(repo, "git@github.com:jcsoftdev/demo-repo.git");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the bare project id in the main checkout", async () => {
    const result = await runInit({ root: repo, dataDir, ...initOpts });
    expect(result.projectId).toBe("demo-repo");
  });

  it("scopes the project id to the worktree name in a linked worktree", async () => {
    const wt = join(repo, ".claude", "worktrees", "agent-a");
    git(repo, "worktree", "add", "-q", "-b", "task/one", wt);

    const result = await runInit({ root: wt, dataDir, ...initOpts });
    expect(result.projectId).toBe("demo-repo@agent-a");
  });

  it("records the worktree name in project.json", async () => {
    const wt = join(repo, "wt-b");
    git(repo, "worktree", "add", "-q", "-b", "task/two", wt);
    await runInit({ root: wt, dataDir, ...initOpts });

    const config = JSON.parse(
      await readFile(join(wt, ".project-brain", "project.json"), "utf-8")
    );
    expect(config.worktree).toBe("wt-b");
  });

  it("registers the worktree under its own id without clobbering the main entry", async () => {
    await runInit({ root: repo, dataDir, ...initOpts });
    const wt = join(repo, "wt-c");
    git(repo, "worktree", "add", "-q", "-b", "task/three", wt);
    await runInit({ root: wt, dataDir, ...initOpts });

    const registry = await readRegistry(dataDir);
    expect(registry["demo-repo"]?.root).toBe(repo);
    expect(registry["demo-repo@wt-c"]?.root).toBe(wt);
  });

  it("gives two worktrees of the same repo two different ids", async () => {
    const a = join(repo, "wt-one");
    const b = join(repo, "wt-two");
    git(repo, "worktree", "add", "-q", "-b", "t/a", a);
    git(repo, "worktree", "add", "-q", "-b", "t/b", b);

    const ra = await runInit({ root: a, dataDir, ...initOpts });
    const rb = await runInit({ root: b, dataDir, ...initOpts });
    expect(ra.projectId).not.toBe(rb.projectId);
  });

  it("preserves an existing projectId on re-init rather than re-deriving it", async () => {
    const wt = join(repo, "wt-d");
    git(repo, "worktree", "add", "-q", "-b", "t/d", wt);
    await runInit({ root: wt, dataDir, ...initOpts });
    const second = await runInit({ root: wt, dataDir, ...initOpts });

    expect(second.projectId).toBe("demo-repo@wt-d");
  });
});
