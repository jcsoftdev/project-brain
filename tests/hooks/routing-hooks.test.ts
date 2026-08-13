import { describe, it, expect } from "bun:test";
import { upsertRoutingHooks } from "../../src/hooks/claude-settings.js";
import { routingGuardDecision } from "../../src/hooks/routing-guard.js";
import { ROUTING_CONTENT_VERSION } from "../../src/constants.js";

function groups(settings: any, event: string): any[] {
  return settings.hooks?.[event] ?? [];
}

function commands(settings: any, event: string): string[] {
  return groups(settings, event).flatMap((g: any) =>
    (g.hooks ?? []).map((h: any) => h.command as string)
  );
}

describe("upsertRoutingHooks", () => {
  it("installs the SessionStart reminder from nothing", () => {
    const settings = upsertRoutingHooks(null, { strict: false });
    expect(commands(settings, "SessionStart").some((c) => c.includes("routing-rules"))).toBe(true);
  });

  it("leaves PreToolUse alone unless strict mode is asked for", () => {
    // Blocking a delegation is intrusive, and inheriting the session model is a
    // legitimate choice — so enforcement never arrives by default.
    const settings = upsertRoutingHooks(null, { strict: false });
    expect(groups(settings, "PreToolUse").length).toBe(0);
  });

  it("adds the PreToolUse guard in strict mode, matched on the spawn tool", () => {
    const settings = upsertRoutingHooks(null, { strict: true });
    const group = groups(settings, "PreToolUse")[0];

    expect(group.matcher).toMatch(/Agent/);
    expect(group.matcher).toMatch(/Task/);
    expect(commands(settings, "PreToolUse").some((c) => c.includes("routing-guard"))).toBe(true);
  });

  it("preserves unrelated settings and other events' hooks", () => {
    const existing = {
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "project-brain search --stdin" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      },
    };
    const settings: any = upsertRoutingHooks(existing, { strict: false });

    expect(settings.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(commands(settings, "UserPromptSubmit")).toContain("project-brain search --stdin");
    expect(commands(settings, "SessionStart")).toContain("echo hi");
    expect(commands(settings, "SessionStart").some((c) => c.includes("routing-rules"))).toBe(true);
  });

  it("does not mutate the settings object it was handed", () => {
    const existing = { hooks: { SessionStart: [] as any[] } };
    upsertRoutingHooks(existing, { strict: true });
    expect(existing.hooks.SessionStart.length).toBe(0);
  });

  it("is idempotent — running setup twice does not duplicate the hook", () => {
    const once = upsertRoutingHooks(null, { strict: true });
    const twice = upsertRoutingHooks(once, { strict: true });

    expect(commands(twice, "SessionStart").filter((c) => c.includes("routing-rules")).length).toBe(1);
    expect(commands(twice, "PreToolUse").filter((c) => c.includes("routing-guard")).length).toBe(1);
  });

  it("upgrades a plain install to strict without duplicating the reminder", () => {
    const plain = upsertRoutingHooks(null, { strict: false });
    const strict = upsertRoutingHooks(plain, { strict: true });

    expect(commands(strict, "SessionStart").filter((c) => c.includes("routing-rules")).length).toBe(1);
    expect(commands(strict, "PreToolUse").length).toBe(1);
  });
});

describe("routingGuardDecision", () => {
  const spawn = (input: Record<string, unknown>) => ({
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: input,
  });

  it("allows a spawn that names its model", () => {
    const decision = routingGuardDecision(spawn({ model: "haiku", description: "haiku: find X" }));
    expect(decision.block).toBe(false);
  });

  it("blocks a spawn with no model, and says why", () => {
    const decision = routingGuardDecision(spawn({ description: "find X" }));

    expect(decision.block).toBe(true);
    expect(decision.reason).toMatch(/fast|balanced|deep/);
  });

  it("fails open on a payload it cannot parse", () => {
    // A guard that blocks on its own parse failure is worse than no guard.
    expect(routingGuardDecision(null).block).toBe(false);
    expect(routingGuardDecision({ tool_name: "Agent" }).block).toBe(false);
    expect(routingGuardDecision("not an object" as unknown).block).toBe(false);
  });

  it("ignores tools that are not a subagent spawn", () => {
    expect(
      routingGuardDecision({ tool_name: "Bash", tool_input: { command: "ls" } }).block
    ).toBe(false);
  });

  it("treats an empty model as absent", () => {
    expect(routingGuardDecision(spawn({ model: "  " })).block).toBe(true);
  });
});

describe("routing-rules payload", () => {
  it("emits SessionStart additionalContext with the tier table", async () => {
    const { buildRoutingReminder } = await import("../../src/hooks/routing-rules.js");
    const payload = JSON.parse(await buildRoutingReminder());

    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(payload.hookSpecificOutput.additionalContext).toContain("fast");
    expect(payload.hookSpecificOutput.additionalContext).toContain("deep");
    expect(payload.hookSpecificOutput.additionalContext).toContain("Tier");
  });

  it("stays well under the 10,000-character hook output cap", async () => {
    const { buildRoutingReminder } = await import("../../src/hooks/routing-rules.js");
    const payload = JSON.parse(await buildRoutingReminder());
    expect(payload.hookSpecificOutput.additionalContext.length).toBeLessThan(10_000);
  });

  it("injects the rules, not the prose — the session pays for every character", async () => {
    const { buildRoutingReminder } = await import("../../src/hooks/routing-rules.js");
    const payload = JSON.parse(await buildRoutingReminder());
    const context: string = payload.hookSpecificOutput.additionalContext;

    expect(context).not.toContain("Relative cost");
    expect(context).not.toContain(`model-routing-version: ${ROUTING_CONTENT_VERSION}`);
  });
});
