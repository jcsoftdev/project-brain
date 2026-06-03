import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, readFile, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("installGitHook", () => {
  let tempDir: string;
  let hooksDir: string;
  let hookPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "git-hook-"));
    hooksDir = join(tempDir, ".git", "hooks");
    await mkdir(hooksDir, { recursive: true });
    hookPath = join(hooksDir, "post-commit");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates post-commit hook with correct content", async () => {
    const { installGitHook } = await import("../../src/hooks/git.js");
    await installGitHook(tempDir);

    const content = await readFile(hookPath, "utf-8");
    expect(content).toContain("#!/bin/sh");
    expect(content).toContain("project-brain sync --changed-only");
    expect(content).toContain("> /dev/null 2>&1 &");
  });

  it("sets permissions to 0o755", async () => {
    const { installGitHook } = await import("../../src/hooks/git.js");
    await installGitHook(tempDir);

    const proc = Bun.spawn(["stat", "-f", "%Lp", hookPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const perms = (await new Response(proc.stdout).text()).trim();
    expect(perms).toBe("755");
  });

  it("appends to existing hook without project-brain", async () => {
    const existingContent = "#!/bin/sh\necho 'existing hook'\n";
    await writeFile(hookPath, existingContent);

    const { installGitHook } = await import("../../src/hooks/git.js");
    await installGitHook(tempDir);

    const content = await readFile(hookPath, "utf-8");
    expect(content).toContain("echo 'existing hook'");
    expect(content).toContain("project-brain sync --changed-only");
  });

  it("skips if project-brain already in hook", async () => {
    const existingContent =
      "#!/bin/sh\n# project-brain: auto-sync on commit\nproject-brain sync --changed-only > /dev/null 2>&1 &\n";
    await writeFile(hookPath, existingContent);

    const { installGitHook } = await import("../../src/hooks/git.js");
    await installGitHook(tempDir);

    const content = await readFile(hookPath, "utf-8");
    // Should not duplicate
    const matches = content.match(/project-brain sync/g);
    expect(matches?.length).toBe(1);
  });

  it("runs sync in background with suppressed output", async () => {
    const { installGitHook } = await import("../../src/hooks/git.js");
    await installGitHook(tempDir);

    const content = await readFile(hookPath, "utf-8");
    // Background: & at end. Suppressed: > /dev/null 2>&1
    expect(content).toContain("> /dev/null 2>&1 &");
  });
});
