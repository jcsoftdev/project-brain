import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function git(root: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

describe("commit-diff", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brain-commitdiff-"));
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "Test"]);
    await mkdir(join(root, "auth"), { recursive: true });
    await writeFile(join(root, "auth", "login.ts"), "export function login() {}\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "feat(auth): add login"]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists changed files in the latest commit, including the root commit", async () => {
    const { getChangedFiles } = await import("../../src/git/commit-diff.js");
    expect(getChangedFiles(root)).toEqual(["auth/login.ts"]);
  });

  it("returns the commit message", async () => {
    const { getCommitMessage } = await import("../../src/git/commit-diff.js");
    expect(getCommitMessage(root)).toBe("feat(auth): add login");
  });

  it("returns the diff scoped to a module path", async () => {
    const { getModuleDiff } = await import("../../src/git/commit-diff.js");
    const diff = getModuleDiff(root, "auth/");
    expect(diff).toContain("login.ts");
    expect(diff).toContain("export function login");
  });
});
