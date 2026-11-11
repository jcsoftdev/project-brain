import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allUnits, claudeTuiUnits, type SetupContext } from "../../src/setup/units.js";
import {
  ACTIVITY_PANE_FILES,
  ACTIVITY_PLUGIN_KEY,
  MARKETPLACE_NAME,
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

const TUI_IDS = ["tui:activity-pane", "tui:readable-replies"];

describe("Claude TUI units", () => {
  it("are grouped, selected on a fresh setup, and never installed silently on upgrade", () => {
    for (const id of TUI_IDS) {
      const unit = unitOf(id);
      expect(unit, id).toBeDefined();
      expect(unit.group).toBe("Claude TUI");
      expect(unit.defaultSelected).toBe(true);
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
