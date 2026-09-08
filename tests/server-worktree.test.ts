import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createServer } from "../src/server.js";
import type { EmbeddingClient } from "../src/types.js";

const stubEmbeddings: EmbeddingClient = {
  dim: 768,
  model: "nomic-embed-text",
  embed: async () => null,
  isAvailable: async () => true,
};

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
  git(dir, "remote", "add", "origin", "git@github.com:jcsoftdev/demo-repo.git");
}

describe("server boot inside a git worktree", () => {
  let dir: string;
  let repo: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-srv-wt-"));
    repo = join(dir, "checkout");
    await mkdir(repo);
    await makeRepo(repo);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses to boot in a worktree that was never initialized", async () => {
    const wt = join(repo, "wt-a");
    git(repo, "worktree", "add", "-q", "-b", "t/a", wt);

    await expect(
      createServer({
        dbPath: join(dir, "data"),
        embeddings: stubEmbeddings,
        projectRoot: wt,
        dataDir: join(dir, "data"),
      })
    ).rejects.toThrow(/worktree/i);
  });

  it("names the worktree and the fix in the refusal", async () => {
    const wt = join(repo, "wt-b");
    git(repo, "worktree", "add", "-q", "-b", "t/b", wt);

    let message = "";
    try {
      await createServer({
        dbPath: join(dir, "data"),
        embeddings: stubEmbeddings,
        projectRoot: wt,
        dataDir: join(dir, "data"),
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("wt-b");
    expect(message).toContain("project-brain init");
  });

  it("does not leave an empty graph behind when it refuses", async () => {
    const wt = join(repo, "wt-c");
    git(repo, "worktree", "add", "-q", "-b", "t/c", wt);

    try {
      await createServer({
        dbPath: join(dir, "data"),
        embeddings: stubEmbeddings,
        projectRoot: wt,
        dataDir: join(dir, "data"),
      });
    } catch {
      // expected
    }
    expect(existsSync(join(wt, ".project-brain", "graph.db"))).toBe(false);
  });

  it("boots normally in a worktree that has been initialized", async () => {
    const wt = join(repo, "wt-d");
    git(repo, "worktree", "add", "-q", "-b", "t/d", wt);
    await mkdir(join(wt, ".project-brain"), { recursive: true });
    await writeFile(
      join(wt, ".project-brain", "project.json"),
      JSON.stringify({ projectId: "demo-repo@wt-d", worktree: "wt-d" })
    );

    const { server } = await createServer({
      dbPath: join(dir, "data"),
      embeddings: stubEmbeddings,
      projectRoot: wt,
      dataDir: join(dir, "data"),
    });
    expect(server).toBeDefined();
  });

  it("boots normally in the main checkout even with no .project-brain yet", async () => {
    const { server } = await createServer({
      dbPath: join(dir, "data"),
      embeddings: stubEmbeddings,
      projectRoot: repo,
      dataDir: join(dir, "data"),
    });
    expect(server).toBeDefined();
  });
});
