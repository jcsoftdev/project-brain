import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allUnits, claudeTuiUnits, type SetupContext } from "../../src/setup/units.js";
import {
  ACTIVITY_PANE_FILES,
  ACTIVITY_PLUGIN_KEY,
  ACTIVITY_PLUGIN_NAME,
  CONTEXT_GATE_FILES,
  CONTEXT_GATE_PLUGIN_KEY,
  CONTEXT_GATE_PLUGIN_NAME,
  FILE_PREVIEW_FILES,
  FILE_PREVIEW_PLUGIN_KEY,
  FILE_PREVIEW_PLUGIN_NAME,
  MARKETPLACE_NAME,
  SKILL_LISTING_FILES,
  SKILL_LISTING_PLUGIN_KEY,
  SKILL_LISTING_PLUGIN_NAME,
  READABLE_REPLIES_SECTION_ID,
  marketplaceDir,
} from "../../src/setup/claude-tui.js";
import { groupRowsForPrompt } from "../../src/interactive.js";

let dir: string;
let dataDir: string;
let settingsPath: string;
let claudeMd: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-claude-tui-"));
  dataDir = join(dir, "data");
  settingsPath = join(dir, ".claude", "settings.json");
  claudeMd = join(dir, ".claude", "CLAUDE.md");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const ctxFor = (): SetupContext =>
  ({ dataDir, installed: [], claudeSettingsPath: settingsPath, routingConfigPath: join(dir, "none.json") }) as unknown as SetupContext;
const unitOf = (id: string) => allUnits(ctxFor()).find((u) => u.id === id)!;
const readSettings = async () => JSON.parse(await readFile(settingsPath, "utf8"));

const USER_SETTINGS = {
  model: "opus",
  enabledPlugins: { "caveman@caveman": true },
  extraKnownMarketplaces: { caveman: { source: { source: "github", repo: "someone/caveman" } } },
  hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] },
};

async function seedSettings(value: unknown) {
  await mkdir(join(dir, ".claude"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(value, null, 2));
}

const TUI_IDS = ["tui:activity-pane", "tui:readable-replies", "tui:terminal-theme", "tui:claude-theme", "tui:skill-listing", "tui:context-gate", "tui:file-preview"];
const UNCHECKED = new Set(["tui:terminal-theme", "tui:claude-theme", "tui:skill-listing", "tui:context-gate", "tui:file-preview"]);

describe("Claude TUI units", () => {
  it("are grouped, never installed silently on upgrade, and only the terminal and Claude Code themes, the skill listing, the context gate and the file preview ship unchecked", () => {
    for (const id of TUI_IDS) {
      const unit = unitOf(id);
      expect(unit, id).toBeDefined();
      expect(unit.group).toBe("Claude TUI");
      expect(unit.defaultSelected).toBe(!UNCHECKED.has(id));
      expect(unit.autoOnUpgrade).toBeFalsy();
      expect(unit.description).toContain("untick");
    }
    expect(claudeTuiUnits().map((u) => u.id)).toEqual(TUI_IDS);
  });

  it("renders the group between Skills and Other", () => {
    const row = (id: string, group: string) => ({ id, group, label: id, description: "", state: "absent" }) as any;
    const groups = groupRowsForPrompt([row("o", "Other"), row("t", "Claude TUI"), row("s", "Skills"), row("h", "Hosts")]).map((s) => s.group);
    expect(groups).toEqual(["Hosts", "Skills", "Claude TUI", "Other"]);
    expect(groupRowsForPrompt([row("t", "Claude TUI")])[0]!.blurb.length).toBeGreaterThan(10);
  });
});

describe("tui:activity-pane", () => {
  const ourSource = () => ({ source: { source: "directory", path: marketplaceDir(dataDir) } });

  it("absent → apply → current → remove → absent, other settings preserved", async () => {
    await seedSettings(USER_SETTINGS);
    const unit = unitOf("tui:activity-pane");
    expect(await unit.inspect(ctxFor())).toBe("absent");

    await unit.apply(ctxFor());
    expect(await unit.inspect(ctxFor())).toBe("current");
    const applied = await readSettings();
    expect(applied.extraKnownMarketplaces[MARKETPLACE_NAME]).toEqual(ourSource());
    expect(applied.enabledPlugins[ACTIVITY_PLUGIN_KEY]).toBe(true);
    expect(applied.enabledPlugins["caveman@caveman"]).toBe(true);
    expect(applied.extraKnownMarketplaces.caveman).toEqual(USER_SETTINGS.extraKnownMarketplaces.caveman);
    expect(applied.hooks).toEqual(USER_SETTINGS.hooks);

    const pluginDir = join(marketplaceDir(dataDir), "project-brain-activity");
    for (const [rel, text] of Object.entries(ACTIVITY_PANE_FILES)) {
      expect(await readFile(join(pluginDir, rel), "utf8"), rel).toBe(text);
    }
    const manifest = JSON.parse(await readFile(join(marketplaceDir(dataDir), ".claude-plugin", "marketplace.json"), "utf8"));
    expect(manifest.name).toBe(MARKETPLACE_NAME);
    expect(manifest.plugins[0].source).toBe("./project-brain-activity");

    await unit.remove(ctxFor());
    expect(await unit.inspect(ctxFor())).toBe("absent");
    expect(await readSettings()).toEqual(USER_SETTINGS);
    expect(existsSync(marketplaceDir(dataDir))).toBe(false);
  });

  it("removal keeps a file the user put in the marketplace directory", async () => {
    const unit = unitOf("tui:activity-pane");
    await unit.apply(ctxFor());
    await writeFile(join(marketplaceDir(dataDir), "notes.txt"), "mine");
    await unit.remove(ctxFor());
    expect(await readdir(marketplaceDir(dataDir))).toEqual(["notes.txt"]);
  });

  it("is stale when a shipped file changed on disk, and apply refreshes it", async () => {
    const unit = unitOf("tui:activity-pane");
    await unit.apply(ctxFor());
    await writeFile(join(marketplaceDir(dataDir), "project-brain-activity", "hooks", "register.tsx"), "old");
    expect(await unit.inspect(ctxFor())).toBe("stale");
    await unit.apply(ctxFor());
    expect(await unit.inspect(ctxFor())).toBe("current");
  });

  it("leaves a foreign project-brain marketplace untouched", async () => {
    const foreign = {
      ...USER_SETTINGS,
      extraKnownMarketplaces: { [MARKETPLACE_NAME]: { source: { source: "github", repo: "other/brain" } } },
      enabledPlugins: { [ACTIVITY_PLUGIN_KEY]: true },
    };
    await seedSettings(foreign);
    const unit = unitOf("tui:activity-pane");
    expect(await unit.inspect(ctxFor())).toBe("foreign");
    await unit.apply(ctxFor());
    await unit.remove(ctxFor());
    expect(await readSettings()).toEqual(foreign);
    expect(existsSync(marketplaceDir(dataDir))).toBe(false);
  });

  it("keeps a plugin the user switched off switched off", async () => {
    await seedSettings({ enabledPlugins: { [ACTIVITY_PLUGIN_KEY]: false } });
    const unit = unitOf("tui:activity-pane");
    await unit.apply(ctxFor());
    expect((await readSettings()).enabledPlugins[ACTIVITY_PLUGIN_KEY]).toBe(false);
    expect(await unit.inspect(ctxFor())).toBe("current");
  });
});

describe("tui:activity-pane fullscreen renderer", () => {
  it("apply sets tui to fullscreen and remove deletes a key that was absent before", async () => {
    await seedSettings(USER_SETTINGS);
    const unit = unitOf("tui:activity-pane");
    await unit.apply(ctxFor());
    expect((await readSettings()).tui).toBe("fullscreen");
    await unit.remove(ctxFor());
    expect("tui" in (await readSettings())).toBe(false);
  });

  it("remove restores the user's previous value, even after a re-apply", async () => {
    await seedSettings({ ...USER_SETTINGS, tui: "default" });
    const unit = unitOf("tui:activity-pane");
    await unit.apply(ctxFor());
    await unit.apply(ctxFor());
    expect((await readSettings()).tui).toBe("fullscreen");
    await unit.remove(ctxFor());
    expect(await readSettings()).toEqual({ ...USER_SETTINGS, tui: "default" });
  });

  it("remove leaves a value the user changed after install alone", async () => {
    const unit = unitOf("tui:activity-pane");
    await unit.apply(ctxFor());
    await seedSettings({ ...(await readSettings()), tui: "default" });
    await unit.remove(ctxFor());
    expect((await readSettings()).tui).toBe("default");
  });

  it("an update after the user picked another renderer keeps their choice", async () => {
    const unit = unitOf("tui:activity-pane");
    await unit.apply(ctxFor());
    await seedSettings({ ...(await readSettings()), tui: "default" });
    expect(await unit.inspect(ctxFor())).toBe("current");
    await unit.apply(ctxFor());
    expect((await readSettings()).tui).toBe("default");
  });

  it("remove without the install record leaves the user's own fullscreen", async () => {
    await seedSettings({ ...USER_SETTINGS, tui: "fullscreen", enabledPlugins: { ...USER_SETTINGS.enabledPlugins, "project-brain-activity@project-brain": false } });
    await unitOf("tui:activity-pane").remove(ctxFor());
    expect((await readSettings()).tui).toBe("fullscreen");
  });
});

describe("tui:readable-replies", () => {
  const USER_TEXT = "# My rules\n\n- keep it short\n";

  it("absent → apply → current → remove → absent, user text preserved", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(claudeMd, USER_TEXT);
    const unit = unitOf("tui:readable-replies");
    expect(await unit.inspect(ctxFor())).toBe("absent");

    await unit.apply(ctxFor());
    expect(await unit.inspect(ctxFor())).toBe("current");
    const written = await readFile(claudeMd, "utf8");
    expect(written.startsWith(USER_TEXT.trimEnd())).toBe(true);
    expect(written).toContain(`<!-- ${READABLE_REPLIES_SECTION_ID}:start -->`);
    expect(written).toContain("Open with the result in one or two plain sentences.");

    await unit.remove(ctxFor());
    expect(await unit.inspect(ctxFor())).toBe("absent");
    expect((await readFile(claudeMd, "utf8")).trim()).toBe(USER_TEXT.trim());
  });

  it("is stale when the written block is an older version, and apply refreshes it", async () => {
    const unit = unitOf("tui:readable-replies");
    await unit.apply(ctxFor());
    const old = (await readFile(claudeMd, "utf8")).replace(/readable-replies-version: \d+/, "readable-replies-version: 0");
    await writeFile(claudeMd, old);
    expect(await unit.inspect(ctxFor())).toBe("stale");
    await unit.apply(ctxFor());
    expect(await unit.inspect(ctxFor())).toBe("current");
  });
});

describe("tui:skill-listing", () => {
  const listingCtx = (prompt: SetupContext["promptGeneralSkills"] = async () => null): SetupContext => ({ ...ctxFor(), promptGeneralSkills: prompt });
  const listingDir = () => join(marketplaceDir(dataDir), SKILL_LISTING_PLUGIN_NAME);
  const manifest = async () => JSON.parse(await readFile(join(marketplaceDir(dataDir), ".claude-plugin", "marketplace.json"), "utf8"));
  const pluginNames = async () => (await manifest()).plugins.map((p: { name: string }) => p.name);

  it("absent → apply → current → remove → absent in a temp HOME, other settings preserved", async () => {
    await seedSettings(USER_SETTINGS);
    const unit = unitOf("tui:skill-listing");
    expect(await unit.inspect(listingCtx())).toBe("absent");

    await unit.apply(listingCtx());
    expect(await unit.inspect(listingCtx())).toBe("current");
    const applied = await readSettings();
    expect(applied.enabledPlugins[SKILL_LISTING_PLUGIN_KEY]).toBe(true);
    expect(applied.enabledPlugins[ACTIVITY_PLUGIN_KEY]).toBeUndefined();
    expect("tui" in applied).toBe(false);
    for (const [rel, text] of Object.entries(SKILL_LISTING_FILES)) expect(await readFile(join(listingDir(), rel), "utf8"), rel).toBe(text);
    expect(await pluginNames()).toEqual([SKILL_LISTING_PLUGIN_NAME]);
    expect(existsSync(join(dataDir, "skill-usage.json"))).toBe(true);

    await unit.remove(listingCtx());
    expect(await unit.inspect(listingCtx())).toBe("absent");
    expect(await readSettings()).toEqual(USER_SETTINGS);
    expect(existsSync(marketplaceDir(dataDir))).toBe(false);
    expect(existsSync(join(dataDir, "skill-usage.json"))).toBe(false);
  });

  it("shares the marketplace with the activity pane: removing one keeps the other current", async () => {
    await seedSettings(USER_SETTINGS);
    const pane = unitOf("tui:activity-pane");
    const listing = unitOf("tui:skill-listing");
    await pane.apply(ctxFor());
    await listing.apply(listingCtx());
    expect(await pane.inspect(ctxFor())).toBe("current");
    expect(await listing.inspect(listingCtx())).toBe("current");
    expect(await pluginNames()).toEqual([ACTIVITY_PLUGIN_NAME, SKILL_LISTING_PLUGIN_NAME]);

    await listing.remove(listingCtx());
    expect(await pane.inspect(ctxFor())).toBe("current");
    expect((await readSettings()).extraKnownMarketplaces[MARKETPLACE_NAME]).toBeDefined();
    expect(existsSync(listingDir())).toBe(false);

    await listing.apply(listingCtx());
    await pane.remove(ctxFor());
    expect(await listing.inspect(listingCtx())).toBe("current");
    expect(await pluginNames()).toEqual([SKILL_LISTING_PLUGIN_NAME]);
  });

  it("asks for the general-use skills with the most used suggested but not ticked, and saves the answer", async () => {
    const skillDir = join(dir, ".claude", "skills", "brain-style");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: brain-style\ndescription: Keeps code declarative.\n---\nbody\n");
    const projects = join(dir, ".claude", "projects", "-repo");
    await mkdir(projects, { recursive: true });
    const call = { type: "tool_use", id: "t1", name: "Skill", input: { skill: "brain-style" } };
    await writeFile(join(projects, "s.jsonl"), `${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { content: [call] } })}\n`);

    const asked: Array<{ options: unknown; current: string[] }> = [];
    await unitOf("tui:skill-listing").apply(
      listingCtx(async (options, current) => {
        asked.push({ options, current });
        return ["brain-style"];
      })
    );
    expect(asked).toEqual([{ options: [{ name: "brain-style", uses: 1 }], current: [] }]);
    expect(JSON.parse(await readFile(join(dataDir, "skills.json"), "utf8")).general).toEqual(["brain-style"]);

    await unitOf("tui:skill-listing").apply(listingCtx(async (_options, current) => (asked.push({ options: null, current }), null)));
    expect(asked[1]!.current).toEqual(["brain-style"]);
    expect(JSON.parse(await readFile(join(dataDir, "skills.json"), "utf8")).general).toEqual(["brain-style"]);
  });
});

describe("tui:context-gate", () => {
  const gateDir = () => join(marketplaceDir(dataDir), CONTEXT_GATE_PLUGIN_NAME);
  const pluginNames = async () =>
    JSON.parse(await readFile(join(marketplaceDir(dataDir), ".claude-plugin", "marketplace.json"), "utf8")).plugins.map((p: { name: string }) => p.name);

  it("absent → apply → current → remove, other settings and the sibling mod preserved", async () => {
    await seedSettings(USER_SETTINGS);
    const unit = unitOf("tui:context-gate");
    expect(await unit.inspect(ctxFor())).toBe("absent");

    await unitOf("tui:activity-pane").apply(ctxFor());
    await unit.apply(ctxFor());
    expect(await unit.inspect(ctxFor())).toBe("current");
    expect((await readSettings()).enabledPlugins[CONTEXT_GATE_PLUGIN_KEY]).toBe(true);
    for (const [rel, text] of Object.entries(CONTEXT_GATE_FILES)) expect(await readFile(join(gateDir(), rel), "utf8"), rel).toBe(text);
    expect(await pluginNames()).toEqual([ACTIVITY_PLUGIN_NAME, CONTEXT_GATE_PLUGIN_NAME]);

    await unit.remove(ctxFor());
    expect((await readSettings()).enabledPlugins[CONTEXT_GATE_PLUGIN_KEY]).toBeUndefined();
    expect(await unitOf("tui:activity-pane").inspect(ctxFor())).toBe("current");
    expect(existsSync(gateDir())).toBe(false);
    await unitOf("tui:activity-pane").remove(ctxFor());
    expect(await readSettings()).toEqual(USER_SETTINGS);
    expect(await unit.inspect(ctxFor())).toBe("absent");
  });
});

describe("tui:file-preview", () => {
  const previewDir = () => join(marketplaceDir(dataDir), FILE_PREVIEW_PLUGIN_NAME);
  const pluginNames = async () =>
    JSON.parse(await readFile(join(marketplaceDir(dataDir), ".claude-plugin", "marketplace.json"), "utf8")).plugins.map((p: { name: string }) => p.name);

  it("absent → apply → current → remove, other settings and the sibling mod preserved", async () => {
    await seedSettings(USER_SETTINGS);
    const unit = unitOf("tui:file-preview");
    expect(await unit.inspect(ctxFor())).toBe("absent");

    await unitOf("tui:activity-pane").apply(ctxFor());
    await unit.apply(ctxFor());
    expect(await unit.inspect(ctxFor())).toBe("current");
    expect((await readSettings()).enabledPlugins[FILE_PREVIEW_PLUGIN_KEY]).toBe(true);
    for (const [rel, text] of Object.entries(FILE_PREVIEW_FILES)) expect(await readFile(join(previewDir(), rel), "utf8"), rel).toBe(text);
    expect(await pluginNames()).toEqual([ACTIVITY_PLUGIN_NAME, FILE_PREVIEW_PLUGIN_NAME]);

    await unit.remove(ctxFor());
    expect((await readSettings()).enabledPlugins[FILE_PREVIEW_PLUGIN_KEY]).toBeUndefined();
    expect(await unitOf("tui:activity-pane").inspect(ctxFor())).toBe("current");
    expect(existsSync(previewDir())).toBe(false);
    await unitOf("tui:activity-pane").remove(ctxFor());
    expect(await readSettings()).toEqual(USER_SETTINGS);
    expect(await unit.inspect(ctxFor())).toBe("absent");
  });
});
