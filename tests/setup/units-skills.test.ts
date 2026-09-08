import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { SetupContext } from "../../src/setup/units.js";

async function context(overrides: Partial<SetupContext> = {}): Promise<SetupContext> {
  const dir = await mkdtemp(join(tmpdir(), "pb-units-"));
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
    ...overrides,
  };
}

describe("skill units", () => {
  it("declares one unit per shipped skill, all selected by default", async () => {
    const { skillUnits } = await import("../../src/setup/units.js");
    const { SKILL_MANIFESTS } = await import("../../src/rules/skills.js");

    const ids = skillUnits().map((u) => u.id).sort();
    const expected = Object.keys(SKILL_MANIFESTS).map((n) => `skill:${n}`).sort();

    expect(ids).toEqual(expected);
    expect(skillUnits().every((u) => u.defaultSelected)).toBe(true);
    expect(skillUnits().every((u) => u.group === "Skills")).toBe(true);
  });

  it("moves absent -> current on apply and current -> absent on remove", async () => {
    const { skillUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const unit = skillUnits().find((u) => u.id === "skill:brain-okf")!;

    expect(await unit.inspect(ctx)).toBe("absent");
    await unit.apply(ctx);
    expect(await unit.inspect(ctx)).toBe("current");
    await unit.remove(ctx);
    expect(await unit.inspect(ctx)).toBe("absent");

    await rm(ctx.skillTargetDirs[0]!, { recursive: true, force: true });
  });

  it("reports stale when the stamp does not match this build", async () => {
    const { skillUnits } = await import("../../src/setup/units.js");
    const { STAMP_FILE } = await import("../../src/rules/skills.js");
    const ctx = await context();
    const unit = skillUnits().find((u) => u.id === "skill:brain-okf")!;

    await unit.apply(ctx);
    const skillDir = join(ctx.skillTargetDirs[0]!, "brain-okf");
    await writeFile(join(skillDir, STAMP_FILE), "deadbeef\nSKILL.md\n", "utf8");

    expect(await unit.inspect(ctx)).toBe("stale");

    await rm(ctx.skillTargetDirs[0]!, { recursive: true, force: true });
  });

  it("reports foreign for a hand-written directory and never removes it", async () => {
    const { skillUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const unit = skillUnits().find((u) => u.id === "skill:brain-okf")!;
    const skillDir = join(ctx.skillTargetDirs[0]!, "brain-okf");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: mine\n---\n", "utf8");

    expect(await unit.inspect(ctx)).toBe("foreign");
    await unit.remove(ctx);
    expect(await unit.inspect(ctx)).toBe("foreign");

    await rm(ctx.skillTargetDirs[0]!, { recursive: true, force: true });
  });

  it("is unavailable when no AI tool gave us a skills root", async () => {
    const { skillUnits } = await import("../../src/setup/units.js");
    const ctx = await context({ skillTargetDirs: [] });
    const unit = skillUnits().find((u) => u.id === "skill:brain-okf")!;

    expect(await unit.inspect(ctx)).toBe("unavailable");
  });
});
