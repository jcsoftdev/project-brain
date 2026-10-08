import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  removeArchGuardHooks,
  removeCommitCheckHooks,
  upsertArchGuardHooks,
  upsertCommitCheckHooks,
} from "../../src/hooks/claude-settings.js";
import type { SetupContext } from "../../src/setup/units.js";

const preToolUse = (settings: any): any[] => settings.hooks?.PreToolUse ?? [];

describe("upsertCommitCheckHooks", () => {
  it("installs a Bash PreToolUse group inside the hook timeout", () => {
    const [group] = preToolUse(upsertCommitCheckHooks(null));
    expect(group.matcher).toBe("Bash");
    expect(group.hooks[0]).toMatchObject({ type: "command", command: "project-brain commit-check", timeout: 5 });
  });

  it("is idempotent and does not mutate its input", () => {
    const once = upsertCommitCheckHooks(null);
    expect(upsertCommitCheckHooks(once)).toEqual(once);
    expect(preToolUse(upsertCommitCheckHooks(once))).toHaveLength(1);

    const existing = { hooks: { PreToolUse: [] as any[] } };
    upsertCommitCheckHooks(existing);
    expect(existing.hooks.PreToolUse).toHaveLength(0);
  });

  it("removal takes only its own group and is idempotent", () => {
    let settings: object = { permissions: { allow: ["Bash(ls:*)"] } };
    settings = upsertArchGuardHooks(settings);
    settings = upsertCommitCheckHooks(settings);
    expect(preToolUse(settings)).toHaveLength(2);

    const removed: any = removeCommitCheckHooks(settings);
    expect(preToolUse(removed).map((g: any) => g.hooks[0].command)).toEqual(["project-brain arch-guard"]);
    expect(removed.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(removeCommitCheckHooks(removed)).toEqual(removed);

    const alone: any = removeCommitCheckHooks(upsertCommitCheckHooks(null));
    expect(alone.hooks.PreToolUse).toBeUndefined();
    expect(preToolUse(removeArchGuardHooks(settings)).map((g: any) => g.hooks[0].command)).toEqual([
      "project-brain commit-check",
    ]);
  });
});

describe("hooks:commit-check unit", () => {
  async function context() {
    const dir = await mkdtemp(join(tmpdir(), "pb-commit-check-"));
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
    return { dir, ctx };
  }

  it("discloses the data flow and goes absent -> current -> absent", async () => {
    const { guidanceUnits } = await import("../../src/setup/units.js");
    const unit = guidanceUnits().find((u) => u.id === "hooks:commit-check")!;
    const { dir, ctx } = await context();

    expect(unit.description).toContain("api.typesafe.ai");
    expect(await unit.inspect(ctx)).toBe("absent");
    await unit.apply(ctx);
    expect(await unit.inspect(ctx)).toBe("current");
    await unit.apply(ctx);
    await unit.remove(ctx);
    expect(await unit.inspect(ctx)).toBe("absent");
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults on exactly when a TypeSafe token is configured", async () => {
    const { guidanceUnits } = await import("../../src/setup/units.js");
    const unit = guidanceUnits().find((u) => u.id === "hooks:commit-check")!;
    const { dir, ctx } = await context();
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      expect(unit.defaultSelected).toBe(false);
      expect(await unit.defaultWhen!(ctx)).toBe(false);

      const { writeRerankerToken } = await import("../../src/rerank/token.js");
      await writeRerankerToken(ctx.dataDir, "tsk-test");
      expect(await unit.defaultWhen!(ctx)).toBe(true);
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
