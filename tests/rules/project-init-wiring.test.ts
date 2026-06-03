import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";

/**
 * T-6.2 wiring: runInit should call writeProjectRules and write CLAUDE.md.
 * Uses skipRules: true to opt out in tests that don't need it.
 */
describe("runInit project rules wiring (T-6.2)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-init-rules-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runInit accepts skipRules option without error", async () => {
    const { runInit } = await import("../../src/commands/init.js");

    await expect(
      runInit({ root: tempDir, skipGitHook: true, skipRules: true })
    ).resolves.toBeDefined();
  });

  it("runInit writes CLAUDE.md when skipRules is not set", async () => {
    const { runInit } = await import("../../src/commands/init.js");

    await runInit({ root: tempDir, skipGitHook: true });

    const claudePath = join(tempDir, "CLAUDE.md");
    const content = await readFile(claudePath, "utf-8");
    expect(content).toContain("project-brain");
    expect(content).toContain("search_context");
  });

  it("runInit writes CLAUDE.md with project ID substituted", async () => {
    const { runInit } = await import("../../src/commands/init.js");

    const result = await runInit({ root: tempDir, skipGitHook: true });

    const claudePath = join(tempDir, "CLAUDE.md");
    const content = await readFile(claudePath, "utf-8");
    expect(content).toContain(result.projectId);
    expect(content).not.toContain("{{projectId}}");
  });

  it("runInit does NOT write CLAUDE.md when skipRules is true", async () => {
    const { runInit } = await import("../../src/commands/init.js");

    await runInit({ root: tempDir, skipGitHook: true, skipRules: true });

    const claudePath = join(tempDir, "CLAUDE.md");
    const file = Bun.file(claudePath);
    const exists = await file.exists();
    expect(exists).toBe(false);
  });

  it("runInit is still idempotent on re-run with rules enabled", async () => {
    const { runInit } = await import("../../src/commands/init.js");

    await runInit({ root: tempDir, skipGitHook: true });
    await runInit({ root: tempDir, skipGitHook: true });

    const claudePath = join(tempDir, "CLAUDE.md");
    const content = await readFile(claudePath, "utf-8");
    const startCount = content.split("<!-- project-brain:start -->").length - 1;
    expect(startCount).toBe(1);
  });
});
