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
    await runInit({ root: tempDir, dataDir: join(tempDir, ".project-brain"), skipGitHook: true, skipIndex: true, skipRules: true });

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
    await runInit({ root: tempDir, dataDir: join(tempDir, ".project-brain"), skipGitHook: true, skipIndex: true, skipRules: true });

    const raw = await readFile(join(claudeDir, "settings.json"), "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;

    expect(settings.permissions).toEqual(existing.permissions);
    expect(commandsOf(settings).some((c) => c.includes("project-brain search"))).toBe(true);
  });

  it("is idempotent: running init twice does not duplicate the hook", async () => {
    const { runInit } = await import("../../src/commands/init.js");
    await runInit({ root: tempDir, dataDir: join(tempDir, ".project-brain"), skipGitHook: true, skipIndex: true, skipRules: true });
    await runInit({ root: tempDir, dataDir: join(tempDir, ".project-brain"), skipGitHook: true, skipIndex: true, skipRules: true });

    const raw = await readFile(join(tempDir, ".claude", "settings.json"), "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const pb = commandsOf(settings).filter((c) => c.includes("project-brain search"));
    expect(pb.length).toBe(1);
  });

  it("--no-hook flag skips settings.json creation", async () => {
    const { runInit } = await import("../../src/commands/init.js");
    await runInit({
      root: tempDir,
      dataDir: join(tempDir, ".project-brain"),
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

/** Collect every command string for one event across all matcher groups. */
function commandsForEvent(settings: Record<string, unknown>, event: string): string[] {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const groups = (hooks?.[event] as Array<Record<string, unknown>> | undefined) ?? [];
  const cmds: string[] = [];
  for (const g of groups) {
    const inner = Array.isArray(g.hooks) ? (g.hooks as Array<Record<string, unknown>>) : [];
    for (const h of inner) if (typeof h.command === "string") cmds.push(h.command);
  }
  return cmds;
}

describe("removeRoutingHooks (pure function)", () => {
  it("removes both the SessionStart reminder and the PreToolUse guard", async () => {
    const { upsertRoutingHooks, removeRoutingHooks } = await import(
      "../../src/hooks/claude-settings.js"
    );
    const installed = upsertRoutingHooks(null, { strict: true });
    const result = removeRoutingHooks(installed) as Record<string, unknown>;

    expect(commandsForEvent(result, "SessionStart")).toEqual([]);
    expect(commandsForEvent(result, "PreToolUse")).toEqual([]);
  });

  it("leaves another tool's hooks and unrelated keys untouched", async () => {
    const { upsertRoutingHooks, removeRoutingHooks } = await import(
      "../../src/hooks/claude-settings.js"
    );
    const foreign = {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "other-tool greet" }] }],
      },
    };
    const result = removeRoutingHooks(upsertRoutingHooks(foreign, { strict: true })) as Record<
      string,
      unknown
    >;

    expect(commandsForEvent(result, "SessionStart")).toEqual(["other-tool greet"]);
    expect(result.permissions).toEqual({ allow: ["Bash(ls:*)"] });
  });

  it("is idempotent and safe on settings that never had the hooks", async () => {
    const { removeRoutingHooks } = await import("../../src/hooks/claude-settings.js");
    expect(removeRoutingHooks(null)).toEqual({ hooks: {} });
    expect(removeRoutingHooks({ hooks: {} })).toEqual({ hooks: {} });
  });

  it("does not remove the worktree hooks", async () => {
    const { upsertWorktreeHooks, removeRoutingHooks } = await import(
      "../../src/hooks/claude-settings.js"
    );
    const result = removeRoutingHooks(upsertWorktreeHooks(null, { strict: false })) as Record<
      string,
      unknown
    >;

    expect(commandsForEvent(result, "SessionStart")).toEqual([
      "project-brain worktree-hook session",
    ]);
  });
});

describe("removeWorktreeHooks (pure function)", () => {
  it("removes the SessionStart, WorktreeRemove and PreToolUse entries", async () => {
    const { upsertWorktreeHooks, removeWorktreeHooks } = await import(
      "../../src/hooks/claude-settings.js"
    );
    const result = removeWorktreeHooks(
      upsertWorktreeHooks(null, { strict: true })
    ) as Record<string, unknown>;

    expect(commandsForEvent(result, "SessionStart")).toEqual([]);
    expect(commandsForEvent(result, "WorktreeRemove")).toEqual([]);
    expect(commandsForEvent(result, "PreToolUse")).toEqual([]);
  });

  it("does not remove the routing hooks", async () => {
    const { upsertRoutingHooks, removeWorktreeHooks } = await import(
      "../../src/hooks/claude-settings.js"
    );
    const result = removeWorktreeHooks(
      upsertRoutingHooks(null, { strict: false })
    ) as Record<string, unknown>;

    expect(commandsForEvent(result, "SessionStart")).toEqual(["project-brain routing-rules"]);
  });

  it("does not remove the project-level context hook", async () => {
    const { upsertContextHook, removeWorktreeHooks } = await import(
      "../../src/hooks/claude-settings.js"
    );
    const result = removeWorktreeHooks(upsertContextHook(null)) as Record<string, unknown>;

    expect(commandsForEvent(result, "UserPromptSubmit")).toEqual([
      "project-brain search --stdin",
    ]);
  });
});
