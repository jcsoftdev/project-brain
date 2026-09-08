import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { worktreeStatus } from "../../src/commands/worktree.js";

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

describe("worktreeStatus", () => {
  let dir: string;
  let repo: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-wt-status-"));
    repo = join(dir, "checkout");
    await mkdir(repo);
    await makeRepo(repo, "git@github.com:jcsoftdev/Demo-Repo.git");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports the main checkout with the port-registry pair and no scoping", async () => {
    const status = await worktreeStatus(repo);

    expect(status.worktree).toBe("main");
    expect(status.isMain).toBe(true);
    expect(status.project).toBe("demo-repo");
    expect(status.projectId).toBe("Demo-Repo");
  });

  it("reports a linked worktree with a scoped project id", async () => {
    const wt = join(repo, "wt-a");
    git(repo, "worktree", "add", "-q", "-b", "t/a", wt);

    const status = await worktreeStatus(wt);
    expect(status.worktree).toBe("wt-a");
    expect(status.isMain).toBe(false);
    expect(status.projectId).toBe("Demo-Repo@wt-a");
  });

  it("hands port-registry the SAME pair for every worktree of one repo", async () => {
    const wt = join(repo, "wt-b");
    git(repo, "worktree", "add", "-q", "-b", "t/b", wt);

    const main = await worktreeStatus(repo);
    const linked = await worktreeStatus(wt);
    expect(linked.project).toBe(main.project);
    expect(linked.worktree).not.toBe(main.worktree);
  });

  it("says a worktree is not indexed when it has no project.json", async () => {
    const wt = join(repo, "wt-c");
    git(repo, "worktree", "add", "-q", "-b", "t/c", wt);

    expect((await worktreeStatus(wt)).indexed).toBe(false);
  });

  it("says a worktree is indexed once init has written project.json", async () => {
    const wt = join(repo, "wt-d");
    git(repo, "worktree", "add", "-q", "-b", "t/d", wt);
    await mkdir(join(wt, ".project-brain"), { recursive: true });
    await writeFile(
      join(wt, ".project-brain", "project.json"),
      JSON.stringify({ projectId: "Demo-Repo@wt-d" })
    );

    const status = await worktreeStatus(wt);
    expect(status.indexed).toBe(true);
    expect(status.projectId).toBe("Demo-Repo@wt-d");
  });

  it("prefers the id recorded in project.json over a freshly derived one", async () => {
    const wt = join(repo, "wt-e");
    git(repo, "worktree", "add", "-q", "-b", "t/e", wt);
    await mkdir(join(wt, ".project-brain"), { recursive: true });
    await writeFile(
      join(wt, ".project-brain", "project.json"),
      JSON.stringify({ projectId: "renamed-by-hand@wt-e" })
    );

    expect((await worktreeStatus(wt)).projectId).toBe("renamed-by-hand@wt-e");
  });
});
