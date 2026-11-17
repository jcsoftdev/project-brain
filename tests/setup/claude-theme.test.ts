import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
    expect(await claudeThemeState(settings, dataDir, theme)).toBe("absent");
    await applyClaudeTheme(settings, dataDir, theme);
    expect(await claudeThemeState(settings, dataDir, theme)).toBe("current");
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
    expect(await claudeThemeState(settings, dataDir, theme)).toBe("absent");
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
    expect(await claudeThemeState(settings, dataDir, theme)).toBe("stale");
    await writeFile(settings, "{ not json");
    expect(await claudeThemeState(settings, dataDir, theme)).toBe("foreign");
    await applyClaudeTheme(settings, dataDir, theme);
    expect(await readFile(settings, "utf8")).toBe("{ not json");
  });

  it("keeps a theme the user picked after setup applied ours: update does not undo it, removal does not either", async () => {
    await writeFile(settings, JSON.stringify({ theme: "auto" }));
    await applyClaudeTheme(settings, dataDir, theme);
    await writeFile(settings, JSON.stringify({ theme: "light" }));
    expect(await claudeThemeState(settings, dataDir, theme)).toBe("current");
    await applyClaudeTheme(settings, dataDir, theme);
    expect(await readSettings()).toEqual({ theme: "light" });
    await removeClaudeTheme(settings, dataDir, theme);
    expect(await readSettings()).toEqual({ theme: "light" });
  });

  it("writes through a symlinked settings.json instead of replacing the link", async () => {
    const real = join(dir, "dotfiles", "settings.json");
    await mkdir(join(dir, "dotfiles"), { recursive: true });
    await writeFile(real, JSON.stringify({ theme: "auto" }));
    await rm(settings, { force: true });
    await symlink(real, settings);
    await applyClaudeTheme(settings, dataDir, theme);
    expect(JSON.parse(await readFile(real, "utf8")).theme).toBe(claudeCodeThemeRef(theme));
    await removeClaudeTheme(settings, dataDir, theme);
    expect(JSON.parse(await readFile(real, "utf8")).theme).toBe("auto");
  });
});
