import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AIToolRegistrar } from "../../src/registrars/types.js";

/** Claude Code registrar: enough for setup to treat it as a routing/hook target. */
function claudeRegistrar(): AIToolRegistrar {
  return {
    name: "Claude Code",
    isInstalled: async () => true,
    register: async () => {},
    writeRules: async () => {},
    routing: {
      hostKey: "claude",
      mechanism: "per-spawn",
      howToApply: "pass `model` on the call.",
      labelField: "the description field",
      models: { fast: "haiku", balanced: "sonnet", deep: "opus" },
    },
    writtenRoutingVersion: async () => null,
    writeModelRouting: async () => {},
  } as unknown as AIToolRegistrar;
}

async function run(extra: Record<string, unknown> = {}) {
  const { runSetup } = await import("../../src/commands/setup.js");
  const dir = await mkdtemp(join(tmpdir(), "pb-wt-hooks-"));
  const settingsPath = join(dir, "settings.json");

  const result = await runSetup({
    dataDir: join(dir, "data"),
    skipOllama: true,
    registrars: [claudeRegistrar()],
    skillInstall: "no",
    modelRouting: "no",
    routingHook: { mode: "no", strict: false },
    claudeSettingsPath: settingsPath,
    ...extra,
  });

  const written = existsSync(settingsPath)
    ? JSON.parse(await readFile(settingsPath, "utf8"))
    : null;
  return { result, written };
}

function commands(settings: any, event: string): string[] {
  return (settings?.hooks?.[event] ?? []).flatMap((g: any) =>
    (g.hooks ?? []).map((h: any) => h.command as string)
  );
}

describe("setup installs the worktree hooks", () => {
  it("installs them even when the routing hooks were declined", async () => {
    // Declining model-routing reminders is not declining index hygiene. A leaked
    // worktree index is a correctness problem, not a preference.
    const { written } = await run();
    expect(commands(written, "WorktreeRemove").some((c) => c.includes("worktree-hook"))).toBe(
      true
    );
    expect(commands(written, "SessionStart").some((c) => c.includes("worktree-hook"))).toBe(true);
  });

  it("reports that it installed them, without the guard", async () => {
    const { result } = await run();
    expect(result.worktreeHooks).toEqual({ installed: true, strict: false });
  });

  it("writes nothing when explicitly declined", async () => {
    const { result, written } = await run({ worktreeHook: { mode: "no", strict: false } });
    expect(result.worktreeHooks).toEqual({ installed: false, strict: false });
    expect(written).toBeNull();
  });

  it("installs no spawn guard by default", async () => {
    // One extra turn on every delegation is a cost only its owner can agree to.
    const { written } = await run();
    expect(written.hooks.PreToolUse).toBeUndefined();
  });

  it("installs the spawn guard in strict mode", async () => {
    const { result, written } = await run({ worktreeHook: { mode: "yes", strict: true } });
    expect(result.worktreeHooks).toEqual({ installed: true, strict: true });
    expect(commands(written, "PreToolUse").some((c) => c.includes("worktree-guard"))).toBe(true);
  });

  it("adds nothing on a second run over the same settings file", async () => {
    const { runSetup } = await import("../../src/commands/setup.js");
    const dir = await mkdtemp(join(tmpdir(), "pb-wt-hooks-twice-"));
    const settingsPath = join(dir, "settings.json");
    const opts = {
      dataDir: join(dir, "data"),
      skipOllama: true,
      registrars: [claudeRegistrar()],
      skillInstall: "no" as const,
      modelRouting: "no" as const,
      routingHook: { mode: "no" as const, strict: false },
      worktreeHook: { mode: "yes" as const, strict: true },
      claudeSettingsPath: settingsPath,
    };

    await runSetup(opts);
    const once = JSON.parse(await readFile(settingsPath, "utf8"));
    await runSetup(opts);
    const twice = JSON.parse(await readFile(settingsPath, "utf8"));

    expect(commands(twice, "SessionStart").length).toBe(commands(once, "SessionStart").length);
    expect(commands(twice, "WorktreeRemove").length).toBe(commands(once, "WorktreeRemove").length);
    expect(commands(twice, "PreToolUse").length).toBe(commands(once, "PreToolUse").length);
  });
});
