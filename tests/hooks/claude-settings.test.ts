import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

/** Collect every command string across all UserPromptSubmit matcher groups. */
function commandsOf(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const groups = (hooks?.UserPromptSubmit as Array<Record<string, unknown>> | undefined) ?? [];
  const cmds: string[] = [];
  for (const g of groups) {
    const inner = Array.isArray(g.hooks) ? (g.hooks as Array<Record<string, unknown>>) : [];
    for (const h of inner) if (typeof h.command === "string") cmds.push(h.command);
  }
  return cmds;
}

/** The first command entry across all groups (for shape assertions). */
function firstCommandEntry(settings: Record<string, unknown>): Record<string, unknown> | undefined {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const groups = (hooks?.UserPromptSubmit as Array<Record<string, unknown>> | undefined) ?? [];
  for (const g of groups) {
    const inner = Array.isArray(g.hooks) ? (g.hooks as Array<Record<string, unknown>>) : [];
    if (inner[0]) return inner[0];
  }
  return undefined;
}

// ── Pure function unit tests ──────────────────────────────────────────────

describe("upsertContextHook (pure function)", () => {
  it("returns settings with UserPromptSubmit hook when given null (fresh)", async () => {
    const { upsertContextHook } = await import("../../src/hooks/claude-settings.js");
    const result = upsertContextHook(null) as Record<string, unknown>;

    expect(result).toHaveProperty("hooks");
    expect(commandsOf(result).some((c) => c.includes("project-brain search --stdin"))).toBe(true);
  });

  it("nests the command under a matcher group with a required `hooks` array (Claude Code schema)", async () => {
    const { upsertContextHook } = await import("../../src/hooks/claude-settings.js");
    const result = upsertContextHook(null) as Record<string, unknown>;
    const groups = (result.hooks as Record<string, unknown>).UserPromptSubmit as Array<Record<string, unknown>>;

    // Each array item MUST be a matcher group with a `hooks` array, NOT a bare command entry.
    for (const g of groups) {
      expect(Array.isArray(g.hooks)).toBe(true);
      expect(g.command).toBeUndefined();
    }
  });

  it("preserves existing permissions when merging", async () => {
    const { upsertContextHook } = await import("../../src/hooks/claude-settings.js");
    const existing = { permissions: { allow: ["Bash(git:*)"], deny: [] } };
    const result = upsertContextHook(existing) as Record<string, unknown>;

    expect(result.permissions).toEqual(existing.permissions);
    expect(result).toHaveProperty("hooks");
  });

  it("preserves existing hooks that are not UserPromptSubmit", async () => {
    const { upsertContextHook } = await import("../../src/hooks/claude-settings.js");
    const existing = {
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo pre" }] }] },
    };
    const result = upsertContextHook(existing) as Record<string, unknown>;
    const hooks = result.hooks as Record<string, unknown>;
    expect(hooks).toHaveProperty("PreToolUse");
    expect(hooks).toHaveProperty("UserPromptSubmit");
  });

  it("does NOT duplicate the hook on second call (idempotent)", async () => {
    const { upsertContextHook } = await import("../../src/hooks/claude-settings.js");
    const once = upsertContextHook(null);
    const twice = upsertContextHook(once) as Record<string, unknown>;

    const pb = commandsOf(twice).filter((c) => c.includes("project-brain search"));
    expect(pb.length).toBe(1);
  });

  it("returns correct hook structure with type, command, timeout, statusMessage", async () => {
    const { upsertContextHook } = await import("../../src/hooks/claude-settings.js");
    const result = upsertContextHook(null) as Record<string, unknown>;
    const entry = firstCommandEntry(result)!;

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

    const raw = await readFile(join(tempDir, ".claude", "settings.json"), "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    expect(commandsOf(settings).some((c) => c.includes("project-brain search --stdin"))).toBe(true);
  });

  it("merges without clobbering an existing permissions block", async () => {
    const claudeDir = join(tempDir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const existing = { permissions: { allow: ["Bash(git:*)"], deny: [] } };
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify(existing, null, 2));

    const { runInit } = await import("../../src/commands/init.js");
    await runInit({ root: tempDir, skipGitHook: true, skipIndex: true, skipRules: true });

    const raw = await readFile(join(claudeDir, "settings.json"), "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;

    expect(settings.permissions).toEqual(existing.permissions);
    expect(commandsOf(settings).some((c) => c.includes("project-brain search"))).toBe(true);
  });

  it("is idempotent: running init twice does not duplicate the hook", async () => {
    const { runInit } = await import("../../src/commands/init.js");
    await runInit({ root: tempDir, skipGitHook: true, skipIndex: true, skipRules: true });
    await runInit({ root: tempDir, skipGitHook: true, skipIndex: true, skipRules: true });

    const raw = await readFile(join(tempDir, ".claude", "settings.json"), "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const pb = commandsOf(settings).filter((c) => c.includes("project-brain search"));
    expect(pb.length).toBe(1);
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
