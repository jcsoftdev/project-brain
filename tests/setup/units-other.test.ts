import { describe, it, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { SetupContext } from "../../src/setup/units.js";

async function context(): Promise<SetupContext> {
  const dir = await mkdtemp(join(tmpdir(), "pb-other-"));
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

describe("other units", () => {
  it("writes and deletes the brain-record connection config", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const unit = otherUnits().find((u) => u.id === "config:record-connection")!;

    expect(await unit.inspect(ctx)).toBe("absent");
    await unit.apply(ctx);
    expect(await unit.inspect(ctx)).toBe("current");
    expect(JSON.parse(await Bun.file(ctx.recordConfigPath).text())).toEqual({
      mode: "fresh",
      cdpPort: 9222,
    });
    await unit.remove(ctx);
    expect(await unit.inspect(ctx)).toBe("absent");

    await rm(ctx.dataDir, { recursive: true, force: true });
  });

  it("reports the record config stale when the on-disk value differs", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const unit = otherUnits().find((u) => u.id === "config:record-connection")!;

    await unit.apply(ctx);
    ctx.recordConnection.cdpPort = 9333;

    expect(await unit.inspect(ctx)).toBe("stale");

    await rm(ctx.dataDir, { recursive: true, force: true });
  });

  it("never deletes the Ollama model on remove", async () => {
    const { otherUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const unit = otherUnits().find((u) => u.id === "embed:ollama-model")!;

    // Must not throw and must not shell out.
    await unit.remove(ctx);
    expect(unit.description).toContain("shared");
  });
});

describe("allUnits", () => {
  it("returns every group with unique ids, hosts first", async () => {
    const { allUnits } = await import("../../src/setup/units.js");
    const ctx = await context();
    const units = allUnits(ctx);
    const ids = units.map((u) => u.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(units.filter((u) => u.group === "Skills").length).toBeGreaterThan(0);
    expect(ids).toContain("guidance:model-routing");
    expect(ids).toContain("embed:ollama-model");
  });

  it("has a unit for every shipped skill manifest", async () => {
    const { allUnits } = await import("../../src/setup/units.js");
    const { SKILL_MANIFESTS } = await import("../../src/rules/skills.js");
    const ctx = await context();
    const ids = new Set(allUnits(ctx).map((u) => u.id));

    for (const name of Object.keys(SKILL_MANIFESTS)) {
      expect(ids.has(`skill:${name}`)).toBe(true);
    }
  });
});
