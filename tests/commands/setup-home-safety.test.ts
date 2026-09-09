import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AIToolRegistrar } from "../../src/registrars/types.js";

function claudeRegistrar(): AIToolRegistrar {
  return {
    name: "Claude Code",
    isInstalled: async () => true,
    register: async () => {},
    writeRules: async () => {},
    routing: {
      hostKey: "claude",
      mechanism: "per-spawn",
      howToApply: "pass `model` on the call.",
      labelField: "the description field",
      models: { fast: "haiku", balanced: "sonnet", deep: "opus" },
    },
    writtenRoutingVersion: async () => null,
    writeModelRouting: async () => {},
  } as unknown as AIToolRegistrar;
}

describe("setup never writes outside the paths it was given", () => {
  // Redirection goes through BRAIN_CLAUDE_SETTINGS, not HOME: Bun's
  // os.homedir() ignores a runtime HOME change (node honours it), so a HOME
  // override would read as a guard while protecting nothing under `bun test`.
  let home: string;
  let dir: string;
  let backup: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pb-home-safety-"));
    home = join(dir, "home");
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ sentinel: true }));
    backup = process.env.BRAIN_CLAUDE_SETTINGS;
    process.env.BRAIN_CLAUDE_SETTINGS = join(home, ".claude", "settings.json");
  });

  afterEach(async () => {
    if (backup === undefined) delete process.env.BRAIN_CLAUDE_SETTINGS;
    else process.env.BRAIN_CLAUDE_SETTINGS = backup;
    await rm(dir, { recursive: true, force: true });
  });

  it("leaves ~/.claude/settings.json untouched when an explicit path is given", async () => {
    // The regression this guards: the worktree hook installer resolves
    // ~/.claude/settings.json at call time, and unlike the routing installer it
    // has no consent gate to return early through. A `bun test` run was observed
    // writing real hooks into a developer's own settings file.
    const { runSetup } = await import("../../src/commands/setup.js");
    const settingsPath = join(dir, "explicit-settings.json");

    await runSetup({
      dataDir: join(dir, "data"),
      skipOllama: true,
      registrars: [claudeRegistrar()],
      skillTargetDirs: [],
      claudeSettingsPath: settingsPath,
    });

    const home_settings = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    expect(home_settings).toEqual({ sentinel: true });
    expect(existsSync(settingsPath)).toBe(true);
  });

  it("writes into the redirected HOME, never the developer's real one, when no path is given", async () => {
    const { runSetup } = await import("../../src/commands/setup.js");

    await runSetup({
      dataDir: join(dir, "data"),
      skipOllama: true,
      registrars: [claudeRegistrar()],
      skillTargetDirs: [],
    });

    const written = JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8"));
    expect(JSON.stringify(written)).toContain("worktree-hook");
  });
});
