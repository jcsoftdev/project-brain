import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { listFiles } from "../../src/indexer/explorer.js";

describe("explorer (listFiles)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "explorer-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("lists files in a git repo", async () => {
    // Initialize a git repo with tracked files
    await Bun.spawn(["git", "init"], { cwd: tempDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.write(join(tempDir, "file1.ts"), "export const a = 1;");
    await Bun.write(join(tempDir, "file2.md"), "# Hello");
    await Bun.spawn(["git", "add", "."], { cwd: tempDir, stdout: "ignore", stderr: "ignore" }).exited;

    const files = await listFiles(tempDir);
    expect(files).toContain("file1.ts");
    expect(files).toContain("file2.md");
  });

  it("respects .gitignore", async () => {
    await Bun.spawn(["git", "init"], { cwd: tempDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.write(join(tempDir, ".gitignore"), "ignored.log\n");
    await Bun.write(join(tempDir, "tracked.ts"), "const x = 1;");
    await Bun.write(join(tempDir, "ignored.log"), "log data");
    await Bun.spawn(["git", "add", "."], { cwd: tempDir, stdout: "ignore", stderr: "ignore" }).exited;

    const files = await listFiles(tempDir);
    expect(files).toContain("tracked.ts");
    expect(files).not.toContain("ignored.log");
  });

  it("returns total file count", async () => {
    await Bun.spawn(["git", "init"], { cwd: tempDir, stdout: "ignore", stderr: "ignore" }).exited;
    await Bun.write(join(tempDir, "a.ts"), "a");
    await Bun.write(join(tempDir, "b.ts"), "b");
    await Bun.write(join(tempDir, "c.ts"), "c");
    await Bun.spawn(["git", "add", "."], { cwd: tempDir, stdout: "ignore", stderr: "ignore" }).exited;

    const files = await listFiles(tempDir);
    expect(files.length).toBe(3);
  });

  it("handles non-git directories gracefully", async () => {
    await Bun.write(join(tempDir, "file.ts"), "x");

    await expect(listFiles(tempDir)).rejects.toThrow();
  });
});
