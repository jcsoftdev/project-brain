import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SetupContext } from "../../src/setup/units.js";
import {
  removeStyleGuardHooks,
  upsertArchGuardHooks,
  upsertStyleGuardHooks,
} from "../../src/hooks/claude-settings.js";

const preToolUse = (settings: any) => settings.hooks?.PreToolUse ?? [];
const commands = (settings: any) => preToolUse(settings).map((group: any) => group.hooks[0].command);

describe("style-guard settings", () => {
  it("registers one PreToolUse group on the edit tools", () => {
    const [group] = preToolUse(upsertStyleGuardHooks(null));
    expect(group.matcher).toBe("Edit|Write|MultiEdit");
    expect(group.hooks[0]).toMatchObject({ type: "command", command: "project-brain style-guard", timeout: 5 });
  });

  it("is idempotent and does not mutate its input", () => {
    const once = upsertStyleGuardHooks(null);
    const snapshot = JSON.stringify(once);
    expect(upsertStyleGuardHooks(once)).toEqual(once);
    expect(JSON.stringify(once)).toBe(snapshot);
  });

  it("removal leaves sibling guards and unrelated settings", () => {
    const both: any = upsertStyleGuardHooks({ ...upsertArchGuardHooks({ permissions: { allow: ["Bash(ls:*)"] } }) });
    expect(commands(both).sort()).toEqual(["project-brain arch-guard", "project-brain style-guard"]);
    const removed: any = removeStyleGuardHooks(both);
    expect(commands(removed)).toEqual(["project-brain arch-guard"]);
    expect(removed.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect((removeStyleGuardHooks(upsertStyleGuardHooks(null)) as any).hooks.PreToolUse).toBeUndefined();
    expect(() => removeStyleGuardHooks(null)).not.toThrow();
  });
});

describe("hooks:style-guard unit", () => {
  it("is on by default, discloses the Jev data flow, and goes absent -> current -> absent", async () => {
    const { guidanceUnits } = await import("../../src/setup/units.js");
    const unit = guidanceUnits().find((u) => u.id === "hooks:style-guard")!;
    const dir = await mkdtemp(join(tmpdir(), "pb-style-unit-"));
    const ctx = {
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

    expect(unit.defaultSelected).toBe(true);
    expect(unit.description).toContain("api.typesafe.ai");
    expect(await unit.inspect(ctx)).toBe("absent");
    await unit.apply(ctx);
    expect(await unit.inspect(ctx)).toBe("current");
    await unit.remove(ctx);
    expect(await unit.inspect(ctx)).toBe("absent");
    await rm(dir, { recursive: true, force: true });
  });
});
