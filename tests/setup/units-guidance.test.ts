import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { SetupContext } from "../../src/setup/units.js";

async function context(): Promise<SetupContext> {
  const dir = await mkdtemp(join(tmpdir(), "pb-guidance-"));
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
  };
}

describe("hook units", () => {
  it("routing hooks go absent -> current -> absent", async () => {
    const { guidanceUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const unit = guidanceUnits().find((u) => u.id === "hooks:routing")!;

    expect(await unit.inspect(ctx)).toBe("absent");
    await unit.apply(ctx);
    expect(await unit.inspect(ctx)).toBe("current");
    await unit.remove(ctx);
    expect(await unit.inspect(ctx)).toBe("absent");

    await rm(ctx.claudeSettingsPath, { force: true });
  });

  it("removing the routing hooks leaves the worktree hooks installed", async () => {
    const { guidanceUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const routing = guidanceUnits().find((u) => u.id === "hooks:routing")!;
    const worktree = guidanceUnits().find((u) => u.id === "hooks:worktree")!;

    await routing.apply(ctx);
    await worktree.apply(ctx);
    await routing.remove(ctx);

    expect(await routing.inspect(ctx)).toBe("absent");
    expect(await worktree.inspect(ctx)).toBe("current");

    await rm(ctx.claudeSettingsPath, { force: true });
  });

  it("refuses to touch a settings.json that is not valid JSON", async () => {
    const { guidanceUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    await Bun.write(ctx.claudeSettingsPath, "{ this is not json");
    const unit = guidanceUnits().find((u) => u.id === "hooks:worktree")!;

    expect(await unit.inspect(ctx)).toBe("foreign");
    await unit.apply(ctx);
    expect(await Bun.file(ctx.claudeSettingsPath).text()).toBe("{ this is not json");

    await rm(ctx.claudeSettingsPath, { force: true });
  });

  it("honours the strict flag from the context", async () => {
    const { guidanceUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    ctx.hookStrict.worktree = true;
    const unit = guidanceUnits().find((u) => u.id === "hooks:worktree")!;

    await unit.apply(ctx);
    const settings = JSON.parse(await Bun.file(ctx.claudeSettingsPath).text());

    expect(JSON.stringify(settings)).toContain("project-brain worktree-guard");

    await rm(ctx.claudeSettingsPath, { force: true });
  });
});
