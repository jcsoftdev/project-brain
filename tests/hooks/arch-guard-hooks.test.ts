import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { removeArchGuardHooks, upsertArchGuardHooks, upsertRoutingHooks, upsertWorktreeHooks } from "../../src/hooks/claude-settings.js";
import type { SetupContext } from "../../src/setup/units.js";

function preToolUse(settings: any): any[] {
  return settings.hooks?.PreToolUse ?? [];
}

describe("upsertArchGuardHooks", () => {
  it("installs a PreToolUse group matched on every file-writing tool", () => {
    const [group] = preToolUse(upsertArchGuardHooks(null));
    expect(group.matcher.split("|").sort()).toEqual(["Edit", "MultiEdit", "Write"]);
    expect(group.hooks[0]).toMatchObject({ type: "command", command: "project-brain arch-guard", timeout: 5 });
  });

  it("is idempotent", () => {
    const once = upsertArchGuardHooks(null);
    expect(upsertArchGuardHooks(once)).toEqual(once);
    expect(preToolUse(upsertArchGuardHooks(once))).toHaveLength(1);
  });

  it("does not mutate its input", () => {
    const existing = { hooks: { PreToolUse: [] as any[] } };
    upsertArchGuardHooks(existing);
    expect(existing.hooks.PreToolUse).toHaveLength(0);
  });

  it("removal takes only its own group, leaving the other PreToolUse guards and settings", () => {
    let settings: object = { permissions: { allow: ["Bash(ls:*)"] } };
    settings = upsertRoutingHooks(settings, { strict: true });
    settings = upsertWorktreeHooks(settings, { strict: true });
    settings = upsertArchGuardHooks(settings);
    expect(preToolUse(settings)).toHaveLength(3);

    const removed: any = removeArchGuardHooks(settings);
    const left = preToolUse(removed).map((g: any) => g.hooks[0].command);
    expect(left.sort()).toEqual(["project-brain routing-guard", "project-brain worktree-guard"]);
    expect(removed.permissions).toEqual({ allow: ["Bash(ls:*)"] });
  });

  it("removal drops the PreToolUse key when nothing else is left, and tolerates absence", () => {
    expect((removeArchGuardHooks(upsertArchGuardHooks(null)) as any).hooks.PreToolUse).toBeUndefined();
    expect(() => removeArchGuardHooks(null)).not.toThrow();
  });
});

describe("hooks:arch-guard unit", () => {
  async function context(): Promise<SetupContext> {
    const dir = await mkdtemp(join(tmpdir(), "pb-arch-unit-"));
    return {
      dataDir: join(dir, "data"),
      installed: [],
      serverPath: "/usr/local/bin/project-brain",
      claudeSettingsPath: join(dir, "settings.json"),
      recordConfigPath: join(dir, "record-config.json"),
      selectionPath: join(dir, "setup-selection.json"),
      skillTargetDirs: [join(dir, "skills")],
      recordConnection: { mode: "fresh", cdpPort: 9222 },
      hookStrict: { routing: false, worktree: false },
      skipOllama: true,
    } as SetupContext;
  }

  it("is opt-in, discloses the Jev data flow, and goes absent -> current -> absent", async () => {
    const { guidanceUnits } = await import("../../src/setup/units.js");
    const unit = guidanceUnits().find((u) => u.id === "hooks:arch-guard")!;
    const ctx = await context();

    expect(unit.defaultSelected).toBe(false);
    expect(unit.description).toContain("api.typesafe.ai");

    expect(await unit.inspect(ctx)).toBe("absent");
    await unit.apply(ctx);
    expect(await unit.inspect(ctx)).toBe("current");
    await unit.remove(ctx);
    expect(await unit.inspect(ctx)).toBe("absent");

    await rm(ctx.claudeSettingsPath, { force: true });
  });
});
