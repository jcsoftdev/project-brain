import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { deriveProjectId } from "../../src/indexer/project-id.js";

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
