import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyClaudeTheme, claudeThemeFileOf, claudeThemeState, removeClaudeTheme } from "../../src/setup/claude-theme.js";
import { claudeCodeThemeRef, claudeCodeThemeText } from "../../src/themes/claude-code.js";
import { themeById } from "../../src/themes/index.js";

const theme = themeById("dracula");
let dir: string;
let settings: string;
let dataDir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-claude-theme-"));
  settings = join(dir, ".claude", "settings.json");
  dataDir = join(dir, "data");
  await mkdir(join(dir, ".claude"), { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const readSettings = async () => JSON.parse(await readFile(settings, "utf8"));

describe("Claude Code theme unit", () => {
  it("writes the theme file and selects it, keeping the rest of settings.json", async () => {
    await writeFile(settings, JSON.stringify({ theme: "auto", model: "opus" }));
    expect(await claudeThemeState(settings, theme)).toBe("absent");
    await applyClaudeTheme(settings, dataDir, theme);
    expect(await claudeThemeState(settings, theme)).toBe("current");
    expect(await readFile(claudeThemeFileOf(settings, theme), "utf8")).toBe(claudeCodeThemeText(theme));
    expect(await readSettings()).toEqual({ theme: claudeCodeThemeRef(theme), model: "opus" });
  });

  it("puts the previous theme back on removal, and the file goes", async () => {
    await writeFile(settings, JSON.stringify({ theme: "auto" }));
    await applyClaudeTheme(settings, dataDir, theme);
    await applyClaudeTheme(settings, dataDir, theme);
    await removeClaudeTheme(settings, dataDir, theme);
    expect(await readSettings()).toEqual({ theme: "auto" });
    expect(existsSync(claudeThemeFileOf(settings, theme))).toBe(false);
    expect(await claudeThemeState(settings, theme)).toBe("absent");
  });

  it("drops the key when there was no theme before", async () => {
    await writeFile(settings, JSON.stringify({ model: "opus" }));
    await applyClaudeTheme(settings, dataDir, theme);
    await removeClaudeTheme(settings, dataDir, theme);
    expect(await readSettings()).toEqual({ model: "opus" });
  });

  it("works when settings.json does not exist yet", async () => {
    await applyClaudeTheme(settings, dataDir, theme);
    expect(await readSettings()).toEqual({ theme: claudeCodeThemeRef(theme) });
  });

  it("leaves a theme the user chose afterwards alone on removal", async () => {
    await writeFile(settings, JSON.stringify({ theme: "auto" }));
    await applyClaudeTheme(settings, dataDir, theme);
    await writeFile(settings, JSON.stringify({ theme: "light" }));
    await removeClaudeTheme(settings, dataDir, theme);
    expect(await readSettings()).toEqual({ theme: "light" });
  });

  it("calls an edited theme file stale and refuses an unreadable settings.json", async () => {
    await applyClaudeTheme(settings, dataDir, theme);
    await writeFile(claudeThemeFileOf(settings, theme), "{}");
    expect(await claudeThemeState(settings, theme)).toBe("stale");
    await writeFile(settings, "{ not json");
    expect(await claudeThemeState(settings, theme)).toBe("foreign");
    await applyClaudeTheme(settings, dataDir, theme);
    expect(await readFile(settings, "utf8")).toBe("{ not json");
  });
});
