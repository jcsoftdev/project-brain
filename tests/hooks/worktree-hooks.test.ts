import { describe, it, expect } from "bun:test";
import { upsertWorktreeHooks, upsertRoutingHooks } from "../../src/hooks/claude-settings.js";

function groups(settings: any, event: string): any[] {
  return settings.hooks?.[event] ?? [];
}

function commands(settings: any, event: string): string[] {
  return groups(settings, event).flatMap((g: any) =>
    (g.hooks ?? []).map((h: any) => h.command as string)
  );
}

describe("upsertWorktreeHooks", () => {
  it("reclaims dead worktree indexes when a worktree is removed", () => {
    const settings = upsertWorktreeHooks(null);
    expect(commands(settings, "WorktreeRemove").some((c) => c.includes("worktree-hook"))).toBe(
      true
    );
  });

  it("also reconciles at session start, because non-interactive runs skip the removal hook", () => {
    const settings = upsertWorktreeHooks(null);
    expect(commands(settings, "SessionStart").some((c) => c.includes("worktree-hook"))).toBe(true);
  });

  it("gives the two events different subcommands", () => {
    const settings = upsertWorktreeHooks(null);
    expect(commands(settings, "SessionStart")).toContain("project-brain worktree-hook session");
    expect(commands(settings, "WorktreeRemove")).toContain("project-brain worktree-hook cleanup");
  });

  it("adds nothing on a second run", () => {
    const once = upsertWorktreeHooks(null);
    const twice = upsertWorktreeHooks(once);
    expect(commands(twice, "SessionStart").length).toBe(commands(once, "SessionStart").length);
    expect(commands(twice, "WorktreeRemove").length).toBe(commands(once, "WorktreeRemove").length);
  });

  it("does not mutate the settings object it was given", () => {
    const existing = { hooks: { SessionStart: [] as unknown[] } };
    upsertWorktreeHooks(existing);
    expect(existing.hooks.SessionStart).toEqual([]);
  });

  it("preserves unrelated settings and other events' hooks", () => {
    const existing = {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        PostToolUse: [{ hooks: [{ type: "command", command: "something-else" }] }],
      },
    };
    const settings = upsertWorktreeHooks(existing) as any;

    expect(settings.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(commands(settings, "PostToolUse")).toEqual(["something-else"]);
  });

  it("leaves PreToolUse alone unless strict mode is asked for", () => {
    // Blocking every delegation until it states its intent is intrusive. It is a
    // deliberate opt-in, exactly like the routing guard.
    expect(groups(upsertWorktreeHooks(null), "PreToolUse").length).toBe(0);
    expect(groups(upsertWorktreeHooks(null, { strict: false }), "PreToolUse").length).toBe(0);
  });

  it("adds the PreToolUse guard in strict mode, matched on both spawn tool names", () => {
    const settings = upsertWorktreeHooks(null, { strict: true }) as any;
    const group = groups(settings, "PreToolUse")[0];

    expect(group.matcher).toMatch(/Agent/);
    expect(group.matcher).toMatch(/Task/);
    expect(commands(settings, "PreToolUse")).toContain("project-brain worktree-guard");
  });

  it("still installs the two reconciling hooks in strict mode", () => {
    const settings = upsertWorktreeHooks(null, { strict: true });
    expect(commands(settings, "WorktreeRemove").some((c) => c.includes("worktree-hook"))).toBe(
      true
    );
    expect(commands(settings, "SessionStart").some((c) => c.includes("worktree-hook"))).toBe(true);
  });

  it("adds no second guard on a repeated strict run", () => {
    const once = upsertWorktreeHooks(null, { strict: true });
    const twice = upsertWorktreeHooks(once, { strict: true });
    expect(commands(twice, "PreToolUse").length).toBe(commands(once, "PreToolUse").length);
  });

  it("coexists with the routing guard in the same PreToolUse event", () => {
    const settings = upsertWorktreeHooks(upsertRoutingHooks(null, { strict: true }), {
      strict: true,
    });
    const preToolUse = commands(settings, "PreToolUse");

    expect(preToolUse.some((c) => c.includes("routing-guard"))).toBe(true);
    expect(preToolUse.some((c) => c.includes("worktree-guard"))).toBe(true);
  });

  it("coexists with the routing hooks in the same SessionStart event", () => {
    const settings = upsertWorktreeHooks(upsertRoutingHooks(null, { strict: false }));
    const sessionStart = commands(settings, "SessionStart");

    expect(sessionStart.some((c) => c.includes("routing-rules"))).toBe(true);
    expect(sessionStart.some((c) => c.includes("worktree-hook"))).toBe(true);
  });
});
