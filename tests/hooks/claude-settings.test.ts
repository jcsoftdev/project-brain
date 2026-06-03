import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

// ── Pure function unit tests ──────────────────────────────────────────────

describe("upsertContextHook (pure function)", () => {
  it("returns settings with UserPromptSubmit hook when given null (fresh)", async () => {
    const { upsertContextHook } = await import("../../src/hooks/claude-settings.js");
    const result = upsertContextHook(null);

    expect(result).toHaveProperty("hooks");
    const hooks = (result as Record<string, unknown>).hooks as Record<string, unknown>;
    expect(hooks).toHaveProperty("UserPromptSubmit");
    const entries = hooks.UserPromptSubmit as unknown[];
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);

    const entry = entries[0] as Record<string, unknown>;
    expect(typeof entry.command).toBe("string");
    expect((entry.command as string).includes("project-brain search --stdin")).toBe(true);
  });

  it("preserves existing permissions when merging", async () => {
    const { upsertContextHook } = await import("../../src/hooks/claude-settings.js");
    const existing = {
      permissions: {
        allow: ["Bash(git:*)"],
        deny: [],
      },
    };
    const result = upsertContextHook(existing) as Record<string, unknown>;

    expect(result.permissions).toEqual(existing.permissions);
    expect(result).toHaveProperty("hooks");
  });

  it("preserves existing hooks that are not UserPromptSubmit", async () => {
    const { upsertContextHook } = await import("../../src/hooks/claude-settings.js");
    const existing = {
      hooks: {
        PreToolUse: [{ type: "command", command: "echo pre" }],
      },
    };
    const result = upsertContextHook(existing) as Record<string, unknown>;
    const hooks = result.hooks as Record<string, unknown>;
    expect(hooks).toHaveProperty("PreToolUse");
    expect(hooks).toHaveProperty("UserPromptSubmit");
  });

  it("does NOT duplicate the hook on second call (idempotent)", async () => {
    const { upsertContextHook } = await import("../../src/hooks/claude-settings.js");

    const once = upsertContextHook(null);
    const twice = upsertContextHook(once);

    const hooks = (twice as Record<string, unknown>).hooks as Record<string, unknown>;
    const entries = hooks.UserPromptSubmit as unknown[];
    // Should still be exactly 1 project-brain entry, not 2
    const pbEntries = entries.filter(
      (e) => typeof (e as Record<string, unknown>).command === "string" &&
        ((e as Record<string, unknown>).command as string).includes("project-brain search")
    );
    expect(pbEntries.length).toBe(1);
  });

  it("returns correct hook structure with type, command, timeout, statusMessage", async () => {
    const { upsertContextHook } = await import("../../src/hooks/claude-settings.js");
    const result = upsertContextHook(null) as Record<string, unknown>;
    const hooks = result.hooks as Record<string, unknown>;
    const entries = hooks.UserPromptSubmit as Array<Record<string, unknown>>;
    const entry = entries[0];

    expect(entry.type).toBe("command");
    expect(entry.command).toBe("project-brain search --stdin");
    expect(typeof entry.timeout).toBe("number");
    expect(typeof entry.statusMessage).toBe("string");
  });
});

// ── IO integration tests via runInit ─────────────────────────────────────

describe("init hook installation (file IO)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brain-hook-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes .claude/settings.json with UserPromptSubmit hook on fresh init", async () => {
    const { runInit } = await import("../../src/commands/init.js");
    await runInit({ root: tempDir, skipGitHook: true, skipIndex: true, skipRules: true });

    const settingsPath = join(tempDir, ".claude", "settings.json");
    const raw = await readFile(settingsPath, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;

    const hooks = settings.hooks as Record<string, unknown>;
    expect(hooks).toHaveProperty("UserPromptSubmit");
    const entries = hooks.UserPromptSubmit as Array<Record<string, unknown>>;
    const pbEntry = entries.find((e) =>
      typeof e.command === "string" && e.command.includes("project-brain search --stdin")
    );
    expect(pbEntry).toBeDefined();
  });

  it("merges without clobbering an existing permissions block", async () => {
    // Pre-write a settings.json with permissions
    const claudeDir = join(tempDir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const existing = {
      permissions: { allow: ["Bash(git:*)"], deny: [] },
    };
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify(existing, null, 2));

    const { runInit } = await import("../../src/commands/init.js");
    await runInit({ root: tempDir, skipGitHook: true, skipIndex: true, skipRules: true });

    const raw = await readFile(join(claudeDir, "settings.json"), "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;

    // Permissions preserved
    expect(settings.permissions).toEqual(existing.permissions);
    // Hook added
    const hooks = settings.hooks as Record<string, unknown>;
    expect(hooks).toHaveProperty("UserPromptSubmit");
  });

  it("is idempotent: running init twice does not duplicate the hook", async () => {
    const { runInit } = await import("../../src/commands/init.js");
    await runInit({ root: tempDir, skipGitHook: true, skipIndex: true, skipRules: true });
    await runInit({ root: tempDir, skipGitHook: true, skipIndex: true, skipRules: true });

    const raw = await readFile(join(tempDir, ".claude", "settings.json"), "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const hooks = settings.hooks as Record<string, unknown>;
    const entries = hooks.UserPromptSubmit as Array<Record<string, unknown>>;
    const pbEntries = entries.filter(
      (e) => typeof e.command === "string" && e.command.includes("project-brain search")
    );
    expect(pbEntries.length).toBe(1);
  });

  it("--no-hook flag skips settings.json creation", async () => {
    const { runInit } = await import("../../src/commands/init.js");
    await runInit({
      root: tempDir,
      skipGitHook: true,
      skipIndex: true,
      skipRules: true,
      skipClaudeHook: true,
    });

    let exists = false;
    try {
      await readFile(join(tempDir, ".claude", "settings.json"), "utf-8");
      exists = true;
    } catch {
      // Expected — file should not exist
    }
    expect(exists).toBe(false);
  });
});
