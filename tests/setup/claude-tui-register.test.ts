import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allUnits, type SetupContext } from "../../src/setup/units.js";
import {
  CONTEXT_GATE_MOD,
  FILE_PREVIEW_MOD,
  MARKETPLACE_NAME,
  SKILL_LISTING_MOD,
  ACTIVITY_MOD,
  marketplaceDir,
  pluginKey,
  registerWithClaude,
  type ClaudeCli,
} from "../../src/setup/claude-tui.js";

/** A fake `claude` that remembers what it was asked and answers from a table. */
function fakeCli(answers: Record<string, { code: number; out: string }> = {}) {
  const calls: string[][] = [];
  const cli: ClaudeCli = async (args) => {
    calls.push(args);
    return answers[args.slice(0, 3).join(" ")] ?? answers[args.slice(0, 2).join(" ")] ?? { code: 0, out: "[]" };
  };
  return { cli, calls };
}

describe("registerWithClaude", () => {
  it("adds the marketplace when Claude does not list it, then installs the plugin", async () => {
    const { cli, calls } = fakeCli();
    expect(await registerWithClaude("/data", FILE_PREVIEW_MOD, cli)).toBeNull();
    expect(calls).toEqual([
      ["plugin", "marketplace", "list", "--json"],
      ["plugin", "marketplace", "add", marketplaceDir("/data")],
      ["plugin", "install", pluginKey(FILE_PREVIEW_MOD)],
    ]);
  });

  it("does not add a marketplace Claude already lists", async () => {
    const { cli, calls } = fakeCli({ "plugin marketplace list": { code: 0, out: JSON.stringify([{ name: MARKETPLACE_NAME }]) } });
    expect(await registerWithClaude("/data", FILE_PREVIEW_MOD, cli)).toBeNull();
    expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual(["plugin marketplace list", "plugin install project-brain-file-preview@project-brain"]);
  });

  it("returns a note, never throws, when the install fails", async () => {
    const { cli } = fakeCli({ "plugin install": { code: 1, out: "Installing...\nplugin not found" } });
    expect(await registerWithClaude("/data", FILE_PREVIEW_MOD, cli)).toBe("could not install project-brain-file-preview@project-brain (plugin not found)");
  });

  it("says Claude will install it at its next start when the CLI is missing", async () => {
    const { cli, calls } = fakeCli({ "plugin marketplace list": { code: -1, out: "claude is not on PATH" } });
    expect(await registerWithClaude("/data", FILE_PREVIEW_MOD, cli)).toContain("next start");
    expect(calls).toHaveLength(1);
  });

  it("tries to add the marketplace when the list cannot be read", async () => {
    const { cli, calls } = fakeCli({ "plugin marketplace list": { code: 0, out: "not json" } });
    await registerWithClaude("/data", FILE_PREVIEW_MOD, cli);
    expect(calls[1].slice(0, 3)).toEqual(["plugin", "marketplace", "add"]);
  });
});

describe("setup units install the mod through Claude Code", () => {
  let dir: string;
  let dataDir: string;
  let settingsPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-register-"));
    dataDir = join(dir, "data");
    settingsPath = join(dir, ".claude", "settings.json");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const ctx = (cli?: ClaudeCli): SetupContext =>
    ({ dataDir, installed: [], claudeSettingsPath: settingsPath, routingConfigPath: join(dir, "none.json"), claudeCli: cli }) as unknown as SetupContext;

  const MODS = [
    ["tui:activity-pane", ACTIVITY_MOD],
    ["tui:skill-listing", SKILL_LISTING_MOD],
    ["tui:context-gate", CONTEXT_GATE_MOD],
    ["tui:file-preview", FILE_PREVIEW_MOD],
  ] as const;

  it.each(MODS)("%s asks Claude to install its plugin after writing the settings", async (id, mod) => {
    const { cli, calls } = fakeCli();
    const context = ctx(cli);
    await allUnits(context).find((u) => u.id === id)!.apply(context);

    expect(calls.at(-1)).toEqual(["plugin", "install", pluginKey(mod)]);
    expect(JSON.parse(await readFile(settingsPath, "utf8")).enabledPlugins[pluginKey(mod)]).toBe(true);
  });

  it("leaves a plugin the user switched off alone", async () => {
    const { cli, calls } = fakeCli();
    const context = ctx(cli);
    await Bun.write(settingsPath, JSON.stringify({ enabledPlugins: { [pluginKey(FILE_PREVIEW_MOD)]: false } }));
    await allUnits(context).find((u) => u.id === "tui:file-preview")!.apply(context);
    expect(calls).toEqual([]);
  });

  it("runs no CLI when the context carries none", async () => {
    const context = ctx(undefined);
    await allUnits(context).find((u) => u.id === "tui:file-preview")!.apply(context);
    expect(JSON.parse(await readFile(settingsPath, "utf8")).enabledPlugins[pluginKey(FILE_PREVIEW_MOD)]).toBe(true);
  });
});
