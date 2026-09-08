import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { writeProjectRules } from "../../src/rules/project.js";
import type { StackInfo } from "../../src/indexer/stack.js";

const stack: StackInfo = {
  languages: ["TypeScript"],
  frameworks: [],
  packageManager: "bun",
  manifest: "package.json",
};

function initRepo(dir: string): void {
  const r = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
}

async function render(dir: string): Promise<string> {
  await writeProjectRules(dir, { projectId: "demo", stack });
  return readFile(join(dir, "CLAUDE.md"), "utf-8");
}

describe("worktree section in CLAUDE.md", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-rules-wt-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("tells the host to weigh isolation before delegating, in a git project", async () => {
    initRepo(dir);
    const md = await render(dir);

    expect(md).toContain("brain-worktree");
    expect(md).toContain("port_acquire");
  });

  it("names the command that reports the identity", async () => {
    initRepo(dir);
    expect(await render(dir)).toContain("project-brain worktree status");
  });

  it("says nothing about worktrees in a project that is not a git repository", async () => {
    // No git, no worktrees. The instruction would be dead weight in every
    // CLAUDE.md project-brain touches, which is the same reason the OKF
    // section is gated on a bundle existing.
    const md = await render(dir);

    expect(md).not.toContain("brain-worktree");
    expect(md).not.toContain("worktree");
  });

  it("leaves no unsubstituted placeholder behind", async () => {
    initRepo(dir);
    expect(await render(dir)).not.toContain("{{worktree}}");
  });
});
