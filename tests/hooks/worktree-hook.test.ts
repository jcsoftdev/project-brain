import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { buildWorktreeNotice } from "../../src/hooks/worktree-hook.js";

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
  git(dir, "remote", "add", "origin", "git@github.com:jcsoftdev/demo-app.git");
}

function context(payload: string): string {
  return JSON.parse(payload).hookSpecificOutput.additionalContext as string;
}

describe("buildWorktreeNotice", () => {
  let dir: string;
  let repo: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-wt-hook-"));
    repo = join(dir, "checkout");
    await mkdir(repo);
    await makeRepo(repo);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("states the isolation rule in a main checkout", async () => {
    // The host has to weigh a worktree BEFORE delegating, and it will not read a
    // skill it never thought to look for. The rule lands in context once per session.
    const text = context((await buildWorktreeNotice(repo))!);
    expect(text).toContain("brain-worktree");
    expect(text).toContain("port_acquire");
  });

  it("keeps the main-checkout notice short — it is paid for every session", async () => {
    const text = context((await buildWorktreeNotice(repo))!);
    expect(text.length).toBeLessThan(700);
  });

  it("does not claim a main checkout is a worktree", async () => {
    const text = context((await buildWorktreeNotice(repo))!);
    expect(text).not.toContain("You are in the git worktree");
  });

  it("says nothing outside a repository", async () => {
    // No repo, no worktrees, no rule worth stating.
    expect(await buildWorktreeNotice(dir)).toBeNull();
  });

  it("emits a SessionStart payload inside a linked worktree", async () => {
    const wt = join(repo, "wt-a");
    git(repo, "worktree", "add", "-q", "-b", "t/a", wt);

    const payload = await buildWorktreeNotice(wt);
    expect(payload).not.toBeNull();
    expect(JSON.parse(payload!).hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  it("carries the port-registry pair so the agent never guesses a port", async () => {
    const wt = join(repo, "wt-b");
    git(repo, "worktree", "add", "-q", "-b", "t/b", wt);

    const text = context((await buildWorktreeNotice(wt))!);
    expect(text).toContain('project="demo-app"');
    expect(text).toContain('worktree="wt-b"');
  });

  it("warns that the brain is unusable when the worktree was never initialized", async () => {
    const wt = join(repo, "wt-c");
    git(repo, "worktree", "add", "-q", "-b", "t/c", wt);

    const text = context((await buildWorktreeNotice(wt))!);
    expect(text).toContain("project-brain init");
  });

  it("reports the scoped projectId once the worktree is initialized", async () => {
    const wt = join(repo, "wt-d");
    git(repo, "worktree", "add", "-q", "-b", "t/d", wt);
    await mkdir(join(wt, ".project-brain"), { recursive: true });
    await writeFile(
      join(wt, ".project-brain", "project.json"),
      JSON.stringify({ projectId: "demo-app@wt-d" })
    );

    const text = context((await buildWorktreeNotice(wt))!);
    expect(text).toContain("demo-app@wt-d");
    expect(text).not.toContain("project-brain init");
  });
});
