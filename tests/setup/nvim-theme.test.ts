import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  NVIM_THEME_MARKER,
  applyNvimTheme,
  nvimConfigDir,
  nvimThemeFiles,
  nvimThemeState,
  removeNvimTheme,
} from "../../src/setup/nvim-theme.js";
import { allUnits, nvimUnits, type SetupContext } from "../../src/setup/units.js";
import { blend, themeById, uiRolesOf } from "../../src/themes/index.js";

const theme = themeById("dracula");
let dir: string;
let config: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pb-nvim-theme-"));
  config = join(dir, ".config", "nvim");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("Neovim theme files", () => {
  it("writes the palette, the highlights and the spec, each starting with the marker", async () => {
    expect(await nvimThemeState(config, theme)).toBe("absent");
    await applyNvimTheme(config, theme);
    expect(await nvimThemeState(config, theme)).toBe("current");
    for (const rel of Object.keys(nvimThemeFiles(theme))) {
      expect((await readFile(join(config, rel), "utf8")).startsWith(NVIM_THEME_MARKER)).toBe(true);
    }
    const palette = await readFile(join(config, "lua/project-brain/palette.lua"), "utf8");
    expect(palette).toContain('background = "#17141d"');
    expect(palette).toContain('pink = "#ff79c6"');
  });

  it("calls an edited file stale and puts it back on apply", async () => {
    await applyNvimTheme(config, theme);
    await writeFile(join(config, "lua/project-brain/palette.lua"), `${NVIM_THEME_MARKER}\nreturn {}\n`);
    expect(await nvimThemeState(config, theme)).toBe("stale");
    await applyNvimTheme(config, theme);
    expect(await nvimThemeState(config, theme)).toBe("current");
  });

  it("never touches a file of the user's at one of its paths", async () => {
    const mine = join(config, "lua/plugins/project-brain-theme.lua");
    await mkdir(dirname(mine), { recursive: true });
    await writeFile(mine, "return { -- mine\n}\n");
    expect(await nvimThemeState(config, theme)).toBe("foreign");
    await applyNvimTheme(config, theme);
    await removeNvimTheme(config, theme);
    expect(await readFile(mine, "utf8")).toBe("return { -- mine\n}\n");
    expect(existsSync(join(config, "lua/project-brain/palette.lua"))).toBe(false);
  });

  it("removes only its own files, and the directory it made", async () => {
    await mkdir(join(config, "lua/plugins"), { recursive: true });
    await writeFile(join(config, "lua/plugins/colorscheme.lua"), "return {}\n");
    await applyNvimTheme(config, theme);
    await removeNvimTheme(config, theme);
    expect(await readdir(join(config, "lua/plugins"))).toEqual(["colorscheme.lua"]);
    expect(existsSync(join(config, "lua/project-brain"))).toBe(false);
  });

  it("finds the config under XDG_CONFIG_HOME when it is absolute, else under ~/.config", () => {
    expect(nvimConfigDir("/h", "/x")).toBe("/x/nvim");
    expect(nvimConfigDir("/h", undefined)).toBe("/h/.config/nvim");
    expect(nvimConfigDir("/h", "relative")).toBe("/h/.config/nvim");
  });

  it("is its own group, off by default", () => {
    const unit = nvimUnits()[0]!;
    expect(unit.id).toBe("nvim:theme");
    expect(unit.group).toBe("Neovim");
    expect(unit.defaultSelected).toBe(false);
    expect(unit.description).toContain("untick");
    const ctx = { dataDir: "/tmp/x", installed: [], claudeSettingsPath: "/tmp/x/.claude/settings.json", routingConfigPath: "/tmp/none.json" } as unknown as SetupContext;
    expect(allUnits(ctx).some((one) => one.id === "nvim:theme")).toBe(true);
  });
});

const NVIM = Bun.which("nvim");

describe.skipIf(!NVIM)("Neovim highlights, evaluated by Neovim itself", () => {
  const evaluate = async () => {
    await applyNvimTheme(config, theme);
    const probe = join(dir, "probe.lua");
    await writeFile(
      probe,
      `package.path = ${JSON.stringify(join(config, "lua"))} .. "/?.lua;" .. package.path
local p = require("project-brain.palette")
local h = require("project-brain.highlights")
local c = { git = {}, gitSigns = {}, diff = {} }
h.colors(c, p)
local hl = {}
h.groups(hl, c, p)
io.write(vim.json.encode({ colors = c, hl = hl, syntax = h.syntax(p) }))
`
    );
    const out = Bun.spawnSync([NVIM!, "--headless", "--clean", "-l", probe], { stdout: "pipe", stderr: "pipe" });
    expect(out.stderr.toString()).toBe("");
    return JSON.parse(out.stdout.toString()) as { colors: Record<string, any>; hl: Record<string, any>; syntax: Record<string, string> };
  };

  it("paints a diff that reads as green added, red removed, and a stronger tint on changed words", async () => {
    const { hl } = await evaluate();
    const bg = theme.background;
    expect(hl.DiffAdd.bg).toBe(blend(bg, theme.accents.green, 0.12));
    expect(hl.DiffDelete.bg).toBe(blend(bg, theme.accents.red, 0.12));
    expect(hl.DiffChange.bg).toBe(blend(bg, theme.accents.cyan, 0.06));
    expect(hl.DiffText.bg).toBe(blend(bg, theme.accents.orange, 0.22));
    expect(hl.DiffText.bold).toBe(true);
    expect(hl.DiffTextAdd.bg).toBe(blend(bg, theme.accents.green, 0.22));
    // The deleted-line filler (the hatch) is a quiet red, not a loud one.
    expect(hl.DiffDelete.fg).toBe(blend(theme.accents.red, bg, 0.5));
  });

  it("agrees with the TypeScript blend, so the Lua and the registry cannot drift", async () => {
    const { colors } = await evaluate();
    expect(colors.diff.add).toBe(blend(theme.background, theme.accents.green, 0.12));
    expect(colors.bg).toBe(theme.background);
    expect(colors.bg_highlight).toBe(blend(theme.background, theme.selection, 0.45));
  });

  it("computes the same UI roles as the TypeScript every other tool reads", async () => {
    const { colors, hl } = await evaluate();
    const roles = uiRolesOf(theme);
    expect(colors.diff).toEqual({ add: roles.diff.add, delete: roles.diff.delete, change: roles.diff.change, text: roles.diff.text });
    expect(colors.bg).toBe(roles.surface.base);
    expect(colors.bg_float).toBe(roles.surface.float);
    expect(colors.bg_highlight).toBe(roles.surface.line);
    expect(colors.bg_visual).toBe(roles.surface.selection);
    expect(colors.fg_dark).toBe(roles.text.fgDim);
    expect(colors.fg_gutter).toBe(roles.text.gutter);
    expect(colors.dark5).toBe(roles.text.muted);
    expect(colors.border).toBe(roles.border.idle);
    expect(colors.border_highlight).toBe(roles.border.focus);
    const { unstaged: _unstaged, ...lineGit } = roles.git;
    expect(colors.git).toEqual(lineGit);
    expect([colors.error, colors.warning, colors.info, colors.hint]).toEqual([
      roles.status.error,
      roles.status.warning,
      roles.status.info,
      roles.status.hint,
    ]);
    expect(hl.CursorLine.bg).toBe(roles.surface.line);
    expect(hl.DiffText.bg).toBe(roles.diff.text);
    expect(hl.DiffTextAdd.bg).toBe(roles.diff.textAdd);
    expect(hl.GitSignsDeleteInline.bg).toBe(roles.diff.textDelete);
    expect(hl.DiffDelete).toEqual({ bg: roles.diff.delete, fg: roles.diff.deleteFiller });
    expect(hl.DiffAdd.bg).toBe(roles.diff.add);
    expect(hl.DiffChange.bg).toBe(roles.diff.change);
    expect(hl.GitSignsAddInline.bg).toBe(roles.diff.textAdd);
    expect(hl.GitSignsChangeInline.bg).toBe(roles.diff.text);
    expect(hl.GitSignsAddLn.bg).toBe(roles.diff.add);
    expect(hl.GitSignsDeleteLn.bg).toBe(roles.diff.delete);
    expect(hl.diffLine.fg).toBe(roles.diff.hunk);
    expect(hl.diffFile).toEqual({ fg: roles.diff.file, bold: true });
    expect(hl.Search).toEqual({ bg: roles.surface.search, fg: roles.text.fg });
    expect(hl.IncSearch).toEqual({ bg: roles.surface.searchCurrent, fg: roles.text.onAccent });
    expect(colors.blue).toBe(roles.text.path);
  });

  it("paints code from the same syntax roles the TypeScript hands to every other tool", async () => {
    const { hl, syntax } = await evaluate();
    const roles = uiRolesOf(theme).syntax;
    expect(syntax).toEqual(roles);
    const painted: [string, keyof typeof roles][] = [
      ["@keyword", "keyword"],
      ["@operator", "operator"],
      ["@function", "function"],
      ["@function.builtin", "builtin"],
      ["@type", "type"],
      ["@string", "string"],
      ["@string.escape", "escape"],
      ["@string.regexp", "regexp"],
      ["@number", "number"],
      ["@constant", "constant"],
      ["@variable.parameter", "parameter"],
      ["@variable", "variable"],
      ["@comment", "comment"],
      ["@tag", "tag"],
      ["@tag.delimiter", "tagDelimiter"],
      ["@attribute", "attribute"],
      ["@markup.heading", "heading"],
      ["@markup.link", "link"],
      ["@markup.raw", "raw"],
    ];
    for (const [group, role] of painted) expect(hl[group].fg, group).toBe(roles[role]);
  });

  it("paints code the way the theme does: pink keywords, green functions, yellow strings, purple numbers", async () => {
    const { hl } = await evaluate();
    expect(hl["@keyword"].fg).toBe(theme.accents.pink);
    expect(hl["@function.call"].fg).toBe(theme.accents.green);
    expect(hl["@string"].fg).toBe(theme.accents.yellow);
    expect(hl["@number"].fg).toBe(theme.accents.purple);
    expect(hl["@type"].fg).toBe(theme.accents.cyan);
    expect(hl["@variable.parameter"]).toEqual({ fg: theme.accents.orange, italic: true });
    expect(hl.Comment).toEqual({ fg: theme.comment, italic: true });
  });
});
