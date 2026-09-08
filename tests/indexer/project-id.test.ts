import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  deriveProjectId,
  scopedProjectId,
  parseScopedProjectId,
  isScopedProjectId,
} from "../../src/indexer/project-id.js";

describe("deriveProjectId", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "project-id-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("extracts repo name from HTTPS remote", async () => {
    await Bun.spawn(["git", "init"], { cwd: tempDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(
      ["git", "remote", "add", "origin", "https://github.com/user/my-project.git"],
      { cwd: tempDir, stdout: "ignore", stderr: "ignore" }
    ).exited;

    const id = await deriveProjectId(tempDir);
    expect(id).toBe("my-project");
  });

  it("extracts repo name from SSH remote", async () => {
    await Bun.spawn(["git", "init"], { cwd: tempDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(
      ["git", "remote", "add", "origin", "git@github.com:org/another-repo.git"],
      { cwd: tempDir, stdout: "ignore", stderr: "ignore" }
    ).exited;

    const id = await deriveProjectId(tempDir);
    expect(id).toBe("another-repo");
  });

  it("handles .git suffix in URLs", async () => {
    await Bun.spawn(["git", "init"], { cwd: tempDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(
      ["git", "remote", "add", "origin", "https://github.com/user/repo-name.git"],
      { cwd: tempDir, stdout: "ignore", stderr: "ignore" }
    ).exited;

    const id = await deriveProjectId(tempDir);
    expect(id).toBe("repo-name");
  });

  it("handles URL without .git suffix", async () => {
    await Bun.spawn(["git", "init"], { cwd: tempDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.spawn(
      ["git", "remote", "add", "origin", "https://github.com/user/plain-repo"],
      { cwd: tempDir, stdout: "ignore", stderr: "ignore" }
    ).exited;

    const id = await deriveProjectId(tempDir);
    expect(id).toBe("plain-repo");
  });

  it("falls back to directory basename when no remote", async () => {
    await Bun.spawn(["git", "init"], { cwd: tempDir, stdout: "ignore", stderr: "ignore" }).exited;

    const id = await deriveProjectId(tempDir);
    // Should use the temp dir basename
    expect(id.length).toBeGreaterThan(0);
  });

  it("falls back to directory basename for non-git directory", async () => {
    const id = await deriveProjectId(tempDir);
    expect(id.length).toBeGreaterThan(0);
  });
});

describe("scopedProjectId", () => {
  it("leaves the base id untouched for the main checkout", () => {
    expect(scopedProjectId("project-brain", "main")).toBe("project-brain");
  });

  it("suffixes the base id with the worktree name for a linked worktree", () => {
    expect(scopedProjectId("project-brain", "agent-a")).toBe("project-brain@agent-a");
  });

  it("does not double-scope an id that is already scoped", () => {
    expect(scopedProjectId("project-brain@agent-a", "agent-a")).toBe("project-brain@agent-a");
  });
});

describe("parseScopedProjectId", () => {
  it("splits a scoped id into its base and worktree", () => {
    expect(parseScopedProjectId("project-brain@agent-a")).toEqual({
      base: "project-brain",
      worktree: "agent-a",
    });
  });

  it("reports an unscoped id as the main checkout", () => {
    expect(parseScopedProjectId("project-brain")).toEqual({
      base: "project-brain",
      worktree: "main",
    });
  });

  it("splits on the LAST separator so a base id containing one survives", () => {
    expect(parseScopedProjectId("weird@name@agent-a")).toEqual({
      base: "weird@name",
      worktree: "agent-a",
    });
  });

  it("round-trips every scoped id it produces", () => {
    const parsed = parseScopedProjectId(scopedProjectId("my-repo", "wt-7"));
    expect(parsed).toEqual({ base: "my-repo", worktree: "wt-7" });
  });
});

describe("isScopedProjectId", () => {
  it("is true only for ids that name a linked worktree", () => {
    expect(isScopedProjectId("project-brain@agent-a")).toBe(true);
    expect(isScopedProjectId("project-brain")).toBe(false);
  });
});
