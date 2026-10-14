import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featureEnabled, setFeature } from "../../src/features.js";
import { gatherTaskContext, taskSwitchEnabled } from "../../src/hooks/task-switch.js";
import { loadSelection } from "../../src/setup/selection.js";
import { allUnits, type SetupContext } from "../../src/setup/units.js";
import { ClaudeRegistrar } from "../../src/registrars/claude.js";
import { runSetup } from "../../src/commands/setup.js";

let dir: string;
let dataDir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-feature-units-"));
  dataDir = join(dir, "data");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const ctxFor = (over: Partial<SetupContext> = {}): SetupContext =>
  ({ dataDir, installed: [], claudeSettingsPath: join(dir, ".claude", "settings.json"), routingConfigPath: join(dir, "none.json"), ...over }) as unknown as SetupContext;
const unitOf = (id: string, ctx = ctxFor()) => allUnits(ctx).find((u) => u.id === id)!;

const FEATURE_UNITS = ["feature:routing-skill", "feature:task-switch", "feature:search-gate", "config:context-slim", "config:mcp-prune"];

describe("features.json", () => {
  it("is on without a file or with a corrupt one, off when written off, and the env opt-out wins", async () => {
    expect(featureEnabled("task-switch", dataDir, {})).toBe(true);
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "features.json"), "{broken");
    expect(featureEnabled("task-switch", dataDir, {})).toBe(true);
    await setFeature(dataDir, "task-switch", false);
    expect(featureEnabled("task-switch", dataDir, {})).toBe(false);
    expect(featureEnabled("search-gate", dataDir, {})).toBe(true);
    await setFeature(dataDir, "task-switch", true);
    expect(featureEnabled("task-switch", dataDir, {})).toBe(true);
    expect(featureEnabled("task-switch", dataDir, { PROJECT_BRAIN_TASK_SWITCH: "0" })).toBe(false);
  });
});

describe("context-economy units", () => {
  it("are listed, selected by default and offered to upgraders", () => {
    for (const id of FEATURE_UNITS) {
      const unit = unitOf(id);
      expect(unit, id).toBeDefined();
      expect(unit.defaultSelected, id).toBe(true);
      expect(unit.autoOnUpgrade, id).toBe(true);
      expect(unit.description.length, id).toBeGreaterThan(20);
    }
  });

  for (const [id, feature] of [
    ["feature:task-switch", "task-switch"],
    ["feature:search-gate", "search-gate"],
    ["feature:routing-skill", "routing-skill"],
  ] as const) {
    it(`${id}: current by default, unticking switches the feature off and ticking back on`, async () => {
      const unit = unitOf(id);
      expect(await unit.inspect(ctxFor())).toBe("current");
      await unit.remove(ctxFor());
      expect(featureEnabled(feature, dataDir, {})).toBe(false);
      expect(await unit.inspect(ctxFor())).toBe("absent");
      await unit.apply(ctxFor());
      expect(featureEnabled(feature, dataDir, {})).toBe(true);
    });
  }

  it("task-switch: unticking stops the notice at runtime", async () => {
    const transcript = join(dir, "t.jsonl");
    const usage = { input_tokens: 150_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    await writeFile(
      transcript,
      [
        { type: "user", message: { content: "fix the login" } },
        { type: "assistant", message: { usage } },
      ].map((l) => JSON.stringify(l)).join("\n")
    );
    expect(await gatherTaskContext(transcript, "next thing", {}, async () => undefined, dataDir)).not.toBeNull();
    await unitOf("feature:task-switch").remove(ctxFor());
    expect(taskSwitchEnabled({}, dataDir)).toBe(false);
    expect(await gatherTaskContext(transcript, "next thing", {}, async () => undefined, dataDir)).toBeNull();
  });

  it("routing-skill: unticked writes the full block inline, ticked writes the skill and a pointer", async () => {
    const registrar = new ClaudeRegistrar(join(dir, ".claude"));
    const ctx = ctxFor({ installed: [registrar] });
    const guidance = unitOf("guidance:model-routing", ctx);
    const rulesPath = join(dir, ".claude", "CLAUDE.md");
    const skillFile = join(dir, ".claude", "skills", "brain-model-routing", "SKILL.md");

    await guidance.apply(ctx);
    expect(existsSync(skillFile)).toBe(true);
    expect(await guidance.inspect(ctx)).toBe("current");

    await unitOf("feature:routing-skill", ctx).remove(ctx);
    expect(await guidance.inspect(ctx)).toBe("stale");
    await guidance.apply(ctx);
    expect(existsSync(skillFile)).toBe(false);
    expect((await readFile(rulesPath, "utf8")).length).toBeGreaterThan(1200);
    expect(await guidance.inspect(ctx)).toBe("current");

    await unitOf("feature:routing-skill", ctx).apply(ctx);
    expect(await guidance.inspect(ctx)).toBe("stale");
    await guidance.apply(ctx);
    expect(existsSync(skillFile)).toBe(true);
  });

  it("context-slim: moves a big user section on apply, never a managed block, and unticking restores it", async () => {
    const claudeDir = join(dir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const big = `## Deploy notes\n\n${"Run the thing carefully. ".repeat(300)}\n`;
    const managed = `<!-- gentle-ai:persona -->\n## Rules\n${"managed text ".repeat(600)}\n<!-- /gentle-ai:persona -->\n`;
    const original = `${managed}\n${big}\n## Small\n\ntiny\n`;
    await writeFile(join(claudeDir, "CLAUDE.md"), original);
    const unit = unitOf("config:context-slim");

    expect(await unit.inspect(ctxFor())).toBe("absent");
    await unit.apply(ctxFor());
    const slim = await readFile(join(claudeDir, "CLAUDE.md"), "utf8");
    expect(slim).toContain("managed text");
    expect(slim).not.toContain("Run the thing");
    expect(slim).toContain("tiny");
    expect(existsSync(join(claudeDir, "skills", "memory-deploy-notes", "SKILL.md"))).toBe(true);
    expect(await unit.inspect(ctxFor())).toBe("current");

    await unit.remove(ctxFor());
    expect(await readFile(join(claudeDir, "CLAUDE.md"), "utf8")).toBe(original);
    expect(featureEnabled("context-slim", dataDir, {})).toBe(false);
    expect(await unit.inspect(ctxFor())).toBe("absent");
  });

  it("context-slim: a CLAUDE.md with only managed content moves nothing and reports current", async () => {
    const claudeDir = join(dir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    const managed = `<!-- gentle-ai:persona -->\n## Rules\n${"managed text ".repeat(600)}\n<!-- /gentle-ai:persona -->\n`;
    await writeFile(join(claudeDir, "CLAUDE.md"), managed);
    const unit = unitOf("config:context-slim");
    expect(await unit.inspect(ctxFor())).toBe("current");
    await unit.apply(ctxFor());
    expect(await readFile(join(claudeDir, "CLAUDE.md"), "utf8")).toBe(managed);
  });

  it("mcp-prune: ticking and unticking persist the feature flag", async () => {
    const unit = unitOf("config:mcp-prune");
    await unit.remove(ctxFor());
    expect(featureEnabled("mcp-prune", dataDir, {})).toBe(false);
    await unit.apply(ctxFor());
    expect(featureEnabled("mcp-prune", dataDir, {})).toBe(true);
  });
});

describe("setup flow", () => {
  const common = () => ({
    dataDir,
    skipOllama: true,
    registrars: [] as never[],
    skillTargetDirs: [],
    claudeSettingsPath: join(dir, "settings.json"),
  });
  const IDS = ["feature:routing-skill", "feature:task-switch", "feature:search-gate"];

  it("lists the units with their descriptions in the checklist", async () => {
    let shown: Array<{ id: string; description: string }> = [];
    await runSetup({ ...common(), quiet: true, promptUnitSelection: async (rows) => ((shown = rows), null) });
    for (const id of IDS) expect(shown.find((r) => r.id === id)?.description.length).toBeGreaterThan(20);
  });

  it("unticking in the checklist switches the features off; an upgrade that never saw them leaves them on and selected", async () => {
    await runSetup({ ...common(), quiet: true, units: { mode: "explicit", selected: [] } });
    for (const f of ["task-switch", "search-gate", "routing-skill"] as const) expect(featureEnabled(f, dataDir, {})).toBe(false);

    // A selection written before these units existed: they appear in neither list.
    await rm(dataDir, { recursive: true, force: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      join(dataDir, "setup-selection.json"),
      JSON.stringify({ version: 1, updatedAt: "", binaryVersion: "0.0.1", selected: ["hooks:routing"], declined: [] })
    );
    await runSetup({ ...common(), quiet: true, applySaved: true });
    const saved = await loadSelection(join(dataDir, "setup-selection.json"));
    for (const id of IDS) expect(saved?.selected).toContain(id);
    for (const f of ["task-switch", "search-gate", "routing-skill"] as const) expect(featureEnabled(f, dataDir, {})).toBe(true);
  });
});
